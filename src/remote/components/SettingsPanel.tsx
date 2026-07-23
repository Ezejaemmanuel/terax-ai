import { useRemotePrefs } from "@/remote/lib/prefs";

export function SettingsPanel() {
  const {
    accordionsOpen,
    setAccordionsOpen,
    theme,
    setTheme,
  } = useRemotePrefs();

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b border-border px-3 py-2">
        <h2 className="text-[12px] font-medium">Settings</h2>
        <p className="text-[10.5px] text-muted-foreground">
          Preferences for this device only.
        </p>
      </div>
      <div className="flex flex-col gap-1 p-2">
        <label className="flex cursor-pointer items-start justify-between gap-3 rounded-md px-2.5 py-2.5 hover:bg-muted/50">
          <span className="min-w-0">
            <span className="block text-[13px] font-medium">
              Accordions open by default
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
              Thinking, tool calls, and results start expanded instead of
              collapsed.
            </span>
          </span>
          <input
            type="checkbox"
            checked={accordionsOpen}
            onChange={(e) => setAccordionsOpen(e.target.checked)}
            className="mt-1 size-4 shrink-0 accent-foreground"
          />
        </label>

        <div className="flex items-start justify-between gap-3 rounded-md px-2.5 py-2.5">
          <span className="min-w-0">
            <span className="block text-[13px] font-medium">Theme</span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              Appearance for the remote viewer.
            </span>
          </span>
          <div className="flex shrink-0 gap-1">
            {(["light", "dark"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                className={
                  theme === value
                    ? "rounded-md border border-border bg-muted px-2.5 py-1 text-[11px] font-medium"
                    : "rounded-md border border-transparent px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted/50"
                }
              >
                {value === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
