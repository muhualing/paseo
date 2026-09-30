import { describe, expect, it } from "vitest";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { buildTimelinePromptIndex } from "./timeline-prompt-index.js";

describe("buildTimelinePromptIndex", () => {
  it("indexes every canonical user prompt with a stable timeline position", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 3,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "  First\n\n   prompt  " },
      },
      {
        seq: 4,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "response" },
      },
      {
        seq: 8,
        timestamp: "2026-01-01T00:00:02.000Z",
        item: { type: "user_message", text: "Second prompt" },
      },
    ];

    expect(buildTimelinePromptIndex("epoch-1", rows)).toEqual({
      epoch: "epoch-1",
      prompts: [
        { seq: 3, timestamp: "2026-01-01T00:00:00.000Z", preview: "First prompt" },
        { seq: 8, timestamp: "2026-01-01T00:00:02.000Z", preview: "Second prompt" },
      ],
    });
  });

  it("bounds previews without indexing assistant rows", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "x".repeat(200) },
      },
      {
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "ignored" },
      },
    ];

    const result = buildTimelinePromptIndex("epoch-1", rows);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]?.preview).toHaveLength(120);
    expect(result.prompts[0]?.preview.endsWith("…")).toBe(true);
  });
});

it("serves exact source identities only on bounded opt-in pages without changing legacy previews", () => {
  const text = " automatic\n input " + "x".repeat(200);
  const rows: AgentTimelineRow[] = Array.from({ length: 55 }, (_, seq) => ({
    seq,
    timestamp: "2026-01-01",
    item: {
      type: "user_message",
      text,
      messageId: `message-${seq}`,
      clientMessageId: seq === 0 ? "scheduled:1" : "ordinary:1",
    },
  }));
  const first = buildTimelinePromptIndex("epoch", rows, { includeItems: true });
  expect(first.prompts).toHaveLength(50);
  expect(first.prompts[0].item).toEqual(rows[0].item);
  expect(first.nextCursor).toBe(49);
  const next = buildTimelinePromptIndex("epoch", rows, { includeItems: true, cursor: 49 });
  expect(next.prompts.map((p) => p.seq)).toEqual([50, 51, 52, 53, 54]);
  expect(next.nextCursor).toBeNull();
  expect(buildTimelinePromptIndex("epoch", rows).prompts[0]).not.toHaveProperty("item");
  expect(rows[0].item.text).toBe(text);
});

it("does not truncate a source body into a misleading hash input or send oversized bodies", () => {
  const rows: AgentTimelineRow[] = [
    { seq: 1, timestamp: "now", item: { type: "user_message", text: "x".repeat(70000) } },
  ];
  const page = buildTimelinePromptIndex("epoch", rows, { includeItems: true });
  expect(page.prompts[0].item).toBeUndefined();
  expect(page.prompts[0].preview).toHaveLength(120);
  expect(page.nextCursor).toBeNull();
});

it("caps a source page by byte budget before reaching the row limit", () => {
  const rows: AgentTimelineRow[] = Array.from({ length: 10 }, (_, seq) => ({
    seq,
    timestamp: "now",
    item: { type: "user_message", text: "x".repeat(40000) },
  }));
  const page = buildTimelinePromptIndex("epoch", rows, { includeItems: true });
  expect(page.prompts).toHaveLength(6);
  expect(page.nextCursor).toBe(5);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(262144);
});
