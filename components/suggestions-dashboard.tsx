"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, LayoutGrid, List } from "lucide-react";
import type { ActionItem } from "@/lib/db/schema";
import type { SuggestionsData } from "@/lib/suggestions";
import { ActionItemCard } from "@/components/action-item-card";
import {
  StatusBadge,
  toneFromCategory,
  toneFromPriority,
  toneFromStatus,
} from "@/components/status-badge";
import { useTerminal } from "@/components/terminal-context";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

type ViewMode = "board" | "list";
type DatePreset = "all" | "yesterday" | "last_week" | "last_month" | "custom";

const DAY_MS = 24 * 60 * 60 * 1000;

const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: "all", label: "Any time" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last_week", label: "Last 7 days" },
  { key: "last_month", label: "Last 30 days" },
  { key: "custom", label: "Custom range" },
];

type DateRange = { from: number | null; to: number | null } | null;

/**
 * Resolves a date preset to concrete epoch-ms bounds. Reads the system clock
 * (Date.now), so this is only ever called from event handlers — never from
 * render or a memo — and its result is stored directly in state.
 */
function computeDateRange(preset: DatePreset, customFrom: string, customTo: string): DateRange {
  if (preset === "all") return null;
  if (preset === "custom") {
    return {
      from: customFrom ? new Date(`${customFrom}T00:00:00`).getTime() : null,
      to: customTo ? new Date(`${customTo}T23:59:59.999`).getTime() : null,
    };
  }
  const now = Date.now();
  if (preset === "yesterday") {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    return { from: startOfToday.getTime() - DAY_MS, to: startOfToday.getTime() };
  }
  if (preset === "last_week") return { from: now - 7 * DAY_MS, to: now };
  return { from: now - 30 * DAY_MS, to: now }; // last_month
}

const STATUS_COLUMNS: { key: ActionItem["status"]; title: string }[] = [
  { key: "suggested", title: "Suggested" },
  { key: "approved", title: "Approved" },
  { key: "synced", title: "Synced" },
  { key: "shipped", title: "Shipped" },
  { key: "dismissed", title: "Dismissed" },
];

export function SuggestionsDashboard({ initial }: { initial: SuggestionsData }) {
  const router = useRouter();
  const { openTerminal } = useTerminal();

  const [items, setItems] = useState<ActionItem[]>(initial.items);
  const [view, setView] = useState<ViewMode>("board");
  const [repoFilter, setRepoFilter] = useState<string>("all");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");
  const [dateRange, setDateRange] = useState<DateRange>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  function handleDatePresetChange(preset: DatePreset) {
    setDatePreset(preset);
    setDateRange(computeDateRange(preset, customFrom, customTo));
  }
  function handleCustomFromChange(value: string) {
    setCustomFrom(value);
    setDateRange(computeDateRange("custom", value, customTo));
  }
  function handleCustomToChange(value: string) {
    setCustomTo(value);
    setDateRange(computeDateRange("custom", customFrom, value));
  }
  const filtersActive = repoFilter !== "all" || datePreset !== "all";
  function handleClearFilters() {
    setRepoFilter("all");
    handleDatePresetChange("all");
  }

  const [pushingId, setPushingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [pushErrors, setPushErrors] = useState<Record<string, string>>({});

  const projectsById = useMemo(
    () => new Map(initial.projects.map((p) => [p.id, p])),
    [initial.projects],
  );

  const filteredItems = items.filter((i) => {
    if (repoFilter !== "all" && i.projectId !== repoFilter) return false;
    if (dateRange) {
      if (dateRange.from != null && i.createdAt < dateRange.from) return false;
      if (dateRange.to != null && i.createdAt > dateRange.to) return false;
    }
    return true;
  });

  function handleOpenTerminal(
    projectId: string,
    prompt: string,
    title: string,
    agentId?: string,
    startRef?: string,
  ) {
    const project = projectsById.get(projectId);
    if (project) openTerminal(project, prompt, title, agentId, startRef);
  }

  async function handlePush(item: ActionItem) {
    setPushingId(item.id);
    setPushErrors((e) => ({ ...e, [item.id]: "" }));
    try {
      const res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionItemId: item.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPushErrors((e) => ({ ...e, [item.id]: body.error ?? "Failed to create issue." }));
        return;
      }
      setItems((prev) => prev.map((i) => (i.id === item.id ? body.actionItem : i)));
    } catch {
      setPushErrors((e) => ({ ...e, [item.id]: "Network error." }));
    } finally {
      setPushingId(null);
    }
  }

  async function handleRemove(item: ActionItem) {
    setRemovingId(item.id);
    try {
      const res = await fetch("/api/action-items", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionItemId: item.id }),
      });
      if (!res.ok) return;
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      router.refresh();
    } finally {
      setRemovingId(null);
    }
  }

  const selectedItem = selectedId ? (items.find((i) => i.id === selectedId) ?? null) : null;
  const selectedProject = selectedItem ? projectsById.get(selectedItem.projectId) : undefined;

  // Board columns can overflow horizontally past the viewport — these track
  // whether there's more content off-screen so a fade hint can be shown.
  const boardScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  function updateBoardScrollState() {
    const el = boardScrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  }
  useEffect(() => {
    updateBoardScrollState();
    window.addEventListener("resize", updateBoardScrollState);
    return () => window.removeEventListener("resize", updateBoardScrollState);
  }, [filteredItems.length, view]);

  /** Row: title plus scannable priority/category/repo/age — click opens the full card in a dialog. */
  function renderRow(item: ActionItem, variant: "board" | "list" = "board") {
    const project = projectsById.get(item.projectId);
    const badges = (
      <>
        {item.priority && (
          <StatusBadge tone={toneFromPriority(item.priority)}>{item.priority}</StatusBadge>
        )}
        {item.category && (
          <StatusBadge tone={toneFromCategory(item.category)}>{item.category}</StatusBadge>
        )}
      </>
    );
    const attribution = (
      <>
        {project && (
          <span className="truncate">
            {project.owner}/{project.repoName}
          </span>
        )}
        <span className="shrink-0">{timeAgo(item.createdAt)}</span>
      </>
    );

    if (variant === "list") {
      return (
        <button
          key={item.id}
          onClick={() => setSelectedId(item.id)}
          className="flex items-center justify-between gap-3 rounded-lg border border-outline-variant bg-surface p-3 text-left transition-colors hover:border-outline"
        >
          <h4 className="min-w-0 truncate text-sm font-medium text-on-surface">{item.title}</h4>
          <div className="flex shrink-0 items-center gap-3">
            <div className="flex items-center gap-1.5">{badges}</div>
            <div className="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
              {attribution}
            </div>
            <ChevronRight className="size-3.5 shrink-0 text-on-surface-variant" />
          </div>
        </button>
      );
    }

    return (
      <button
        key={item.id}
        onClick={() => setSelectedId(item.id)}
        className="flex flex-col gap-1 rounded-lg border border-outline-variant bg-surface p-3 text-left transition-colors hover:border-outline"
      >
        <div className="flex items-center justify-between gap-2">
          <h4 className="truncate text-sm font-medium text-on-surface">{item.title}</h4>
          <ChevronRight className="size-3.5 shrink-0 text-on-surface-variant" />
        </div>
        {(item.priority || item.category) && (
          <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
        )}
        <div className="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
          {attribution}
        </div>
      </button>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={repoFilter}
            onChange={(e) => setRepoFilter(e.target.value)}
            className="rounded-md border border-outline-variant bg-surface-container-low px-2.5 py-1.5 text-xs text-on-surface"
          >
            <option value="all">All repos</option>
            {initial.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.owner}/{p.repoName}
              </option>
            ))}
          </select>

          <select
            value={datePreset}
            onChange={(e) => handleDatePresetChange(e.target.value as DatePreset)}
            className="rounded-md border border-outline-variant bg-surface-container-low px-2.5 py-1.5 text-xs text-on-surface"
          >
            {DATE_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>

          {datePreset === "custom" && (
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => handleCustomFromChange(e.target.value)}
                max={customTo || undefined}
                className="rounded-md border border-outline-variant bg-surface-container-low px-2 py-1.5 text-xs text-on-surface"
              />
              <span className="text-xs text-on-surface-variant">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => handleCustomToChange(e.target.value)}
                min={customFrom || undefined}
                className="rounded-md border border-outline-variant bg-surface-container-low px-2 py-1.5 text-xs text-on-surface"
              />
            </div>
          )}

          {filtersActive && (
            <button
              onClick={handleClearFilters}
              className="rounded-md border border-outline-variant px-2.5 py-1.5 text-xs text-on-surface-variant transition-colors hover:bg-white/5 hover:text-on-surface"
            >
              Clear filters
            </button>
          )}
        </div>

        <div className="flex items-center gap-0.5 rounded-md border border-outline-variant p-0.5">
          <button
            onClick={() => setView("board")}
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-xs",
              view === "board"
                ? "bg-surface-container text-on-surface"
                : "text-on-surface-variant hover:text-on-surface",
            )}
          >
            <LayoutGrid className="size-3.5" />
            Board
          </button>
          <button
            onClick={() => setView("list")}
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-xs",
              view === "list"
                ? "bg-surface-container text-on-surface"
                : "text-on-surface-variant hover:text-on-surface",
            )}
          >
            <List className="size-3.5" />
            List
          </button>
        </div>
      </div>

      {filteredItems.length === 0 ? (
        <p className="text-xs text-on-surface-variant">
          {items.length === 0
            ? "No suggestions yet. Sync a repo to generate some."
            : "No suggestions match the current filters."}
        </p>
      ) : view === "board" ? (
        <div className="relative flex-1 overflow-hidden">
          {canScrollLeft && (
            <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-surface to-transparent" />
          )}
          {canScrollRight && (
            <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-surface to-transparent" />
          )}
          <div
            ref={boardScrollRef}
            onScroll={updateBoardScrollState}
            className="scroll-fade flex h-full gap-3 overflow-x-auto pb-2"
          >
            {STATUS_COLUMNS.map((col) => {
              const colItems = filteredItems.filter((i) => i.status === col.key);
              return (
                <div
                  key={col.key}
                  className={cn(
                    "flex min-w-64 flex-1 flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-2",
                    col.key === "dismissed" && "opacity-70",
                  )}
                >
                  <div className="flex items-center justify-between px-1 py-0.5">
                    <StatusBadge tone={toneFromStatus(col.key)}>{col.title}</StatusBadge>
                    <span className="text-[11px] text-on-surface-variant">{colItems.length}</span>
                  </div>
                  <div className="scroll-fade flex flex-1 flex-col gap-2 overflow-y-auto">
                    {colItems.length === 0 ? (
                      <p className="flex flex-1 items-center justify-center text-center text-[11px] text-on-surface-variant">
                        No items
                      </p>
                    ) : (
                      colItems.map((item) => renderRow(item))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="scroll-fade flex flex-col gap-2 overflow-y-auto">
          {filteredItems.map((item) => renderRow(item, "list"))}
        </div>
      )}

      <Dialog open={selectedItem !== null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <DialogContent className="max-w-lg">
          {selectedItem && (
            <>
              <DialogTitle className="sr-only">{selectedItem.title}</DialogTitle>
              {selectedProject && (
                <p className="mb-2 text-[11px] font-medium text-on-surface-variant">
                  {selectedProject.owner}/{selectedProject.repoName}
                </p>
              )}
              <ActionItemCard
                item={selectedItem}
                pushing={pushingId === selectedItem.id}
                error={pushErrors[selectedItem.id]}
                baseBranch={selectedProject?.defaultBranch ?? "main"}
                onPush={() => handlePush(selectedItem)}
                onOpenTerminal={(prompt, title, agentId, startRef) =>
                  handleOpenTerminal(selectedItem.projectId, prompt, title, agentId, startRef)
                }
                onRemove={() => handleRemove(selectedItem)}
                removing={removingId === selectedItem.id}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
