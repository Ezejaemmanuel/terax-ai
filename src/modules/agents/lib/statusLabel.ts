import type { AgentStatus } from "./types";

/**
 * Single source of truth for how an agent status is presented in the UI —
 * the terminal tab bar and the AI history sidebar both read from here so the
 * wording and colors never drift apart.
 *
 * `pulse` is true only while something is actively in flight (working) or
 * blocking on the user (waiting); a completed turn is steady, not animated.
 */
export type AgentStatusStyle = {
  text: string;
  /** Tailwind background class for the status dot. */
  dot: string;
  /** Tailwind text-color class for the status label. */
  textColor: string;
  pulse: boolean;
};

export function agentStatusStyle(status: AgentStatus): AgentStatusStyle {
  switch (status) {
    case "working":
      return {
        text: "Working…",
        dot: "bg-emerald-500",
        textColor: "text-emerald-500",
        pulse: true,
      };
    case "waiting":
      return {
        text: "Awaiting input",
        dot: "bg-amber-400",
        textColor: "text-amber-500",
        pulse: true,
      };
    case "completed":
      return {
        text: "Completed",
        dot: "bg-sky-400",
        textColor: "text-sky-500",
        pulse: false,
      };
  }
}
