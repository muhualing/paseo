import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { describe, expect, test, it } from "vitest";

import type { AgentTimelineRow } from "./agent-manager.js";
import {
  projectTimelineRows,
  selectProjectedTimelinePage,
  selectTimelineWindowByProjectedLimit,
} from "./timeline-projection.js";

describe("projectTimelineRows", () => {
  test("merges adjacent assistant chunks in projected mode", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "Hel" },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "lo" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: { type: "user_message", text: "next" },
      },
    ];

    const projected = projectTimelineRows({ rows, mode: "projected" });

    expect(projected).toHaveLength(2);
    expect(projected[0]?.item).toEqual({
      type: "assistant_message",
      text: "Hello",
    });
    expect(projected[0]?.seqStart).toBe(1);
    expect(projected[0]?.seqEnd).toBe(2);
    expect(projected[0]?.sourceSeqRanges).toEqual([{ startSeq: 1, endSeq: 2 }]);
    expect(projected[0]?.collapsed).toContain("assistant_merge");
  });

  test("merges adjacent assistant chunks with the same message id in projected mode", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "Hel", messageId: "msg-1" },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "lo", messageId: "msg-1" },
      },
    ];

    const projected = projectTimelineRows({ rows, mode: "projected" });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.item).toEqual({
      type: "assistant_message",
      text: "Hello",
      messageId: "msg-1",
    });
  });

  test("keeps adjacent assistant chunks with different message ids separate in projected mode", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "First answer.", messageId: "msg-1" },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "Second answer.", messageId: "msg-2" },
      },
    ];

    const projected = projectTimelineRows({ rows, mode: "projected" });

    expect(projected).toHaveLength(2);
    expect(projected[0]?.item).toEqual({
      type: "assistant_message",
      text: "First answer.",
      messageId: "msg-1",
    });
    expect(projected[1]?.item).toEqual({
      type: "assistant_message",
      text: "Second answer.",
      messageId: "msg-2",
    });
  });

  test("merges adjacent reasoning chunks in projected mode", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "reasoning", text: "Step " },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "reasoning", text: "by step" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: { type: "assistant_message", text: "done" },
      },
    ];

    const projected = projectTimelineRows({ rows, mode: "projected" });

    expect(projected).toHaveLength(2);
    expect(projected[0]?.item).toEqual({ type: "reasoning", text: "Step by step" });
    expect(projected[0]?.collapsed).toContain("reasoning_merge");
  });

  test("collapses tool lifecycle by callId and reports exact source seq ranges", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "running",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: null,
          },
        },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "working" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "completed",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: { stdout: "/tmp" },
          },
        },
      },
    ];

    const projected = projectTimelineRows({ rows, mode: "projected" });

    expect(projected).toHaveLength(2);
    const tool = projected[0];
    expect(tool?.item.type).toBe("tool_call");
    if (tool?.item.type === "tool_call") {
      expect(tool.item.status).toBe("completed");
      expect(tool.item.callId).toBe("call_1");
    }
    expect(tool?.sourceSeqRanges).toEqual([
      { startSeq: 1, endSeq: 1 },
      { startSeq: 3, endSeq: 3 },
    ]);
    expect(tool?.collapsed).toContain("tool_lifecycle");
  });

  test("replaces plugin rows with the same identity across turns", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        turnId: "turn-1",
        timestamp: "2026-02-13T00:00:00.000Z",
        item: {
          type: "plugin",
          id: "review-1",
          pluginId: "review",
          kind: "review",
          version: 1,
          data: { status: "running" },
        },
      },
      {
        seq: 2,
        turnId: "turn-2",
        timestamp: "2026-02-13T00:00:00.100Z",
        item: {
          type: "plugin",
          id: "review-1",
          pluginId: "review",
          kind: "review",
          version: 1,
          data: { status: "complete" },
        },
      },
    ];

    const projected = projectTimelineRows({ rows, mode: "projected" });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.item).toEqual(rows[1]?.item);
    expect(projected[0]?.turnId).toBe("turn-2");
    expect(projected[0]?.sourceSeqRanges).toEqual([{ startSeq: 1, endSeq: 2 }]);
    expect(projected[0]?.collapsed).toContain("identity");
  });

  test("returns canonical rows unchanged in canonical mode", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 10,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "A" },
      },
      {
        seq: 11,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "B" },
      },
    ];

    const projected = projectTimelineRows({ rows, mode: "canonical" });

    expect(projected).toHaveLength(2);
    expect(projected[0]?.item).toEqual(rows[0]?.item);
    expect(projected[1]?.item).toEqual(rows[1]?.item);
    expect(projected[0]?.collapsed).toEqual([]);
    expect(projected[1]?.collapsed).toEqual([]);
  });
});

describe("selectTimelineWindowByProjectedLimit", () => {
  test("tail limit selects canonical rows for the latest projected entries", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "Hel" },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.010Z",
        item: { type: "assistant_message", text: "lo" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.020Z",
        item: { type: "user_message", text: "next" },
      },
      {
        seq: 4,
        timestamp: "2026-02-13T00:00:00.030Z",
        item: { type: "assistant_message", text: "Wor" },
      },
      {
        seq: 5,
        timestamp: "2026-02-13T00:00:00.040Z",
        item: { type: "assistant_message", text: "ld" },
      },
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      direction: "tail",
      limit: 1,
    });

    expect(selected.minSeq).toBe(4);
    expect(selected.maxSeq).toBe(5);
    expect(selected.selectedRows.map((row) => row.seq)).toEqual([4, 5]);
    expect(selected.projectedEntries).toHaveLength(1);
    expect(selected.projectedEntries[0]?.item).toEqual({
      type: "assistant_message",
      text: "World",
    });
  });

  test("after limit selects canonical rows for the earliest projected entries", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 10,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "A" },
      },
      {
        seq: 11,
        timestamp: "2026-02-13T00:00:00.010Z",
        item: { type: "assistant_message", text: "B" },
      },
      {
        seq: 12,
        timestamp: "2026-02-13T00:00:00.020Z",
        item: { type: "user_message", text: "u1" },
      },
      {
        seq: 13,
        timestamp: "2026-02-13T00:00:00.030Z",
        item: { type: "user_message", text: "u2" },
      },
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      direction: "after",
      limit: 2,
    });

    expect(selected.minSeq).toBe(10);
    expect(selected.maxSeq).toBe(12);
    expect(selected.selectedRows.map((row) => row.seq)).toEqual([10, 11, 12]);
    expect(selected.projectedEntries).toHaveLength(2);
  });

  test("uses max seqEnd across selected projected entries when tool lifecycle seqEnd is non-monotonic", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "running",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: null,
          },
        },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "working" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "completed",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: { stdout: "/tmp" },
          },
        },
      },
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      direction: "tail",
      limit: 2,
    });

    expect(selected.projectedEntries).toHaveLength(2);
    expect(selected.minSeq).toBe(1);
    expect(selected.maxSeq).toBe(3);
    expect(selected.selectedRows.map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  test("expands projected entries for overlapping seq ranges", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "running",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: null,
          },
        },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "work" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: { type: "assistant_message", text: "ing" },
      },
      {
        seq: 4,
        timestamp: "2026-02-13T00:00:00.300Z",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "completed",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "pwd" },
            output: { stdout: "/tmp" },
          },
        },
      },
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      direction: "after",
      limit: 1,
    });

    expect(selected.minSeq).toBe(1);
    expect(selected.maxSeq).toBe(4);
    expect(selected.selectedRows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(selected.projectedEntries).toHaveLength(2);
    expect(selected.projectedEntries.map((entry) => entry.item.type)).toEqual([
      "tool_call",
      "assistant_message",
    ]);
  });

  test("before direction selects the latest projected entries from the earlier window", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-02-13T00:00:00.000Z",
        item: { type: "assistant_message", text: "a" },
      },
      {
        seq: 2,
        timestamp: "2026-02-13T00:00:00.100Z",
        item: { type: "assistant_message", text: "b" },
      },
      {
        seq: 3,
        timestamp: "2026-02-13T00:00:00.200Z",
        item: { type: "user_message", text: "u1" },
      },
      {
        seq: 4,
        timestamp: "2026-02-13T00:00:00.300Z",
        item: { type: "user_message", text: "u2" },
      },
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      direction: "before",
      limit: 1,
    });

    expect(selected.minSeq).toBe(4);
    expect(selected.maxSeq).toBe(4);
    expect(selected.selectedRows.map((row) => row.seq)).toEqual([4]);
    expect(selected.projectedEntries).toHaveLength(1);
    expect(selected.projectedEntries[0]?.item).toEqual({
      type: "user_message",
      text: "u2",
    });
  });

  test("tail limit treats a repeated running tool call as one projected item", () => {
    const rows: AgentTimelineRow[] = [
      ...Array.from({ length: 6 }, (_, index) => ({
        seq: index + 1,
        timestamp: `2026-02-13T00:00:00.00${index}Z`,
        item: { type: "assistant_message" as const, text: `old ${index}` },
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        seq: index + 7,
        timestamp: `2026-02-13T00:00:01.0${index}Z`,
        item: {
          type: "tool_call" as const,
          callId: "call_1",
          name: "shell",
          status: "running" as const,
          error: null,
          detail: {
            type: "unknown" as const,
            input: { cmd: "sleep 10" },
            output: { progress: index },
          },
        },
      })),
    ];

    const selected = selectTimelineWindowByProjectedLimit({
      rows,
      direction: "tail",
      limit: 100,
    });

    const tools = selected.projectedEntries.filter((entry) => entry.item.type === "tool_call");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.collapsed).toContain("tool_lifecycle");
    expect(selected.projectedEntries).toHaveLength(2);
  });
});

describe("selectProjectedTimelinePage", () => {
  function toolRow(seq: number, status: "running" | "completed"): AgentTimelineRow {
    return {
      seq,
      timestamp: new Date(1000 + seq).toISOString(),
      item: {
        type: "tool_call",
        callId: "call_1",
        name: "shell",
        status,
        error: null,
        detail: {
          type: "unknown",
          input: { cmd: "sleep 10" },
          output: status === "completed" ? { stdout: "done" } : null,
        },
      },
    };
  }

  test("tail page returns full projected items instead of tool lifecycle deltas", () => {
    const rows: AgentTimelineRow[] = [
      { seq: 1, timestamp: "2026-02-13T00:00:00.000Z", item: { type: "user_message", text: "go" } },
      ...Array.from({ length: 120 }, (_, index) => toolRow(index + 2, "running")),
    ];

    const page = selectProjectedTimelinePage({ rows, direction: "tail", limit: 100 });

    expect(page.entries.map((entry) => entry.item.type)).toEqual(["user_message", "tool_call"]);
    expect(page.entries[1]?.collapsed).toContain("tool_lifecycle");
    expect(page.entries[1]?.sourceSeqRanges).toEqual([{ startSeq: 2, endSeq: 121 }]);
    expect(page.startSeq).toBe(1);
    expect(page.endSeq).toBe(121);
    expect(page.hasNewer).toBe(false);
  });

  test("after page includes a full projected tool item when only its update is new", () => {
    const rows: AgentTimelineRow[] = [
      toolRow(10, "running"),
      {
        seq: 11,
        timestamp: "2026-02-13T00:00:00.011Z",
        item: { type: "assistant_message", text: "working" },
      },
      toolRow(250, "completed"),
    ];

    const page = selectProjectedTimelinePage({
      rows,
      direction: "after",
      cursorSeq: 249,
      limit: 100,
    });

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.item.type).toBe("tool_call");
    expect(page.entries[0]?.seqStart).toBe(10);
    expect(page.entries[0]?.seqEnd).toBe(250);
    expect(page.entries[0]?.sourceSeqRanges).toEqual([
      { startSeq: 10, endSeq: 10 },
      { startSeq: 250, endSeq: 250 },
    ]);
    expect(page.startSeq).toBe(250);
    expect(page.endSeq).toBe(250);
  });

  test("after page cursor advances only through contiguously covered seqs", () => {
    const rows: AgentTimelineRow[] = [
      toolRow(1, "running"),
      ...Array.from({ length: 498 }, (_, index) => ({
        seq: index + 2,
        timestamp: new Date(2000 + index).toISOString(),
        item: { type: "user_message" as const, text: `middle ${index + 2}` },
      })),
      toolRow(500, "completed"),
      ...Array.from({ length: 101 }, (_, index) => ({
        seq: index + 501,
        timestamp: new Date(3000 + index).toISOString(),
        item: { type: "user_message" as const, text: `later ${index + 501}` },
      })),
    ];

    const page = selectProjectedTimelinePage({
      rows,
      direction: "after",
      cursorSeq: 0,
      limit: 100,
    });

    expect(page.entries[0]?.item.type).toBe("tool_call");
    expect(
      page.entries.some((entry) => entry.item.type === "user_message" && entry.seqStart === 101),
    ).toBe(false);
    expect(page.endSeq).toBe(100);
    expect(page.hasNewer).toBe(true);
  });

  test("after limit counts projected entries while preserving their canonical sequence coverage", () => {
    const rows: AgentTimelineRow[] = [
      ...Array.from({ length: 200 }, (_, index) => ({
        seq: index + 1,
        timestamp: new Date(1000 + index).toISOString(),
        item: { type: "assistant_message" as const, text: "x" },
      })),
      ...Array.from({ length: 150 }, (_, index) => ({
        seq: index + 201,
        timestamp: new Date(2000 + index).toISOString(),
        item: { type: "user_message" as const, text: `message ${index + 1}` },
      })),
    ];

    const page = selectProjectedTimelinePage({
      rows,
      direction: "after",
      cursorSeq: 0,
      limit: 100,
    });

    expect({
      entryCount: page.entries.length,
      firstEntry: page.entries[0],
      lastEntry: page.entries.at(-1),
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      hasNewer: page.hasNewer,
    }).toEqual({
      entryCount: 100,
      firstEntry: {
        item: {
          type: "assistant_message",
          text: "x".repeat(200),
        },
        timestamp: new Date(1199).toISOString(),
        seqStart: 1,
        seqEnd: 200,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 200 }],
        collapsed: ["assistant_merge"],
      },
      lastEntry: {
        item: { type: "user_message", text: "message 99" },
        timestamp: new Date(2098).toISOString(),
        seqStart: 299,
        seqEnd: 299,
        sourceSeqRanges: [{ startSeq: 299, endSeq: 299 }],
        collapsed: [],
      },
      startSeq: 1,
      endSeq: 299,
      hasNewer: true,
    });
  });

  test("before limit counts projected entries without repeating a merged assistant", () => {
    const rows: AgentTimelineRow[] = [
      ...Array.from({ length: 80 }, (_, index) => ({
        seq: index + 1,
        timestamp: new Date(1000 + index).toISOString(),
        item: { type: "assistant_message" as const, text: "x" },
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        seq: index + 81,
        timestamp: new Date(2000 + index).toISOString(),
        item: { type: "user_message" as const, text: `message ${index + 1}` },
      })),
    ];

    const newest = selectProjectedTimelinePage({
      rows,
      direction: "before",
      cursorSeq: 85,
      limit: 2,
    });
    const middle = selectProjectedTimelinePage({
      rows,
      direction: "before",
      cursorSeq: newest.startSeq ?? 0,
      limit: 2,
    });
    const oldest = selectProjectedTimelinePage({
      rows,
      direction: "before",
      cursorSeq: middle.startSeq ?? 0,
      limit: 2,
    });
    const exhausted = selectProjectedTimelinePage({
      rows,
      direction: "before",
      cursorSeq: oldest.startSeq ?? 0,
      limit: 2,
    });

    const pageSummaries = [];
    for (const page of [newest, middle, oldest]) {
      pageSummaries.push({
        entryTypes: page.entries.map((entry) => entry.item.type),
        startSeq: page.startSeq,
        endSeq: page.endSeq,
        hasOlder: page.hasOlder,
      });
    }
    expect(pageSummaries).toEqual([
      { entryTypes: ["user_message", "user_message"], startSeq: 83, endSeq: 84, hasOlder: true },
      { entryTypes: ["user_message", "user_message"], startSeq: 81, endSeq: 82, hasOlder: true },
      { entryTypes: ["assistant_message"], startSeq: 1, endSeq: 80, hasOlder: false },
    ]);
    expect(exhausted.entries).toEqual([]);
  });

  test("before pages place a full wide tool on the page containing its projected anchor", () => {
    const rows: AgentTimelineRow[] = [
      toolRow(1, "running"),
      ...Array.from({ length: 498 }, (_, index) => ({
        seq: index + 2,
        timestamp: new Date(2000 + index).toISOString(),
        item: { type: "user_message" as const, text: `middle ${index + 2}` },
      })),
      toolRow(500, "completed"),
    ];

    const newestPage = selectProjectedTimelinePage({
      rows,
      direction: "before",
      cursorSeq: 500,
      limit: 100,
    });
    const anchoredPage = selectProjectedTimelinePage({
      rows,
      direction: "before",
      cursorSeq: 101,
      limit: 100,
    });

    expect(newestPage.entries).toHaveLength(100);
    expect(newestPage.entries.some((entry) => entry.item.type === "tool_call")).toBe(false);
    expect(newestPage.startSeq).toBe(400);
    expect(newestPage.endSeq).toBe(499);
    expect(newestPage.hasOlder).toBe(true);

    expect(anchoredPage.entries).toHaveLength(100);
    expect(anchoredPage.entries[0]?.item.type).toBe("tool_call");
    expect(anchoredPage.entries[0]?.seqStart).toBe(1);
    expect(anchoredPage.entries[0]?.seqEnd).toBe(500);
    expect(anchoredPage.startSeq).toBe(1);
    expect(anchoredPage.endSeq).toBe(100);
    expect(anchoredPage.hasOlder).toBe(false);
  });

  test("tail page includes a wide tool when its completion is the newest seq", () => {
    const rows: AgentTimelineRow[] = [
      toolRow(1, "running"),
      ...Array.from({ length: 499 }, (_, index) => ({
        seq: index + 2,
        timestamp: new Date(2000 + index).toISOString(),
        item: { type: "user_message" as const, text: `middle ${index + 2}` },
      })),
      toolRow(501, "completed"),
    ];

    const page = selectProjectedTimelinePage({ rows, direction: "tail", limit: 100 });

    expect(page.entries.some((entry) => entry.item.type === "tool_call")).toBe(true);
    expect(page.endSeq).toBe(501);
  });
});

import {
  TimelineDisplay,
  historicalDisplayRevision,
  readHistoricalDisplayIndex,
  textDigest,
  isStandaloneQuietText,
} from "./timeline-display.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("server timeline display", () => {
  const nativeId = "fbd6bc94-215b-4ba4-b7fd-3abf2bf629d1";
  const old = "[cto-watch 兜底] project=example issue=https://example.test/1\nevent";
  const record = { nativeMessageId: nativeId, exactTextSha256: textDigest(old) };
  const index = {
    schemaVersion: 1 as const,
    revision: historicalDisplayRevision([record]),
    records: [record],
  };
  const raw = (items: AgentTimelineItem[]) => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("display", { items, epoch: "audit" });
    return store.fetch("display", { limit: 0 });
  };
  it("requires both historical identity and exact text and preserves ordinary provenance", () => {
    const source = raw([
      { type: "user_message", text: old, messageId: nativeId },
      { type: "user_message", text: old, messageId: "different" },
      { type: "user_message", text: `${old}\nWhy?`, messageId: nativeId },
      { type: "user_message", text: old, messageId: nativeId, clientMessageId: "ordinary" },
      { type: "user_message", text: old, clientMessageId: "cto-watch:old" },
      { type: "user_message", text: old },
    ]);
    const view = new TimelineDisplay(index).fetch(source, { limit: 0 });
    expect(view.rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(view.rows.map((row) => row.item)).toEqual([
      source.rows[1].item,
      source.rows[2].item,
      source.rows[3].item,
      source.rows[5].item,
    ]);
    expect(source.window.maxSeq).toBe(6);
    expect(new TimelineDisplay(null).fetch(source, { limit: 0 }).rows).toHaveLength(5);
    expect(new TimelineDisplay(index, false).fetch(source, { limit: 0 }).epoch).toBe("audit");
    expect(new TimelineDisplay(index, false).fetch(source, { limit: 0 }).rows).toEqual(source.rows);
  });
  it("keeps batched-format pastes and mismatched body digests visible", () => {
    const text = "[cto-watch 事件] 按一手证据推进；自述需复验。\nfirst\nsecond";
    const source = raw([
      { type: "user_message", text, clientMessageId: `cto-watch:${textDigest(text)}` },
      { type: "user_message", text, clientMessageId: "cto-watch:wrong" },
      { type: "user_message", text, clientMessageId: "ordinary" },
    ]);
    expect(new TimelineDisplay(null).fetch(source).rows.map((row) => row.item)).toEqual(
      source.rows.slice(1).map((row) => row.item),
    );
  });
  it("suppresses every streaming marker prefix while retaining body, code examples and separators", () => {
    const marker = "<cto-watch-quiet/>";
    for (let length = 1; length <= marker.length; length++)
      expect(isStandaloneQuietText(marker.slice(0, length), true)).toBe(true);
    expect(isStandaloneQuietText("---\n<cto-watch-quiet/>\n___")).toBe(true);
    expect(isStandaloneQuietText("  \n\t")).toBe(true);
    for (const text of [
      "---",
      "    <cto-watch-quiet/>",
      "`<cto-watch-quiet/>`",
      `${marker}\nProgress: 3 checks passed`,
      "<",
    ])
      expect(isStandaloneQuietText(text)).toBe(false);
  });
  it("pages across a completely hidden window and rejects cursors from another display revision", () => {
    const source = raw(
      Array.from({ length: 500 }, () => ({
        type: "user_message" as const,
        text: old,
        clientMessageId: "cto-watch:old",
      })),
    );
    const display = new TimelineDisplay(null);
    const page = display.fetch(source, {
      direction: "after",
      cursor: { epoch: "audit:display-v1:unavailable", seq: 0 },
      limit: 1,
    });
    expect(page.window).toEqual({ minSeq: 0, maxSeq: 0, nextSeq: 1 });
    expect(page.rows).toEqual([]);
    expect(page.hasNewer).toBe(false);
    expect(page.hasOlder).toBe(false);
    expect(display.fetch(source, { cursor: { epoch: "audit", seq: 1 } }).staleCursor).toBe(true);
  });
  it("accepts only a bounded, private, regular, revision-validated historical index", () => {
    const directory = mkdtempSync(join(tmpdir(), "display-index-"));
    const file = join(directory, "index.json");
    try {
      expect(readHistoricalDisplayIndex(file)).toBeNull();
      writeFileSync(file, JSON.stringify(index), { mode: 0o600 });
      expect(readHistoricalDisplayIndex(file)).toEqual(index);
      symlinkSync(file, join(directory, "link"));
      expect(readHistoricalDisplayIndex(join(directory, "link"))).toBeNull();
      chmodSync(file, 0o644);
      expect(readHistoricalDisplayIndex(file)).toBeNull();
      chmodSync(file, 0o600);
      for (const bad of [
        { ...index, revision: "0".repeat(64) },
        { ...index, records: [record, record] },
        { ...index, records: [{ ...record, nativeMessageId: "not-native" }] },
      ]) {
        writeFileSync(file, JSON.stringify(bad));
        expect(readHistoricalDisplayIndex(file)).toBeNull();
      }
      writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 1));
      expect(readHistoricalDisplayIndex(file)).toBeNull();
      writeFileSync(file, Buffer.from([0xff]));
      expect(readHistoricalDisplayIndex(file)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
