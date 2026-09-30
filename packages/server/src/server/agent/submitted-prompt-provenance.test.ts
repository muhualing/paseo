import { expect, test } from "vitest";
import { threadItemToTimeline } from "./providers/codex-app-server-agent.js";
import {
  promptTextSha256,
  restoreSubmittedPromptProvenance,
  SubmittedPromptBindingsSchema,
  type SubmittedPromptBinding,
} from "./submitted-prompt-provenance.js";

const scope = { provider: "codex", sessionId: "native-session" };
const sources = ["automatic-input", "ordinary-input", "progress-input"];
const opcodes = ["clientId", "client_id", "clientUserMessageId"];
const scenarios = [
  "missing",
  "damaged",
  "wrong-provider",
  "wrong-session",
  "wrong-hash",
  "ambiguous",
  "no-native-id",
  "trusted-auto",
  "trusted-ordinary",
  "trusted-progress",
];
const cases = opcodes.flatMap((opcode) =>
  sources.flatMap((source) => scenarios.map((scenario) => ({ opcode, source, scenario }))),
);

test.each(cases)(
  "native source boundary $opcode / $source / $scenario",
  ({ opcode, source, scenario }) => {
    const native = {
      type: "userMessage",
      id: scenario === "no-native-id" ? undefined : "native-message",
      [opcode]: source,
      content: [{ type: "text", text: "same text" }],
    };
    const item = threadItemToTimeline(native);
    if (!item || item.type !== "user_message") throw new Error("Expected native user message");
    const before = structuredClone(item);
    Object.freeze(item);
    const binding: SubmittedPromptBinding = {
      ...scope,
      providerMessageId: "native-message",
      clientMessageId: "automatic-input",
      textSha256: promptTextSha256("same text"),
    };
    let bindings: SubmittedPromptBinding[] = [];
    let expectedSource: string | undefined;
    if (scenario === "wrong-provider") bindings = [{ ...binding, provider: "claude" }];
    if (scenario === "wrong-session") bindings = [{ ...binding, sessionId: "other-session" }];
    if (scenario === "wrong-hash")
      bindings = [{ ...binding, textSha256: promptTextSha256("other text") }];
    if (scenario === "ambiguous")
      bindings = [binding, { ...binding, clientMessageId: "ordinary-input" }];
    if (scenario === "no-native-id") bindings = [binding];
    if (scenario === "damaged") {
      const parsed = SubmittedPromptBindingsSchema.safeParse([
        { clientMessageId: "automatic-input" },
      ]);
      expect(parsed.success).toBe(false);
    }
    const trustedSources: Record<string, string> = {
      "trusted-auto": "automatic-input",
      "trusted-ordinary": "ordinary-input",
      "trusted-progress": "progress-input",
    };
    if (trustedSources[scenario]) {
      expectedSource = trustedSources[scenario];
      bindings = [{ ...binding, clientMessageId: expectedSource }];
    }
    const restored = restoreSubmittedPromptProvenance(item, bindings, scope);
    const expected = {
      type: "user_message",
      text: "same text",
      ...(item.messageId ? { messageId: item.messageId } : {}),
      ...(expectedSource ? { clientMessageId: expectedSource } : {}),
    };
    expect(restored).toEqual(expected);
    expect(restored).not.toBe(item);
    expect(item).toEqual(before);
  },
);

test.each([
  undefined,
  { provider: "", sessionId: "native-session" },
  { provider: "codex", sessionId: "" },
])("missing native scope never restores identity: %j", (nativeScope) => {
  const item = {
    type: "user_message",
    text: "same text",
    messageId: "native",
    clientMessageId: "automatic-input",
  } as const;
  const binding = {
    ...scope,
    providerMessageId: "native",
    clientMessageId: "automatic-input",
    textSha256: promptTextSha256("same text"),
  };
  expect(restoreSubmittedPromptProvenance(item, [binding], nativeScope)).toEqual({
    type: "user_message",
    text: "same text",
    messageId: "native",
  });
});
