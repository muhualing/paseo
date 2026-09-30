import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const PROMPT_PREVIEW_MAX_LENGTH = 120;

export interface TimelinePromptIndexEntry {
  seq: number;
  timestamp: string;
  preview: string;
  item?: Extract<AgentTimelineRow["item"], { type: "user_message" }>;
}

export interface TimelinePromptIndex {
  epoch: string;
  prompts: TimelinePromptIndexEntry[];
  nextCursor?: number | null;
}

function promptPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= PROMPT_PREVIEW_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, PROMPT_PREVIEW_MAX_LENGTH - 1)}…`;
}

export function buildTimelinePromptIndex(
  epoch: string,
  rows: readonly AgentTimelineRow[],
  options: { includeItems?: boolean; cursor?: number } = {},
): TimelinePromptIndex {
  if (options.includeItems) {
    // Source bodies are opt-in, bounded, and contain only the existing user-message contract.
    const candidates = rows.filter(
      (row) =>
        row.item.type === "user_message" &&
        (options.cursor === undefined || row.seq > options.cursor),
    );
    const prompts: TimelinePromptIndexEntry[] = [];
    let bytes = 0;
    for (const row of candidates) {
      if (row.item.type !== "user_message") continue;
      const size = Buffer.byteLength(JSON.stringify(row.item));
      if (prompts.length >= 50 || (prompts.length > 0 && bytes + Math.min(size, 65536) > 262144))
        break;
      prompts.push({
        seq: row.seq,
        timestamp: row.timestamp,
        preview: promptPreview(row.item.text),
        ...(size <= 65536
          ? {
              item: {
                type: row.item.type,
                text: row.item.text,
                ...(row.item.messageId !== undefined ? { messageId: row.item.messageId } : {}),
                ...(row.item.clientMessageId !== undefined
                  ? { clientMessageId: row.item.clientMessageId }
                  : {}),
              },
            }
          : {}),
      });
      bytes += Math.min(size, 65536);
    }
    return {
      epoch,
      prompts,
      nextCursor: prompts.length < candidates.length ? prompts[prompts.length - 1].seq : null,
    };
  }
  return {
    epoch,
    prompts: rows.flatMap((row) =>
      row.item.type === "user_message"
        ? [
            {
              seq: row.seq,
              timestamp: row.timestamp,
              preview: promptPreview(row.item.text),
            },
          ]
        : [],
    ),
  };
}
