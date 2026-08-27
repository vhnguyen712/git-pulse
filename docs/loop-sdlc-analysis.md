# Can GitPulse become a loop-engineering SDLC platform?

> **Direction note (superseded in part):** full autonomous loop operation was
> considered and **set aside**. The chosen direction is the *observable,
> controllable run cockpit* — see `observable-run-cockpit.md`. This document is
> kept for the loop mapping and the "what would full autonomy require" reasoning,
> which still informs the cockpit's run model.


> Analysis of evolving GitPulse from a *planning dashboard that can launch an
> agent* into a *platform that operates a closed engineering loop*. Grounded in
> the codebase as of `claude/app-extension-approaches-gpxw1v`.

## Short answer

Yes — and it's a natural trajectory, not a rewrite. GitPulse already owns the
*hardest* and most differentiated half of the loop (observe → analyze → plan →
publish). But "run the implementation in the embedded terminal" is **not yet**
the same as "operate the loop," because of one architectural fact:

> The embedded terminal is **interactive / human-in-the-loop by design**. It
> seeds a prompt but deliberately does not send it — *"the user reviews it and
> presses Enter"* (`lib/terminal/server.ts:195`). The pty is a raw keystroke
> bridge: no completion detection, no structured result, no headless mode.

So becoming a loop platform is mostly about adding an **execution + verification
spine** and a second, *orchestrated* run mode alongside the existing attended one.

## The loop, mapped to what exists

| Stage | State | Where |
|---|---|---|
| 1. Observe (commits since last) | ✅ Have | `lib/sync.ts`, `lib/github.ts` |
| 2. Analyze / plan (next steps) | ✅ Have (crown jewel) | `lib/llm.ts`, `lib/context.ts` |
| 3. Task spec (title/priority) | 🟡 Partial — no acceptance criteria | `actionItems` schema |
| 4. Implement | 🟡 Partial — **interactive only** | `lib/terminal/*` |
| 5. Verify (test/lint/build) | ❌ Missing | — |
| 6. Review | 🟡 Partial — opens draft PR, reconciles state | `lib/pulls.ts` |
| 7. Integrate / merge | 🟡 Partial — tracks PR, no merge automation | `lib/pulls.ts` |
| 8. Feedback → back to (1) | ✅ Closes naturally — next sync re-analyzes merged commits | `lib/sync.ts` |

The loop *already closes* through the sync engine. The missing spine is **4→5→6**
run as an observable, gated, headless sequence rather than a human at a TUI.

## The one required pivot: attended terminal → orchestrated run

Two execution modes should coexist:

- **Attended (today):** interactive TUI in a worktree, human drives. Keep it — it's
  great for exploration and rescue.
- **Orchestrated (new):** a *Run* is spawned headless, its output/result captured,
  verification executed, state advanced automatically, human gates only where policy
  says so.

The interactive pty can't back the orchestrated mode (no completion signal, no
result). Orchestrated runs need the agent CLIs' **non-interactive / print modes**
(e.g. `claude -p`) so output is a captured artifact, not a scrollback stream.

## New building blocks

1. **`runs` table** — durable record of an agent run: `actionItemId`, `agentId`,
   `worktreePath`, `branch`, `status` (queued/running/verifying/review/done/failed),
   `iterations`, captured logs, result (diff/PR). Makes runs survive restarts and
   gives the UI something to show. (The current in-memory `sessions` map is lost on
   restart — fine for attended, not for orchestrated.)
2. **Headless runner** — spawn the agent in print/non-interactive mode in a worktree,
   capture stdout + exit, know when it's *done*. Reuses `createSessionWorktree` and
   `effectiveAgentCommand`.
3. **Verification stage** — run the repo's own `test` / `lint` / `build` in the
   worktree, capture pass/fail. This is what makes it SDLC vs. a PR spammer.
4. **Bounded self-heal** — on verification failure, feed the failure back to the agent,
   re-run, cap at N iterations, then escalate to the human. (Mirrors the "drive a PR to
   green" posture, applied locally.)
5. **Autonomy policy (per project)** — a dial, not a default: `suggest only` →
   `implement + open draft PR` → `verify + PR` → `auto-merge on green`. This is what
   the word "fully" should mean — configurable, not unconditional.
6. **Orchestrator** — extend the existing auto-sync scheduler (`lib/auto-sync-scheduler.ts`)
   from "sweep stale repos" into "also pick up approved action items and advance their
   runs through the state machine."
7. **MCP loop tools** — add `sync_project`, `create_action_item`, `start_run`,
   `get_run` so an agent (or external driver) can operate the loop programmatically
   (proposal E in `extension-proposals.md`).

## Architecture options

**Option 1 — In-process orchestration (recommended start).**
Keep everything in the Node server; add the `runs` table + headless runner + verification,
drive the state machine from the scheduler. Matches the local-first ethos, lowest friction.
Limit: a crash mid-run needs the `runs` table + a resume pass to recover.

**Option 2 — Durable SQLite-backed job queue + worker.**
Same as 1 but runs go through a persisted queue with retries and a resume-on-boot worker.
More robust concurrency and crash-recovery; moderate added complexity. Natural evolution of 1.

**Option 3 — Delegate execution to CI (GitHub Actions / hosted runner).**
Most robust, but breaks the "runs on your machine, token never leaves the server" model
that is core to GitPulse's security posture. Only if the product intentionally moves
off local-first.

Recommendation: **1 → 2**, staying local-first. Option 3 is a different product.

## Honest constraints

- **Verification is non-negotiable.** Without stage 5 + gates, an autonomous loop just
  emits unreviewed PRs. The verification + policy dial are what make this a *platform*
  rather than a prompt launcher.
- **"Fully autonomous" should ship as "supervised autopilot" first** — human approves
  the gates (task → run, run → PR, PR → merge); tighten the dial per project as trust builds.
- **Single-user, local scope still holds.** This is autonomy over *your own* pinned
  repos on *your* machine — not a multi-tenant CI SaaS. That constraint is a feature.
- **Concurrency/resource limits** — headless runs are heavier than a sparkline; cap
  concurrent runs, reuse the worktree machinery, keep the 10-per-sweep discipline.

## Suggested incremental path

1. **`runs` table + headless runner** for a single action item (attended trigger, "Run this item"). Capture result, show it.
2. **Verification stage** — run repo test/lint/build in the worktree, surface pass/fail on the run.
3. **Draft PR from a green run** — wire the existing `openDraftPullRequest` to a passing run.
4. **Bounded self-heal loop** on verification failure.
5. **Autonomy policy dial** per project + orchestrator pickup of approved items.
6. **MCP loop tools** so it's drivable programmatically.
7. **Auto-merge on green** (highest autonomy) behind the policy dial.

Each step is independently useful and shippable; the loop is "operating" by step 5.
