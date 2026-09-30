import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const serverRoot = path.resolve(process.argv[2]);
const browserEvidence = process.argv[3];
const rawMode = process.env.PASEO_TIMELINE_DISPLAY === "raw";
const load = (name) => import(pathToFileURL(path.join(serverRoot, "dist/server/server", name)));
const requireOfficial = createRequire(path.join(serverRoot, "package.json"));
const { WebSocket } = requireOfficial("ws");
const { DaemonClient } = await import(
  pathToFileURL(requireOfficial.resolve("@getpaseo/client/internal/daemon-client"))
);
const { createPaseoDaemon } = await load("bootstrap.js");
const { MockLoadTestAgentClient } = await load("agent/providers/mock-load-test-agent.js");
const { textDigest } = await load("agent/timeline-display.js");
assert.equal(JSON.parse(await readFile(path.join(serverRoot, "package.json"))).version, "0.10.2");
const isolated = await mkdtemp(path.join(tmpdir(), "display-compat-"));
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
let daemon;
let client;
let browser;
try {
  const home = path.join(isolated, "home");
  const cwd = path.join(isolated, "project");
  await mkdir(cwd);
  daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome: home,
      agentStoragePath: path.join(home, "agents"),
      staticDir: isolated,
      daemonVersion: "0.10.2",
      isDev: true,
      hostnames: true,
      corsAllowedOrigins: [],
      mcpEnabled: false,
      mcpDebug: false,
      relayEnabled: false,
      pluginsEnabled: false,
      agentClients: { mock: new MockLoadTestAgentClient() },
      webUi: { enabled: true, distDir: path.join(serverRoot, "dist/server/web-ui") },
      appBaseUrl: "https://app.paseo.sh",
    },
    logger,
  );
  await daemon.start();
  const port = daemon.getListenTarget().port;
  const serverId = daemon.getServerId();
  client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "legacy-display-verification",
    capabilities: { owned_subscriptions: false, selective_agent_timeline: false },
    reconnect: { enabled: false },
    webSocketFactory: (url) => new WebSocket(url),
  });
  await client.connect();
  const live = [];
  client.subscribeRawMessages((message) => {
    if (message.type === "agent_stream" && message.payload.event.type === "timeline")
      live.push(message.payload);
  });
  const agent = await client.createAgent({
    provider: "mock",
    cwd,
    model: "ten-second-stream",
    title: "Display compatibility",
  });
  const prompt = "[cto-watch 事件] 按一手证据推进；自述需复验。\nbackground-hidden-fixture";
  const manager = daemon.agentManager;
  await manager.appendTimelineItem(agent.id, {
    type: "user_message",
    text: "ordinary-before-hidden",
    clientMessageId: "before",
  });
  await manager.appendTimelineItem(agent.id, {
    type: "assistant_message",
    text: "ordinary-answer-before-hidden",
  });
  for (let i = 0; i < 220; i++) {
    await manager.appendTimelineItem(agent.id, {
      type: "user_message",
      text: prompt,
      clientMessageId: `cto-watch:${textDigest(prompt)}`,
    });
    await manager.appendTimelineItem(agent.id, {
      type: "assistant_message",
      text: "<cto-watch-quiet/>",
    });
  }
  await manager.appendTimelineItem(agent.id, {
    type: "user_message",
    text: "ordinary-after-hidden",
    clientMessageId: "after",
  });
  await manager.appendTimelineItem(agent.id, {
    type: "assistant_message",
    text: "15-minute-progress-visible",
  });
  await client.ping({ requestId: "display-barrier" });
  assert.deepEqual(
    live.map((item) => item.seq),
    rawMode ? Array.from({ length: 444 }, (_, i) => i + 1) : [1, 2, 3, 4],
  );
  const audit = JSON.stringify(await manager.getTimelineRows(agent.id));
  const rawHash = createHash("sha256").update(audit).digest("hex");
  if (rawMode) {
    const full = await client.fetchAgentTimeline(agent.id, { limit: 0 });
    assert.equal(full.entries.length, 444);
    assert.equal(full.epoch, manager.fetchTimeline(agent.id, { limit: 0 }).epoch);
    const index = await client.listAgentTimelinePrompts(agent.id);
    assert.equal(index.prompts.length, 222);
    assert.equal(JSON.stringify(await manager.getTimelineRows(agent.id)), audit);
    console.log(
      JSON.stringify({
        officialVersion: "0.10.2",
        rawDisplaySwitch: true,
        rows: 444,
        auditUnchanged: true,
        rawSha256: rawHash,
      }),
    );
  } else {
    const tail = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 2 });
    assert.deepEqual(
      tail.entries.map((entry) => entry.item.text),
      ["ordinary-after-hidden", "15-minute-progress-visible"],
    );
    const older = await client.fetchAgentTimeline(agent.id, {
      direction: "before",
      cursor: tail.startCursor,
      limit: 2,
    });
    assert.deepEqual(
      older.entries.map((entry) => entry.item.text),
      ["ordinary-before-hidden", "ordinary-answer-before-hidden"],
    );
    assert.equal(older.hasOlder, false);
    const prompts = await client.listAgentTimelinePrompts(agent.id);
    assert.deepEqual(
      prompts.prompts.map((entry) => entry.preview),
      ["ordinary-before-hidden", "ordinary-after-hidden"],
    );
    assert.equal(
      prompts.prompts.every((entry) => entry.item === undefined),
      true,
    );
    const search = await client.searchAgentTimeline({
      agentId: agent.id,
      query: "background-hidden-fixture",
    });
    assert.deepEqual(search.locations, []);
    const caught = await client.fetchAgentTimeline(agent.id, {
      direction: "after",
      cursor: { epoch: tail.epoch, seq: 2 },
      limit: 0,
    });
    assert.equal(caught.endCursor.seq, 4);
    assert.equal(caught.hasNewer, false);
    assert.equal(JSON.stringify(await manager.getTimelineRows(agent.id)), audit);
    const result = {
      officialVersion: "0.10.2",
      rawRows: JSON.parse(audit).length,
      visibleRows: 4,
      rawSha256: rawHash,
      auditUnchanged: true,
      legacyPrompts: true,
      longHiddenPagination: true,
      liveSeq: [1, 2, 3, 4],
      browser: false,
    };
    if (browserEvidence) {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PASEO_DISPLAY_TEST_CHROMIUM,
      });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(
        ({ serverId: browserServerId, port: browserPort }) => {
          const now = new Date().toISOString();
          localStorage.setItem(
            "@paseo:daemon-registry",
            JSON.stringify([
              {
                serverId: browserServerId,
                label: "Compatibility",
                connections: [
                  { id: "direct", type: "directTcp", endpoint: `127.0.0.1:${browserPort}` },
                ],
                preferredConnectionId: "direct",
                createdAt: now,
                updatedAt: now,
              },
            ]),
          );
        },
        { serverId, port },
      );
      const page = await context.newPage();
      await page.goto(
        `http://127.0.0.1:${port}/h/${encodeURIComponent(serverId)}/workspace/${encodeURIComponent(agent.workspaceId)}?open=${encodeURIComponent(`agent:${agent.id}`)}`,
      );
      await page
        .getByText("ordinary-after-hidden", { exact: true })
        .waitFor({ state: "visible", timeout: 30000 });
      await page
        .getByText("15-minute-progress-visible", { exact: true })
        .waitFor({ state: "visible", timeout: 10000 });
      assert.equal(await page.getByText("background-hidden-fixture", { exact: false }).count(), 0);
      await page.reload();
      await page
        .getByText("ordinary-before-hidden", { exact: true })
        .waitFor({ state: "visible", timeout: 30000 });
      await page
        .getByText("15-minute-progress-visible", { exact: true })
        .waitFor({ state: "visible", timeout: 10000 });
      await manager.appendTimelineItem(agent.id, {
        type: "user_message",
        text: prompt,
        clientMessageId: `cto-watch:${textDigest(prompt)}`,
      });
      await manager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        text: "<cto-watch-quiet/>",
      });
      await manager.appendTimelineItem(agent.id, {
        type: "user_message",
        text: "ordinary-live-after-hidden",
        clientMessageId: "live",
      });
      await page
        .getByText("ordinary-live-after-hidden", { exact: true })
        .waitFor({ state: "visible", timeout: 10000 });
      assert.equal(await page.getByText("background-hidden-fixture", { exact: false }).count(), 0);
      result.browser = true;
      await mkdir(browserEvidence, { recursive: true, mode: 0o700 });
      await page.screenshot({ path: path.join(browserEvidence, "official-legacy.png") });
      await context.close();
    }
    console.log(JSON.stringify(result));
  }
} finally {
  await browser?.close();
  await client?.close();
  await daemon?.stop();
  await daemon?.agentManager.flush();
  await rm(isolated, { recursive: true, force: true });
}
