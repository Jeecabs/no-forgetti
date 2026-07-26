import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

import type { ReviewServiceMonitor } from "./monitor.ts";

export interface MemoryMonitorSummary {
  projectRoot: string;
  branch: string;
  entries: number;
  usedChars: number;
  maxChars: number;
}

type Theme = ExtensionCommandContext["ui"]["theme"];

function money(value: number): string {
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function ratio(used: number, limit: number): number {
  return limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
}

function meter(theme: Theme, used: number, limit: number, width = 18): string {
  const filled = Math.round(ratio(used, limit) * width);
  const color = used >= limit ? "error" : used / limit >= 0.8 ? "warning" : "success";
  return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

function age(value: string, observedAt: string): string {
  const elapsed = Math.max(0, new Date(observedAt).getTime() - new Date(value).getTime());
  if (elapsed < 1_000) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

function serviceState(snapshot: ReviewServiceMonitor): { label: string; color: "success" | "warning" | "error" | "muted" } {
  if (snapshot.mode === "embedded") return { label: "EMBEDDED", color: "muted" };
  if (snapshot.exhausted.length > 0) return { label: `LIMIT REACHED · ${snapshot.exhausted.join(" + ")}`, color: "error" };
  if (!snapshot.workerFresh) return { label: "WORKER OFFLINE", color: "warning" };
  if (snapshot.worker?.state === "working") return { label: "REVIEWING", color: "success" };
  if (snapshot.worker?.state === "waiting-retry") return { label: "WAITING TO RETRY", color: "warning" };
  return { label: "READY", color: "success" };
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
    `state: ${serviceState(snapshot).label.toLowerCase()}`,
    `mode: ${snapshot.mode}`,
    `reviewer: ${reviewer}`,
    `worker: ${worker}`,
    `queue: ${snapshot.spool.queued} queued · ${snapshot.spool.running} running · ${snapshot.spool.outcomes} outcomes · ${snapshot.spool.deadLetter} dead-letter`,
    `calls: ${snapshot.budget.calls}/${limits?.maxCallsPerDay ?? "n/a"}`,
    `tokens: ${snapshot.budget.tokens}/${limits?.maxTokensPerDay ?? "n/a"}`,
    `cost: ${money(snapshot.budget.costUsd)}/${limits ? money(limits.maxCostPerDayUsd) : "n/a"}`,
    `budget day: ${snapshot.budget.day} UTC`,
    `active memory: ${memory.branch} · ${memory.entries} entries · ${memory.usedChars}/${memory.maxChars} chars`,
    `project: ${memory.projectRoot}`,
  ].join("\n");
}

function dashboard(
  theme: Theme,
  snapshot: ReviewServiceMonitor,
  memory: MemoryMonitorSummary,
  width: number,
  refreshing: boolean,
  error?: string,
): Container {
  const container = new Container();
  const state = serviceState(snapshot);
  const reviewer = snapshot.reviewer;
  const inner = Math.max(1, width - 4);
  const row = (label: string, value: string) => truncateToWidth(`${theme.fg("dim", label.padEnd(12))}${value}`, inner);

  container.addChild(new DynamicBorder((text: string) => theme.fg(state.color, text)));
  container.addChild(new Text(
    `${theme.fg("accent", theme.bold("NO FORGETTI"))} ${theme.fg("muted", "/ external review monitor")}\n` +
    `${theme.fg(state.color, theme.bold(state.label))} ${theme.fg("dim", `· ${snapshot.mode} authority`)}`,
    1,
    0,
  ));
  container.addChild(new Text("", 0, 0));
  container.addChild(new Text([
    row("MEMORY", `${memory.branch} · ${memory.entries} entries · ${memory.usedChars}/${memory.maxChars} chars`),
    row("REVIEWER", reviewer ? `${reviewer.provider}/${reviewer.model} · reasoning ${reviewer.reasoningEffort}` : "not configured"),
    row("WORKER", snapshot.worker
      ? `${snapshot.worker.state} · pid ${snapshot.worker.pid} · heartbeat ${age(snapshot.worker.updatedAt, snapshot.observedAt)}${snapshot.workerFresh ? "" : " · STALE"}`
      : "not running"),
    row("SPOOL", `${snapshot.spool.queued} queued   ${snapshot.spool.running} running   ${snapshot.spool.outcomes} outcomes   ${snapshot.spool.deadLetter} dead`),
  ].join("\n"), 1, 0));

  if (reviewer) {
    container.addChild(new Text("", 0, 0));
    container.addChild(new Text(theme.fg("muted", `DAILY BUDGET · ${snapshot.budget.day} UTC`), 1, 0));
    container.addChild(new Text([
      row("CALLS", `${meter(theme, snapshot.budget.calls, reviewer.maxCallsPerDay)}  ${snapshot.budget.calls.toLocaleString()} / ${reviewer.maxCallsPerDay.toLocaleString()}`),
      row("TOKENS", `${meter(theme, snapshot.budget.tokens, reviewer.maxTokensPerDay)}  ${snapshot.budget.tokens.toLocaleString()} / ${reviewer.maxTokensPerDay.toLocaleString()}`),
      row("COST", `${meter(theme, snapshot.budget.costUsd, reviewer.maxCostPerDayUsd)}  ${money(snapshot.budget.costUsd)} / ${money(reviewer.maxCostPerDayUsd)}`),
    ].join("\n"), 1, 0));
  }

  if (snapshot.exhausted.length > 0) {
    container.addChild(new Text("", 0, 0));
    container.addChild(new Text(
      theme.bg("toolErrorBg", theme.fg("error", theme.bold(` LIMIT REACHED  ${snapshot.exhausted.join(", ")} · resumes next UTC day `))),
      1,
      0,
    ));
  } else if (!snapshot.workerFresh && snapshot.mode === "external") {
    container.addChild(new Text("", 0, 0));
    container.addChild(new Text(theme.fg("warning", "Worker heartbeat is stale. Queued evidence remains durable."), 1, 0));
  }
  if (error) container.addChild(new Text(theme.fg("error", `Refresh failed: ${error}`), 1, 0));
  container.addChild(new Text("", 0, 0));
  container.addChild(new Text(
    theme.fg("dim", `${refreshing ? "refreshing…" : "r refresh"} · esc close · limits reset at 00:00 UTC`),
    1,
    0,
  ));
  container.addChild(new DynamicBorder((text: string) => theme.fg("borderMuted", text)));
  return container;
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
        return dashboard(theme, snapshot, memory, width, refreshing, error).render(width);
      },
      invalidate() {},
      handleInput(data) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) done();
        else if (data.toLowerCase() === "r") void refresh();
      },
    };
  }, {
    overlay: true,
    overlayOptions: { width: "76%", minWidth: 58, maxHeight: "82%", anchor: "center", margin: 1 },
  });
}
