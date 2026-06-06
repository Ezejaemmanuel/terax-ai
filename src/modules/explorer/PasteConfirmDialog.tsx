import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** An external (OS-clipboard) paste awaiting the user's confirmation. */
export type PendingOsPaste = {
  /** Directory the items will be copied into. */
  targetDir: string;
  /** Absolute source paths read from the OS clipboard. */
  sources: string[];
};

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

type Props = {
  pending: PendingOsPaste | null;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Confirms pasting files/folders that were copied outside the app (Explorer,
 * Finder, …). External paste is the one place we ask first — it's easy to land
 * unexpected files into the wrong folder.
 */
export function PasteConfirmDialog({ pending, onConfirm, onCancel }: Props) {
  const open = pending !== null;
  const sources = pending?.sources ?? [];
  const count = sources.length;
  const targetName = pending ? baseName(pending.targetDir) : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {count === 1 ? `Paste “${baseName(sources[0])}”?` : `Paste ${count} items?`}
          </DialogTitle>
          <DialogDescription>
            {count === 1 ? "This item" : "These items"} will be copied into{" "}
            <span className="font-medium text-foreground">{targetName}</span>.
          </DialogDescription>
        </DialogHeader>

        {count > 1 && (
          <ul className="max-h-48 overflow-y-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[12px]">
            {sources.map((s) => (
              <li key={s} className="truncate py-0.5">
                {baseName(s)}
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm}>
            Paste
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
