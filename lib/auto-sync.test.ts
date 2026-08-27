import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { selectMock, listReposMock, syncProjectMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  listReposMock: vi.fn(),
  syncProjectMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { select: selectMock },
}));

vi.mock("@/lib/github", () => ({
  listRepos: listReposMock,
}));

// isProjectStale is a pure helper; keep the real one, mock only syncProject.
vi.mock("@/lib/sync", async () => {
  const actual = await vi.importActual<typeof import("./sync")>("./sync");
  return { ...actual, syncProject: syncProjectMock };
});

const { runAutoSync, resolveIntervalMinutes, MAX_REPOS_PER_RUN } = await import("./auto-sync");

/** db.select().from() resolves to the given pinned-project rows. */
function mockPinned(rows: unknown[]) {
  selectMock.mockReturnValue({ from: vi.fn().mockResolvedValue(rows) });
}

function project(owner: string, repo: string, lastSyncedAt: number | null) {
  return { owner, repoName: repo, lastSyncedAt };
}

function liveRepo(fullName: string, pushedAt: string | null) {
  return { fullName, pushedAt };
}

beforeEach(() => {
  vi.clearAllMocks();
  syncProjectMock.mockResolvedValue({ upToDate: false });
});

describe("resolveIntervalMinutes", () => {
  it("falls back to the 30-minute default when unset or invalid", () => {
    expect(resolveIntervalMinutes(null)).toBe(30);
    expect(resolveIntervalMinutes(undefined)).toBe(30);
    expect(resolveIntervalMinutes(0)).toBe(30);
    expect(resolveIntervalMinutes(-5)).toBe(30);
    expect(resolveIntervalMinutes(NaN)).toBe(30);
  });

  it("floors anything under 5 minutes to 5", () => {
    expect(resolveIntervalMinutes(1)).toBe(5);
    expect(resolveIntervalMinutes(4)).toBe(5);
  });

  it("honors a valid interval, truncating fractions", () => {
    expect(resolveIntervalMinutes(15)).toBe(15);
    expect(resolveIntervalMinutes(45.9)).toBe(45);
  });
});

describe("runAutoSync", () => {
  // The sweep spaces syncs with a real setTimeout; fake timers let the
  // multi-project cases run instantly instead of waiting seconds each.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Drives runAutoSync to completion, flushing the inter-sync delays. */
  async function sweep() {
    const promise = runAutoSync();
    await vi.runAllTimersAsync();
    return promise;
  }

  it("only syncs projects pushed to since their last sync", async () => {
    mockPinned([
      project("acme", "fresh", Date.parse("2026-01-02T00:00:00Z")), // synced after push → skip
      project("acme", "stale", Date.parse("2026-01-01T00:00:00Z")), // pushed after sync → run
      project("acme", "never", null), // never synced → run
    ]);
    listReposMock.mockResolvedValue([
      liveRepo("acme/fresh", "2026-01-01T00:00:00Z"),
      liveRepo("acme/stale", "2026-01-02T00:00:00Z"),
      liveRepo("acme/never", "2026-01-01T00:00:00Z"),
    ]);

    const result = await sweep();

    expect(result.staleCount).toBe(2);
    expect(result.ranCount).toBe(2);
    const synced = syncProjectMock.mock.calls.map((c) => c[1]);
    expect(synced).toEqual(["stale", "never"]);
  });

  it("skips pinned projects with no matching live repo (renamed/deleted)", async () => {
    mockPinned([project("acme", "gone", null)]);
    listReposMock.mockResolvedValue([liveRepo("acme/other", "2026-01-01T00:00:00Z")]);

    const result = await sweep();

    expect(result.staleCount).toBe(0);
    expect(syncProjectMock).not.toHaveBeenCalled();
  });

  it("caps the sweep at MAX_REPOS_PER_RUN", async () => {
    const many = Array.from({ length: MAX_REPOS_PER_RUN + 5 }, (_, i) =>
      project("acme", `repo-${i}`, null),
    );
    mockPinned(many);
    listReposMock.mockResolvedValue(
      many.map((p) => liveRepo(`acme/${p.repoName}`, "2026-01-01T00:00:00Z")),
    );

    const result = await sweep();

    expect(result.staleCount).toBe(MAX_REPOS_PER_RUN + 5);
    expect(result.ranCount).toBe(MAX_REPOS_PER_RUN);
    expect(syncProjectMock).toHaveBeenCalledTimes(MAX_REPOS_PER_RUN);
  });

  it("reports a per-project failure without aborting the sweep", async () => {
    mockPinned([
      project("acme", "boom", null),
      project("acme", "ok", null),
    ]);
    listReposMock.mockResolvedValue([
      liveRepo("acme/boom", "2026-01-01T00:00:00Z"),
      liveRepo("acme/ok", "2026-01-01T00:00:00Z"),
    ]);
    syncProjectMock
      .mockRejectedValueOnce(new Error("GitHub exploded"))
      .mockResolvedValueOnce({ upToDate: false });

    const result = await sweep();

    expect(result.ranCount).toBe(2);
    expect(result.results[0]).toMatchObject({ repo: "boom", result: "error", error: "GitHub exploded" });
    expect(result.results[1]).toMatchObject({ repo: "ok", result: "synced" });
  });
});
