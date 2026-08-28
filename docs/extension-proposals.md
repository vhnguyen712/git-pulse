# GitPulse — Extension Proposals (backlog)

> Stored for later implementation. These are candidate features analyzed against
> the codebase as of branch `claude/app-extension-approaches-gpxw1v`. Each is
> scoped to reuse machinery that already exists rather than adding new
> infrastructure. Ordered roughly by leverage-to-effort.

## Context: what already exists

- **Sync engine** (`lib/sync.ts`) — Compare-API commit range → cached LLM
  analysis keyed by `(project, baseSha, headSha)`.
- **Action items** (`lib/action-items.ts`, `issues.ts`, `pulls.ts`) —
  next_step / brainstorm / todo → GitHub Issue, draft PR, PR lifecycle reconcile.
- **Living overview** (`projectOverviews`) — README-style doc re-synthesized each sync.
- **Portfolio / health** (`lib/portfolio.ts`) — 0–100 momentum score, "going cold" ranking, token/cost rollups.
- **Automation** — in-app scheduler + `POST /api/cron/sync`.
- **Embedded terminal** (`lib/terminal/*`) — launches Claude Code / Codex / Antigravity CLIs in per-session git worktrees.
- **MCP server** (`lib/mcp/register.ts`) — stdio + HTTP, 6 tools.
- **TODO scanner** (`lib/todo-scan.ts`) — inline TODO/FIXME → action items.

## Identified gaps

1. The app *observes* "going cold" but never *reaches out* — no digest/notification.
2. Rich history (`aiSummaries` token usage + timestamps) is captured but only shown as a sparkline.
3. No cross-summary memory or search over what the LLM has concluded.
4. Action items are append-only — nothing re-checks whether a next-step got shipped.
5. MCP surface is read + publish only — an agent can't drive the loop (no `sync_project`, `create_action_item`).

## Proposals

### A — Proactive digests / notifications  *(recommended; medium effort)*
Reuse the stale-sweep + `computeRepoHealth` to emit a periodic digest ("3 projects
going cold, 12 open suggestions") over a pluggable channel (email / Slack / webhook),
mirroring the "any OpenAI-compatible URL you configure" pattern. The scheduler is the
heartbeat; this is a delivery adapter + a `notifications` settings block. Closes gap #1
— the feature the tagline implies but doesn't deliver.

### B — Portfolio analytics view  *(high visible payoff; low–medium effort)*
Charts over already-persisted data: commits/week, action-item funnel
(suggested→shipped), token spend over time, per-project health trajectory. Reuses
`components/charts/*` and the `costPerMillion*` settings. Mostly querying + composition,
no new external calls. Closes gap #2.

### C — Action-item lifecycle intelligence  *(closes the loop; medium effort)*
On each sync, have the LLM cross-check open action items against new commits and
auto-transition ones that appear shipped (or flag stale ones). Turns the backlog from
append-only into self-maintaining. Closes gap #4.

### D — Semantic / cross-project search  *(highest ceiling; higher effort)*
Embed summaries + overviews for "search everything GitPulse ever concluded." Needs an
embedding store (SQLite can hold vectors). Closes gap #3.

### E — Deepen the MCP surface  *(smallest effort; high value)*
Add `sync_project`, `create_action_item`, `get_project_overview` so an agent in the
embedded terminal can run the full observe→plan→publish loop. Pure additive registration
in `lib/mcp/register.ts`. Closes gap #5 and is a prerequisite for the loop-SDLC direction
(see `docs/loop-sdlc-analysis.md`).

## Recommendation

Build **A** first (delivers on the core promise, reuses existing machinery). **E** is the
cheapest complementary add and unlocks the autonomous direction.
