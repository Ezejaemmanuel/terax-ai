import { formatBytes, type BlockChunks } from "@/remote/lib/useBlockChunks";

/// Footer for a block the page had to clamp. "truncated for transport" used to
/// be the end of the road; it is now a control that pulls the next range
/// straight from the source transcript, so nothing in a session is unreachable
/// from a phone — it just arrives in bounded steps.
export function ExpandTail({ state }: { state: BlockChunks }) {
  if (state.complete && !state.error) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
      <button
        type="button"
        onClick={state.loadMore}
        disabled={state.loading}
        className="rounded border border-border px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
      >
        {state.loading
          ? "loading…"
          : `show more · ${formatBytes(state.remaining)} left`}
      </button>
      {state.error && (
        <span className="text-destructive">{state.error}</span>
      )}
    </div>
  );
}
