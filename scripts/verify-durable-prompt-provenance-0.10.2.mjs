import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const serverRoot = path.resolve(process.argv[2]);
const phase = process.argv[3];
const root = process.argv[4];
const id = "00000000-0000-4000-8000-000000000998";
const imports = async (name) =>
  import(pathToFileURL(path.join(serverRoot, "dist/server/server/agent", name)));
const { AgentManager } = await imports("agent-manager.js");
const { AgentStorage } = await imports("agent-storage.js");
const { promptTextSha256 } = await imports("submitted-prompt-provenance.js");
const packageInfo = JSON.parse(await readFile(path.join(serverRoot, "package.json")));
assert.equal(packageInfo.version, "0.10.2");
const logger = {
  child() {
    return this;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};
const capabilities = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

async function setTestBindings(storage, sourceId, scenario, sessionId) {
  const record = await storage.get(sourceId);
  if (scenario === "missing") delete record.submittedPromptBindings;
  if (scenario === "damaged")
    record.submittedPromptBindings = [{ clientMessageId: "automatic-input" }];
  if (scenario === "ambiguous")
    record.submittedPromptBindings = [
      {
        provider: "codex",
        sessionId,
        providerMessageId: "native-message-1",
        clientMessageId: "automatic-input",
        textSha256: promptTextSha256("same text"),
      },
      {
        provider: "codex",
        sessionId,
        providerMessageId: "native-message-1",
        clientMessageId: "ordinary-input",
        textSha256: promptTextSha256("same text"),
      },
    ];
  await storage.upsert(record);
}

if (!phase) {
  const state = await mkdtemp(path.join(tmpdir(), "prompt-provenance-verification-"));
  try {
    for (const step of [
      "write",
      "restart",
      "missing",
      "damaged",
      "ambiguous",
      "different-session",
      "corrupt-json",
    ]) {
      const child = spawnSync(process.execPath, [process.argv[1], serverRoot, step, state], {
        encoding: "utf8",
      });
      assert.equal(child.status, 0, `${step}: ${child.stderr}`);
      process.stdout.write(child.stdout);
    }
  } finally {
    await rm(state, { recursive: true, force: true });
  }
} else {
  const rawPath = path.join(root, "provider-history.json");
  const raw = phase === "write" ? [] : JSON.parse(await readFile(rawPath, "utf8"));
  const rawDigest = () => createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  let originalRawHash = rawDigest();
  const sessionId = phase === "different-session" ? "other-session" : "native-session";
  let turns = 0;
  class Session {
    constructor(config) {
      this.config = config;
      this.provider = "codex";
      this.capabilities = capabilities;
      this.listeners = new Set();
    }
    subscribe(callback) {
      this.listeners.add(callback);
      return () => this.listeners.delete(callback);
    }
    emit(event) {
      for (const callback of this.listeners) callback(event);
    }
    describePersistence() {
      return { provider: "codex", sessionId };
    }
    async getRuntimeInfo() {
      return { provider: "codex", sessionId, model: "test-model", modeId: null };
    }
    async getAvailableModes() {
      return [];
    }
    async getCurrentMode() {
      return null;
    }
    getPendingPermissions() {
      return [];
    }
    async close() {}
    async interrupt() {}
    async *streamHistory() {
      for (const event of raw) yield structuredClone(event);
    }
    async startTurn(prompt, options) {
      const index = ++turns;
      const turnId = `native-turn-${index}`;
      const messageId = `native-message-${index}`;
      const item = { type: "user_message", text: prompt, messageId };
      raw.push({ type: "timeline", provider: "codex", item });
      setTimeout(() => {
        this.emit({ type: "turn_started", provider: "codex", turnId });
        this.emit({
          type: "timeline",
          provider: "codex",
          turnId,
          item: { ...item, clientMessageId: options.clientMessageId },
        });
        this.emit({ type: "turn_completed", provider: "codex", turnId });
      }, 0);
      return { turnId };
    }
  }
  const client = {
    provider: "codex",
    capabilities,
    async isAvailable() {
      return true;
    },
    async fetchCatalog() {
      return {
        models: [{ provider: "codex", id: "test-model", label: "Test", isDefault: true }],
        modes: [],
      };
    },
    async createSession(config) {
      return new Session(config);
    },
    async resumeSession() {
      return new Session({ provider: "codex", cwd: root });
    },
  };
  const storage = new AgentStorage(path.join(root, "records"), logger);
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    idFactory: () => id,
  });
  const expected = [
    "automatic-input",
    "automatic-input",
    "ordinary-input",
    "progress-input",
    undefined,
  ];
  try {
    if (phase === "write") {
      await manager.createAgent({ provider: "codex", cwd: root }, undefined, {
        workspaceId: undefined,
      });
      for (const clientMessageId of expected.slice(0, 4))
        await manager.runAgent(id, "same text", { clientMessageId });
      raw.push({
        type: "timeline",
        provider: "codex",
        item: { type: "user_message", text: "same text", messageId: "native-unsubmitted" },
      });
      await writeFile(rawPath, JSON.stringify(raw));
      originalRawHash = rawDigest();
      await manager.flush();
      assert.equal((await storage.getSubmittedPromptBindings(id)).length, 4);
      const epoch = manager.fetchTimeline(id).epoch;
      await manager.reloadAgentSession(id, undefined, { rehydrateFromDisk: true });
      await manager.hydrateTimelineFromProvider(id);
      assert.notEqual(manager.fetchTimeline(id).epoch, epoch);
      await writeFile(
        path.join(root, "epoch.json"),
        JSON.stringify(manager.fetchTimeline(id).epoch),
      );
    } else {
      if (phase === "corrupt-json") {
        const files = await readdir(path.join(root, "records"), { recursive: true });
        const recordPath = files.find((file) => file.endsWith(`${id}.json`));
        assert.equal(typeof recordPath, "string");
        await writeFile(path.join(root, "records", recordPath), "{");
      }
      if (["missing", "damaged", "ambiguous"].includes(phase)) {
        await setTestBindings(storage, id, phase, sessionId);
      }
      // Restore complete bindings after the missing/damaged cases so ambiguity and session scope are independent.
      if (phase === "different-session") {
        const record = await storage.get(id);
        record.submittedPromptBindings = [
          {
            provider: "codex",
            sessionId: "native-session",
            providerMessageId: "native-message-1",
            clientMessageId: "automatic-input",
            textSha256: promptTextSha256("same text"),
          },
        ];
        await storage.upsert(record);
      }
      await manager.resumeAgentFromPersistence(
        { provider: "codex", sessionId, metadata: { cwd: root } },
        undefined,
        id,
      );
      await manager.hydrateTimelineFromProvider(id);
    }
    if (phase === "restart")
      assert.notEqual(
        manager.fetchTimeline(id).epoch,
        JSON.parse(await readFile(path.join(root, "epoch.json"))),
      );
    const sourceIds = manager.getTimeline(id).map((item) => item.clientMessageId);
    assert.deepEqual(
      sourceIds,
      ["write", "restart"].includes(phase) ? expected : expected.map(() => undefined),
    );
    await manager.hydrateTimelineFromProvider(id, { force: true });
    assert.deepEqual(
      manager.getTimeline(id).map((item) => item.clientMessageId),
      sourceIds,
    );
    assert.equal(rawDigest(), originalRawHash);
    assert.equal(
      createHash("sha256")
        .update(await readFile(rawPath))
        .digest("hex"),
      originalRawHash,
    );
    // The display policy uses restored identity; equal text never hides ordinary/progress inputs.
    const displayed = manager
      .getTimeline(id)
      .filter((item) => item.clientMessageId !== "automatic-input");
    assert.equal(displayed.length, ["write", "restart"].includes(phase) ? 3 : 5);
    console.log(`${phase}: pass; ${sourceIds.length} inputs; raw history unchanged by hydration`);
  } finally {
    await manager.closeAgent(id).catch(() => undefined);
    await manager.flush();
  }
}
