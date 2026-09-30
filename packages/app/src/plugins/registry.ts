import { useMemo, useSyncExternalStore } from "react";
import { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { resolveAppVersion } from "@/utils/app-version";
import { createPluginClientRuntime } from "./client-runtime";
import { runPluginClientBundle, type PluginClientRuntime } from "./evaluate";
import type { InstalledPlugin } from "./types";

type CatalogPlugin = Awaited<ReturnType<DaemonClient["getPluginCatalog"]>>[number];

export class PluginRegistry {
  private readonly byHost = new Map<string, InstalledPlugin[]>();
  private readonly listeners = new Set<() => void>();
  private readonly displayReady = new Set<string>();
  private readonly readyPlugins = new WeakSet<InstalledPlugin>();
  private readonly hydration = new WeakMap<InstalledPlugin, Promise<boolean>>();
  private readonly initializations = new Map<string, object>();
  private snapshot: InstalledPlugin[] = [];
  private readonly disposed = new WeakSet<InstalledPlugin>();
  private readonly evaluationErrors = new Map<string, string>();

  constructor(
    private readonly dependencies: {
      version: string | null;
      createRuntime: typeof createPluginClientRuntime;
    },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): InstalledPlugin[] => this.snapshot;

  isHostDisplayReady = (serverId: string): boolean => this.displayReady.has(serverId);

  allowHostDisplay(serverId: string): void {
    this.displayReady.add(serverId);
    this.publish();
  }

  getEvaluationError(serverId: string, pluginId: string): string | undefined {
    return this.evaluationErrors.get(`${serverId}/${pluginId}`);
  }

  installCatalog(
    serverId: string,
    catalog: CatalogPlugin[],
    options: {
      replacePluginId?: string;
      client: DaemonClient;
    },
  ): boolean {
    const previous = this.byHost.get(serverId) ?? [];
    const previousTimelineBundles = previous
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    const preserved = catalog.flatMap((entry) => {
      const existing = previous.find(
        (plugin) =>
          plugin.id !== options.replacePluginId &&
          plugin.id === entry.id &&
          plugin.clientBundle === entry.clientBundle &&
          plugin.requirements?.paseo === entry.requirements?.paseo,
      );
      return existing ? [existing] : [];
    });
    const generation = {};
    this.initializations.set(serverId, generation);
    let failed = false;
    if (preserved.length !== catalog.length) this.displayReady.delete(serverId);
    const removed = previous.filter((plugin) => !preserved.includes(plugin));
    if (removed.length > 0) {
      this.byHost.set(serverId, preserved);
      this.publish();
      for (const plugin of removed) this.dispose(plugin);
    }
    const installed = catalog.flatMap((entry) => {
      const key = `${serverId}/${entry.id}`;
      let runtime: PluginClientRuntime | undefined;
      let lifetime: AbortController | undefined;
      try {
        if (!entry.clientBundle) return [];
        assertPluginCompatibility({ ...entry, version: this.dependencies.version, runtime: "app" });
        const existing = preserved.find(
          (plugin) => plugin.id === entry.id && plugin.clientBundle === entry.clientBundle,
        );
        if (existing) {
          this.evaluationErrors.delete(key);
          return [existing];
        }
        lifetime = new AbortController();
        const installation: InstalledPlugin = {
          lifetime,
          id: entry.id,
          serverId,
          clientBundle: entry.clientBundle,
          requirements: entry.requirements,
          queryClient: new QueryClient(),
          cleanup: () => undefined,
          surfaces: [],
          settingsScreens: [],
          sidebarItems: [],
          workspacePanels: [],
          commandCenterItems: [],
          clientSlashCommands: [],
          attachmentSources: [],
          themes: [],
          timelineTransformers: [],
          timelineRenderers: [],
        };
        runtime = this.dependencies.createRuntime(installation, options.client);
        const pending: Promise<unknown>[] = [];
        let initializing = true;
        const rpc = runtime.rpc;
        const evaluated = runPluginClientBundle(
          entry.id,
          entry.clientBundle,
          {
            ...runtime,
            rpc(definition, input) {
              const request = rpc(definition, input);
              if (initializing) pending.push(request);
              return request;
            },
          },
          () => this.publish(),
        );
        Object.assign(installation, evaluated);
        if (pending.length === 0) {
          initializing = false;
          this.readyPlugins.add(installation);
        } else {
          this.hydration.set(
            installation,
            (async () => {
              let completed = 0;
              while (completed < pending.length) {
                const batch = pending.slice(completed);
                completed = pending.length;
                const outcomes = await Promise.allSettled(batch);
                if (
                  installation.lifetime.signal.aborted ||
                  outcomes.some((outcome) => outcome.status === "rejected")
                ) {
                  initializing = false;
                  return false;
                }
              }
              initializing = false;
              this.readyPlugins.add(installation);
              return true;
            })(),
          );
        }
        const paseo = runtime.paseo;
        installation.cleanup = async () => {
          const results = await Promise.allSettled([paseo.dispose(), evaluated.cleanup()]);
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Plugin cleanup failed",
            );
        };
        this.evaluationErrors.delete(key);
        return [installation];
      } catch (error) {
        failed = true;
        lifetime?.abort();
        void runtime?.paseo
          .dispose()
          .catch((failure) => console.warn(`[Plugins] API cleanup failed for ${key}`, failure));
        this.evaluationErrors.set(key, error instanceof Error ? error.message : String(error));
        console.warn(`[Plugins] Failed to evaluate ${serverId}/${entry.id}`, error);
        return [];
      }
    });
    const configuredIds = new Set(catalog.map((entry) => entry.id));
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`) && !configuredIds.has(key.slice(serverId.length + 1))) {
        this.evaluationErrors.delete(key);
      }
    }
    this.byHost.set(serverId, installed);
    if (!failed && installed.every((plugin) => this.readyPlugins.has(plugin))) {
      this.initializations.delete(serverId);
      this.displayReady.add(serverId);
    } else if (!failed) {
      // Setup continuations consume these same RPC promises before display becomes ready.
      void Promise.all(
        installed.map((plugin) => this.hydration.get(plugin) ?? Promise.resolve(true)),
      ).then((outcomes) => {
        if (this.initializations.get(serverId) !== generation || outcomes.includes(false))
          return undefined;
        this.initializations.delete(serverId);
        this.displayReady.add(serverId);
        this.publish();
        return undefined;
      });
    }
    this.publish();
    const installedTimelineBundles = installed
      .filter((plugin) => plugin.timelineTransformers.length > 0)
      .map((plugin) => `${plugin.id}\0${plugin.clientBundle}`);
    return (
      previousTimelineBundles.length !== installedTimelineBundles.length ||
      previousTimelineBundles.some((bundle, index) => bundle !== installedTimelineBundles[index])
    );
  }

  removeHost(serverId: string): void {
    const installed = this.byHost.get(serverId);
    this.displayReady.delete(serverId);
    this.initializations.delete(serverId);
    if (!installed) {
      this.publish();
      return;
    }
    for (const plugin of installed) this.dispose(plugin);
    for (const key of this.evaluationErrors.keys()) {
      if (key.startsWith(`${serverId}/`)) this.evaluationErrors.delete(key);
    }
    this.byHost.delete(serverId);
    this.publish();
  }

  private dispose(plugin: InstalledPlugin): void {
    if (this.disposed.has(plugin)) return;
    this.disposed.add(plugin);
    plugin.lifetime.abort();
    plugin.queryClient.clear();
    try {
      void Promise.resolve(plugin.cleanup()).catch((error) => {
        console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
      });
    } catch (error) {
      console.warn(`[Plugins] Cleanup failed for ${plugin.serverId}/${plugin.id}`, error);
    }
  }

  private publish(): void {
    this.snapshot = [...this.byHost.values()]
      .flat()
      .sort((left, right) =>
        `${left.serverId}/${left.id}`.localeCompare(`${right.serverId}/${right.id}`),
      );
    for (const listener of this.listeners) listener();
  }
}

export const pluginRegistry = new PluginRegistry({
  version: resolveAppVersion(),
  createRuntime: createPluginClientRuntime,
});

export function useInstalledPlugins(): InstalledPlugin[] {
  return useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getSnapshot,
    pluginRegistry.getSnapshot,
  );
}

export function useInstalledPlugin(serverId: string, pluginId: string): InstalledPlugin | null {
  return (
    useInstalledPlugins().find(
      (plugin) => plugin.serverId === serverId && plugin.id === pluginId,
    ) ?? null
  );
}

export function usePluginInstallations(pluginId: string): InstalledPlugin[] {
  const installed = useInstalledPlugins();
  return useMemo(() => installed.filter((plugin) => plugin.id === pluginId), [installed, pluginId]);
}

export function useHostPluginDisplayReady(serverId: string): boolean {
  return useSyncExternalStore(
    pluginRegistry.subscribe,
    () => pluginRegistry.isHostDisplayReady(serverId),
    () => pluginRegistry.isHostDisplayReady(serverId),
  );
}
