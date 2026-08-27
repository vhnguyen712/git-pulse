# The Observable Run Cockpit (chosen direction)

> **Direction decision.** GitPulse should *not* operate a full autonomous
> loop-engineering SDLC (see `loop-sdlc-analysis.md` for why that was
> considered and set aside). Instead the goal is a **fully controllable,
> dynamic, and observable** agent-run experience — a cockpit + flight recorder —
> where the human stays in control and every run is transparent and steerable
> across the axes that matter: **tokens, cost, step-by-step progress, skills,
> model, tools**.

## The reframing

| Autonomy platform (set aside) | Observable cockpit (chosen) |
|---|---|
| Runs the loop *for* you | You run it; it's instrumented |
| Optimizes for hands-off | Optimizes for **insight + control** |
| Success = green PR with no human | Success = you see & steer every step |
| Gates are a safety brake | Control *is* the product |

## The one technical pivot: raw pty → structured run

Today the embedded terminal streams **raw bytes** over a pty
(`lib/terminal/server.ts`). Raw bytes are a black box: you cannot see token
usage, cost, which step is running, which tool fired, or which skill was
invoked — the information isn't in the stream.

Observability requires the agent's **structured event stream** instead of (or
alongside) raw terminal bytes. The agent CLIs already emit machine-readable
streaming output designed for exactly this:

- **Claude Code** — headless/print mode with a streaming-JSON output format
  emits structured events: assistant/message deltas, `tool_use` / `tool_result`,
  and per-turn **usage** (input/output tokens). It also exposes **hooks**
  (PreToolUse / PostToolUse) and **permission modes** — natural control points.
- **Codex / others** — comparable non-interactive JSON event output.

> Exact flags/schemas should be verified against the installed CLI versions
> before implementation — treat the above as the capability, not a copy-paste.

Capturing that stream is what turns a terminal into an instrument.

## Data model — the flight recorder

Extend the DB with a run + step timeline (the token/cost discipline already used
for `aiSummaries` in `lib/llm.ts`, applied to live agent runs):

- **`runs`** — `id`, `projectId`, `actionItemId?`, `agentId`, `model`,
  `worktreePath`, `branch`, `status` (queued/running/paused/awaiting-approval/
  done/failed/cancelled), `config` (skills enabled, budget caps, gating level),
  totals (`promptTokens`, `completionTokens`, `totalTokens`, `costEstimate`,
  `durationMs`), `createdAt`.
- **`run_steps`** — ordered timeline. `runId`, `seq`, `type`
  (message / tool_use / tool_result / usage / error / gate), `tool?`, `skill?`,
  `title`, `payload` (JSON), `promptTokens?`, `completionTokens?`,
  `costEstimate?`, `durationMs?`, `createdAt`.

Every step is stamped with tokens + cost, so the run is queryable after the
fact: cost per step, cost per tool, cost per skill, cost per run — and
comparable across runs.

## Control plane — "fully controllable + dynamic"

Control points a human operates before and during a run:

- **Pre-run config (dynamic knobs):** model, agent, which skills are enabled,
  token/cost budget cap, gating level, temperature — stored on the run so runs
  are A/B-comparable.
- **Gate each tool** (PreToolUse hook / permission mode): approve, deny, or
  edit before a risky tool executes.
- **Pause / resume / step:** advance one step at a time; hold at any point.
- **Inject guidance:** send a mid-run steering message into the agent.
- **Budget guards:** when a run crosses its token/cost ceiling, auto-pause (or
  stop) instead of silently burning budget.
- **Cancel:** kill the run, keep the worktree + recorded timeline.

The interactive terminal stays as the "attended/manual" escape hatch; the
cockpit is the instrumented default.

## Observability UI — the cockpit

A run view built on `components/charts/*`:

- **Live step timeline** — each step as it happens, with type/tool/skill icon,
  duration, and a token/cost delta.
- **Running meters** — cumulative tokens + estimated cost (using the existing
  `costPerMillionInput/Output` settings), updating live.
- **Attribution breakdowns** — cost & tokens by tool, by skill, by step type;
  which skills fired and how often.
- **Diff preview** — what the run changed in its worktree.
- **Run history & compare** — put two runs side by side (same task, different
  model/skills) and compare cost, steps, outcome.

## Honest constraints

- **Instrumentation depth is bounded by what the CLI emits.** Token/cost/skill
  visibility is only as good as the structured stream; verify per-CLI. Where a
  CLI reports no usage (as some OpenAI-compat proxies already do for GitPulse's
  own calls), the meter degrades to steps/duration, not tokens.
- **Cost is an estimate**, driven by the display-only `costPerMillion*` settings
  — same caveat the app already carries.
- **Two output modes to reconcile:** raw pty (great UX, opaque) vs structured
  stream (observable, less of a "real terminal"). A pragmatic path runs the
  structured stream for the recorder and offers an attached terminal view for
  the human — or renders the timeline as the primary view with raw output on tap.

## Suggested incremental path

1. **`runs` + `run_steps` tables** and a structured-stream runner for **one**
   agent (Claude Code print/stream-json), capturing steps + usage. No control yet.
2. **Cockpit read view** — live timeline + running token/cost meters for a run.
3. **Attribution** — cost/tokens by tool and by skill; run history list.
4. **Budget cap** — pre-run token/cost ceiling that pauses the run.
5. **Gating** — approve/deny tools via hook/permission mode.
6. **Pause / step / inject guidance** controls.
7. **Run compare** — two runs side by side across cost/steps/outcome.

Each step is independently useful; by step 2 you already have observability, by
step 5 you already have real control.
