import { getBranchHeadSha, getTree, getBlobText, type TreeEntry } from "@/lib/github";

/** Comment markers we collect, matched as whole uppercase words. */
export const TODO_MARKERS = ["TODO", "FIXME", "HACK", "XXX"] as const;
export type TodoMarker = (typeof TODO_MARKERS)[number];

/** A single marker found in the repo's source. */
export interface TodoFinding {
  file: string;
  line: number;
  marker: TodoMarker;
  /** Trailing text after the marker (trimmed), e.g. "refactor this once the API stabilizes". */
  text: string;
}

/** Caps so one scan can't fetch an unbounded number of blobs / burn GitHub budget. */
const MAX_FILES = 300;
const MAX_FILE_BYTES = 256 * 1024; // skip anything bigger — generated/vendored/minified
/** Cap markers returned so a repo full of TODOs doesn't flood the board. */
const MAX_FINDINGS = 200;

/** Directory segments never worth scanning (dependencies, build output, VCS). */
const IGNORED_DIR_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  "vendor",
  "target",
  ".venv",
  "venv",
  "__pycache__",
]);

/** Extensions we treat as scannable source/text. */
const SCANNABLE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "kts", "scala",
  "c", "h", "cc", "cpp", "hpp", "cs", "swift", "m", "mm",
  "php", "sh", "bash", "zsh", "sql",
  "css", "scss", "sass", "less",
  "html", "vue", "svelte", "astro",
  "yml", "yaml", "toml", "md", "mdx", "txt",
]);

/** Filenames that are lockfiles/generated — skip even if the extension is scannable. */
const IGNORED_FILENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "composer.lock",
  "cargo.lock",
  "poetry.lock",
]);

// One marker at a time, as a whole uppercase word, with any trailing description.
const MARKER_RE = new RegExp(`\\b(${TODO_MARKERS.join("|")})\\b[:\\s-]*(.*)$`);

function isScannable(entry: TreeEntry): boolean {
  if (entry.type !== "blob") return false;
  if (entry.size != null && entry.size > MAX_FILE_BYTES) return false;

  const segments = entry.path.split("/");
  if (segments.some((s) => IGNORED_DIR_SEGMENTS.has(s))) return false;

  const filename = segments[segments.length - 1];
  if (IGNORED_FILENAMES.has(filename.toLowerCase())) return false;

  const dot = filename.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = filename.slice(dot + 1).toLowerCase();
  return SCANNABLE_EXTENSIONS.has(ext);
}

/** Scan one file's text for markers. Exported for unit testing. */
export function scanText(file: string, content: string): TodoFinding[] {
  const findings: TodoFinding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = MARKER_RE.exec(lines[i]);
    if (!match) continue;
    findings.push({
      file,
      line: i + 1,
      marker: match[1] as TodoMarker,
      text: match[2].trim(),
    });
  }
  return findings;
}

export interface TodoScanResult {
  findings: TodoFinding[];
  filesScanned: number;
  /** True when the tree or the findings cap cut the scan short. */
  truncated: boolean;
}

/**
 * Scans a repo branch for inline TODO/FIXME/HACK/XXX markers via GitHub's git
 * tree + blob APIs (no clone). Budgeted: at most MAX_FILES scannable files and
 * MAX_FINDINGS results. Returns findings in file/line order.
 */
export async function scanRepoTodos(
  owner: string,
  repo: string,
  branch: string,
): Promise<TodoScanResult> {
  const headSha = await getBranchHeadSha(owner, repo, branch);
  const tree = await getTree(owner, repo, headSha);

  const scannable = tree.entries.filter(isScannable);
  const capped = scannable.slice(0, MAX_FILES);
  const truncatedFiles = tree.truncated || scannable.length > capped.length;

  const findings: TodoFinding[] = [];
  let truncatedFindings = false;
  for (const entry of capped) {
    if (findings.length >= MAX_FINDINGS) {
      truncatedFindings = true;
      break;
    }
    const content = await getBlobText(owner, repo, entry.sha);
    if (content == null) continue;
    for (const f of scanText(entry.path, content)) {
      if (findings.length >= MAX_FINDINGS) {
        truncatedFindings = true;
        break;
      }
      findings.push(f);
    }
  }

  return {
    findings,
    filesScanned: capped.length,
    truncated: truncatedFiles || truncatedFindings,
  };
}
