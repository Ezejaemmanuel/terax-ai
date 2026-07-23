import { Component, type ReactNode } from "react";

/// A local boundary rather than the app's shared one: the shared boundary logs
/// through a Tauri invoke, which does not exist in a plain browser.
export class RemoteErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("remote view crashed:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium">Something broke rendering this.</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          {this.state.error.message}
        </p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="rounded-md border border-border px-3 py-1.5 text-xs"
        >
          Try again
        </button>
      </div>
    );
  }
}
