"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Project } from "@/lib/db/schema";
import { DEFAULT_AGENT_ID } from "@/lib/terminal/agents";

export interface TerminalSession {
  /** Stable client-generated id — also used as the pty sessionId on the server. */
  id: string;
  project: Project;
  prompt: string;
  /** Short label for the tab (e.g. the action item's title). */
  title: string;
  /** Which agent CLI this session runs (see lib/terminal/agents.ts). */
  agentId: string;
  /** When set, the session's worktree checks out this existing branch
   * directly (instead of branching off the base) — used to resume a
   * `gitpulse/<id>` branch, e.g. for conflict resolution. */
  startRef?: string;
}

interface TerminalContextValue {
  sessions: TerminalSession[];
  activeId: string | null;
  height: number;
  openTerminal: (
    project: Project,
    prompt: string,
    title: string,
    agentId?: string,
    startRef?: string,
  ) => void;
  activateSession: (id: string) => void;
  closeSession: (id: string) => void;
  updateProject: (project: Project) => void;
  setHeight: (height: number) => void;
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

export const TERMINAL_MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 320;
const MAX_HEIGHT_RATIO = 0.85;

/**
 * Holds the embedded terminal's open sessions (one `claude` tab each) and its
 * user-adjusted height at the app-shell level — outside the `{children}` that
 * Next.js swaps on navigation — so the terminals (and their live WebSocket
 * connections) survive moving between pages instead of unmounting.
 */
export function TerminalProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [height, setHeightState] = useState(DEFAULT_HEIGHT);

  const openTerminal = useCallback(
    (
      project: Project,
      prompt: string,
      title: string,
      agentId: string = DEFAULT_AGENT_ID,
      startRef?: string,
    ) => {
      // Re-opening the same task with the same agent just refocuses its
      // existing tab rather than spawning a duplicate session for it —
      // opening it with a *different* agent gets its own tab.
      const existing = sessions.find(
        (s) => s.project.id === project.id && s.prompt === prompt && s.agentId === agentId,
      );
      if (existing) {
        setActiveId(existing.id);
        return;
      }
      // Generated outside the setSessions updater (and setActiveId called
      // here rather than inside it) so the updater stays pure — React's
      // Strict Mode double-invokes impure updaters in dev, which previously
      // produced two different session ids and left activeId pointing at
      // the one that didn't make it into state.
      const session: TerminalSession = {
        id: crypto.randomUUID(),
        project,
        prompt,
        title: title.trim() || `${project.owner}/${project.repoName}`,
        agentId,
        startRef,
      };
      setSessions((prev) => [...prev, session]);
      setActiveId(session.id);
    },
    [sessions],
  );

  const activateSession = useCallback((id: string) => setActiveId(id), []);

  const closeSession = useCallback((id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      setActiveId((current) => {
        if (current !== id) return current;
        // Closed the active tab — fall back to the last remaining one.
        return next.length > 0 ? next[next.length - 1].id : null;
      });
      return next;
    });
  }, []);

  const updateProject = useCallback((project: Project) => {
    setSessions((prev) =>
      prev.map((s) => (s.project.id === project.id ? { ...s, project } : s)),
    );
  }, []);

  const setHeight = useCallback((next: number) => {
    const max = typeof window !== "undefined" ? window.innerHeight * MAX_HEIGHT_RATIO : 800;
    setHeightState(Math.min(Math.max(next, TERMINAL_MIN_HEIGHT), max));
  }, []);

  const value = useMemo(
    () => ({
      sessions,
      activeId,
      height,
      openTerminal,
      activateSession,
      closeSession,
      updateProject,
      setHeight,
    }),
    [sessions, activeId, height, openTerminal, activateSession, closeSession, updateProject, setHeight],
  );

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminal() {
  const ctx = useContext(TerminalContext);
  if (!ctx) throw new Error("useTerminal must be used within a TerminalProvider");
  return ctx;
}
