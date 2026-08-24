"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Project } from "@/lib/db/schema";

interface TerminalSession {
  project: Project;
  prompt: string;
}

interface TerminalContextValue {
  session: TerminalSession | null;
  height: number;
  openTerminal: (project: Project, prompt: string) => void;
  closeTerminal: () => void;
  updateProject: (project: Project) => void;
  setHeight: (height: number) => void;
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

export const TERMINAL_MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 320;
const MAX_HEIGHT_RATIO = 0.85;

/**
 * Holds the embedded terminal's session (which project/prompt, if any) and
 * its user-adjusted height at the app-shell level — outside the `{children}`
 * that Next.js swaps on navigation — so the terminal (and its live WebSocket
 * connection) survives moving between pages instead of unmounting.
 */
export function TerminalProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [height, setHeightState] = useState(DEFAULT_HEIGHT);

  const openTerminal = useCallback((project: Project, prompt: string) => {
    setSession({ project, prompt });
  }, []);

  const closeTerminal = useCallback(() => setSession(null), []);

  const updateProject = useCallback((project: Project) => {
    setSession((s) => (s ? { ...s, project } : s));
  }, []);

  const setHeight = useCallback((next: number) => {
    const max = typeof window !== "undefined" ? window.innerHeight * MAX_HEIGHT_RATIO : 800;
    setHeightState(Math.min(Math.max(next, TERMINAL_MIN_HEIGHT), max));
  }, []);

  const value = useMemo(
    () => ({ session, height, openTerminal, closeTerminal, updateProject, setHeight }),
    [session, height, openTerminal, closeTerminal, updateProject, setHeight],
  );

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminal() {
  const ctx = useContext(TerminalContext);
  if (!ctx) throw new Error("useTerminal must be used within a TerminalProvider");
  return ctx;
}
