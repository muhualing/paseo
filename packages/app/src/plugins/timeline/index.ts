import { useMemo } from "react";
import { useInstalledPlugins, useHostPluginDisplayReady } from "../registry";
import { transformTimelineItem, type TimelineItemTransform } from "./model";

export type { InstalledPluginTimelineItem, TimelineItemTransform } from "./model";
export { PluginTimelineItemView } from "./view";

export function useInstalledTimelineDisplayPolicy(serverId: string) {
  const ready = useHostPluginDisplayReady(serverId);
  const installed = useInstalledPlugins();
  const plugins = useMemo(
    () => installed.filter((plugin) => plugin.serverId === serverId),
    [installed, serverId],
  );
  const transform: TimelineItemTransform = useMemo(
    () => (input) => {
      if (
        !ready &&
        input.canonical !== false &&
        (plugins.length === 0 || input.item.type === "user_message")
      )
        return [];
      return transformTimelineItem({ ...input, plugins });
    },
    [plugins, ready],
  );
  const requiresSourceItems =
    !ready ||
    plugins.some((plugin) =>
      plugin.timelineTransformers.some(
        (transformer) => transformer.query.itemType === "user_message",
      ),
    );
  return useMemo(() => ({ transform, requiresSourceItems }), [transform, requiresSourceItems]);
}
