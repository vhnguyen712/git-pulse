import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

const DATA_DIR = path.join(process.cwd(), ".gitpulse");
const DB_PATH = path.join(DATA_DIR, "data.db");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Reuse a single connection across hot-reloads in dev (Next.js dev server
// re-evaluates modules on change; a fresh better-sqlite3 handle per reload
// would leak file descriptors).
declare global {
  var __gitpulseSqlite: Database.Database | undefined;
}

function getSqlite(): Database.Database {
  if (globalThis.__gitpulseSqlite) return globalThis.__gitpulseSqlite;

  ensureDataDir();
  const sqlite = new Database(DB_PATH);
  // Must be set before any other pragma/query — Next's build spawns several
  // worker processes that each import this module (and race to run
  // migrations below) — without a busy timeout in place first, even the
  // journal_mode switch below can itself throw SQLITE_BUSY instead of
  // waiting the ~10ms it actually takes for the winner's transaction to commit.
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  if (process.env.NODE_ENV !== "production") {
    globalThis.__gitpulseSqlite = sqlite;
  }
  return sqlite;
}

export const db = drizzle(getSqlite(), { schema });

// Auto-migrate on startup so a fresh clone works with just
// `npm install && npm run dev` — no separate migrate step for the
// single local user to remember.
declare global {
  var __gitpulseMigrated: boolean | undefined;
}

if (!globalThis.__gitpulseMigrated) {
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  globalThis.__gitpulseMigrated = true;
}
