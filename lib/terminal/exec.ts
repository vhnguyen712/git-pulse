import fs from "node:fs";
import path from "node:path";

/**
 * Shared PATH/PATHEXT executable resolution, used by both the interactive
 * embedded terminal (lib/terminal/server.ts, spawning via node-pty) and the
 * instrumented run runner (lib/runs/runner.ts, spawning via node:child_process).
 * Neither spawn API does a shell-style PATH search for a bare command name —
 * confirmed for node-pty by testing: `pty.spawn("claude", ...)` throws "File
 * not found" on Windows even though `claude` resolves fine via `where`/`which`,
 * while the same call with claude's absolute path works. So PATH is searched
 * by hand here, same as a shell would (including PATHEXT on Windows, since
 * `claude` there is `claude.exe`).
 *
 * `command` may itself already be an absolute path (e.g. a Settings override
 * pointing at a non-standard install) — in that case it's used directly rather
 * than searched for on PATH.
 */

const executableCache = new Map<string, string | null>();

export function resolveExecutable(command: string): string | null {
  if (executableCache.has(command)) return executableCache.get(command)!;

  if (path.isAbsolute(command)) {
    const found = isExecutableFile(command) ? command : null;
    executableCache.set(command, found);
    return found;
  }

  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (isExecutableFile(candidate)) {
        executableCache.set(command, candidate);
        return candidate;
      }
    }
  }
  executableCache.set(command, null);
  return null;
}

function isExecutableFile(candidate: string): boolean {
  if (!fs.existsSync(candidate)) return false;
  if (process.platform !== "win32") {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      return false;
    }
  }
  return true;
}
