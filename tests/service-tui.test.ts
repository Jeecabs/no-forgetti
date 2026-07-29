import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { ReviewServiceMonitor } from "../src/service/monitor.ts";
import { formatReviewServiceMonitorText, type MemoryMonitorSummary, renderReviewServiceMonitorCard } from "../src/service/tui.ts";

// Pi wraps every rendered line in colour, so the card must stay width-exact with
// escape codes present: a line wider than the overlay crashes the TUI renderer.
const theme = {
  fg: (color: string, text: string) => `[38;5;42m${text}[0m<${color}>`.replace(`<${color}>`, ""),
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `[1m${text}[0m`,
} as unknown as Theme;

const observedAt = "2026-07-26T06:00:00.000Z";

const memory: MemoryMonitorSummary = {
  projectRoot: "/Users/example/no-forgetti",
  branch: "main",
  entries: 13,
  usedChars: 2_307,
  maxChars: 4_000,
};

const base: ReviewServiceMonitor = {
  mode: "external",
  reviewer: {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxCallsPerDay: 100,
    maxTokensPerDay: 500_000,
    maxCostPerDayUsd: 10,
  },
  budget: {
    day: "2026-07-26",
    calls: 1,
    tokens: 784,
    costUsd: 0.0047,
    charged: { calls: 1, tokens: 784, costNanodollars: 4_700_000 },
    held: { calls: 0, tokens: 0, costNanodollars: 0 },
    unknown: { calls: 0, tokens: 0, costNanodollars: 0 },
  },
  spool: { queued: 0, running: 0, outcomes: 1, deadLetter: 0 },
  worker: { version: 1, workerId: "w", pid: 54_742, startedAt: observedAt, updatedAt: observedAt, state: "idle" },
  workerFresh: true,
  exhausted: [],
  observedAt,
};

const cases: Array<[string, ReviewServiceMonitor]> = [
  ["ready", base],
  ["working", {
    ...base,
    worker: { ...base.worker!, state: "working" },
    spool: { queued: 3, running: 1, outcomes: 12, deadLetter: 2 },
    budget: { ...base.budget, calls: 78, tokens: 412_000, costUsd: 8.4 },
  }],
  ["exhausted", {
    ...base,
    exhausted: ["calls", "tokens"],
    budget: { ...base.budget, calls: 100, tokens: 500_000, costUsd: 9.99 },
  }],
  ["stale worker", { ...base, workerFresh: false }],
  ["no reviewer", { mode: "embedded", budget: base.budget, spool: base.spool, workerFresh: false, exhausted: [], observedAt }],
];

test("monitor card renders width-exact lines at every terminal width", () => {
  for (const [name, snapshot] of cases) {
    for (const width of [78, 60, 40, 24]) {
      for (const refreshing of [false, true]) {
        const lines = renderReviewServiceMonitorCard({
          theme,
          snapshot,
          memory,
          width,
          refreshing,
          error: refreshing ? "spool unreachable" : undefined,
        });
        for (const [index, line] of lines.entries()) {
          assert.equal(visibleWidth(line), width, `${name} @${width} line ${index}: ${JSON.stringify(line)}`);
        }
      }
    }
  }
});

test("monitor includes current-project review phase and debug identity", () => {
  const reviewId = `review_${"a".repeat(40)}`;
  const activeMemory: MemoryMonitorSummary = {
    ...memory,
    reviews: [{ jobId: reviewId, phase: "retrying", attempt: 2, retryAt: observedAt }],
  };
  const text = formatReviewServiceMonitorText(base, activeMemory);
  assert.match(text, new RegExp(`project review: retrying attempt 2 ${reviewId}`, "u"));
  const card = renderReviewServiceMonitorCard({ theme, snapshot: base, memory: activeMemory, width: 78 })
    .join("\n")
    .replaceAll(/\u001B\[[\d;]*m/gu, "");
  assert.match(card, /project job/u);
  assert.match(card, /retrying attempt 2 review_/u);
});

test("monitor card surfaces exhausted limits and stale workers", () => {
  const strip = (lines: string[]) => lines.join("\n").replaceAll(/\[[\d;]*m/gu, "");

  const exhausted = strip(renderReviewServiceMonitorCard({ theme, snapshot: cases[2]![1], memory, width: 78 }));
  assert.match(exhausted, /limit reached/u);
  assert.match(exhausted, /calls and tokens/u);

  const stale = strip(renderReviewServiceMonitorCard({ theme, snapshot: cases[3]![1], memory, width: 78 }));
  assert.match(stale, /worker offline/u);
  assert.match(stale, /heartbeat is stale/u);

  // Labels stay in sentence case; the old build shouted every row header.
  assert.doesNotMatch(strip(renderReviewServiceMonitorCard({ theme, snapshot: base, memory, width: 78 })), /\b[A-Z]{4,}\b/u);
});
