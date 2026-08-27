# GitPulse AI

A self-hosted, single-user dashboard that turns your GitHub commit history
into a progress summary, a prioritized next-step plan, and issue-ready ideas
— so you stop losing context on side-projects you haven't touched in weeks.

Point it at a repo, click **Sync now**, and it will:

1. Pull the commits since your last sync (via GitHub's Compare API).
2. Ask an LLM to summarize what was built, suggest next steps, and brainstorm
   improvements — returned as validated, structured JSON.
3. Let you push any suggestion straight to a GitHub Issue with one click.

Everything runs locally. See [Security & Your Token](#security--your-token)
before you connect a real account.

## Getting started

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) — it'll prompt you to
[Settings](http://127.0.0.1:3000/settings) to enter your GitHub token and LLM
credentials. The SQLite database is created automatically at
`.gitpulse/data.db` on first run (migrations apply themselves — no separate
step needed).

### Configuration

Configure everything from the **Settings** page in the UI — values are saved
to the local SQLite DB and take effect immediately, no restart needed.

`.env.local` remains supported as a fallback (handy for headless/Docker runs,
or to bake in defaults before first launch); anything set in Settings
overrides it. Copy `.env.example` to `.env.local` if you want to use it:

| Variable       | Notes                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| `GITHUB_TOKEN` | Fine-grained PAT — see scopes below.                                       |
| `LLM_BASE_URL` | Any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, local Ollama…).   |
| `LLM_API_KEY`  | API key for that endpoint.                                                 |
| `LLM_MODEL`    | Model name as expected by that endpoint.                                   |
| `CRON_SECRET`  | Bearer token required by `/api/cron/sync` — see Auto-sync below.           |

## Auto-sync (optional)

Auto-sync re-syncs every pinned project whose repo has been pushed to since
its last sync — the same background job the "Sync now" button runs, just for
all stale repos at once (capped at 10 per run, spaced out to stay under
GitHub's rate limits). There are two ways to run it.

### In-app scheduler (recommended)

The simplest option — no OS scheduler to wire up. In
[Settings](http://127.0.0.1:3000/settings) → **Automation**, tick
**Auto-sync stale projects in the background** and set an interval (minutes;
default 30, floored at 5). While the app is running, it sweeps stale
projects on that interval on its own. Toggling it takes effect immediately —
no restart. (Only active for a persistent process, i.e. `npm run start`; the
dev server skips it.)

### External scheduler (via the cron endpoint)

Alternatively, `POST /api/cron/sync` runs the same sweep, so you can drive it
from an OS scheduler if you prefer to keep the app process free of a timer.

1. Set a **Cron secret** in [Settings](http://127.0.0.1:3000/settings)
   (or `CRON_SECRET` in `.env.local`).
2. On Windows, create a Task Scheduler task that runs periodically (e.g.
   every 30 minutes) while the app is running:

   ```powershell
   powershell -Command "Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/cron/sync -Headers @{Authorization='Bearer <your-cron-secret>'}"
   ```

   Register it non-interactively with `schtasks`:

   ```powershell
   schtasks /Create /SC MINUTE /MO 30 /TN "GitPulse Auto-Sync" /TR "powershell -Command \"Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/cron/sync -Headers @{Authorization='Bearer <your-cron-secret>'}\""
   ```

A request without the correct `Authorization: Bearer <secret>` header gets a
`401`; without any secret configured, a `500` telling you to set one.

## Security & Your Token

This app is designed to run **locally, for one person**. The security model
reflects that — it is not built for multi-tenant or public deployment.

- **Where your token lives:** whether entered via **Settings** or
  `.env.local`, your GitHub token and LLM API key are only ever read by the
  Next.js **server** process. They are never sent to the browser, never
  appear in client-side JavaScript, and never get logged (an outgoing-log
  redactor strips anything that looks like a token or `Authorization`
  header). The Settings page itself is write-only for secrets — after
  saving, the API only ever returns a masked `••••1234` form, never the
  full value, so it can't leak back out through the browser, devtools, or a
  screen share.
- **Where your token does *not* go:** every GitHub and LLM API call happens
  server-side, behind `app/api/**` routes. The browser only ever talks to
  your own local server.
- **What leaves your machine:** requests only go to `api.github.com` and
  whichever LLM base URL you configured. Nothing else.
- **Minimum PAT scopes** (fine-grained token):
  - `Contents: Read-only` — commit history, file diffs, README.
  - `Metadata: Read-only` — repository listing.
  - `Issues: Read & Write` — read open issues, create new ones from AI suggestions.
  - `Pull requests: Read` — only if you view PR data.
- **Local data:** the SQLite database (`.gitpulse/data.db`, which now also
  holds anything saved via Settings) and `.env.local` are both git-ignored.
  If you fork/clone this repo, double check `git status` never shows them
  before you push.
- **Network binding:** the dev server binds to `127.0.0.1` — not exposed to
  your LAN.

If a token is ever compromised, revoke it from
[github.com/settings/tokens](https://github.com/settings/tokens) immediately
— its scope is limited on purpose to cap the blast radius.

## Tech stack

Next.js (App Router) + TypeScript · Tailwind CSS + shadcn/ui · `@octokit/rest`
· OpenAI SDK (custom `baseURL`) · SQLite via Drizzle ORM · Zod validation.

## License

MIT — see [LICENSE](./LICENSE).
