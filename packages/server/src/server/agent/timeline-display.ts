import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
} from "./agent-timeline-store-types.js";
import { selectProjectedTimelinePage, type TimelineSeqRange } from "./timeline-projection.js";

const MAX_BYTES = 2 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const indexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: digest,
  records: z
    .array(z.strictObject({ nativeMessageId: z.uuid(), exactTextSha256: digest }))
    .max(10000),
});
export type HistoricalDisplayIndex = z.infer<typeof indexSchema>;
export function textDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function historicalDisplayRevision(records: HistoricalDisplayIndex["records"]): string {
  return textDigest(
    JSON.stringify(
      [...records]
        .sort((a, b) => {
          const left = `${a.nativeMessageId}\0${a.exactTextSha256}`;
          const right = `${b.nativeMessageId}\0${b.exactTextSha256}`;
          if (left < right) return -1;
          return left > right ? 1 : 0;
        })
        .map(({ nativeMessageId, exactTextSha256 }) => ({ exactTextSha256, nativeMessageId })),
    ),
  );
}
function sameIndexStat(before: Stats, after: Stats): boolean {
  return (
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.uid === after.uid &&
    before.mode === after.mode
  );
}
export function readHistoricalDisplayIndex(
  path = join(
    homedir(),
    ".agent-config",
    "cto-watch",
    "notes",
    "approved-historical-source-index.json",
  ),
): HistoricalDisplayIndex | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o7777) !== 0o600 ||
      before.size > MAX_BYTES
    )
      return null;
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length > MAX_BYTES || length !== before.size) return null;
    if (!sameIndexStat(before, after)) return null;
    const parsed = indexSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))),
    );
    if (!parsed.success) return null;
    const index = parsed.data;
    if (
      new Set(index.records.map((record) => record.nativeMessageId.toLowerCase())).size !==
        index.records.length ||
      historicalDisplayRevision(index.records) !== index.revision
    )
      return null;
    return index;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const QUIET_ACK = "<cto-watch-quiet/>";
export function isStandaloneQuietText(text: string, streaming = false): boolean {
  if (!text.trim()) return true;
  let markerSeen = false;
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (
      /^[ \t]*$/.test(line) ||
      /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)
    )
      continue;
    const marker = /^ {0,3}(\S+)[ \t]*$/.exec(line)?.[1];
    if (
      marker === QUIET_ACK ||
      (streaming &&
        index === lines.length - 1 &&
        marker !== undefined &&
        QUIET_ACK.startsWith(marker))
    ) {
      markerSeen = true;
      continue;
    }
    return false;
  }
  return markerSeen;
}
export function isReliableBackgroundPrompt(text: string, clientMessageId?: string): boolean {
  if (!clientMessageId?.startsWith("cto-watch:")) return false;
  const oldHeader =
    /^\[cto-watch (?:事件|兜底)\] project=[A-Za-z0-9._-]+ issue=\S+(?:\r?\n|$)/.test(text);
  const batchHeader = text.split(/\r?\n/, 1)[0] === "[cto-watch 事件] 按一手证据推进；自述需复验。";
  // The short format binds the complete body, including batched events.
  return oldHeader || (batchHeader && clientMessageId === `cto-watch:${textDigest(text)}`);
}

/** Only called on admitted/restored rows, never on native provider metadata. */
export class TimelineDisplay {
  private readonly suppressed = new Map<string, Set<number>>();
  private readonly historical = new Map<string, string>();

  constructor(
    private readonly index: HistoricalDisplayIndex | null,
    readonly enabled = process.env.PASEO_TIMELINE_DISPLAY !== "raw",
  ) {
    for (const record of index?.records ?? [])
      this.historical.set(record.nativeMessageId.toLowerCase(), record.exactTextSha256);
  }

  hasSuppressed(key: string): boolean {
    return this.suppressed.has(key);
  }
  clearSuppressed(key: string): void {
    this.suppressed.delete(key);
  }
  suppressedStarts(key: string): ReadonlySet<number> {
    return this.suppressed.get(key) ?? new Set();
  }

  native(raw: AgentTimelineFetchResult): AgentTimelineFetchResult {
    if (!this.enabled) return raw;
    return {
      ...raw,
      rows: raw.rows.map((row) =>
        Object.assign({}, row, { item: withoutNativeDisplaySource(row.item) }),
      ),
    };
  }

  stream(
    key: string,
    raw: AgentTimelineFetchResult,
    seq: number,
    item: AgentTimelineItem,
    streaming: boolean,
  ) {
    const view = this.project(raw, streaming);
    const row = raw.rows.find((candidate) =>
      candidate.sourceSeqRanges.some((range) => range.startSeq <= seq && range.endSeq >= seq),
    );
    const pending = this.suppressed.get(key) ?? new Set<number>();
    if (view.hiddenRanges.some((range) => range.startSeq <= seq && range.endSeq >= seq)) {
      if (row?.item.type === "assistant_message") pending.add(row.seqStart);
      this.suppressed.set(key, pending);
      return null;
    }
    // Release the complete item when a held prefix grows ordinary text.
    const displayItem =
      row?.item.type === "assistant_message" && pending.delete(row.seqStart) ? row.item : item;
    if (pending.size === 0) this.suppressed.delete(key);
    return { item: displayItem, seq: view.mapSeq(seq), epoch: view.epoch };
  }

  private hidden(item: AgentTimelineItem, streaming: boolean): boolean {
    if (item.type === "assistant_message") return isStandaloneQuietText(item.text, streaming);
    if (item.type !== "user_message") return false;
    if (item.clientMessageId !== undefined && !item.clientMessageId.startsWith("cto-watch:"))
      return false;
    if (isReliableBackgroundPrompt(item.text, item.clientMessageId)) return true;
    return (
      item.messageId !== undefined &&
      this.historical.get(item.messageId.toLowerCase()) === textDigest(item.text)
    );
  }

  project(raw: AgentTimelineFetchResult, streaming = false) {
    if (!this.enabled)
      return { ...raw, mapSeq: (seq: number) => seq, hiddenRanges: [] as TimelineSeqRange[] };
    const hidden = raw.rows.filter((row) =>
      this.hidden(row.item, streaming && row.seqEnd === raw.window.maxSeq),
    );
    // Ranges carry actual source coverage; seqStart/seqEnd can span interleaved tools.
    const ranges = hidden
      .flatMap((row) => row.sourceSeqRanges)
      .sort((a, b) => a.startSeq - b.startSeq);
    const hiddenRanges: TimelineSeqRange[] = [];
    for (const range of ranges) {
      const last = hiddenRanges.at(-1);
      if (last && range.startSeq <= last.endSeq + 1)
        last.endSeq = Math.max(last.endSeq, range.endSeq);
      else hiddenRanges.push({ ...range });
    }
    const removedBefore: number[] = [];
    let removed = 0;
    for (const range of hiddenRanges) {
      removedBefore.push(removed);
      removed += range.endSeq - range.startSeq + 1;
    }
    const mapSeq = (seq: number) => {
      let low = 0;
      let high = hiddenRanges.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (hiddenRanges[middle].startSeq <= seq) low = middle + 1;
        else high = middle;
      }
      if (low === 0) return seq;
      const range = hiddenRanges[low - 1];
      return seq - removedBefore[low - 1] - (Math.min(seq, range.endSeq) - range.startSeq + 1);
    };
    const hiddenRows = new Set(hidden);
    const rows = raw.rows
      .filter((row) => !hiddenRows.has(row))
      .map((row) =>
        Object.assign({}, row, {
          seq: mapSeq(row.seq),
          seqStart: mapSeq(row.seqStart),
          seqEnd: mapSeq(row.seqEnd),
          sourceSeqRanges: row.sourceSeqRanges.map((range) => ({
            startSeq: mapSeq(range.startSeq),
            endSeq: mapSeq(range.endSeq),
          })),
        }),
      );
    const maxSeq = mapSeq(raw.window.maxSeq);
    return {
      ...raw,
      epoch: `${raw.epoch}:display-v1:${this.index?.revision ?? "unavailable"}`,
      rows,
      window: {
        minSeq: rows.length ? rows.reduce((min, row) => Math.min(min, row.seqStart), Infinity) : 0,
        maxSeq,
        nextSeq: maxSeq + 1,
      },
      mapSeq,
      hiddenRanges,
    };
  }

  sourceCursor(raw: AgentTimelineFetchResult, cursor: { epoch: string; seq: number }) {
    if (!this.enabled) return cursor;
    const view = this.project(raw);
    if (cursor.epoch !== view.epoch) throw new Error("History changed; reopen the conversation");
    for (const row of raw.rows) {
      if (
        view.hiddenRanges.some(
          (range) => range.startSeq <= row.seqStart && range.endSeq >= row.seqStart,
        )
      )
        continue;
      for (const range of row.sourceSeqRanges) {
        const start = view.mapSeq(range.startSeq);
        const end = view.mapSeq(range.endSeq);
        if (cursor.seq >= start && cursor.seq <= end)
          return { epoch: raw.epoch, seq: range.startSeq + cursor.seq - start };
      }
    }
    throw new Error("History checkpoint is unavailable");
  }

  fetch(
    raw: AgentTimelineFetchResult,
    options: AgentTimelineFetchOptions = {},
    streaming = false,
  ): AgentTimelineFetchResult {
    const view = this.project(raw, streaming);
    const direction = options.direction ?? "tail";
    const staleCursor = options.cursor !== undefined && options.cursor.epoch !== view.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      options.cursor !== undefined &&
      view.rows.length > 0 &&
      options.cursor.seq < view.window.minSeq - 1;
    const page = selectProjectedTimelinePage({
      rows: view.rows,
      bounds: view.rows.length ? view.window : undefined,
      direction: staleCursor || gap ? "tail" : direction,
      cursorSeq: options.cursor?.seq,
      limit: options.limit ?? 200,
    });
    return {
      epoch: view.epoch,
      direction,
      reset: staleCursor || gap,
      staleCursor,
      gap,
      window: view.window,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      rows: page.entries.map((row) => Object.assign({ seq: row.seqEnd }, row)),
    };
  }
}

export function withoutNativeDisplaySource(item: AgentTimelineItem): AgentTimelineItem {
  if (item.type !== "user_message") return item;
  const { clientMessageId: _nativeSource, ...nativeItem } = item;
  return nativeItem;
}
