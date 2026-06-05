import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import { Streamdown } from "streamdown";

// Shared Streamdown config so every markdown surface (preview tabs, the
// in-editor `.md` preview) renders with identical components + prose styling.
const components = { code: MarkdownCode };

export function MarkdownContent({ content }: { content: string }) {
  return (
    <Streamdown
      className="select-text prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      components={components}
    >
      {content}
    </Streamdown>
  );
}
