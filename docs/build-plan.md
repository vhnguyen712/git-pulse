# Build & Ship Plan — Observable, Controllable Agent Runs

> **What this is.** A single, detailed implementation plan that compiles the
> *observable run cockpit* (`observable-run-cockpit.md`) into the *loop-SDLC run
> model* (`loop-sdlc-analysis.md`) and sequences them to **build and ship
> together**. The run model provides the execution substrate; the cockpit
> provides the observability + control. Neither ships alone — every milestone
> below delivers a slice of both.
>
> The two source docs remain for background; this document is the authoritative
> plan of record.

---

## 1. Goal

Turn GitPulse's agent execution from an opaque, attended terminal into a
**recorded, instrumented, human-steerable run** — where each run is transparent
across **tokens, cost, step-by-step progress, skills, tools, and model**, and
controllable at each point (gate, pause, step, inject guidance, budget-cap,
cancel).

Explicitly **not** a goal: autonomous end-to-end SDLC operation. The human stays
in the loop; control *is* the product. Single-user, local, token-never-leaves-
the-server posture is preserved.

## 2. Scope

**In scope**
- A durable run + step timeline data model.
- A structured (non-interactive) agent runner that captures events + usage.
- Live observability UI (timeline, token/cost meters, attribution).
- Control plane: pre-run config, tool gating, pause/step/inject, budget guard, cancel.
- Cost/token accounting reusing the existing `TokenUsage` + `costPerMillion*` machinery.
- Optional wiring: start a run from an action item; open a draft PR from a finished run.

**Out of scope (for this plan)**
- Auto-merge / unattended promotion (the autonomy dial in `loop-sdlc-analysis.md`).
- Verification/self-heal loop as an *automatic* gate — a run may *invoke* tests,
  but GitPulse doesn't auto-advance on green. (Left as a later extension.)
- Multi-tenant / remote execution (Option 3 in the loop doc) — breaks local-first.

## 3. Architecture overview

```text
                         ┌──────────────────────────────────────────┐
   Cockpit UI  ◀── WS ───│  server.ts (existing Node http + ws)      │
   (React)     ── HTTP ─▶│   ├─ /api/runs            (start/list/get)│
                         │   ├─ /api/runs/[id]/control (pause/step…) │
                         │   └─ upgrade: /ws/runs/[id] (live events) │
                         └───────────────┬──────────────────────────┘
                                         │
                    ┌────────────────────▼─────────────────────┐
                    │  lib/runs/*  (new)                        │
                    │   runner.ts   spawn agent (stream mode)   │
                    │   parser.ts   CLI events → RunStep[]      │
                    │   recorder.ts persist steps + usage       │
                    │   control.ts  gate/pause/step/budget      │
                    │   cost.ts     tokens → $ (costPerMillion) │
                    └───────┬───────────────────────┬───────────┘
                            │ reuses                 │ persists
              lib/terminal/worktree.ts        lib/db (runs, run_steps)
              lib/terminal/agents.ts
```

The runner sits **beside** the existing interactive pty path
(`lib/terminal/server.ts`), not replacing it. The interactive terminal remains
the "attended/manual" escape hatch; runs are the instrumented default.

## 4. Phase 0 — capability spike (must precede M1)

The whole plan rests on the agent CLIs emitting a machine-readable event stream
with usage. Verify before building.

**Tasks**
- Confirm Claude Code's headless/print mode + streaming-JSON output format and
  the exact flag(s); capture a real event transcript for a small task.
- Confirm which events carry **token usage**, **tool_use/tool_result**, and any
  **skill/subagent** markers.
- Confirm the control mechanisms and which are viable per-run: **hooks**
  (PreToolUse/PostToolUse), **permission mode**, mid-run input injection, and
  clean cancellation.
- Repeat the minimal check for Codex (second agent), noting gaps.

**Deliverable:** `docs/spike-cli-streaming.md` — a short decision record: exact
commands, the event schema we'll parse, and which control features each agent
supports. **Gate:** if usage isn't in the stream for an agent, the cockpit
degrades to steps/duration for it (documented, not blocking).

## 5. Data model (Drizzle — `lib/db/schema.ts`)

```ts
// Runs = one instrumented agent execution.
runs {
  id            text pk
  projectId     text -> projects.id (cascade)
  actionItemId  text -> action_items.id (set null)   // nullable: ad-hoc runs
  agentId       text                                  // "claude" | "codex" | ...
  model         text
  worktreePath  text
  branch        text
  status        text enum(queued,running,paused,awaiting_approval,done,failed,cancelled)
  configJson    text          // { skills[], budgetTokens?, budgetUsd?, gating, temperature? }
  promptTokens  integer
  completionTokens integer
  totalTokens   integer
  costEstimate  real          // computed via cost.ts
  durationMs    integer
  error         text
  createdAt / updatedAt integer
}

// Run steps = the ordered flight-recorder timeline.
run_steps {
  id            text pk
  runId         text -> runs.id (cascade)
  seq           integer                                // monotonic within a run
  type          text enum(message,tool_use,tool_result,usage,gate,error,system)
  tool          text            // when type=tool_use/result
  skill         text            // when a skill is active
  title         text            // short human label
  payloadJson   text            // full event, for the detail drawer
  promptTokens  integer
  completionTokens integer
  costEstimate  real
  durationMs    integer
  createdAt     integer
}
```

- Follows the token-accounting shape already on `ai_summaries`.
- Migration generated with `drizzle-kit generate` (never hand-edit; matches repo convention).
- `run_steps` is append-only; `runs` totals are rolled up by `recorder.ts` as steps land.

## 6. Backend — the structured runner (`lib/runs/`)

- **`runner.ts`** — `startRun(input)`: resolve project + agent (`getAgent`,
  `effectiveAgentCommand`), create a worktree (`createSessionWorktree`, reused
  from the terminal path), spawn the agent in **structured stream mode** (from
  Phase 0), and stream stdout into the parser. On exit, finalize the run and
  `removeSessionWorktree` (non-force, keep uncommitted work — same discipline as
  `terminal/server.ts`).
- **`parser.ts`** — pure function `parseEvent(line) -> RunStep | null`. Pure and
  `node:`-free so it's unit-testable with recorded fixtures from Phase 0.
- **`recorder.ts`** — persist each `RunStep`, update `runs` rollups (tokens,
  cost, duration), and publish to the live WS channel + an in-memory subscriber
  map (mirrors the `sessions` map pattern in `terminal/server.ts`).
- **`cost.ts`** — `estimateCost(usage, settings)` using `costPerMillionInput/
  Output`. Reuse `TokenUsage` from `lib/llm.ts`. Null usage → null cost (meter
  degrades to steps/duration), matching the app's existing "proxy omits usage" handling.
- **`control.ts`** — run control state machine (see §7).

Runs are tracked in a process-level `Map` (like `sessions`) **and** persisted, so
a restart can mark orphaned `running` rows as `failed` on boot (a resume pass).

## 7. Control plane (`lib/runs/control.ts`)

Each control maps to a Phase-0-verified CLI mechanism; degrade gracefully where a
given agent lacks one.

| Control | Mechanism | Degradation |
|---|---|---|
| **Pre-run config** | flags at spawn: model, enabled skills, temperature | subset of flags the CLI accepts |
| **Tool gating** | PreToolUse hook / permission mode → run pauses at `awaiting_approval` | if unsupported: gating disabled, noted in UI |
| **Budget guard** | `cost.ts` watches rollups; crossing `budgetTokens/budgetUsd` → auto-pause | always available (server-side) |
| **Pause / resume** | hold/release the agent's input + hook responses | if not pausable: offered as cancel only |
| **Step** | release exactly one gated tool, re-hold | requires gating support |
| **Inject guidance** | write a steering message to the agent's input | requires input injection |
| **Cancel** | kill process, keep worktree + recorded timeline | always available |

Budget guard and cancel are the **always-on floor**; everything else is
best-effort per agent capability and surfaced honestly in the UI.

## 8. API surface

- `POST /api/runs` — start a run `{ projectId, actionItemId?, agentId, model, config }` → `runId`.
- `GET /api/runs` / `GET /api/runs/[id]` — list / detail (run + steps).
- `POST /api/runs/[id]/control` — `{ action: pause|resume|step|inject|cancel, payload? }`.
- **WS `/ws/runs/[id]`** — live `RunStep` events + status transitions. Wired into
  the existing `upgrade` handler in `server.ts` (same-origin check reused from
  `isSameOrigin`).

All routes are server-side under `app/api/**`, preserving the token boundary.

## 9. Cockpit UI

- **Run cockpit** `app/project/[owner]/[repo]/runs/[runId]/page.tsx` (or a panel
  in the existing workspace) — live **step timeline**, running **token + cost
  meters**, **control bar** (pause/step/inject/cancel + budget), a **diff
  preview** of the worktree, and a step **detail drawer** (raw payload).
- **Attribution** — cost/tokens **by tool** and **by skill**, and a **skills-
  fired** list. Built on `components/charts/*` (bar-series, donut, sparkline).
- **Run history + compare** — list of past runs; select two to compare cost /
  steps / outcome side by side (A/B the same task across models or skill sets).
- **Config panel** — pre-run knobs (agent, model, skills, budget cap, gating level).

## 10. MCP + action-item integration

- Extend `lib/mcp/register.ts` with `start_run` and `get_run` so a run is
  drivable programmatically (additive registration, matches proposal E).
- Add a **"Run this item"** action on the action-item card that seeds the run
  from the item's title/description (reuses the seeded-prompt idea from the
  terminal, now feeding the structured runner).
- Optional finish hook: offer `openDraftPullRequest` (existing, `lib/pulls.ts`)
  from a completed run — human-triggered, not automatic (stays in scope).

## 11. Milestones — each independently shippable

| M | Deliverable | Ships (run model + cockpit) | Acceptance | Status |
|---|---|---|---|---|
| **M0** | Phase-0 spike + decision record | — | `spike-cli-streaming.md` merged; event schema fixed | ✅ Claude Code, verified against a real install (v2.1.250) + a real production run through the actual runner. Codex/Antigravity still unverified — no install available. |
| **M1** | `runs`/`run_steps` schema + migration; `parser.ts` + fixtures | substrate | migration applies; parser unit tests green | ✅ |
| **M2** | `runner.ts` + `recorder.ts`: start a run for Claude Code, persist timeline + usage | substrate | a run records a full step timeline with tokens | ✅ |
| **M3** | Cockpit **read** view: live timeline + running token/cost meters (WS) | **observability achieved** | open app, start a run, watch steps + meters live | ✅ backend + UI shipped, verified via a real WS/API run; UI itself not browser-rendered |
| **M4** | Attribution (by tool / by skill) + run history + compare | observability+ | two runs comparable side by side | ✅ tokens-by-tool (bar) + steps-by-type (donut) + cost-by-tool/skill on the cockpit (`lib/runs/attribution.ts`, unit-tested); run history list + two-run compare view in the Runs tab |
| **M5** | Budget guard + cancel | control floor | run auto-pauses at cap; cancel keeps worktree+timeline | ✅ token/cost budget guard (SIGSTOP where supported, hard stop otherwise) + cancel (SIGTERM→SIGKILL), both verified in tests |
| **M6** | Tool gating (approve/deny) + pause/step/inject | **real control achieved** | gate a tool, single-step, inject guidance mid-run | 🟡 Gating confirmed impossible headlessly — `--permission-mode manual` tested directly against a tool call in `-p` mode and did not block it (not just an absent flag). **Inject is real**: confirmed a `--input-format stream-json` process stays alive and correctly processes a second stdin turn well after the first completed; wired end to end (adapter `formatUserTurn`, runner grace-timer + stdin lifecycle, WS + REST control, cockpit "Send guidance" UI) and verified with a live two-turn run through the real API against the real CLI, injected via the REST control endpoint. step/gating remain unsupported by any adapter. |
| **M7** | MCP `start_run`/`get_run` + "Run this item" + optional draft PR | integration | run launched from an action item; PR opened on demand | ✅ MCP tools; a "Run" button on each action-item card (seeded with the same prompt as "Open in Claude Code") starts a run and navigates to its cockpit; a `done` run tied to an action item can open its draft PR inline |

Follow-up found during the M0 spike, not yet scheduled: prefer an adapter's own
authoritative cost (Claude Code's `total_cost_usd`) over GitPulse's flat-rate
token estimate when available — see `spike-cli-streaming.md`'s "Known gap"
section. GitPulse's estimate currently overstates Claude Code cost because it
can't represent prompt-cache pricing tiers.

Ship after each milestone. The product is genuinely *observable* at M3 and
genuinely *controllable* at M6; M4/M5/M7 deepen both.

## 12. Testing strategy

- **Unit (vitest, matches repo):** `parser.ts` against recorded Phase-0 fixtures
  (happy path, missing-usage, tool_use/result pairing, malformed line);
  `cost.ts` (usage → $, null usage); control state machine transitions.
- **Recorder rollups:** steps in → correct run totals (tokens/cost/duration).
- **Integration:** a fake agent binary emitting a canned event stream drives
  `runner.ts` end to end (no network, no real CLI) — asserts persisted timeline
  and WS broadcast.
- **Manual/`/run`:** exercise the cockpit against a real Claude Code run on a
  scratch repo before each ship.
- Keep `npm run lint` + `npm test` green per push (repo convention).

## 13. Risks & mitigations

- **CLI stream/control gaps** → Phase 0 gates the design; degrade per-agent
  (usage→steps-only; gating optional) and surface capability honestly in UI.
- **Restart mid-run** → persisted `runs`; boot pass marks orphaned `running` as
  `failed`; worktree cleanup is idempotent (reuses terminal teardown).
- **Cost is an estimate** → labeled as such, driven by `costPerMillion*` (existing caveat).
- **Concurrency / resource load** → cap concurrent runs; reuse worktree machinery;
  keep the app's existing rate-limit discipline.
- **UX tension (raw terminal vs structured view)** → timeline is primary; raw
  output available on tap; interactive pty stays as the separate attended mode.
- **Scope creep toward autonomy** → auto-advance/auto-merge explicitly out; any
  verification step is human-reviewed, not a gate.

## 14. How they ship together

The run model and the cockpit are not sequential phases — each milestone lands a
vertical slice of both: M1–M2 build the substrate *for* the cockpit; M3–M4 make
that substrate observable; M5–M6 make it controllable; M7 wires it into the
existing action-item/MCP loop. At no point is there a "backend-only" release with
nothing to see. First shippable increment: **M3** (observable runs).
