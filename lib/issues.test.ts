import { describe, it, expect, vi, beforeEach } from "vitest";

const { findFirstActionItem, findFirstProject, returningMock, updateMock, createIssueMock } =
  vi.hoisted(() => ({
    findFirstActionItem: vi.fn(),
    findFirstProject: vi.fn(),
    returningMock: vi.fn(),
    updateMock: vi.fn(),
    createIssueMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      actionItems: { findFirst: findFirstActionItem },
      projects: { findFirst: findFirstProject },
    },
    update: updateMock,
  },
}));

vi.mock("@/lib/github", () => ({
  createIssue: createIssueMock,
}));

// Import after the mocks above so `db` and `createIssue` resolve to the mocks.
const { publishActionItem } = await import("./issues");

const BASE_ITEM = {
  id: "item-1",
  projectId: "proj-1",
  status: "suggested" as const,
  title: "Add tests",
  description: "Some description",
  source: "next_step" as const,
};

const PROJECT = { id: "proj-1", owner: "acme", repoName: "widgets" };

beforeEach(() => {
  vi.clearAllMocks();
  // Chainable db.update(...).set(...).where(...).returning()
  updateMock.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: returningMock }),
    }),
  });
});

describe("publishActionItem", () => {
  it("returns not_found when the action item doesn't exist", async () => {
    findFirstActionItem.mockResolvedValue(undefined);

    const result = await publishActionItem("missing");

    expect(result).toEqual({
      ok: false,
      code: "not_found",
      message: "Action item not found.",
    });
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("is idempotent: an already-synced item is returned as-is without filing a duplicate issue", async () => {
    const synced = { ...BASE_ITEM, status: "synced" as const, githubIssueNumber: 42 };
    findFirstActionItem.mockResolvedValue(synced);

    const result = await publishActionItem("item-1");

    expect(result).toEqual({ ok: true, actionItem: synced, created: false });
    expect(createIssueMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects a dismissed item", async () => {
    findFirstActionItem.mockResolvedValue({ ...BASE_ITEM, status: "dismissed" as const });

    const result = await publishActionItem("item-1");

    expect(result).toEqual({
      ok: false,
      code: "dismissed",
      message: "This item was dismissed and can't be pushed.",
    });
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("returns no_project when the item's project is missing", async () => {
    findFirstActionItem.mockResolvedValue(BASE_ITEM);
    findFirstProject.mockResolvedValue(undefined);

    const result = await publishActionItem("item-1");

    expect(result).toEqual({
      ok: false,
      code: "no_project",
      message: "Project not found.",
    });
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it("creates a GitHub issue and marks the item synced", async () => {
    findFirstActionItem.mockResolvedValue(BASE_ITEM);
    findFirstProject.mockResolvedValue(PROJECT);
    createIssueMock.mockResolvedValue({ number: 7, htmlUrl: "https://github.com/acme/widgets/issues/7" });
    const updated = {
      ...BASE_ITEM,
      status: "synced",
      githubIssueNumber: 7,
      githubIssueUrl: "https://github.com/acme/widgets/issues/7",
    };
    returningMock.mockResolvedValue([updated]);

    const result = await publishActionItem("item-1");

    expect(createIssueMock).toHaveBeenCalledWith(
      "acme",
      "widgets",
      "Add tests",
      expect.stringContaining("Some description"),
    );
    expect(result).toEqual({ ok: true, actionItem: updated, created: true });
  });
});
