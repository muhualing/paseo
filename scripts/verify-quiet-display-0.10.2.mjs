import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [serverRoot, protocolRoot] = process.argv.slice(2);
if (!serverRoot || !protocolRoot) {
  throw new Error("Usage: node verify-quiet-display-0.10.2.mjs SERVER_ROOT PROTOCOL_ROOT");
}
for (const [name, root] of [
  ["server", serverRoot],
  ["protocol", protocolRoot],
]) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, `@getpaseo/${name}`);
  assert.equal(manifest.version, "0.10.2");
}
const load = (root, file) => import(pathToFileURL(path.resolve(root, file)).href);
const messages = await load(protocolRoot, "dist/messages.js");
const { validateWSOutboundMessage } = await load(protocolRoot, "dist/validation/ws-outbound.js");
const { WSOutboundMessageSchema: legacyValidator } = await load(
  protocolRoot,
  "dist/generated/validation/ws-outbound.aot.js",
);
const request = {
  type: "agent.timeline.list_prompts.request",
  agentId: "fixture",
  requestId: "test",
};
assert.deepEqual(messages.AgentTimelineListPromptsRequestMessageSchema.parse(request), request);
assert.equal(
  messages.AgentTimelineListPromptsRequestMessageSchema.parse({
    ...request,
    includeItems: true,
    cursor: 1,
  }).includeItems,
  true,
);
assert.equal(
  messages.AgentTimelineListPromptsRequestMessageSchema.safeParse({ ...request, cursor: -1 })
    .success,
  false,
);
const item = {
  type: "user_message",
  text: "complete source",
  messageId: "source",
  clientMessageId: "ordinary:1",
};
const message = {
  type: "agent.timeline.list_prompts.response",
  payload: {
    requestId: "test",
    agentId: "fixture",
    epoch: "epoch",
    error: null,
    nextCursor: 1,
    prompts: [{ seq: 1, timestamp: "now", preview: "complete", item }],
  },
};
const frame = messages.wrapSessionMessage(message);
assert.deepEqual(
  validateWSOutboundMessage(structuredClone(frame)).data.message.payload.prompts[0].item,
  item,
);
assert.equal(legacyValidator.safeParse(structuredClone(frame)).success, true);
const invalid = structuredClone(frame);
invalid.message.payload.prompts[0].item.clientMessageId = 42;
assert.equal(validateWSOutboundMessage(invalid).success, false);
const invalidCursor = structuredClone(frame);
invalidCursor.message.payload.nextCursor = -1;
assert.equal(validateWSOutboundMessage(invalidCursor).success, false);
const { buildTimelinePromptIndex } = await load(
  serverRoot,
  "dist/server/server/agent/timeline-prompt-index.js",
);
const rows = Array.from({ length: 51 }, (_, seq) => ({
  seq,
  timestamp: "now",
  item: { ...item, messageId: `message-${seq}`, metadata: "not transmitted" },
}));
const original = structuredClone(rows);
const first = buildTimelinePromptIndex("epoch", rows, { includeItems: true });
assert.equal(first.prompts.length, 50);
assert.equal(first.nextCursor, 49);
assert.equal(Object.hasOwn(first.prompts[0].item, "metadata"), false);
assert.equal(
  buildTimelinePromptIndex("epoch", rows, { includeItems: true, cursor: 49 }).prompts.length,
  1,
);
assert.equal(buildTimelinePromptIndex("epoch", rows).prompts.length, 51);
assert.equal(Object.hasOwn(buildTimelinePromptIndex("epoch", rows).prompts[0], "item"), false);
assert.deepEqual(rows, original);
const oversized = buildTimelinePromptIndex(
  "epoch",
  [{ seq: 1, timestamp: "now", item: { ...item, text: "x".repeat(65537) } }],
  { includeItems: true },
);
assert.equal(Object.hasOwn(oversized.prompts[0], "item"), false);
const { codexModelSupportsFastMode } = await load(
  serverRoot,
  "dist/server/server/agent/providers/codex-feature-definitions.js",
);
assert.equal(codexModelSupportsFastMode("gpt-6.1-sol"), true);
const { CodexAppServerAgentSession } = await load(
  serverRoot,
  "dist/server/server/agent/providers/codex-app-server-agent.js",
);
const session = { pendingAgentMessages: new Map([["stream-id", "progress"]]) };
assert.equal(
  CodexAppServerAgentSession.prototype.consumeStreamedTextCompletion.call(
    session,
    { type: "assistant_message", text: "progress" },
    "completion-id",
  ),
  true,
);
assert.equal(session.pendingAgentMessages.size, 0);
console.log(
  "0.10.2 optional contract, legacy validator, source bounds, unchanged rows, Fast flag, and stream completion checks passed",
);
