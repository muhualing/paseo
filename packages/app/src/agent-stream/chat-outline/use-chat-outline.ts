import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";
import type { TimelineItemTransform } from "@/plugins/timeline/model";
import { isWeb } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "../strategy";
import {
  createActivePromptPublisher,
  resolveActivePromptSeq,
  shouldAcceptPromptIndexEpoch,
  type ActivePromptSource,
  type ChatOutlinePrompt,
} from "./model";

type PromptSourceItem = NonNullable<AgentTimelinePromptIndexPayload["prompts"][number]["item"]>;

const NO_PROMPTS: ChatOutlinePrompt[] = [];
const NO_STREAM_ITEMS: StreamItem[] = [];

interface PendingPromptJump {
  requestId: number;
  seq: number;
  fetchSettled: boolean;
  hasScrolled: boolean;
}

export interface UseChatOutlineInput {
  agentId: string;
  serverId: string;
  timelineEpoch: string | null;
  tail: StreamItem[];
  head: StreamItem[] | undefined;
  enabled: boolean;
  viewportRef: RefObject<StreamViewportHandle | null>;
  onJumpError: () => void;
  visibleMessageIds?: ReadonlySet<string>;
  transformTimelineItem?: TimelineItemTransform;
  requiresSourceItems?: boolean;
  revealLoadedMessage?: (messageId: string) => boolean;
}

export interface ChatOutline {
  prompts: ChatOutlinePrompt[];
  sourceUnavailable: boolean;
  retrySources: () => void;
  activePrompt: ActivePromptSource;
  jumpToPrompt: (seq: number) => void;
  reportReadingPosition: (seq: number | null) => void;
}

export function useChatOutline({
  agentId,
  serverId,
  timelineEpoch,
  tail,
  head,
  enabled,
  viewportRef,
  onJumpError,
  visibleMessageIds,
  revealLoadedMessage,
  transformTimelineItem,
  requiresSourceItems = transformTimelineItem !== undefined,
}: UseChatOutlineInput): ChatOutline {
  const [index, setIndex] = useState<AgentTimelinePromptIndexPayload | null>(null);
  const sourceIndexRef = useRef<{
    agentId: string;
    serverId: string;
    payload: AgentTimelinePromptIndexPayload;
    includeItems: boolean;
  } | null>(null);
  const includeItems = requiresSourceItems;
  const scope = JSON.stringify([serverId, agentId, timelineEpoch]);
  const [sourceCache, setSourceCache] = useState<{
    scope: string;
    items: Map<number, PromptSourceItem>;
  } | null>(null);
  const [sourceFailure, setSourceFailure] = useState<string | null>(null);
  const [indexFailure, setIndexFailure] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const retrySources = useCallback(() => setRetryAttempt((attempt) => attempt + 1), []);
  const [pendingJump, setPendingJump] = useState<PendingPromptJump | null>(null);
  const [activePrompt] = useState(createActivePromptPublisher);
  const readingSeqRef = useRef<number | null>(null);
  const nextJumpRequestIdRef = useRef(0);
  const nextIndexRequestIdRef = useRef(0);
  const loadedItems = useMemo(() => [...tail, ...(head ?? NO_STREAM_ITEMS)], [head, tail]);
  const loadedSources = useMemo(() => {
    const sources = new Map<number, PromptSourceItem>();
    for (const row of loadedItems) {
      if (row.kind !== "user_message" || row.timelineCursor?.epoch !== timelineEpoch) continue;
      sources.set(row.timelineCursor.seq, {
        type: "user_message",
        text: row.text,
        ...(row.messageId !== undefined ? { messageId: row.messageId } : {}),
        ...(row.clientMessageId !== undefined ? { clientMessageId: row.clientMessageId } : {}),
      });
    }
    return sources;
  }, [loadedItems, timelineEpoch]);
  const prompts = useMemo(() => {
    if (!enabled || !index || index.epoch !== timelineEpoch) return NO_PROMPTS;
    if (!requiresSourceItems || !transformTimelineItem) return index.prompts;
    return index.prompts.filter((prompt) => {
      // A preview cannot establish provenance or match a complete-body hash.
      const item =
        prompt.item ??
        loadedSources.get(prompt.seq) ??
        (sourceCache?.scope === scope ? sourceCache.items.get(prompt.seq) : undefined);
      if (!item) return false;
      return (
        transformTimelineItem({
          item: Object.freeze({ ...item }),
          phase: "complete",
          sourceId: item.messageId ?? `prompt/${index.epoch}/${prompt.seq}`,
        }) === undefined
      );
    });
  }, [
    enabled,
    index,
    timelineEpoch,
    requiresSourceItems,
    transformTimelineItem,
    loadedSources,
    sourceCache,
    scope,
  ]);

  const unloadedSourceSeqs =
    index?.prompts
      .filter((prompt) => !prompt.item && !loadedSources.has(prompt.seq))
      .map((prompt) => prompt.seq)
      .join(",") ?? "";

  // Omitted index bodies use the existing precise timeline read. Serial requests bound
  // concurrent body transfer, and this view-scoped cache is never persisted.
  useEffect(() => {
    setSourceFailure(null);
    if (!enabled || !requiresSourceItems || !index || index.epoch !== timelineEpoch) return;
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      setSourceFailure(scope);
      return;
    }
    let active = true;
    const cached =
      sourceCache?.scope === scope ? sourceCache.items : new Map<number, PromptSourceItem>();
    const missing = index.prompts.filter(
      (prompt) => !prompt.item && !loadedSources.has(prompt.seq) && !cached.has(prompt.seq),
    );
    void (async () => {
      for (const prompt of missing) {
        if (!active) return;
        try {
          const payload = await client.fetchAgentTimeline(agentId, {
            direction: "before",
            cursor: { epoch: index.epoch, seq: prompt.seq + 1 },
            limit: 1,
            projection: "projected",
          });
          if (!active) return;
          const row = payload.entries.find(
            (entry) => entry.seqStart === prompt.seq && entry.seqEnd === prompt.seq,
          );
          if (
            payload.epoch !== index.epoch ||
            payload.staleCursor ||
            !row ||
            row.item.type !== "user_message"
          )
            throw new Error("Outline source no longer matches its timeline position");
          const item: PromptSourceItem = {
            type: "user_message",
            text: row.item.text,
            ...(row.item.messageId !== undefined ? { messageId: row.item.messageId } : {}),
            ...(row.item.clientMessageId !== undefined
              ? { clientMessageId: row.item.clientMessageId }
              : {}),
          };
          setSourceCache((current) => ({
            scope,
            items: new Map([
              ...(current?.scope === scope ? current.items : []),
              [prompt.seq, item],
            ]),
          }));
        } catch {
          if (active) setSourceFailure(scope);
        }
      }
    })();
    return () => {
      active = false;
    };
    // Cache writes only publish resolved sources; they must not restart the read queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    agentId,
    serverId,
    scope,
    enabled,
    requiresSourceItems,
    index,
    timelineEpoch,
    unloadedSourceSeqs,
    retryAttempt,
  ]);

  useEffect(() => {
    setSourceCache(null);
  }, [scope, requiresSourceItems]);

  // The viewed timeline already owns live delivery and reconnect catch-up. Its complete
  // loaded items (including rows outside the mounted window) invalidate the prompt index.
  const latestPromptSeq = loadedItems.reduce(
    (latest, item) =>
      item.kind === "user_message" && item.timelineCursor?.epoch === timelineEpoch
        ? Math.max(latest, item.timelineCursor.seq)
        : latest,
    -1,
  );

  useEffect(() => setIndex(null), [agentId, enabled, serverId, timelineEpoch]);

  // Only a timeline the daemon has served can be indexed. A draft's optimistic stream has no
  // epoch, and its id names no agent the daemon knows.
  useEffect(() => {
    if (!isWeb || !enabled || timelineEpoch === null) {
      setIndex(null);
      return;
    }
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) return;
    let active = true;
    setIndexFailure(null);
    const refresh = () => {
      const requestId = ++nextIndexRequestIdRef.current;
      void (async () => {
        const cached = sourceIndexRef.current;
        const previous =
          includeItems &&
          cached?.includeItems === includeItems &&
          cached.agentId === agentId &&
          cached.serverId === serverId &&
          cached.payload.epoch === timelineEpoch
            ? cached.payload
            : null;
        const after = previous?.prompts.at(-1)?.seq;
        const first = await (includeItems
          ? client.listAgentTimelinePrompts(agentId, { includeItems: true, cursor: after })
          : client.listAgentTimelinePrompts(agentId));
        const pagePrompts =
          previous && first.epoch === previous.epoch
            ? [...previous.prompts, ...first.prompts]
            : [...first.prompts];
        let cursor = first.nextCursor;
        while (cursor !== undefined && cursor !== null) {
          if (!active || requestId !== nextIndexRequestIdRef.current) return null;
          const page = await client.listAgentTimelinePrompts(agentId, {
            includeItems: true,
            cursor,
          });
          if (page.epoch !== first.epoch) return null;
          pagePrompts.push(...page.prompts);
          if (
            page.nextCursor !== undefined &&
            page.nextCursor !== null &&
            page.nextCursor <= cursor
          )
            return null;
          cursor = page.nextCursor;
        }
        return {
          ...first,
          prompts: [...new Map(pagePrompts.map((prompt) => [prompt.seq, prompt])).values()],
        };
      })()
        .then((payload) => {
          if (
            payload &&
            active &&
            requestId === nextIndexRequestIdRef.current &&
            shouldAcceptPromptIndexEpoch(timelineEpoch, payload.epoch)
          ) {
            sourceIndexRef.current = { agentId, serverId, payload, includeItems };
            setIndex(payload);
          }
          return undefined;
        })
        .catch(() => {
          if (active) setIndexFailure(scope);
        });
    };
    refresh();
    return () => {
      active = false;
    };
  }, [
    agentId,
    enabled,
    serverId,
    timelineEpoch,
    latestPromptSeq,
    includeItems,
    retryAttempt,
    scope,
  ]);

  // The transcript resolves display rows (including Markdown blocks and plugin cards) to
  // timeline positions. The outline uses the complete index, including unloaded prompts.
  const publishActivePrompt = useStableEvent(() => {
    activePrompt.publish(resolveActivePromptSeq(prompts, readingSeqRef.current));
  });

  const reportReadingPosition = useStableEvent((seq: number | null) => {
    readingSeqRef.current = seq;
    publishActivePrompt();
  });

  useEffect(() => {
    nextJumpRequestIdRef.current += 1;
    setPendingJump(null);
    readingSeqRef.current = null;
    activePrompt.publish(null);
  }, [activePrompt, agentId, timelineEpoch]);

  // The transcript reports its reading position long before the index arrives, and a reader
  // who never scrolls would otherwise sit on an unmarked rail.
  useEffect(() => {
    publishActivePrompt();
  }, [prompts, publishActivePrompt]);

  useEffect(() => {
    if (pendingJump === null) return;
    const target = loadedItems.find((item) => item.timelineCursor?.seq === pendingJump.seq);
    if (target) {
      if (pendingJump.hasScrolled) return;
      if (visibleMessageIds?.has(target.id) === false) {
        revealLoadedMessage?.(target.id);
        return;
      }
      viewportRef.current?.scrollToMessage?.(target.id);
      setPendingJump((current) => {
        if (current?.requestId !== pendingJump.requestId) return current;
        return { ...current, hasScrolled: true };
      });
      return;
    }
    if (pendingJump.fetchSettled) setPendingJump(null);
  }, [loadedItems, pendingJump, revealLoadedMessage, viewportRef, visibleMessageIds]);

  const jumpToPrompt = useCallback(
    (seq: number) => {
      nextJumpRequestIdRef.current += 1;
      setPendingJump(null);
      const loaded = loadedItems.find((item) => item.timelineCursor?.seq === seq);
      if (loaded) {
        if (revealLoadedMessage?.(loaded.id)) {
          const requestId = nextJumpRequestIdRef.current;
          setPendingJump({ requestId, seq, fetchSettled: true, hasScrolled: false });
          return;
        }
        viewportRef.current?.scrollToMessage?.(loaded.id);
        return;
      }
      if (!index) return;
      const requestId = nextJumpRequestIdRef.current;
      setPendingJump({ requestId, seq, fetchSettled: false, hasScrolled: false });
      void getHostRuntimeStore()
        .fetchAgentTimeline(serverId, agentId, planTimelinePromptJump({ epoch: index.epoch, seq }))
        .catch((error: unknown) => {
          console.warn("Failed to load a Chat outline window", error);
          onJumpError();
        })
        .finally(() => {
          setPendingJump((current) => {
            if (current?.requestId !== requestId) return current;
            return { ...current, fetchSettled: true };
          });
        });
    },
    [agentId, index, loadedItems, onJumpError, revealLoadedMessage, serverId, viewportRef],
  );

  return {
    prompts,
    activePrompt,
    jumpToPrompt,
    reportReadingPosition,
    sourceUnavailable:
      enabled && (indexFailure === scope || (requiresSourceItems && sourceFailure === scope)),
    retrySources,
  };
}
