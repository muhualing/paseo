// @vitest-environment jsdom
import React from "react";
import { render, renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PluginCatalogSync } from "./catalog-sync";
import { pluginRegistry } from "./registry";
import { useInstalledTimelineDisplayPolicy } from "./timeline";
import { transformTimelineItem } from "./timeline/model";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const state = vi.hoisted(() => ({
  connected: true,
  supported: true,
  status: "online",
  known: true,
  access: true,
  read: false,
  rpc: vi.fn(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => state.connected,
  useHostRuntimeSnapshot: () => ({
    authFailureReason: state.status === "auth-error" ? "incorrect_password" : null,
  }),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => state.supported }));
interface TestSessionState {
  sessions: Record<string, { serverInfo: { permissions: string[] } | null }>;
}
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (value: TestSessionState) => unknown) =>
    select({
      sessions: {
        host: {
          serverInfo: state.known
            ? {
                permissions: [
                  ...(state.access ? ["daemon.manage"] : []),
                  ...(state.read ? ["workspace.read"] : []),
                ],
              }
            : null,
        },
      },
    }),
}));
vi.mock("./client-runtime", () => ({
  createPluginClientRuntime: () => ({
    paseo: { dispose: async () => {} },
    rpc: (...args: unknown[]) => state.rpc(...args),
  }),
}));
afterEach(() => {
  pluginRegistry.removeHost("host");
  Object.assign(state, {
    connected: true,
    supported: true,
    status: "online",
    known: true,
    access: true,
    read: false,
  });
});

function catalogClient(): DaemonClient {
  return {
    getPluginCatalog: vi.fn(async () => [
      {
        id: "display",
        requirements: { paseo: ">=0.8.0" },
        clientBundle: `(function(){return {default:function(p){p.addTimelineTransformer({id:"source",query:{itemType:"user_message"},transform:({item})=>item.clientMessageId==="scheduled:1"?{items:[]}:undefined});return function(){};}}})`,
      },
    ]),
    observeEvents: () => ({
      subscribe: ({ snapshot }: { snapshot: () => void }) => snapshot(),
      release: async () => {},
    }),
  } as unknown as DaemonClient;
}

test("disconnect retains a trusted display policy; disable and host removal dispose it", async () => {
  const client = catalogClient();
  const item = {
    type: "user_message" as const,
    text: "automatic input",
    clientMessageId: "scheduled:1",
  };
  const project = () =>
    transformTimelineItem({
      item,
      phase: "complete",
      sourceId: "message",
      plugins: pluginRegistry.getSnapshot(),
    });
  const rendered = render(<PluginCatalogSync serverId="host" client={client} />);
  await waitFor(() => expect(project()).toEqual([]));
  act(() => {
    state.connected = false;
    state.status = "offline";
    rendered.rerender(<PluginCatalogSync serverId="host" client={client} />);
  });
  expect(project()).toEqual([]);
  expect(client.getPluginCatalog).toHaveBeenCalledTimes(1);
  act(() => {
    state.connected = true;
    state.status = "online";
    rendered.rerender(<PluginCatalogSync serverId="host" client={client} />);
  });
  await waitFor(() => expect(client.getPluginCatalog).toHaveBeenCalledTimes(2));
  act(() => {
    state.supported = false;
    rendered.rerender(<PluginCatalogSync serverId="host" client={client} />);
  });
  expect(project()).toBeUndefined();
  rendered.unmount();
  expect(pluginRegistry.getSnapshot()).toEqual([]);
});

test("cold cached history waits for source-index hydration across catalog refresh without blocking optimistic input or progress", async () => {
  let complete!: (value: string) => void;
  state.rpc.mockReturnValue(
    new Promise<string>((resolve) => {
      complete = resolve;
    }),
  );
  const { result, unmount } = renderHook(() => useInstalledTimelineDisplayPolicy("host").transform);
  const input = {
    item: { type: "user_message" as const, text: "same text", messageId: "approved" },
    phase: "complete" as const,
    sourceId: "approved",
  };
  expect(result.current(input)).toEqual([]);
  expect(result.current({ ...input, canonical: false })).toBeUndefined();
  const catalog = [
    {
      id: "history",
      requirements: { paseo: ">=0.8.0" },
      clientBundle: `(function(){return {default:function(p){
    let id;
    p.addTimelineTransformer({id:"history",query:{itemType:"user_message"},transform:({item})=>item.messageId===id && item.text==="same text" && item.clientMessageId===undefined ? {items:[]} : undefined});
    void (async()=>{id=await p.rpc({},{});})();
    return function(){};
  }}})`,
    },
  ];
  const client = {} as DaemonClient;
  act(() => {
    pluginRegistry.installCatalog("host", catalog, { client });
  });
  expect(result.current(input)).toEqual([]);
  expect(
    result.current({ ...input, item: { type: "assistant_message", text: "15-minute progress" } }),
  ).toBeUndefined();
  act(() => {
    pluginRegistry.installCatalog("host", catalog, { client });
  });
  expect(result.current(input)).toEqual([]);
  await act(async () => {
    complete("approved");
  });
  expect(pluginRegistry.isHostDisplayReady("host")).toBe(true);
  expect(result.current(input)).toEqual([]);
  expect(
    result.current({ ...input, item: { ...input.item, messageId: "new-paste" } }),
  ).toBeUndefined();
  expect(
    result.current({ ...input, item: { ...input.item, text: "different text" } }),
  ).toBeUndefined();
  expect(
    result.current({ ...input, item: { ...input.item, clientMessageId: "ordinary:1" } }),
  ).toBeUndefined();
  act(() => {
    pluginRegistry.removeHost("host");
    pluginRegistry.allowHostDisplay("host");
  });
  expect(result.current(input)).toBeUndefined();
  unmount();
});

for (const reason of ["credentials", "permissions"] as const) {
  test(`clears a previously trusted display scope when ${reason} are revoked`, async () => {
    const client = catalogClient();
    const rendered = render(<PluginCatalogSync serverId="host" client={client} />);
    await waitFor(() => expect(pluginRegistry.getSnapshot()).toHaveLength(1));
    act(() => {
      if (reason === "credentials") state.status = "auth-error";
      else state.access = false;
      rendered.rerender(<PluginCatalogSync serverId="host" client={client} />);
    });
    expect(pluginRegistry.getSnapshot()).toHaveLength(0);
    expect(pluginRegistry.isHostDisplayReady("host")).toBe(false);
    rendered.unmount();
  });
}

for (const cold of [true, false]) {
  test(`authenticated reader retains ordinary history after ${cold ? "cold load" : "management revocation"}`, async () => {
    const client = catalogClient();
    state.read = true;
    state.access = !cold;
    const rendered = render(<PluginCatalogSync serverId="host" client={client} />);
    if (!cold) await waitFor(() => expect(pluginRegistry.getSnapshot()).toHaveLength(1));
    act(() => {
      state.access = false;
      rendered.rerender(<PluginCatalogSync serverId="host" client={client} />);
    });
    expect(pluginRegistry.getSnapshot()).toHaveLength(0);
    expect(pluginRegistry.isHostDisplayReady("host")).toBe(true);
    act(() => {
      state.connected = false;
      rendered.rerender(<PluginCatalogSync serverId="host" client={client} />);
    });
    expect(pluginRegistry.isHostDisplayReady("host")).toBe(true);
    act(() => {
      state.connected = true;
      rendered.rerender(<PluginCatalogSync serverId="host" client={client} />);
    });
    const { result, unmount } = renderHook(() => useInstalledTimelineDisplayPolicy("host"));
    for (const type of ["user_message", "assistant_message"] as const) {
      expect(
        result.current.transform({
          item: { type, text: "ordinary history" },
          phase: "complete",
          sourceId: type,
        }),
      ).toBeUndefined();
    }
    act(() => {
      state.status = "auth-error";
      rendered.rerender(<PluginCatalogSync serverId="host" client={client} />);
    });
    expect(pluginRegistry.isHostDisplayReady("host")).toBe(false);
    act(() => {
      state.status = "online";
      rendered.rerender(<PluginCatalogSync serverId="host" client={client} />);
    });
    expect(pluginRegistry.isHostDisplayReady("host")).toBe(true);
    rendered.unmount();
    unmount();
    expect(pluginRegistry.isHostDisplayReady("host")).toBe(false);
  });
}
test("catalog access denial permits only an authenticated history reader", async () => {
  state.read = true;
  const client = catalogClient();
  vi.mocked(client.getPluginCatalog).mockRejectedValue(
    Object.assign(new Error("denied"), { code: "access_denied" }),
  );
  const rendered = render(<PluginCatalogSync serverId="host" client={client} />);
  await waitFor(() => expect(pluginRegistry.isHostDisplayReady("host")).toBe(true));
  act(() => {
    state.read = false;
    rendered.rerender(<PluginCatalogSync serverId="host" client={client} />);
  });
  await waitFor(() => expect(pluginRegistry.isHostDisplayReady("host")).toBe(false));
  rendered.unmount();
});
