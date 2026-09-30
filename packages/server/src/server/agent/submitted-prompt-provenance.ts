import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

export const MAX_SUBMITTED_PROMPT_ID_LENGTH = 512;
export const MAX_SUBMITTED_PROMPT_BINDINGS = 2048;
export const MAX_SUBMITTED_PROMPT_BINDINGS_BYTES = 512 * 1024;

const boundedId = z.string().min(1).max(MAX_SUBMITTED_PROMPT_ID_LENGTH);
const bindingSchema = z
  .object({
    provider: boundedId,
    sessionId: boundedId,
    providerMessageId: boundedId,
    clientMessageId: boundedId,
    textSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function withinBudget(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_SUBMITTED_PROMPT_BINDINGS) return false;
  const entries: unknown[] = value;
  const fieldNames = new Set([
    "provider",
    "sessionId",
    "providerMessageId",
    "clientMessageId",
    "textSha256",
  ]);
  let bytes = 2;
  for (const [index, entry] of entries.entries()) {
    // Bound work before Zod clones entries or JSON encoding touches oversized strings.
    if (!entry || typeof entry !== "object") return false;
    const keys = Object.keys(entry);
    if (keys.length !== 5 || keys.some((key) => !fieldNames.has(key))) return false;
    const fields: unknown[] = Object.values(entry);
    for (const field of fields) {
      if (typeof field !== "string" || field.length > MAX_SUBMITTED_PROMPT_ID_LENGTH) return false;
    }
    bytes += Buffer.byteLength(JSON.stringify(entry), "utf8") + (index ? 1 : 0);
    if (bytes > MAX_SUBMITTED_PROMPT_BINDINGS_BYTES) return false;
  }
  return true;
}

export const SubmittedPromptBindingsSchema = z
  .unknown()
  .refine(withinBudget, "Prompt provenance exceeds storage budget")
  .pipe(z.array(bindingSchema).max(MAX_SUBMITTED_PROMPT_BINDINGS));

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
