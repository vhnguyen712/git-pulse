# M0 Spike — Claude Code Structured Streaming (verified against a real install)

> Status: **done for Claude Code**, run against a real installed CLI
> (v2.1.250) with live API calls. Codex and Antigravity remain unverified —
> `lib/runs/adapters/codex.ts` and `adapters/antigravity.ts` are still
> best-effort per their own doc comments. This document records what was
> actually observed, what in the shipped adapter was wrong, what was fixed,
> and what's still an open question.

## Method

1. `claude --help` — read every flag relevant to non-interactive/structured
   output, budget, and permission control.
2. `claude -p "Reply with exactly the word: pong" --output-format stream-json --verbose`
   in a scratch git repo — captured the full JSONL transcript for a
   no-tool-call turn.
3. `claude -p "Run the shell command: echo hello-from-tool . Then reply with
   exactly the word: done" --output-format stream-json --verbose` — captured
   the full transcript for a turn with one tool call (two model turns: a
   `tool_use` turn, then a text-reply turn), specifically to settle whether
   usage numbers are incremental or cumulative across turns.
4. Ran GitPulse's **actual** `lib/runs/runner.ts` (via `POST /api/runs`, a
   real booted `server.ts`, and a real SQLite DB) against the real `claude`
   binary in a fresh scratch repo, with the corrected adapter — end to end,
   not a stand-in.

All scratch repos, seeded DB rows, and log files were deleted after each run;
none of this is checked in.

## Confirmed flags

- `-p, --print` — non-interactive, print-and-exit.
- `--output-format stream-json` — one JSON object per line. Requires `--print`.
- `--verbose` — used alongside `stream-json` throughout; not confirmed
  strictly required, but every real transcript here used it.
- `--model <model>` — as assumed.
- `--max-budget-usd <amount>` — **new finding, not in the original design.**
  Claude Code has its own built-in spend cap for print-mode runs. `buildSpawn`
  now passes `config.budgetUsd` straight through via this flag (present in
  `--help`; not yet exercised functionally in this spike — a budget-triggered
  stop was not specifically tested).
- `--permission-mode <mode>` — choices are `acceptEdits | auto |
  bypassPermissions | manual | dontAsk | plan`. **No `--permission-prompt-tool`
  flag exists in this version** — the interception mechanism the original
  design assumed for per-tool gating isn't available as documented. Building
  real gating would mean working out what `manual` actually does in
  non-interactive `-p` mode (there's no human at a terminal to prompt) — not
  attempted here. `supportsGating: false` stays correct.
- `--include-hook-events`, `--forward-subagent-text`,
  `--include-partial-messages` — richer stream content not currently used.
  `--forward-subagent-text` in particular looks like a better mechanism for
  subagent/skill visibility than the `skillFromToolUse` heuristic currently
  in place — worth a follow-up spike.
- `--input-format stream-json` — exists for streamed multi-turn input, but
  building real mid-run injection on top of it wasn't attempted this pass;
  `supportsInjection: false` stays correct.

## Event schema — what's real vs. what the shipped code assumed

The stream carries far more event variety than the original design doc
described. Observed top-level `type`s, in order, for one two-turn run:
`active_goal`, `autocompact_state`, `rate_limit_event`, `system` (×4, varying
`subtype`), `stream_event` (×~10, varying `event.type`), `assistant` (×2),
`user` (×1), `result` (×1).

### Bug found and fixed: usage was read from the wrong event

The shipped adapter (`lib/runs/adapters/claude.ts`) read token usage from
`assistant.message.usage`. **That field is a mid-stream snapshot, not the
turn's final count.** Confirmed directly: turn 1's `assistant` event reported
`output_tokens: 20`; the same turn's `stream_event` with
`event.type === "message_delta"` reported `output_tokens: 80` for the
identical turn. Summing every turn's `message_delta` usage across the
two-turn run matched the terminal `result` event's cumulative `usage` object
exactly, field for field (`input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`) — `message_delta`'s
usage is confirmed **per-turn and incremental**, safe to sum the way
`lib/runs/recorder.ts` already does.

**Fix applied:** `parseLine` no longer emits a `usage` event from `assistant`
messages at all (their `message.usage` is now ignored). It emits `usage` only
from `stream_event` where `event.type === "message_delta"`. Verified against
the real end-to-end run above: `promptTokens`/`completionTokens` on the
finished run summed correctly from the two `message_delta` steps and matched
what a hand-check of the transcript expected.

### Bug found and fixed: noisy duplicate "Session started" steps

`system` events carry a `subtype`, and the shipped adapter ignored it
entirely — every `system` line (there were 4 per run: `commands_changed`,
`init`, `status`, and either `task_summary` or `post_turn_summary`) became a
"Session started" timeline step. Worse, `commands_changed` carries a
multi-kilobyte dump of every loaded skill's full description — that was
being written into `payloadJson` on every single run.

**Fix applied:** only `subtype === "init"` maps to "Session started" now.
`subtype === "post_turn_summary"` maps to a `message` step using its
`status_detail` field — a short, genuinely useful natural-language recap
(`"echo verified-by-gitpulse executed; replied done"` in the real run above).
Everything else (`status`, `commands_changed`, `task_summary`) is dropped.

### Confirmed correct, no change needed

- `tool_use` block shape: `{type, id, name, input, caller:{type:"direct"}}` —
  matches `parseLine`'s `block.name`/`block.input` usage.
- `tool_result` block shape (on a `user` message):
  `{tool_use_id, type:"tool_result", content, is_error}` — matches.
- Terminal `result` detection (`obj.type === "result"`, `obj.is_error`) —
  matches.

### Not verified this pass

- `skillFromToolUse`'s exact field names (`Skill`/`Task` tool_use inputs) —
  neither spike transcript invoked a skill or subagent. Still a documented
  best-effort heuristic in `adapters/claude.ts`.
- Codex's and Antigravity's adapters — no real Codex or Antigravity install
  was available to test against.
- `--max-budget-usd`'s actual runtime behavior when the cap is hit.
- `--permission-mode`'s behavior in non-interactive `-p` mode at all.

## Known gap not fixed this pass: cost estimation

The terminal `result` event carries `total_cost_usd` — Claude Code's own
computed cost, correctly priced per cache tier (fresh input vs. cache write vs.
cache read are billed at different rates) and correctly summed across
sub-model usage (`modelUsage` showed a `claude-haiku-4-5` sub-call priced
separately from the main `claude-sonnet-5` turns in one of the spike runs).

GitPulse's own cost estimate (`lib/runs/cost.ts`) is a flat
`costPerMillionInput/Output` rate applied to a single summed token count. For
Claude Code specifically this will **overestimate cost** whenever caching is
in play — which is effectively always, given the ~35–75K cache-heavy prompt
tokens seen in every spike run here — because cache reads are priced far
below fresh input and the flat rate can't represent that.

**Not fixed in this pass** because it's a real contract change (either
`ParsedEvent` gains an adapter-reported `costUsd` override, or the recorder
learns to prefer it when present), not a same-shape bug fix — it deserves its
own scoped change rather than being bolted on here. Filed as a follow-up: add
an optional authoritative-cost override, sourced from the terminal `result`
event, that the recorder prefers over the token-rate estimate when an adapter
provides one.

## Verification performed

- Adapter unit tests rewritten against the real transcript's actual shapes
  (`lib/runs/adapters.test.ts`) — 139 tests total, all green.
- `npm run lint` / `tsc --noEmit` clean.
- Full production `next build` clean.
- **A complete real run**: `POST /api/runs` against a real booted server, a
  real scratch git repo, and the real `claude` binary (agent `claude`, no
  override) — worktree creation, spawn, two full turns (one with a `Bash`
  tool call), parsing, rollup, and finalization to `done` all executed for
  real. Final `promptTokens: 75287, completionTokens: 87` reconciled exactly
  against the sum of the two recorded `usage` steps; all 8 recorded steps had
  strictly increasing, unique `seq` values; the timeline read cleanly (one
  "Session started", the tool call, its result, the reply, the post-turn
  recap, "Run complete" — no duplicate noise).
