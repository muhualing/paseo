import { pluginSettingsKey } from "./settings/use-settings";
import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeIsConnected, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { pluginRegistry } from "./registry";

export function PluginCatalogSync({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient;
}) {
  const connected = useHostRuntimeIsConnected(serverId);
  const authFailure = useHostRuntimeSnapshot(serverId)?.authFailureReason;
  const known = useSessionStore((state) => state.sessions[serverId]?.serverInfo != null);
  // COMPAT(pluginCatalogPermissions): added after v0.10.0, remove after 2027-03-30 when permissions are mandatory.
  const hasAccess = useSessionStore(
    (state) =>
      state.sessions[serverId]?.serverInfo?.permissions?.includes("daemon.manage") !== false,
  );
  const canReadHistory = useSessionStore(
    (state) =>
      state.sessions[serverId]?.serverInfo?.permissions?.includes("workspace.read") === true,
  );
  const supported = useHostFeature(serverId, "plugins");

  useEffect(() => {
    let cancelled = false;
    let refreshQueue = Promise.resolve();
    if (authFailure) {
      // Rejected credentials and revoked access must not retain a previous trust scope.
      pluginRegistry.removeHost(serverId);
      return;
    }
    if (!hasAccess) {
      // A previously authenticated reader keeps its plain cached display on transport loss.
      if (
        !connected &&
        known &&
        canReadHistory &&
        pluginRegistry.isHostDisplayReady(serverId) &&
        !pluginRegistry.getSnapshot().some((plugin) => plugin.serverId === serverId)
      )
        return;
      pluginRegistry.removeHost(serverId);
      // Catalog management is independent of authenticated transcript access.
      if (connected && known && canReadHistory) pluginRegistry.allowHostDisplay(serverId);
      return;
    }
    if (!connected || !known) return;
    if (!supported) {
      pluginRegistry.removeHost(serverId);
      pluginRegistry.allowHostDisplay(serverId);
      return;
    }
    const refresh = (replacePluginId?: string) => {
      refreshQueue = refreshQueue.then(() =>
        client
          .getPluginCatalog()
          .then((catalog) => {
            if (!cancelled) {
              pluginRegistry.installCatalog(serverId, catalog, {
                replacePluginId,
                client,
              });
            }
            return undefined;
          })
          .catch((error) => {
            if (!cancelled) {
              if (error instanceof Error && "code" in error && error.code === "access_denied") {
                pluginRegistry.removeHost(serverId);
                if (canReadHistory) pluginRegistry.allowHostDisplay(serverId);
              }
              console.warn(`[Plugins] Failed to load catalog for ${serverId}`, error);
            }
            return undefined;
          }),
      );
      return refreshQueue;
    };
    const observation = client.observeEvents([
      "status.plugin_catalog_changed",
      "status.plugin_settings_changed",
    ]);
    observation.subscribe({
      snapshot: () => {
        void refresh();
      },
      update: (message) => {
        if (message.type !== "status") return;
        if (message.payload.status === "plugin_settings_changed") {
          const { pluginId, settingsId } = message.payload;
          if (typeof settingsId === "string") {
            const plugin = pluginRegistry
              .getSnapshot()
              .find((item) => item.serverId === serverId && item.id === pluginId);
            void plugin?.queryClient.invalidateQueries({ queryKey: pluginSettingsKey(settingsId) });
          }
        }
        if (message.payload.status === "plugin_catalog_changed") {
          const pluginId = message.payload.pluginId;
          if (typeof pluginId === "string") void refresh(pluginId);
        }
      },
    });
    return () => {
      cancelled = true;
      void observation
        .release()
        .catch((error) => console.warn("[Plugins] Failed to release catalog", error));
    };
  }, [client, connected, known, serverId, authFailure, hasAccess, canReadHistory, supported]);

  useEffect(() => () => pluginRegistry.removeHost(serverId), [serverId, client]);
  return null;
}
