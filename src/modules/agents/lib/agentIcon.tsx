import {
  ChatGptIcon,
  ClaudeIcon,
  RoboticIcon,
  SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

function iconFor(agent: string): IconSvgElement {
  const a = agent.toLowerCase();
  if (a.includes("claude")) return ClaudeIcon;
  if (a.includes("command-code") || a.includes("commandcode"))
    return SourceCodeIcon;
  if (a.includes("codex") || a.includes("gpt") || a.includes("openai"))
    return ChatGptIcon;
  return RoboticIcon;
}

export function AgentIcon({
  agent,
  size = 15,
  className,
}: {
  agent: string;
  size?: number;
  className?: string;
}) {
  const lower = agent.toLowerCase();
  const brandSrc = lower.includes("terax")
    ? "/logo.png"
    : lower.includes("cursor")
      ? "/cursor.svg"
      : null;
  if (brandSrc) {
    return (
      <img
        src={brandSrc}
        alt=""
        width={size}
        height={size}
        className={className}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={iconFor(agent)}
      size={size}
      strokeWidth={1.75}
      className={className}
    />
  );
}
