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
