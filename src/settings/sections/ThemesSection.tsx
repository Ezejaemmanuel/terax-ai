import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import {
  deleteCustomEditorTheme,
  saveCustomEditorTheme,
  type CustomEditorTheme,
} from "@/modules/editor/customEditorThemes";
import { invalidateCustomEditorThemeCache } from "@/modules/editor/lib/themes";
import { parseVsCodeThemeText } from "@/modules/editor/lib/vscodeTheme";
import { useCustomEditorThemesStore } from "@/modules/editor/useCustomEditorThemesStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  EDITOR_THEMES,
  EDITOR_THEME_LABELS,
  setBackgroundBlur,
  setBackgroundImageId,
  setBackgroundKind,
  setBackgroundOpacity,
  setEditorTheme,
} from "@/modules/settings/store";
import { useTheme } from "@/modules/theme";
import {
  deleteBgImage,
  importBgImageFromFile,
} from "@/modules/theme/bgImageStore";
import { deleteCustomTheme, saveCustomTheme } from "@/modules/theme/customThemes";
import { listBuiltinThemes } from "@/modules/theme/themes";
import { validateTheme } from "@/modules/theme/validateTheme";
import { deleteThemeFile, emitThemeEdit } from "@/modules/theme/themeFiles";
import { DEFAULT_THEME_ID } from "@/modules/theme/types";
import { Edit02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useMemo, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

// Approximate swatch colors for built-in editor themes
const BUILTIN_SWATCH: Record<string, { bg: string; accent: string; string: string }> = {
  atomone:       { bg: "#282c34", accent: "#61afef", string: "#98c379" },
  aura:          { bg: "#15141b", accent: "#a277ff", string: "#61ffca" },
  copilot:       { bg: "#0d1117", accent: "#79c0ff", string: "#a5d6ff" },
  "cursor-dark": { bg: "#181818", accent: "#94c1fa", string: "#e394dc" },
  "github-dark": { bg: "#0d1117", accent: "#79c0ff", string: "#a5d6ff" },
  "github-light":{ bg: "#ffffff", accent: "#0550ae", string: "#0a3069" },
  "gruvbox-dark":{ bg: "#282828", accent: "#83a598", string: "#b8bb26" },
  nord:          { bg: "#2e3440", accent: "#88c0d0", string: "#a3be8c" },
  "tokyo-night": { bg: "#1a1b26", accent: "#7aa2f7", string: "#9ece6a" },
  "xcode-dark":  { bg: "#292a30", accent: "#6bdfff", string: "#fc6a5d" },
  "xcode-light": { bg: "#ffffff", accent: "#0b4f79", string: "#c41a16" },
};

export function ThemesSection() {
  const { themeId, setThemeId, resolvedMode, customThemes } = useTheme();
  const builtinThemes = listBuiltinThemes();
  const themes = useMemo(
    () => [...builtinThemes, ...customThemes],
    [builtinThemes, customThemes],
  );
  const customIds = useMemo(
    () => new Set(customThemes.map((t) => t.id)),
    [customThemes],
  );

  const [importError, setImportError] = useState<string | null>(null);
  const [bgError, setBgError] = useState<string | null>(null);
  const [editorImportError, setEditorImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bgInputRef = useRef<HTMLInputElement | null>(null);
  const editorThemeInputRef = useRef<HTMLInputElement | null>(null);

  const activeEditorThemeId = usePreferencesStore((s) => s.editorTheme);
  const customEditorThemes = useCustomEditorThemesStore((s) => s.customEditorThemes);
  const customEditorIds = useMemo(
    () => new Set(customEditorThemes.map((t) => t.id)),
    [customEditorThemes],
  );

  const handleEditorThemeFiles = async (files: FileList | null) => {
    setEditorImportError(null);
    if (!files || files.length === 0) return;
    const file = files[0];
    try {
      const text = await file.text();
      const result = parseVsCodeThemeText(text);
      if (!result.ok) {
        setEditorImportError(`${file.name}: ${result.error}`);
        return;
      }
      // Many valid theme files omit a top-level `name` (it lives in
      // package.json) — fall back to the filename.
      const displayName =
        result.name ?? (file.name.replace(/\.[^.]+$/, "") || "Imported Theme");
      const slug = displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      const id = `custom-editor-${slug || "theme"}-${Date.now()}`;
      const theme: CustomEditorTheme = {
        id,
        name: displayName,
        rawJson: result.json,
      };
      await saveCustomEditorTheme(theme);
      await setEditorTheme(id);
    } catch (e) {
      setEditorImportError(
        `${file.name}: ${e instanceof Error ? e.message : "failed to read"}`,
      );
    }
  };

  const onRemoveCustomEditorTheme = async (id: string) => {
    invalidateCustomEditorThemeCache(id);
    await deleteCustomEditorTheme(id);
    if (activeEditorThemeId === id) {
      await setEditorTheme("atomone");
    }
  };

  const onCreateTheme = () => {
    void emitThemeEdit({ action: "create" });
    void getCurrentWindow().hide();
  };

  const onEditTheme = (id: string) => {
    void emitThemeEdit({ action: "edit", id });
    void getCurrentWindow().hide();
  };

  const backgroundKind = usePreferencesStore((s) => s.backgroundKind);
  const backgroundImageId = usePreferencesStore((s) => s.backgroundImageId);
  const backgroundOpacity = usePreferencesStore((s) => s.backgroundOpacity);
  const backgroundBlur = usePreferencesStore((s) => s.backgroundBlur);

  const handleThemeFiles = async (files: FileList | null) => {
    setImportError(null);
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const result = validateTheme(parsed);
        if (!result.ok) {
          setImportError(`${file.name}: ${result.error}`);
          return;
        }
        await saveCustomTheme(result.theme);
        setThemeId(result.theme.id);
      } catch (e) {
        setImportError(
          `${file.name}: ${e instanceof Error ? e.message : "failed to read"}`,
        );
        return;
      }
    }
  };

  const onPickThemeFile = () => fileInputRef.current?.click();

  const onRemoveCustomTheme = async (id: string) => {
    if (themeId === id) setThemeId(DEFAULT_THEME_ID);
    await deleteCustomTheme(id);
    void deleteThemeFile(id);
  };

  const onPickBgFile = () => bgInputRef.current?.click();

  const handleBgFiles = async (files: FileList | null) => {
    setBgError(null);
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith("image/")) {
      setBgError(`${file.name}: not an image`);
      return;
    }
    try {
      const prev = backgroundImageId;
      const { id } = await importBgImageFromFile(file);
      await setBackgroundImageId(id);
      await setBackgroundKind("image");
      if (prev && prev !== id) await deleteBgImage(prev).catch(() => undefined);
    } catch (e) {
      setBgError(e instanceof Error ? e.message : "failed to import image");
    }
  };

  const onRemoveBackground = async () => {
    setBgError(null);
    const prev = backgroundImageId;
    await setBackgroundKind("none");
    await setBackgroundImageId(null);
    if (prev) await deleteBgImage(prev).catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Themes"
        description="Theme, background image, and customization."
      />

      <div
        className="flex flex-col gap-2"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          void handleThemeFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-between">
          <Label>Theme</Label>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={onCreateTheme}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={2} />
              Create
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onPickThemeFile}
            >
              Import .terax-theme
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".terax-theme,.json,application/json"
            className="hidden"
            onChange={(e) => {
              void handleThemeFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {importError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {importError}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          {themes.map((t) => {
            const v =
              t.variants[resolvedMode] ?? t.variants.dark ?? t.variants.light;
            const c = v?.colors;
            const swatchBg = c?.background ?? "var(--background)";
            const swatchFg = c?.foreground ?? "var(--foreground)";
            const swatchAccent = c?.primary ?? c?.accent ?? "var(--accent)";
            const swatchMuted = c?.muted ?? "var(--muted)";
            const selected = themeId === t.id;
            const isCustom = customIds.has(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setThemeId(t.id)}
                className={cn(
                  "group flex items-center gap-3 rounded-lg border p-2.5 text-left transition-all",
                  selected
                    ? "border-foreground/60 ring-1 ring-foreground/20"
                    : "border-border/60 hover:border-border",
                )}
              >
                <div
                  className="flex h-10 w-14 shrink-0 items-center justify-center gap-1 rounded-md border border-border/40"
                  style={{ background: swatchBg }}
                >
                  <span
                    className="h-5 w-2 rounded-sm"
                    style={{ background: swatchAccent }}
                  />
                  <span
                    className="h-5 w-2 rounded-sm"
                    style={{ background: swatchFg, opacity: 0.7 }}
                  />
                  <span
                    className="h-5 w-2 rounded-sm"
                    style={{ background: swatchMuted }}
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12.5px] font-medium">
                    {t.name}
                  </span>
                  {t.description ? (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {t.description}
                    </span>
                  ) : null}
                </div>
                {isCustom ? (
                  <span className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                    <span
                      role="button"
                      aria-label={`Edit ${t.name}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditTheme(t.id);
                      }}
                    >
                      <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
                    </span>
                    <span
                      role="button"
                      aria-label={`Remove ${t.name}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRemoveCustomTheme(t.id);
                      }}
                    >
                      ×
                    </span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Editor IDE Theme */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>Editor IDE Theme</Label>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => editorThemeInputRef.current?.click()}
          >
            Import VSCode Theme
          </Button>
          <input
            ref={editorThemeInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              void handleEditorThemeFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {editorImportError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {editorImportError}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          {(EDITOR_THEMES as readonly string[]).map((id) => {
            const swatch = BUILTIN_SWATCH[id];
            const selected = activeEditorThemeId === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => void setEditorTheme(id)}
                className={cn(
                  "flex items-center gap-3 rounded-lg border p-2.5 text-left transition-all",
                  selected
                    ? "border-foreground/60 ring-1 ring-foreground/20"
                    : "border-border/60 hover:border-border",
                )}
              >
                <div
                  className="flex h-10 w-14 shrink-0 items-center justify-center gap-1 rounded-md border border-border/40"
                  style={{ background: swatch?.bg ?? "#1e1e1e" }}
                >
                  <span className="h-5 w-2 rounded-sm" style={{ background: swatch?.accent ?? "#569cd6" }} />
                  <span className="h-5 w-2 rounded-sm" style={{ background: swatch?.string ?? "#ce9178", opacity: 0.9 }} />
                  <span className="h-5 w-2 rounded-sm" style={{ background: swatch?.bg ? swatch.bg + "88" : "#555", opacity: 0.7 }} />
                </div>
                <span className="truncate text-[12.5px] font-medium">
                  {EDITOR_THEME_LABELS[id as keyof typeof EDITOR_THEME_LABELS] ?? id}
                </span>
              </button>
            );
          })}
          {customEditorThemes.map((t) => {
            const bg = t.rawJson.colors?.["editor.background"] ?? "#1e1e1e";
            const selected = activeEditorThemeId === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => void setEditorTheme(t.id)}
                className={cn(
                  "group flex items-center gap-3 rounded-lg border p-2.5 text-left transition-all",
                  selected
                    ? "border-foreground/60 ring-1 ring-foreground/20"
                    : "border-border/60 hover:border-border",
                )}
              >
                <div
                  className="flex h-10 w-14 shrink-0 items-center justify-center gap-1 rounded-md border border-border/40"
                  style={{ background: bg }}
                >
                  <span className="h-5 w-2 rounded-sm opacity-60" style={{ background: t.rawJson.colors?.["editor.foreground"] ?? "#d4d4d4" }} />
                  <span className="h-5 w-2 rounded-sm opacity-60" style={{ background: t.rawJson.colors?.["editor.foreground"] ?? "#d4d4d4" }} />
                  <span className="h-5 w-2 rounded-sm opacity-40" style={{ background: t.rawJson.colors?.["editor.foreground"] ?? "#d4d4d4" }} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12.5px] font-medium">{t.name}</span>
                  <span className="truncate text-[10.5px] text-muted-foreground">Custom</span>
                </div>
                <span
                  role="button"
                  aria-label={`Remove ${t.name}`}
                  className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-muted hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    void onRemoveCustomEditorTheme(t.id);
                  }}
                >
                  ×
                </span>
              </button>
            );
          })}
        </div>
        {customEditorIds.size === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Import any VSCode-compatible theme .json to use it as your editor syntax theme.
          </p>
        ) : null}
      </div>

      <div
        className="flex flex-col gap-2"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          void handleBgFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-between">
          <Label>Background</Label>
          <div className="flex items-center gap-2">
            {backgroundKind === "image" && backgroundImageId ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                onClick={() => void onRemoveBackground()}
              >
                Remove
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onPickBgFile}
            >
              {backgroundKind === "image" ? "Replace image" : "Choose image"}
            </Button>
            <input
              ref={bgInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void handleBgFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        </div>
        {bgError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {bgError}
          </div>
        ) : null}
        {backgroundKind === "image" && backgroundImageId ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11.5px] text-muted-foreground">
                Opacity
              </span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {Math.round(backgroundOpacity * 100)}%
              </span>
            </div>
            <Slider
              value={[backgroundOpacity]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={(v) => void setBackgroundOpacity(v[0] ?? 0)}
            />
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11.5px] text-muted-foreground">Blur</span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {backgroundBlur}px
              </span>
            </div>
            <Slider
              value={[backgroundBlur]}
              min={0}
              max={64}
              step={1}
              onValueChange={(v) => void setBackgroundBlur(v[0] ?? 0)}
            />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Drop an image here or pick one. Stored locally; doesn't affect the
            default look until set.
          </p>
        )}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
