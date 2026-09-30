import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

export const SubmittedPromptBindingsSchema = z.array(
  z
    .object({
      provider: z.string().min(1),
      sessionId: z.string().min(1),
      providerMessageId: z.string().min(1),
      clientMessageId: z.string().min(1),
      textSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
);

export type SubmittedPromptBinding = z.infer<typeof SubmittedPromptBindingsSchema>[number];

export function promptTextSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function restoreSubmittedPromptProvenance(
  item: AgentTimelineItem,
  bindings: readonly SubmittedPromptBinding[],
): AgentTimelineItem {
  if (item.type !== "user_message" || !item.messageId || item.clientMessageId) return item;
  const matches = bindings.filter((binding) => binding.providerMessageId === item.messageId);
  const identities = new Set(matches.map((binding) => binding.clientMessageId));
  const textSha256 = promptTextSha256(item.text);
  // A native identity is necessary. Text only validates it; it never selects a source.
  if (identities.size !== 1 || matches.some((binding) => binding.textSha256 !== textSha256)) {
    return item;
  }
  return { ...item, clientMessageId: matches[0].clientMessageId };
}
