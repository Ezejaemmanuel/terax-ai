import { Button } from "@/components/ui/button";
import { useBroadcastStore } from "@/modules/broadcast/useBroadcastStore";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { Wifi01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";

/// Always visible while broadcasting: the window is readable from the network,
/// and that should never be something you can forget about.
export function BroadcastIndicator() {
  const info = useBroadcastStore((s) => s.info);
  const init = useBroadcastStore((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  if (!info) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 gap-1 rounded-md px-2 text-[11px] font-medium text-chart-2 hover:bg-chart-2/10"
      onClick={() => void openSettingsWindow("broadcast")}
      title={`Broadcasting on port ${info.port}, click to manage`}
    >
      <HugeiconsIcon icon={Wifi01Icon} size={13} strokeWidth={2} />
      Live
    </Button>
  );
}
