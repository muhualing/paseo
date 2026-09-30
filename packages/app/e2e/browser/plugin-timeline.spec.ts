import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { chatOutlineRail } from "../support/helpers/chat-outline";
import { expect, test } from "../support/fixtures";
import {
  withTimelinePlugin,
  requestPluginTimeline,
  interactWithStreamingCard,
  expectWholeCompletedCard,
  expectBothConsecutiveTools,
} from "../support/helpers/plugin-timeline";

for (const width of [1100, 390]) {
  test(`assistant plugin receives the whole streaming message at width ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await withTimelinePlugin(page, info, "assistant", async (agent) => {
      await requestPluginTimeline(agent);
      await interactWithStreamingCard(page);
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await expectWholeCompletedCard(page);
      // Local state is checked during growth; the viewport remounts on the history handoff.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expectWholeCompletedCard(page);
    });
  });
}

test("Overview preserves both consecutive tool plugin cards", async ({ page }, info) => {
  await withTimelinePlugin(page, info, "tools", async (agent) => {
    await requestPluginTimeline(agent);
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await expectBothConsecutiveTools(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectBothConsecutiveTools(page);
  });
});

test("display rules survive a browser disconnect and filter the outline before cached history is painted", async ({
  page,
}, info) => {
  info.setTimeout(180_000);
  const directory = await mkdtemp(path.join(tmpdir(), "display-policy-"));
  const client = await connectDaemonClient<
    import("@getpaseo/client/internal/daemon-client").DaemonClient
  >({ clientIdPrefix: "display-policy" });
  const previous = await client.getDaemonConfig();
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "display-policy-",
    title: "Display policy regression",
    model: "ten-second-stream",
    featureValues: {
      mockStreamingAssistantResponse: "Visible fifteen-minute progress",
      mockStreamingAssistantIntervalMs: 1,
    },
  });
  const text = "AUTOMATIC_ONLY: emit 1 coalesced agent stream updates";
  let disconnected = false;
  let holdCatalog = false;
  let reconnectAttempts = 0;
  let connections = 0;
  const sockets = new Set<import("@playwright/test").WebSocketRoute>();
  const held: Array<{
    socket: import("@playwright/test").WebSocketRoute;
    message: string | Buffer;
  }> = [];
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    if (disconnected) {
      reconnectAttempts += 1;
      socket.close();
      return;
    }
    connections += 1;
    sockets.add(socket);
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (
        holdCatalog &&
        frame.type === "session" &&
        frame.message?.type === "plugin.catalog.get.response"
      )
        held.push({ socket, message });
      else socket.send(message);
    });
  });
  await page.addInitScript(() => {
    Object.assign(window, { displayLeaks: [], watchDisplayLeaks: true });
    const observer = new MutationObserver(() => {
      const state = window as unknown as { displayLeaks: string[]; watchDisplayLeaks: boolean };
      if (!state.watchDisplayLeaks) return;
      for (const node of document.querySelectorAll('[data-testid="user-message"]')) {
        if (node.textContent?.includes("AUTOMATIC_ONLY"))
          state.displayLeaks.push("user source painted");
      }
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true });
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ chatOutlineEnabled: true }));
  });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "display-policy", requirements: pluginRequirements }),
    );
    await writeFile(
      path.join(directory, "index.client.tsx"),
      `export default function(p) {
      p.addTimelineTransformer({id:"source",query:{itemType:"user_message"},transform:({item})=>item.clientMessageId?.startsWith("scheduled:")?{items:[]}:undefined});
      p.addTimelineTransformer({id:"quiet",query:{itemType:"assistant_message"},transform:({item,phase})=>item.text.trim()==="<quiet/>" || item.text.trim()==="" || (phase==="streaming" && "<quiet/>".startsWith(item.text.trim())) ? {items:[]} : undefined});
      return ()=>{};
    }`,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await client.sendAgentMessage(agent.agentId, text, { messageId: "scheduled:1" });
    await client.waitForFinish(agent.agentId, 30_000);
    const original = await client.listAgentTimelinePrompts(agent.agentId, { includeItems: true });
    expect(original.prompts[0].item?.clientMessageId).toBe("scheduled:1");
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAgentRoute(page, agent);
    await expect(
      page.getByText("Visible fifteen-minute progress", { exact: true }).last(),
    ).toBeVisible();
    await expect(page.getByTestId("user-message")).toHaveCount(0);
    await expect(chatOutlineRail(page).getByRole("tab")).toHaveCount(0);
    disconnected = true;
    for (const socket of sockets)
      socket.close({ code: 1012, reason: "isolated connection interruption" });
    await expect.poll(() => reconnectAttempts).toBeGreaterThan(0);
    await expect(page.getByTestId("user-message")).toHaveCount(0);
    const beforeReconnect = connections;
    disconnected = false;
    await expect.poll(() => connections).toBeGreaterThan(beforeReconnect);
    await expect(page.getByTestId("user-message")).toHaveCount(0);
    holdCatalog = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expect(page.getByTestId("user-message")).toHaveCount(0);
    holdCatalog = false;
    for (const { socket, message } of held.splice(0)) socket.send(message);
    await expect(
      page.getByText("Visible fifteen-minute progress", { exact: true }).last(),
    ).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, "displayLeaks"))).toEqual([]);
    await page.evaluate(() => Reflect.set(window, "watchDisplayLeaks", false));
    await client.sendAgentMessage(agent.agentId, text, { messageId: "ordinary:1" });
    await client.waitForFinish(agent.agentId, 30_000);
    await expect(page.getByTestId("user-message").filter({ hasText: text })).toHaveCount(1);
    await client.sendAgentMessage(
      agent.agentId,
      "Ordinary question: emit 1 coalesced agent stream updates",
      { messageId: "ordinary:2" },
    );
    await client.waitForFinish(agent.agentId, 30_000);
    await expect(chatOutlineRail(page).getByRole("tab")).toHaveCount(2);
    await client.disablePlugin("display-policy");
    await expect(page.getByTestId("user-message").filter({ hasText: text })).toHaveCount(2);
    await expect(chatOutlineRail(page).getByRole("tab")).toHaveCount(3);
    const after = await client.listAgentTimelinePrompts(agent.agentId, { includeItems: true });
    expect(after.prompts[0]).toEqual(original.prompts[0]);
    await info.attach("display-policy", {
      body: await page.screenshot({ path: info.outputPath("display-policy.png") }),
      contentType: "image/png",
    });
    await client.enablePlugin("display-policy");
    for (const response of ["<quiet/>", "   "]) {
      const quiet = await seedMockAgentWorkspace({
        repoPrefix: "quiet-output-",
        title: "Quiet output regression",
        model: "ten-second-stream",
        featureValues: {
          mockStreamingAssistantResponse: response,
          mockStreamingAssistantIntervalMs: 1,
        },
      });
      try {
        await client.sendAgentMessage(
          quiet.agentId,
          "Ordinary question: emit 1 coalesced agent stream updates",
        );
        await client.waitForFinish(quiet.agentId, 30_000);
        await openAgentRoute(page, quiet);
        await expect(page.getByTestId("user-message")).toHaveCount(1);
        await expect(page.getByTestId("assistant-message")).toHaveCount(0);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByTestId("user-message")).toHaveCount(1);
        await expect(page.getByTestId("assistant-message")).toHaveCount(0);
      } finally {
        await quiet.cleanup();
      }
    }
  } catch (error) {
    await info.attach("display-policy-before-cleanup", {
      body: await page.screenshot({ path: info.outputPath("display-policy-before-cleanup.png") }),
      contentType: "image/png",
    });
    throw error;
  } finally {
    await client.removePlugin("display-policy").catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
    await agent.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized ordinary prompts keep their outline and authenticated reader history remains visible", async ({
  page,
}, info) => {
  info.setTimeout(180_000);
  const directory = await mkdtemp(path.join(tmpdir(), "outline-large-"));
  const client = await connectDaemonClient<
    import("@getpaseo/client/internal/daemon-client").DaemonClient
  >({ clientIdPrefix: "outline-large" });
  const previous = await client.getDaemonConfig();
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "outline-large-",
    title: "Oversized prompt regression",
    model: "ten-second-stream",
    featureValues: {
      mockStreamingAssistantResponse: "Visible fifteen-minute progress",
      mockStreamingAssistantIntervalMs: 1,
    },
  });
  let reader = false;
  let readerInfoFrames = 0;
  let readerSocket: import("@playwright/test").WebSocketRoute | null = null;
  let serverInfoFrame: string | null = null;
  const readerFrameTypes: Record<string, number> = {};
  let failSourceReads = true;
  const sourceRequestIds = new Set<string>();
  let catalogRequests = 0;
  const sourceReads: Array<{
    cursor: { epoch: string; seq: number };
    limit: number;
    projection: string;
  }> = [];
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    readerSocket = socket;
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.message?.type === "plugin.catalog.get.request") catalogRequests++;
      if (frame.message?.type === "fetch_agent_timeline_request" && frame.message.limit === 1) {
        sourceReads.push(frame.message);
        sourceRequestIds.add(frame.message.requestId);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.message?.payload?.status === "server_info") serverInfoFrame = String(message);
      if (reader && frame.message?.type)
        readerFrameTypes[frame.message.type] = (readerFrameTypes[frame.message.type] ?? 0) + 1;
      // The published daemon admits local owner sessions. This fixture narrows only its
      // advertised permission contract to exercise the client reader gate; server
      // authorization is covered separately with a real workspace.read principal.
      if (
        failSourceReads &&
        frame.message?.type === "fetch_agent_timeline_response" &&
        sourceRequestIds.has(frame.message.payload.requestId)
      ) {
        frame.message.payload.error = "Temporary source read failure";
        socket.send(JSON.stringify(frame));
      } else if (reader && frame.message?.payload?.status === "server_info") {
        readerInfoFrames++;
        frame.message.payload.permissions = ["workspace.read"];
        socket.send(JSON.stringify(frame));
      } else socket.send(message);
    });
  });
  await page.addInitScript(() =>
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ chatOutlineEnabled: true })),
  );
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "outline-large", requirements: pluginRequirements }),
    );
    await writeFile(
      path.join(directory, "index.client.tsx"),
      `export default function(p){p.addTimelineTransformer({id:"source",query:{itemType:"user_message"},transform:({item})=>item.clientMessageId?.startsWith("scheduled:")?{items:[]}:undefined});return ()=>{};}`,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    for (const [name, text] of [
      ["ASCII", "A".repeat(72000)],
      ["中文", "普通问题".repeat(6000)],
    ] as const) {
      for (const source of ["scheduled", "ordinary"]) {
        await client.sendAgentMessage(
          agent.agentId,
          `${name} ${text} emit 1 coalesced agent stream updates`,
          { messageId: `${source}:${name}` },
        );
        await client.waitForFinish(agent.agentId, 30000);
      }
    }
    // Push the large prompts out of the initial 40-row projected window.
    for (let i = 0; i < 22; i++) {
      await client.sendAgentMessage(
        agent.agentId,
        "Background input: emit 1 coalesced agent stream updates",
        { messageId: `scheduled:filler-${i}` },
      );
      await client.waitForFinish(agent.agentId, 30000);
    }
    // The bounded source index is paged; the legacy preview index covers all prompts.
    expect((await client.listAgentTimelinePrompts(agent.agentId)).prompts).toHaveLength(26);
    const original = await client.listAgentTimelinePrompts(agent.agentId, { includeItems: true });
    expect(original.prompts).toHaveLength(4);
    expect(original.nextCursor).not.toBeNull();
    expect(original.prompts.slice(0, 4).every((prompt) => prompt.item === undefined)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("chat-outline-retry")).toBeVisible();
    await expect(chatOutlineRail(page).getByRole("tab")).toHaveCount(0);
    failSourceReads = false;
    await page.getByTestId("chat-outline-retry").click();
    await expect(chatOutlineRail(page).getByRole("tab")).toHaveCount(2);
    for (const tick of await chatOutlineRail(page).getByRole("tab").all()) {
      expect(await tick.getAttribute("aria-label")).toMatch(/ASCII|中文/);
    }
    for (const prompt of original.prompts.slice(0, 4)) {
      expect(sourceReads).toContainEqual(
        expect.objectContaining({
          cursor: { epoch: original.epoch, seq: prompt.seq + 1 },
          limit: 1,
          projection: "projected",
        }),
      );
    }
    await chatOutlineRail(page).getByRole("tab").first().click();
    await expect(page.getByTestId("user-message").filter({ hasText: "ASCII" })).toHaveCount(1);
    await expect(page.getByTestId("chat-outline-retry")).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(chatOutlineRail(page).getByRole("tab")).toHaveCount(2);
    await client.disablePlugin("outline-large");
    await expect(chatOutlineRail(page).getByRole("tab")).toHaveCount(26);
    const after = await client.listAgentTimelinePrompts(agent.agentId, { includeItems: true });
    expect(after.prompts).toEqual(original.prompts);
    expect(after.epoch).toBe(original.epoch);
    expect(after.nextCursor).toBe(original.nextCursor);
    await client.enablePlugin("outline-large");
    await expect(chatOutlineRail(page).getByRole("tab")).toHaveCount(2);
    reader = true;
    catalogRequests = 0;
    expect(serverInfoFrame).not.toBeNull();
    const permissionUpdate = JSON.parse(serverInfoFrame!);
    permissionUpdate.message.payload.permissions = ["workspace.read"];
    expect(readerSocket).not.toBeNull();
    readerSocket!.send(JSON.stringify(permissionUpdate));
    await expect(chatOutlineRail(page).getByRole("tab")).toHaveCount(26);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => page.getByTestId("user-message").count()).toBeGreaterThan(0);
    await expect(
      page.getByText("Visible fifteen-minute progress", { exact: true }).last(),
    ).toBeVisible();
    await expect(chatOutlineRail(page).getByRole("tab")).toHaveCount(26);
    expect(catalogRequests).toBe(0);
    await info.attach("oversized-reader", {
      body: await page.screenshot({ path: info.outputPath("oversized-reader.png") }),
      contentType: "image/png",
    });
  } catch (error) {
    await info.attach("reader-contract-diagnostic", {
      body: JSON.stringify({
        reader,
        readerInfoFrames,
        readerFrameTypes,
        catalogRequests,
        sourceReadCount: sourceReads.length,
        userCount: await page.getByTestId("user-message").count(),
        outlineCount: await chatOutlineRail(page).getByRole("tab").count(),
        workspaceUnavailable: await page
          .getByText("Workspace unavailable", { exact: true })
          .count(),
        historyError: await page.getByTestId("chat-outline-retry").count(),
      }),
      contentType: "application/json",
    });
    await info.attach("before-cleanup", {
      body: await page.screenshot({ path: info.outputPath("before-cleanup.png") }),
      contentType: "image/png",
    });
    throw error;
  } finally {
    await client.removePlugin("outline-large").catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
    await agent.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
