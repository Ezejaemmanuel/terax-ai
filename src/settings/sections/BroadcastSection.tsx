import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useBroadcastStore } from "@/modules/broadcast/useBroadcastStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  BROADCAST_NTFY_SERVER_DEFAULT,
  setBroadcastAutoStart,
  setBroadcastNtfyEnabled,
  setBroadcastNtfyServer,
  setBroadcastNtfyTopic,
  setBroadcastPort,
} from "@/modules/settings/store";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

/// Rendered lazily so the QR encoder never lands in the initial settings bundle.
function QrCode({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import("qrcode")
      .then((mod) =>
        mod.toDataURL(value, { margin: 1, width: 320, errorCorrectionLevel: "M" }),
      )
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!src) {
    return <div className="size-40 rounded-md border border-border/60" />;
  }
  return (
    <img
      src={src}
      alt="QR code for the broadcast link"
      className="size-40 rounded-md bg-white p-1"
    />
  );
}

export function BroadcastSection() {
  const prefs = usePreferencesStore();
  const { info, busy, error, init, start, stop } = useBroadcastStore();
  const [portDraft, setPortDraft] = useState(String(prefs.broadcastPort));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    setPortDraft(String(prefs.broadcastPort));
  }, [prefs.broadcastPort]);

  const running = info !== null;

  const config = {
    port: prefs.broadcastPort,
    ntfy: {
      enabled: prefs.broadcastNtfyEnabled,
      server: prefs.broadcastNtfyServer || BROADCAST_NTFY_SERVER_DEFAULT,
      topic: prefs.broadcastNtfyTopic,
    },
  };

  const copyLink = async () => {
    if (!info) return;
    await navigator.clipboard.writeText(info.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Restarting is how settings take effect: the token, port and ntfy topic are
  // all captured when the server binds.
  const restart = async () => {
    await stop();
    await start(config);
  };

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="Broadcast"
        description="Serve a read-only view of your agent sessions to other devices on this wifi network. Nothing leaves your network."
      />

      <div className="flex flex-col gap-2">
        <SettingRow
          title={running ? "Broadcasting" : "Broadcast is off"}
          description={
            running
              ? "Anyone on this network with the link below can read your sessions."
              : "Turn on to serve the read-only viewer on your local network."
          }
        >
          <Switch
            checked={running}
            disabled={busy}
            onCheckedChange={(next) => {
              void (next ? start(config) : stop());
            }}
          />
        </SettingRow>

        {error && (
          <p className="px-1 text-[11px] text-destructive">{error}</p>
        )}

        {info && (
          <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/60 p-3 sm:flex-row sm:items-center">
            <QrCode value={info.url} />
            <div className="flex min-w-0 flex-col gap-2">
              <span className="text-[12.5px] font-medium">
                Scan this with your phone
              </span>
              <code className="block truncate rounded-md bg-muted px-2 py-1 font-mono text-[10.5px]">
                {info.url}
              </code>
              <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                The link carries an access token. Anyone who has it can read
                your sessions until you turn broadcasting off or regenerate it.
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => void copyLink()}>
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void restart()}
                >
                  Regenerate token
                </Button>
              </div>
            </div>
          </div>
        )}

        <SettingRow
          title="Start with Terax"
          description="Begin broadcasting automatically when the app launches."
        >
          <Switch
            checked={prefs.broadcastAutoStart}
            onCheckedChange={(v) => void setBroadcastAutoStart(v)}
          />
        </SettingRow>

        <SettingRow
          title="Port"
          description="Applied the next time broadcasting starts."
        >
          <Input
            className="h-7 w-24 text-[12px]"
            value={portDraft}
            inputMode="numeric"
            onChange={(e) => setPortDraft(e.target.value)}
            onBlur={() => {
              const n = Number(portDraft);
              if (Number.isFinite(n)) void setBroadcastPort(n);
              else setPortDraft(String(prefs.broadcastPort));
            }}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <SectionHeader
          title="Phone notifications"
          description="A plain LAN address is not a secure context, so browsers refuse to deliver web push there. Terax uses ntfy instead: install the ntfy app, subscribe to a topic, and put that topic here."
        />

        <SettingRow
          title="Send notifications to ntfy"
          description="Only when an agent needs your input or finishes a turn."
        >
          <Switch
            checked={prefs.broadcastNtfyEnabled}
            onCheckedChange={(v) => void setBroadcastNtfyEnabled(v)}
          />
        </SettingRow>

        <SettingRow
          title="Topic"
          description="Pick something unguessable. Anyone who knows a topic name can read its messages."
        >
          <Input
            className="h-7 w-56 text-[12px]"
            placeholder="terax-a7f3c1"
            defaultValue={prefs.broadcastNtfyTopic}
            onBlur={(e) => void setBroadcastNtfyTopic(e.target.value)}
          />
        </SettingRow>

        <SettingRow
          title="Server"
          description="Change only if you run your own ntfy instance."
        >
          <Input
            className="h-7 w-56 text-[12px]"
            placeholder={BROADCAST_NTFY_SERVER_DEFAULT}
            defaultValue={prefs.broadcastNtfyServer}
            onBlur={(e) => void setBroadcastNtfyServer(e.target.value)}
          />
        </SettingRow>

        {running && prefs.broadcastNtfyEnabled && (
          <p className="px-1 text-[11px] text-muted-foreground">
            Notification settings apply on the next start. Use Regenerate token
            above to restart now.
          </p>
        )}
      </div>
    </div>
  );
}
