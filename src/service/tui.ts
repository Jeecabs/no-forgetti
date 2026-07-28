import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { ReviewServiceMonitor } from "./monitor.ts";

export interface MemoryMonitorSummary {
  projectRoot: string;
  branch: string;
  entries: number;
  usedChars: number;
  maxChars: number;
}

type Theme = ExtensionCommandContext["ui"]["theme"];
type StatusColor = "success" | "warning" | "error" | "muted";

/** Fixed card width: the content is fixed-size, so a stretched banner only hurts scanning. */
const CARD_WIDTH = 78;
const LABEL_WIDTH = 10;

function money(value: number): string {
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function ratio(used: number, limit: number): number {
  return limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
}

function meter(theme: Theme, used: number, limit: number, width: number): string {
  const fraction = ratio(used, limit);
  // Any non-zero usage shows at least one segment, so "barely started" never reads as "idle".
  const filled = used > 0 ? Math.max(1, Math.round(fraction * width)) : 0;
  const color = fraction >= 1 ? "error" : fraction >= 0.8 ? "warning" : "success";
  return theme.fg(color, "━".repeat(filled)) + theme.fg("dim", "─".repeat(width - filled));
}

function age(value: string, observedAt: string): string {
  const elapsed = Math.max(0, new Date(observedAt).getTime() - new Date(value).getTime());
  if (elapsed < 1_000) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

function serviceState(snapshot: ReviewServiceMonitor): { label: string; color: StatusColor } {
  if (snapshot.mode === "embedded") return { label: "embedded", color: "muted" };
  if (snapshot.exhausted.length > 0) return { label: "limit reached", color: "error" };
  if (snapshot.workerCompatible === false) return { label: "restart required", color: "warning" };
  if (!snapshot.workerFresh) return { label: "worker offline", color: "warning" };
  if (snapshot.worker?.state === "working") return { label: "reviewing", color: "success" };
  if (snapshot.worker?.state === "waiting-retry") return { label: "waiting to retry", color: "warning" };
  return { label: "ready", color: "success" };
}

function stateSummary(snapshot: ReviewServiceMonitor): string {
  const state = serviceState(snapshot);
  return snapshot.exhausted.length > 0 ? `${state.label} · ${snapshot.exhausted.join(" + ")}` : state.label;
}

export function formatReviewServiceMonitorText(
  snapshot: ReviewServiceMonitor,
  memory: MemoryMonitorSummary,
): string {
  const reviewer = snapshot.reviewer ? `${snapshot.reviewer.provider}/${snapshot.reviewer.model}` : "active Pi model";
  const worker = snapshot.worker
    ? `${snapshot.worker.state}${snapshot.workerFresh ? "" : " (stale)"} · pid ${snapshot.worker.pid} · updated ${age(snapshot.worker.updatedAt, snapshot.observedAt)}`
    : "not running";
  const limits = snapshot.reviewer;
  return [
    "No Forgetti review service",
    `state: ${stateSummary(snapshot)}`,
    `mode: ${snapshot.mode}`,
    `reviewer: ${reviewer}`,
    `worker: ${worker}`,
    `queue: ${snapshot.spool.queued} queued · ${snapshot.spool.running} running · ${snapshot.spool.outcomes} outcomes · ${snapshot.spool.deadLetter} dead-letter`,
    `calls: ${snapshot.budget.calls}/${limits?.maxCallsPerDay ?? "n/a"}`,
    `tokens: ${snapshot.budget.tokens}/${limits?.maxTokensPerDay ?? "n/a"}`,
    `cost: ${money(snapshot.budget.costUsd)}/${limits ? money(limits.maxCostPerDayUsd) : "n/a"}`,
    ...(snapshot.budget.charged && snapshot.budget.held && snapshot.budget.unknown ? [
      `attempts: ${snapshot.budget.charged.calls} settled · ${snapshot.budget.held.calls} held · ${snapshot.budget.unknown.calls} unknown`,
    ] : []),
    `budget day: ${snapshot.budget.day} UTC`,
    `active memory: ${memory.branch} · ${memory.entries} entries · ${memory.usedChars}/${memory.maxChars} chars`,
    `project: ${memory.projectRoot}`,
  ].join("\n");
}

/**
 * Draws the monitor as a closed card.
 *
 * An overlay only repaints the columns it occupies, so a panel framed by bare
 * horizontal rules leaves the editor and footer visible along both flanks with
 * nothing marking where the panel starts. Four sides fix that.
 */
export interface ReviewServiceMonitorCard {
  theme: Theme;
  snapshot: ReviewServiceMonitor;
  memory: MemoryMonitorSummary;
  width: number;
  refreshing?: boolean;
  error?: string;
}

export function renderReviewServiceMonitorCard(
  { theme, snapshot, memory, width, refreshing = false, error }: ReviewServiceMonitorCard,
): string[] {
  const state = serviceState(snapshot);
  const reviewer = snapshot.reviewer;
  const budget = snapshot.budget;
  const inner = Math.max(8, width - 4);
  const edge = (text: string) => theme.fg("borderMuted", text);

  const pad = (content: string) => {
    const gap = inner - visibleWidth(content);
    return gap >= 0 ? content + " ".repeat(gap) : truncateToWidth(content, inner);
  };
  const line = (content = "") => `${edge("│")} ${pad(content)} ${edge("│")}`;
  const split = (left: string, right: string) => {
    const gap = inner - visibleWidth(left) - visibleWidth(right);
    return gap >= 1 ? left + " ".repeat(gap) + right : left;
  };
  const row = (label: string, value: string) => line(theme.fg("dim", label.padEnd(LABEL_WIDTH)) + value);

  // "╭─ " + title + " " + at least one rule + "╮" — narrow terminals clamp the overlay,
  // so the title has to give way rather than push the frame past the width.
  const title = truncateToWidth(
    `${theme.fg("accent", theme.bold("no forgetti"))} ${theme.fg("muted", "· external review monitor")}`,
    Math.max(1, width - 6),
  );
  const lines: string[] = [
    edge("╭─ ") + title + " " + edge("─".repeat(Math.max(1, width - 5 - visibleWidth(title))) + "╮"),
    line(),
    line(split(
      `${theme.fg(state.color, "●")} ${theme.fg(state.color, theme.bold(state.label))}`,
      theme.fg("dim", `${snapshot.mode} authority`),
    )),
    line(),
    row("memory", `${memory.branch} · ${memory.entries} entries · ${memory.usedChars.toLocaleString()}/${memory.maxChars.toLocaleString()} chars`),
    row("reviewer", reviewer ? `${reviewer.provider}/${reviewer.model} · reasoning ${reviewer.reasoningEffort}` : theme.fg("warning", "not configured")),
    row("worker", snapshot.worker
      ? `${snapshot.worker.state} · pid ${snapshot.worker.pid} · heartbeat ${age(snapshot.worker.updatedAt, snapshot.observedAt)}`
        + (snapshot.workerFresh ? "" : theme.fg("warning", " · stale"))
      : theme.fg("warning", "not running")),
    row("spool", `${snapshot.spool.queued} queued · ${snapshot.spool.running} running`
      + ` · ${snapshot.spool.outcomes} outcome${snapshot.spool.outcomes === 1 ? "" : "s"} · ${snapshot.spool.deadLetter} dead`),
  ];

  if (reviewer) {
    const used = [budget.calls.toLocaleString(), budget.tokens.toLocaleString(), money(budget.costUsd)];
    const cap = [
      reviewer.maxCallsPerDay.toLocaleString(),
      reviewer.maxTokensPerDay.toLocaleString(),
      money(reviewer.maxCostPerDayUsd),
    ];
    // Fixed number columns: the three ratios stack, and the bars all start at the
    // same offset and run to the frame instead of leaving a ragged gutter.
    const usedWidth = Math.max(...used.map((value) => value.length));
    const capWidth = Math.max(...cap.map((value) => value.length));
    const barWidth = Math.max(6, inner - LABEL_WIDTH - usedWidth - capWidth - 5);
    const gauge = (index: number, current: number, limit: number) =>
      `${used[index]!.padStart(usedWidth)} ${theme.fg("dim", "/")} ${theme.fg("muted", cap[index]!.padEnd(capWidth))}`
      + `  ${meter(theme, current, limit, barWidth)}`;

    lines.push(
      line(),
      line(split(theme.fg("muted", "daily budget"), theme.fg("dim", `${budget.day} utc`))),
      row("calls", gauge(0, budget.calls, reviewer.maxCallsPerDay)),
      row("tokens", gauge(1, budget.tokens, reviewer.maxTokensPerDay)),
      row("cost", gauge(2, budget.costUsd, reviewer.maxCostPerDayUsd)),
    );
    if (budget.charged && budget.held && budget.unknown) {
      lines.push(row("attempts", `${budget.charged.calls} settled · ${budget.held.calls} held · ${budget.unknown.calls} unknown`));
    }
  }

  const notice = snapshot.exhausted.length > 0
    ? { color: "error" as const, text: `limit reached on ${snapshot.exhausted.join(" and ")} · resumes next utc day` }
    : snapshot.workerCompatible === false
      ? { color: "warning" as const, text: "worker memory policy is outdated · restart the managed worker" }
    : !snapshot.workerFresh && snapshot.mode === "external"
      ? { color: "warning" as const, text: "worker heartbeat is stale · queued evidence stays durable" }
      : error
        ? { color: "error" as const, text: `refresh failed: ${error}` }
        : undefined;
  if (notice) lines.push(line(), line(`${theme.fg(notice.color, "▌")} ${theme.fg(notice.color, notice.text)}`));

  lines.push(
    line(),
    line(theme.fg("dim", `${refreshing ? "refreshing…" : "r refresh"}   esc close   limits reset 00:00 utc`)),
    edge("╰" + "─".repeat(Math.max(1, width - 2)) + "╯"),
  );
  return lines;
}

export async function showReviewServiceMonitor(
  ctx: ExtensionCommandContext,
  initial: ReviewServiceMonitor,
  memory: MemoryMonitorSummary,
  load: () => Promise<ReviewServiceMonitor>,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let snapshot = initial;
    let refreshing = false;
    let error: string | undefined;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      error = undefined;
      tui.requestRender();
      try {
        snapshot = await load();
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      } finally {
        refreshing = false;
        tui.requestRender();
      }
    };
    return {
      render(width) {
        return renderReviewServiceMonitorCard({ theme, snapshot, memory, width, refreshing, error });
      },
      invalidate() {},
      handleInput(data) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") done();
        else if (data.toLowerCase() === "r") void refresh();
      },
    };
  }, {
    overlay: true,
    overlayOptions: { width: CARD_WIDTH, maxHeight: "90%", anchor: "center", margin: 1 },
  });
}
