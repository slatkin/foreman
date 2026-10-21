/**
 * Reading a pi session file (JSON lines).
 *
 * A child writes its session to the file the launch spec names. The parent
 * reads that file to learn what the child last said — the `last-message`
 * command uses it, and so does the wrapper's no-report wake-up.
 *
 * Only the read side lives here: foreman never seeds a child session, so
 * there is no session writing and no fork-mode machinery.
 */
import { readFileSync } from "node:fs";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

/**
 * Return the entries after `afterLine` (1-indexed count of existing entries).
 *
 * Skips unparseable lines: a child killed mid-append leaves a torn trailing
 * line, and that must not turn into a failed read instead of the summary.
 */
export function getNewEntries(
  sessionFile: string,
  afterLine: number,
): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  const entries: SessionEntry[] = [];
  for (const line of lines.slice(afterLine)) {
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // Skip a torn line rather than failing the read.
    }
  }
  return entries;
}

/**
 * Find the last assistant message text in a list of entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
export function findLastAssistantMessage(
  entries: SessionEntry[],
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

    const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
    const errorMessage = (msg.message as { errorMessage?: unknown })
      .errorMessage;
    if (
      stopReason === "error" &&
      typeof errorMessage === "string" &&
      errorMessage.trim() !== ""
    ) {
      return `Subagent error: ${errorMessage.trim()}`;
    }
  }
  return null;
}
