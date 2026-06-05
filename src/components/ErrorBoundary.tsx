import { Component, type ErrorInfo, type ReactNode } from "react";

import { uiLog } from "@/lib/uiLog";

type Props = {
  /** Short label identifying the wrapped area, used in logs and the fallback. */
  label?: string;
  children: ReactNode;
  /** Optional custom fallback; receives the error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = { error: Error | null };

/**
 * Catches render-time errors in its subtree and shows a recoverable fallback
 * instead of unmounting the whole window to a blank screen. Every caught error
 * is written to terax.log (via uiLog) so failures are debuggable after release.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const where = this.props.label ? ` in ${this.props.label}` : "";
    uiLog(
      "error",
      `React render error${where}: ${error.message}\n` +
        `${error.stack ?? ""}\n--- component stack ---${info.componentStack ?? ""}`,
    );
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    const area = this.props.label ? `The ${this.props.label} view` : "This view";
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-5 text-[12px]">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-semibold text-destructive">
            Something went wrong
          </span>
          <span className="text-muted-foreground">
            {area} hit an error. It’s been logged to terax.log.
          </span>
        </div>
        <pre className="max-w-full overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[10.5px] whitespace-pre-wrap text-destructive/80">
          {error.message}
        </pre>
        <button
          type="button"
          onClick={this.reset}
          className="rounded-md border border-border/60 px-2.5 py-1 text-[11.5px] transition-colors hover:bg-accent/50"
        >
          Try again
        </button>
      </div>
    );
  }
}
