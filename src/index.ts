import { join } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, VERSION as PI_VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { formatMemoryContext, memoryCharCount } from "./context.ts";
import { scoreMemorySignal, scoreSkillSignal } from "./heuristics.ts";
import { resolveProjectRoot } from "./project.ts";
import { isNonPrimaryAgent } from "./runtime.ts";
import { safeContextText } from "./security.ts";
import { buildReviewEvidenceWindow, requestReviewPlan } from "./review.ts";
import { DEFAULT_SERVICE_CONFIG, loadServiceConfig, type ServiceConfig } from "./service/config.ts";
import { consumeReviewFeedback, ReviewFeedbackInbox } from "./service/feedback.ts";
import { readReviewServiceMonitor, type ReviewServiceMonitor } from "./service/monitor.ts";
import { createReviewJob } from "./service/protocol.ts";
import { ReviewSpool } from "./service/spool.ts";
import { formatReviewServiceMonitorText, showReviewServiceMonitor, type MemoryMonitorSummary } from "./service/tui.ts";
import { PROJECT_SKILL_USE_ENTRY, projectSkillNameFromInvocation, projectSkillNameFromReadPath } from "./skill-native.ts";
import { renderSkillChange } from "./skill-diff.ts";
import { requestSkillReviewPlan } from "./skill-review.ts";
import { ProjectSkillStore } from "./skill-store.ts";
import { showSkillPicker, showSkillViewer } from "./skill-ui.ts";
import { DEFAULT_SKILL_RETENTION_SESSIONS, type SkillProposal, type SkillReviewClaim, type SkillUseResult } from "./skill-types.ts";
import {
  ACTIVE_MEMORY_ENTRY,
  REVIEW_CURSOR_ENTRY,
  SKILL_REVIEW_CURSOR_ENTRY,
  hasUnreviewedUserEntries,
  restoreActiveMemory,
  restoreReviewCursor,
  restoreSkillReviewCursor,
} from "./session-state.ts";
import { ProjectMemoryStore } from "./store.ts";
import {
  DEFAULT_REVIEW_INTERVAL,
  DEFAULT_REVIEW_SIGNAL_THRESHOLD,
  MAIN_MEMORY,
  type MemoryAction,
  type MemoryBranch,
  type MemoryImportance,
  type MutationResult,
  type ReviewClaim,
  type ReviewOperation,
} from "./types.ts";

const STATUS_KEY = "no-forgetti";
const WIDGET_KEY = "no-forgetti";
const MEMORY_REVIEW_ENTRY = "no-forgetti-memory-review";
const MEMORY_REVIEW_JOB_ENTRY = "no-forgetti-memory-review-job";
const REVIEW_GLYPHS = { add: "+", replace: "~", remove: "-", merge: "⇄", assess: "◆" } as const;
const REVIEW_LINE_CHARS = 76;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_CELLS = 4;
const BAR_LEVELS = ["⣀", "⣤", "⣶", "⣿"] as const;

type StateColor = "muted" | "accent";

/** 4-cell braille bar, 16 fill levels; filled cells take the state color, empty cells are dim. */
function capacityBar(t: ExtensionContext["ui"]["theme"], color: StateColor, used: number, max: number): string {
  const steps = max > 0 ? Math.round(Math.min(1, used / max) * BAR_CELLS * BAR_LEVELS.length) : 0;
  let bar = "";
  for (let cell = 0; cell < BAR_CELLS; cell++) {
    const fill = Math.min(BAR_LEVELS.length, Math.max(0, steps - cell * BAR_LEVELS.length));
    bar += fill === 0 ? t.fg("dim", BAR_LEVELS[0]) : t.fg(color, BAR_LEVELS[fill - 1]);
  }
  return bar;
}

const TOOL_NAME = "project_memory";
const REVIEW_TIMEOUT_MS = 120_000;
const SERVICE_MONITOR_POLL_MS = 15_000;
const REVIEW_ABORT_LIFECYCLE = "lifecycle";
const REVIEW_ABORT_TIMEOUT = "timeout";
/** Stamped into durable provenance; tests/manifest.test.ts pins it to package.json. */
export const EXTENSION_VERSION = "0.3.0";

export interface ExtensionDependencies {
  isNonPrimaryAgent: typeof isNonPrimaryAgent;
  createMemoryStore: (projectRoot: string) => ProjectMemoryStore;
  createSkillStore: (projectRoot: string, projectDir: string) => ProjectSkillStore;
  requestReviewPlan: typeof requestReviewPlan;
  requestSkillReviewPlan: typeof requestSkillReviewPlan;
  loadServiceConfig: typeof loadServiceConfig;
  loadServiceMonitor: typeof readReviewServiceMonitor;
  createReviewSpool: () => ReviewSpool;
  reviewTimeoutMs: number;
  writeCommandOutput: (text: string) => void;
}

const DEFAULT_DEPENDENCIES: ExtensionDependencies = {
  isNonPrimaryAgent,
  createMemoryStore: (projectRoot) => new ProjectMemoryStore(projectRoot),
  createSkillStore: (projectRoot, projectDir) => new ProjectSkillStore(projectRoot, { projectDir }),
  requestReviewPlan,
  requestSkillReviewPlan,
  loadServiceConfig,
  loadServiceMonitor: readReviewServiceMonitor,
  createReviewSpool: () => new ReviewSpool(join(getAgentDir(), "no-forgetti", "review-spool")),
  reviewTimeoutMs: REVIEW_TIMEOUT_MS,
  writeCommandOutput: (text) => process.stdout.write(`${text}\n`),
};

interface MemoryToolDetails {
  action: MemoryAction;
  branch: string;
  changed: boolean;
  entries: number;
  usedChars: number;
  maxChars: number;
  message: string;
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}

interface MemoryReviewChange {
  kind: keyof typeof REVIEW_GLYPHS;
  text: string;
  oldText?: string;
}

function restoredExternalReviewDeliveries(ctx: ExtensionContext, projectKey: string): Set<string> {
  const delivered = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== MEMORY_REVIEW_ENTRY) continue;
    const data: unknown = entry.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const state = data as { projectKey?: unknown; jobId?: unknown };
    if (state.projectKey !== undefined && state.projectKey !== projectKey) continue;
    if (typeof state.jobId === "string") delivered.add(state.jobId);
  }
  return delivered;
}

function clipReviewLine(value: string): string {
  const line = firstLine(value.trim());
  return line.length <= REVIEW_LINE_CHARS ? line : `${line.slice(0, REVIEW_LINE_CHARS - 1)}…`;
}

function reviewEntryText(before: MemoryBranch, entryId: string): string {
  return before.entries.find((entry) => entry.id === entryId)?.text ?? entryId;
}

function reviewReplacementChange(
  before: MemoryBranch,
  operation: Extract<ReviewOperation, { action: "replace" }>,
): MemoryReviewChange {
  const previous = before.entries.find((entry) => entry.id === operation.entryId)?.text;
  const change: MemoryReviewChange = { kind: "replace", text: safeContextText(operation.content) };
  if (previous) change.oldText = safeContextText(previous);
  return change;
}

function existingReviewChange(
  before: MemoryBranch,
  operation: Exclude<ReviewOperation, { action: "add" | "merge" }>,
): MemoryReviewChange {
  if (operation.action === "remove") {
    return { kind: "remove", text: safeContextText(reviewEntryText(before, operation.entryId)) };
  }
  if (operation.action === "replace") return reviewReplacementChange(before, operation);
  const text = reviewEntryText(before, operation.entryId);
  return { kind: "assess", text: safeContextText(`${operation.importance}: ${text}`) };
}

function reviewChange(before: MemoryBranch, operation: ReviewOperation): MemoryReviewChange {
  if (operation.action === "add") return { kind: "add", text: safeContextText(operation.content) };
  if (operation.action === "merge") return { kind: "merge", text: safeContextText(operation.content) };
  return existingReviewChange(before, operation);
}

/** Results align 1:1 with the (≤4) operations applyOperations accepted. */
function reviewChanges(
  before: MemoryBranch,
  operations: ReviewOperation[],
  results: MutationResult[],
): MemoryReviewChange[] {
  const changes: MemoryReviewChange[] = [];
  for (const [index, result] of results.entries()) {
    const operation = operations[index];
    if (result.changed && operation) changes.push(reviewChange(before, operation));
  }
  return changes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settleOnAbort<T>(request: {
  promise: Promise<T>;
  signal: AbortSignal;
  message: string;
}): Promise<T> {
  const { promise, signal, message } = request;
  if (signal.aborted) return Promise.reject(new Error(message));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new Error(message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function formatBranch(branch: MemoryBranch): string {
  if (branch.entries.length === 0) return `(project memory '${branch.name}' is empty)`;
  return branch.entries.map((entry, index) => {
    const importance = entry.importanceAssessedAt ? entry.importance : `${entry.importance}?`;
    return `${index + 1}. [${importance}] ${safeContextText(entry.text)}`;
  }).join("\n");
}

function showCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  writeOutput: (text: string) => void,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (ctx.mode === "print") {
    writeOutput(text);
    return;
  }
  throw new Error("Command output requires TUI/RPC mode; use the corresponding model tool in JSON mode.");
}

function formatSkillProposal(proposal: SkillProposal): string {
  const operation = proposal.operations.at(0);
  if (!operation) return `proposal: ${proposal.id}\n(empty)`;
  return [
    `proposal: ${proposal.id}`,
    `action: ${operation.action}`,
    `skill: ${operation.name}`,
    ...(proposal.retention ? ["source: automatic retention"] : []),
    ...(operation.reason ? [`reason: ${operation.reason}`] : []),
    ...(operation.evidence?.length ? [`evidence:\n${operation.evidence.join("\n")}`] : []),
    ...(operation.action === "create" ? [`description: ${operation.description}\n\n--- skill body ---\n${operation.content}`] : []),
    ...(operation.action === "patch" ? [renderSkillChange(operation.oldText ?? "", operation.newText ?? "")] : []),
  ].join("\n\n");
}

/**
 * Pending proposals are unique per (action, name), so the skill name is already a
 * readable handle. Ids stay accepted because older notify copy printed them.
 */
export function resolvePendingRef(pending: SkillProposal[], ref: string): SkillProposal {
  const byId = pending.find((proposal) => proposal.id === ref);
  if (byId) return byId;
  const tokens = ref.split(/\s+/u).filter(Boolean);
  const [action, name] = tokens.length === 2 ? tokens : [undefined, ref];
  const matches = pending.filter((proposal) => {
    const operation = proposal.operations.at(0);
    return operation?.name === name && (action === undefined || operation.action === action);
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`No pending proposal '${ref}'.`);
  const qualified = matches.map((proposal) => `'${proposal.operations.at(0)?.action} ${name}'`);
  throw new Error(`'${name}' has more than one pending proposal; use ${qualified.join(" or ")}.`);
}

interface SkillTrackingSummary {
  tracked: string[];
  withdrawn: number;
  failed: number;
}

function summarizeSkillTracking(
  names: string[],
  results: PromiseSettledResult<SkillUseResult>[],
): SkillTrackingSummary {
  const summary: SkillTrackingSummary = { tracked: [], withdrawn: 0, failed: 0 };
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      summary.failed += 1;
      continue;
    }
    summary.tracked.push(names[index]!);
    summary.withdrawn += result.value.withdrawnRetentionProposals;
  }
  return summary;
}

function notifySkillTrackingFailures(failed: number, ctx: ExtensionContext): void {
  if (failed <= 0) return;
  if (!ctx.hasUI) return;
  ctx.ui.notify(`Project skill usage tracking failed for ${failed} skill(s).`, "warning");
}

function toolDetails(action: MemoryAction, result: MutationResult, store: ProjectMemoryStore): MemoryToolDetails {
  return {
    action,
    branch: result.branch.name,
    changed: result.changed,
    entries: result.branch.entries.length,
    usedChars: memoryCharCount(result.branch),
    maxChars: store.maxChars,
    message: result.message,
  };
}

export function activateProjectMemoryExtension(
  pi: ExtensionAPI,
  overrides: Partial<ExtensionDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  // Child-agent processes can share the primary session's project directory.
  // They must neither receive project memory nor learn/write into it.
  if (dependencies.isNonPrimaryAgent()) return;

  let store: ProjectMemoryStore | undefined;
  let skillStore: ProjectSkillStore | undefined;
  let activeName = MAIN_MEMORY;
  let frozenBranch: MemoryBranch | undefined;
  let reviewPromise: Promise<void> | undefined;
  let reviewController: AbortController | undefined;
  let pendingUserInputs: string[] = [];
  let reviewCursorId: string | undefined;
  let reviewExistingSession = false;
  let skillReviewPromise: Promise<void> | undefined;
  let skillReviewController: AbortController | undefined;
  let skillReviewCursorId: string | undefined;
  let skillReviewExistingSession = false;
  let activeSkillCount = 0;
  let pendingSkillCount = 0;
  let skillReviewRunning = false;
  let knownUserEntryIds = new Set<string>();
  let lastAgentRunSuccessful = false;
  let observedNativeSkillUses = new Set<string>();
  let serviceConfig: ServiceConfig = DEFAULT_SERVICE_CONFIG;
  let reviewSpool: ReviewSpool | undefined;
  let serviceMonitor: ReviewServiceMonitor | undefined;
  let serviceMonitorTimer: ReturnType<typeof setInterval> | undefined;
  let announcedBudgetLimit: string | undefined;
  let serviceMonitorErrorAnnounced = false;
  let reviewFeedbackInbox: ReviewFeedbackInbox | undefined;
  let deliveredExternalReviews = new Set<string>();
  let externalFeedbackPromise: Promise<void> | undefined;
  let externalFeedbackErrorAnnounced = false;

  function presentCommandOutput(
    ctx: ExtensionCommandContext,
    text: string,
    type: "info" | "warning" | "error" = "info",
  ): void {
    showCommandOutput(ctx, text, dependencies.writeCommandOutput, type);
  }

  function requireStore(): ProjectMemoryStore {
    if (!store) throw new Error("Project memory has not initialized yet.");
    return store;
  }

  function requireSkillStore(): ProjectSkillStore {
    if (!skillStore) throw new Error("Project skills have not initialized yet.");
    return skillStore;
  }

  function appendReviewCursor(name: string, throughEntryId: string, outcome: "reviewed" | "queued" | "branch-boundary"): void {
    const memoryStore = requireStore();
    pi.appendEntry(REVIEW_CURSOR_ENTRY, {
      projectKey: memoryStore.projectKey,
      name,
      throughEntryId,
      outcome,
    });
    if (name === activeName) reviewCursorId = throughEntryId;
  }

  function appendSkillReviewCursor(throughEntryId: string): void {
    const memoryStore = requireStore();
    pi.appendEntry(SKILL_REVIEW_CURSOR_ENTRY, {
      projectKey: memoryStore.projectKey,
      throughEntryId,
      outcome: "reviewed",
    });
    skillReviewCursorId = throughEntryId;
  }

  let widgetShown: "review" | "pending" | undefined;

  function refreshWidget(ctx: ExtensionContext): void {
    const key = skillReviewRunning ? "review" : pendingSkillCount > 0 ? "pending" : undefined;
    if (key === widgetShown) return;
    widgetShown = key;
    if (!key) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      let frame = 0;
      const timer =
        key === "review"
          ? setInterval(() => {
              frame = (frame + 1) % SPINNER_FRAMES.length;
              tui.requestRender();
            }, 100)
          : undefined;
      return {
        invalidate() {},
        // Reads live closure state, so count changes render without re-setting the widget.
        render() {
          const rail = theme.fg("dim", "│ ");
          const lines = [theme.fg("dim", "╭ no-forgetti")];
          if (skillReviewRunning) {
            lines.push(`${rail}${theme.fg("accent", SPINNER_FRAMES[frame] ?? "⠋")} ${theme.fg("muted", "reviewing skill proposals…")}`);
          }
          if (pendingSkillCount > 0) {
            lines.push(`${rail}${theme.fg("muted", `pending:${pendingSkillCount} · /project-skills pending`)}`);
          }
          return lines;
        },
        dispose() {
          if (timer) clearInterval(timer);
        },
      };
    });
  }

  function refreshStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    refreshWidget(ctx);
    if (!store || !frozenBranch) return;
    const t = ctx.ui.theme;
    const entries = frozenBranch.entries.length;
    const segs: string[] = [];
    if (activeSkillCount > 0) segs.push(`skills:${activeSkillCount}`);
    if (pendingSkillCount > 0) segs.push(`pending:${pendingSkillCount}`);
    if (serviceConfig.mode !== "embedded") {
      if (serviceMonitor?.exhausted.length) segs.push(t.fg("error", `review:limit-${serviceMonitor.exhausted.join("+")}`));
      else if (serviceMonitor?.workerCompatible === false) segs.push(t.fg("warning", "review:update"));
      else if (serviceMonitor && !serviceMonitor.workerFresh) segs.push(t.fg("warning", "review:offline"));
      else if (!serviceMonitor) segs.push(t.fg("warning", "review:monitor-error"));
      else if (serviceMonitor.spool.queued) segs.push(t.fg("accent", `review:q${serviceMonitor.spool.queued}`));
      else segs.push("review:on");
    }
    if (entries === 0 && segs.length === 0 && !skillReviewRunning) {
      // ponytail: nothing to say — give the footer row back
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    // Bar already communicates memory presence/capacity; avoid repeating it as text.
    const stateColor: StateColor = skillReviewRunning ? "accent" : "muted";
    const bar = capacityBar(t, stateColor, memoryCharCount(frozenBranch), store.maxChars);
    ctx.ui.setStatus(STATUS_KEY, `${bar} ${t.fg("muted", segs.join(" "))}`.trimEnd());
  }

  async function refreshServiceMonitor(ctx: ExtensionContext, notify = false): Promise<void> {
    if (serviceConfig.mode === "embedded") {
      serviceMonitor = undefined;
      refreshStatus(ctx);
      return;
    }
    try {
      serviceMonitor = await dependencies.loadServiceMonitor();
      serviceMonitorErrorAnnounced = false;
      const limitKey = serviceMonitor.exhausted.length > 0
        ? `${serviceMonitor.budget.day}:${serviceMonitor.exhausted.join("+")}`
        : undefined;
      if (notify && limitKey && limitKey !== announcedBudgetLimit && ctx.hasUI) {
        announcedBudgetLimit = limitKey;
        ctx.ui.notify(
          `No Forgetti review budget exhausted (${serviceMonitor.exhausted.join(", ")}); queued evidence remains durable until the next UTC day.`,
          "warning",
        );
      }
      if (!limitKey) announcedBudgetLimit = undefined;
    } catch (error) {
      serviceMonitor = undefined;
      if (notify && !serviceMonitorErrorAnnounced && ctx.hasUI) {
        serviceMonitorErrorAnnounced = true;
        ctx.ui.notify(`No Forgetti service monitor unavailable: ${errorMessage(error)}`, "warning");
      }
    }
    refreshStatus(ctx);
  }

  async function reconcileExternalReviewFeedback(ctx: ExtensionContext): Promise<void> {
    const memoryStore = store;
    const inbox = reviewFeedbackInbox;
    if (serviceConfig.mode !== "external" || !memoryStore || !inbox) return;
    if (externalFeedbackPromise) return externalFeedbackPromise;
    externalFeedbackPromise = (async () => {
      let updatedActiveBranch = false;
      try {
        await consumeReviewFeedback(inbox, (feedback) => {
          if (deliveredExternalReviews.has(feedback.jobId)) return;
          const changes = feedback.changes.map((change): MemoryReviewChange => ({
            kind: change.kind,
            text: safeContextText(change.text),
            ...(change.kind === "replace" ? { oldText: safeContextText(change.oldText) } : {}),
          }));
          pi.appendEntry(MEMORY_REVIEW_ENTRY, {
            projectKey: memoryStore.projectKey,
            jobId: feedback.jobId,
            branch: feedback.branchName,
            status: feedback.status,
            changes,
          });
          deliveredExternalReviews.add(feedback.jobId);
          updatedActiveBranch ||= feedback.status === "applied" && feedback.branchName === activeName;
          // Embedded review surfaces a rejected batch as a warning; a silently
          // dropped external batch would look like memory simply never changed.
          if ((feedback.status === "stale" || feedback.status === "rejected" || feedback.status === "failed") && ctx.hasUI) {
            ctx.ui.notify(`Project memory review failed: ${feedback.messages.at(0) ?? feedback.status}`, "warning");
          }
        });
        if (updatedActiveBranch) frozenBranch = await memoryStore.loadBranch(activeName);
        externalFeedbackErrorAnnounced = false;
        refreshStatus(ctx);
      } catch (error) {
        if (!externalFeedbackErrorAnnounced && ctx.hasUI) {
          externalFeedbackErrorAnnounced = true;
          ctx.ui.notify(`No Forgetti memory feedback unavailable: ${errorMessage(error)}`, "warning");
        }
      }
    })().finally(() => {
      externalFeedbackPromise = undefined;
    });
    return externalFeedbackPromise;
  }

  function startServiceMonitorPolling(ctx: ExtensionContext): void {
    if (serviceMonitorTimer) clearInterval(serviceMonitorTimer);
    serviceMonitorTimer = undefined;
    if (serviceConfig.mode === "embedded") return;
    serviceMonitorTimer = setInterval(() => void (async () => {
      await refreshServiceMonitor(ctx, true);
      await reconcileExternalReviewFeedback(ctx);
    })(), SERVICE_MONITOR_POLL_MS);
    serviceMonitorTimer.unref?.();
  }

  function memoryMonitorSummary(memoryStore: ProjectMemoryStore, branch: MemoryBranch): MemoryMonitorSummary {
    return {
      projectRoot: memoryStore.projectRoot,
      branch: branch.name,
      entries: branch.entries.length,
      usedChars: memoryCharCount(branch),
      maxChars: memoryStore.maxChars,
    };
  }

  async function loadSessionMemory(ctx: ExtensionContext): Promise<void> {
    if (serviceMonitorTimer) clearInterval(serviceMonitorTimer);
    serviceMonitorTimer = undefined;
    serviceMonitor = undefined;
    observedNativeSkillUses = new Set();
    store = undefined;
    skillStore = undefined;
    frozenBranch = undefined;
    activeSkillCount = 0;
    pendingSkillCount = 0;
    pendingUserInputs = [];
    knownUserEntryIds = new Set();
    lastAgentRunSuccessful = false;
    reviewFeedbackInbox = undefined;
    deliveredExternalReviews = new Set();
    externalFeedbackErrorAnnounced = false;
    serviceConfig = DEFAULT_SERVICE_CONFIG;
    reviewSpool = undefined;
    try {
      serviceConfig = await dependencies.loadServiceConfig();
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`No Forgetti service config rejected: ${errorMessage(error)}`, "warning");
    }
    if (serviceConfig.mode !== "embedded") {
      try {
        reviewSpool = dependencies.createReviewSpool();
        await reviewSpool.initialize();
        await reviewSpool.recover();
      } catch (error) {
        reviewSpool = undefined;
        if (ctx.hasUI) ctx.ui.notify(
          `No Forgetti ${serviceConfig.mode} review degraded; durable spool unavailable: ${errorMessage(error)}`,
          "warning",
        );
      }
    }
    const projectRoot = resolveProjectRoot(ctx.cwd);
    const nextStore = dependencies.createMemoryStore(projectRoot);
    try {
      await nextStore.initialize();
    } catch (error) {
      store = undefined;
      skillStore = undefined;
      frozenBranch = undefined;
      activeSkillCount = 0;
      pendingSkillCount = 0;
      if (ctx.hasUI) ctx.ui.notify(`No Forgetti disabled for this project: ${errorMessage(error)}`, "warning");
      return;
    }
    store = nextStore;
    const nextSkillStore = dependencies.createSkillStore(projectRoot, nextStore.projectDir);
    try {
      await nextSkillStore.initialize();
      const migration = await nextSkillStore.applyPendingCreates();
      const maintenance = await nextSkillStore.maintainSession(ctx.sessionManager.getSessionId());
      skillStore = nextSkillStore;
      activeSkillCount = (await nextSkillStore.listSkills()).length;
      pendingSkillCount = (await nextSkillStore.listPending()).length;
      if (ctx.hasUI && migration.applied.length > 0) {
        ctx.ui.notify(`Added pending project skills automatically: ${migration.applied.join(", ")}.`, "info");
      }
      if (ctx.hasUI && migration.retained.length > 0) {
        ctx.ui.notify(`Could not safely add pending project skills: ${migration.retained.join(", ")}. They remain pending.`, "warning");
      }
      if (maintenance.proposals.length > 0 && ctx.hasUI) {
        const names = maintenance.proposals.map((proposal) => proposal.operations.at(0)?.name ?? "unknown");
        ctx.ui.notify(
          `Project skill retention staged ${maintenance.proposals.length} archive proposal(s): ${names.join(", ")}. Inspect with /project-skills pending.`,
          "info",
        );
      }
    } catch (error) {
      skillStore = undefined;
      activeSkillCount = 0;
      pendingSkillCount = 0;
      if (ctx.hasUI) ctx.ui.notify(`Project skills disabled: ${errorMessage(error)}`, "warning");
    }
    activeName = restoreActiveMemory(ctx);
    try {
      frozenBranch = await nextStore.loadBranch(activeName);
    } catch (error) {
      const missing = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing) {
        store = undefined;
        frozenBranch = undefined;
        if (ctx.hasUI) ctx.ui.notify(`No Forgetti disabled for this project: ${errorMessage(error)}`, "warning");
        return;
      }
      const missingName = activeName;
      activeName = MAIN_MEMORY;
      frozenBranch = await nextStore.loadBranch(MAIN_MEMORY);
      if (ctx.hasUI) ctx.ui.notify(`Memory branch '${missingName}' does not exist in this project; using 'main'.`, "warning");
    }
    reviewCursorId = restoreReviewCursor(ctx, nextStore.projectKey, activeName);
    skillReviewCursorId = restoreSkillReviewCursor(ctx, nextStore.projectKey);
    deliveredExternalReviews = restoredExternalReviewDeliveries(ctx, nextStore.projectKey);
    if (serviceConfig.mode === "external") {
      try {
        reviewFeedbackInbox = new ReviewFeedbackInbox(nextStore.projectDir);
        await reviewFeedbackInbox.initialize();
      } catch (error) {
        reviewFeedbackInbox = undefined;
        if (ctx.hasUI) ctx.ui.notify(`No Forgetti memory feedback unavailable: ${errorMessage(error)}`, "warning");
      }
    }
    // Existing sessions are eligible on the next completed turn, rather than
    // requiring another full cadence window before review.
    reviewExistingSession = hasUnreviewedUserEntries(ctx, reviewCursorId);
    skillReviewExistingSession = hasUnreviewedUserEntries(ctx, skillReviewCursorId);
    knownUserEntryIds = new Set(
      ctx.sessionManager.getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .map((entry) => entry.id),
    );
    pendingUserInputs = [];
    lastAgentRunSuccessful = false;
    observedNativeSkillUses = new Set();
    await refreshServiceMonitor(ctx, true);
    await reconcileExternalReviewFeedback(ctx);
    startServiceMonitorPolling(ctx);
    refreshStatus(ctx);
  }

  async function switchMemory(name: string, ctx: ExtensionContext): Promise<void> {
    const memoryStore = requireStore();
    const branch = await memoryStore.loadBranch(name);
    const boundaryEntryId = ctx.sessionManager.getLeafId();
    activeName = branch.name;
    frozenBranch = branch;
    reviewExistingSession = false;
    pi.appendEntry(ACTIVE_MEMORY_ENTRY, { name: activeName });
    if (boundaryEntryId) appendReviewCursor(activeName, boundaryEntryId, "branch-boundary");
    else reviewCursorId = undefined;
    refreshStatus(ctx);
  }

  async function runSkillReview(ctx: ExtensionContext, force: boolean): Promise<void> {
    if (skillReviewPromise) {
      if (force && ctx.hasUI) ctx.ui.notify("Project skill review already running.", "info");
      return skillReviewPromise;
    }
    const projectSkills = skillStore;
    if (!projectSkills) return;
    const reviewAfterEntryId = skillReviewCursorId;
    const throughEntryId = ctx.sessionManager.getLeafId();
    const controller = new AbortController();
    skillReviewController = controller;
    skillReviewPromise = (async () => {
      let claim: SkillReviewClaim | undefined;
      let success = false;
      let cancelled = false;
      let commitStarted = false;
      let reviewTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        claim = await projectSkills.claimReviewIfDue({ force });
        if (!claim) return;
        if (controller.signal.aborted) {
          cancelled = controller.signal.reason === REVIEW_ABORT_LIFECYCLE;
          return;
        }
        skillReviewRunning = true;
        refreshStatus(ctx);
        reviewTimeout = setTimeout(() => controller.abort(REVIEW_ABORT_TIMEOUT), dependencies.reviewTimeoutMs);
        const plan = await settleOnAbort({
          promise: dependencies.requestSkillReviewPlan(ctx, projectSkills, reviewAfterEntryId, controller.signal),
          signal: controller.signal,
          message: "Project skill review was aborted.",
        });
        if (controller.signal.aborted) throw new Error("Project skill review was aborted.");
        clearTimeout(reviewTimeout);
        reviewTimeout = undefined;
        // Validated model output is the commit point. Local proposal admission is
        // bounded and atomic; lifecycle cancellation waits for it to finish.
        commitStarted = true;
        if (plan.operations.length > 0) {
          const operation = plan.operations.at(0)!;
          const submission = await projectSkills.submitProposal(plan.operations, ctx.sessionManager.getSessionId());
          if (submission.result) {
            if (operation.action === "create" && submission.result.changed) activeSkillCount += 1;
            if (ctx.hasUI) {
              const reason = operation.reason ? ` ${operation.reason}` : "";
              ctx.ui.notify(
                operation.action === "create"
                  ? `Project skill review added '${operation.name}' automatically. It becomes a native Pi skill after /reload or next session.`
                  : `Project skill review patched '${operation.name}'.${reason} Undo with /project-skills undo ${operation.name}.`,
                "info",
              );
            }
          } else {
            if (submission.staged) pendingSkillCount += 1;
            if (ctx.hasUI) {
              ctx.ui.notify(
                submission.staged
                  ? `Project skill review staged ${operation.action} '${operation.name}'. Inspect with /project-skills pending ${operation.name}`
                  : `Project skill review matched existing pending ${operation.action} '${operation.name}'.`,
                "info",
              );
            }
          }
        } else if (force && ctx.hasUI) {
          ctx.ui.notify("Project skill review: no reusable workflow change found.", "info");
        }
        if (throughEntryId) appendSkillReviewCursor(throughEntryId);
        success = true;
      } catch (error) {
        const abortReason = !commitStarted && controller.signal.aborted ? controller.signal.reason : undefined;
        if (abortReason === REVIEW_ABORT_LIFECYCLE) {
          cancelled = true;
        } else if (abortReason === REVIEW_ABORT_TIMEOUT) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              "Project skill review timed out; it will retry after backoff on a future completed turn.",
              "warning",
            );
          }
        } else if (ctx.hasUI) {
          ctx.ui.notify(`Project skill review failed: ${errorMessage(error)}`, "warning");
        }
      } finally {
        if (reviewTimeout) clearTimeout(reviewTimeout);
        if (claim) {
          const outcome = success ? "success" : cancelled ? "cancelled" : "failure";
          await projectSkills.finishReview({ claim, outcome }).catch(() => undefined);
        }
        skillReviewRunning = false;
        refreshStatus(ctx);
        if (skillReviewController === controller) skillReviewController = undefined;
        skillReviewPromise = undefined;
      }
    })();
    return skillReviewPromise;
  }

  async function enqueueReviewJob(
    ctx: ExtensionContext,
    branch: MemoryBranch,
    transcript: string,
    throughEntryId: string,
  ): Promise<void> {
    // Do not hand durable evidence to a worker whose admission policy predates
    // this extension. The review claim remains failed (and therefore retryable),
    // while its session evidence cursor stays before the unpersisted job.
    await refreshServiceMonitor(ctx);
    if (serviceMonitor?.workerCompatible === false) {
      throw new Error("No Forgetti review worker restart required: its memory policy is out of date.");
    }
    const spool = reviewSpool;
    if (!spool) throw new Error("External review spool is unavailable.");
    const memoryStore = requireStore();
    const job = createReviewJob({
      projectKey: memoryStore.projectKey,
      sessionId: ctx.sessionManager.getSessionId(),
      throughEntryId,
      transcript,
      branch,
      baseBranchDigest: memoryStore.branchDigest(branch),
      maxChars: memoryStore.maxChars,
    });
    // Interest must be durable before the job is claimable, or a worker can
    // admit and publish its diff before Pi has anywhere to receive it.
    const inbox = serviceConfig.mode === "external" ? reviewFeedbackInbox : undefined;
    try {
      await inbox?.register(job.id, job.digest);
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`No Forgetti could not register memory feedback: ${errorMessage(error)}`, "warning");
    }
    let enqueue: Awaited<ReturnType<typeof spool.enqueue>>;
    try {
      enqueue = await spool.enqueue(job);
    } catch (error) {
      await inbox?.discard(job.id).catch(() => undefined);
      throw error;
    }
    if (enqueue === "quarantined") {
      await inbox?.discard(job.id).catch(() => undefined);
      throw new Error(`Review job '${job.id}' conflicted with an existing durable job.`);
    }
    pi.appendEntry(MEMORY_REVIEW_JOB_ENTRY, {
      version: 1,
      projectKey: memoryStore.projectKey,
      jobId: job.id,
      jobDigest: job.digest,
      mode: serviceConfig.mode,
      throughEntryId,
      status: enqueue,
      producer: { extensionVersion: EXTENSION_VERSION, piVersion: PI_VERSION },
    });
    await refreshServiceMonitor(ctx);
  }

  async function runReview(ctx: ExtensionContext, force: boolean): Promise<void> {
    if (reviewPromise) {
      if (force && ctx.hasUI) ctx.ui.notify("Project memory review already running.", "info");
      return reviewPromise;
    }
    const memoryStore = requireStore();
    const reviewBranchName = activeName;
    const reviewAfterEntryId = reviewCursorId;
    const controller = new AbortController();
    reviewController = controller;
    reviewPromise = (async () => {
      let claimed: ReviewClaim | undefined;
      let success = false;
      let reviewTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        claimed = await memoryStore.claimReview(
          reviewBranchName,
          DEFAULT_REVIEW_INTERVAL,
          DEFAULT_REVIEW_SIGNAL_THRESHOLD,
          force,
        );
        if (!claimed || controller.signal.aborted) return;
        // Building the window walks the whole session branch, so only pay for it
        // once the cadence claim proves a review is actually due.
        const reviewEvidence = buildReviewEvidenceWindow(ctx.sessionManager.getBranch(), reviewAfterEntryId);
        const throughEntryId = reviewEvidence.throughEntryId;
        const branch = await memoryStore.loadBranch(reviewBranchName);
        if (serviceConfig.mode !== "embedded") {
          const evidence = throughEntryId && reviewEvidence.transcript
            ? { throughEntryId, transcript: reviewEvidence.transcript }
            : undefined;
          try {
            // Shadow mode must degrade to the embedded review rather than fail
            // the whole review when no bounded evidence can be enqueued.
            if (!evidence) throw new Error("No bounded completed evidence is available to enqueue.");
            await enqueueReviewJob(ctx, branch, evidence.transcript, evidence.throughEntryId);
          } catch (error) {
            if (serviceConfig.mode === "external") throw error;
            if (ctx.hasUI) ctx.ui.notify(`Project memory shadow enqueue failed: ${errorMessage(error)}`, "warning");
          }
          if (serviceConfig.mode === "external" && evidence) {
            appendReviewCursor(reviewBranchName, evidence.throughEntryId, "queued");
            success = true;
            if (ctx.hasUI) ctx.ui.notify("Project memory review queued for the No Forgetti service.", "info");
            return;
          }
        }
        reviewTimeout = setTimeout(() => controller.abort(), dependencies.reviewTimeoutMs);
        const plan = await dependencies.requestReviewPlan(ctx, {
          branch,
          signal: controller.signal,
          afterEntryId: reviewAfterEntryId,
          transcript: reviewEvidence.transcript,
          maxChars: memoryStore.maxChars,
        });
        const results = await memoryStore.applyOperations(
          reviewBranchName,
          plan.operations,
          ctx.sessionManager.getSessionId(),
          "background_review",
          memoryStore.branchDigest(branch),
        );
        const rejected = results.find((result) => result.message.startsWith("Review batch rejected;"));
        if (rejected) throw new Error(rejected.message);
        const changed = results.filter((result) => result.changed);
        if (reviewBranchName === activeName && changed.length > 0) {
          frozenBranch = changed.at(-1)!.branch;
          refreshStatus(ctx);
        }
        if (throughEntryId) appendReviewCursor(reviewBranchName, throughEntryId, "reviewed");
        success = true;
        if (changed.length > 0) {
          pi.appendEntry(MEMORY_REVIEW_ENTRY, {
            branch: reviewBranchName,
            changes: reviewChanges(branch, plan.operations, results),
          });
        } else if (force && ctx.hasUI) {
          ctx.ui.notify("Project memory review: nothing durable to save.", "info");
        }
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Project memory review failed: ${errorMessage(error)}`, "warning");
      } finally {
        if (reviewTimeout) clearTimeout(reviewTimeout);
        if (claimed) await memoryStore.finishReviewClaim(reviewBranchName, claimed, success).catch(() => undefined);
        if (reviewController === controller) reviewController = undefined;
        reviewPromise = undefined;
      }
    })();
    return reviewPromise;
  }

  async function editProjectSkill(name: string, ctx: ExtensionCommandContext): Promise<boolean> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Skill editing requires an interactive UI.", "warning");
      return false;
    }
    await ctx.waitForIdle();
    await skillReviewPromise?.catch(() => undefined);
    const projectSkills = requireSkillStore();
    const skill = await projectSkills.loadSkill(name);
    const edited = await ctx.ui.editor(`Edit project skill: ${skill.name}`, skill.content);
    if (edited === undefined) return false;
    if (edited === skill.content) {
      ctx.ui.notify(`No changes to '${skill.name}'.`, "info");
      return false;
    }
    const proposal = await projectSkills.stageProposal([{
      action: "patch",
      name: skill.name,
      oldText: skill.content,
      newText: edited,
      reason: "Foreground project-skill edit.",
    }], ctx.sessionManager.getSessionId());
    const result = await projectSkills.approveProposal(proposal.id, "foreground");
    ctx.ui.notify(
      result.changed ? `${result.message} Undo with /project-skills undo ${skill.name}.` : result.message,
      result.changed ? "info" : "warning",
    );
    return result.changed;
  }

  async function browseProjectSkills(ctx: ExtensionCommandContext): Promise<void> {
    const projectSkills = requireSkillStore();
    if (ctx.mode !== "tui") {
      presentCommandOutput(ctx, await projectSkills.skillIndex());
      return;
    }
    let selected: string | undefined;
    while (true) {
      const skills = await projectSkills.listSkills();
      if (skills.length === 0) {
        ctx.ui.notify("No active project skills yet.", "info");
        return;
      }
      const choice = await showSkillPicker(ctx, skills, selected);
      if (!choice) return;
      selected = choice.name;
      if (choice.action === "edit") {
        await editProjectSkill(selected, ctx);
        continue;
      }
      while (true) {
        const skill = await projectSkills.viewSkill(selected);
        const action = await showSkillViewer(ctx, skill, true, (text) => presentCommandOutput(ctx, text));
        if (action === "close") return;
        if (action === "back") break;
        if (action === "edit") {
          await editProjectSkill(selected, ctx);
          continue;
        }
        const index = skills.findIndex((item) => item.name === selected);
        const delta = action === "next" ? 1 : -1;
        selected = skills[(index + delta + skills.length) % skills.length]!.name;
      }
    }
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: "No Forgetti",
    description:
      "Manage durable memory scoped to this project. Actions: list, add, replace, remove. " +
      "Save stable project conventions, architecture facts, verification commands, recurring preferences, and non-obvious durable workflows. " +
      "Never save secrets, temporary task progress, completed-work logs, issue/PR numbers, commit hashes, or raw tool output. " +
      "replace/remove use oldText as a unique substring. importance is high, normal, or low and measures cost of forgetting. Writes persist immediately and are injected automatically at the start of the next turn.",
    promptSnippet: "Read or update durable project-scoped memory",
    promptGuidelines: [
      `Use ${TOOL_NAME} after durable project-specific learning that would prevent future rediscovery or correction.`,
      `Use ${TOOL_NAME} action=replace to consolidate overlapping entries instead of growing memory indefinitely.`,
      `Assess new memories with importance=high|normal|low when confidence permits; omit importance to leave legacy-compatible normal importance unassessed.`,
      `Do not use ${TOOL_NAME} for task progress, transient failures, secrets, or facts already present in AGENTS.md or checked-in docs.`,
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      action: StringEnum(["list", "add", "replace", "remove"] as const),
      content: Type.Optional(Type.String({ description: "Memory text for add/replace" })),
      oldText: Type.Optional(Type.String({ description: "Unique substring for replace/remove" })),
      importance: Type.Optional(StringEnum(["high", "normal", "low"] as const, { description: "Cost of forgetting this memory" })),
    }),
    prepareArguments(args) {
      type Prepared = { action: MemoryAction; content?: string; oldText?: string; importance?: MemoryImportance };
      if (!args || typeof args !== "object" || Array.isArray(args)) return args as Prepared;
      const legacy = args as Record<string, unknown>;
      return {
        ...legacy,
        ...(legacy.content === undefined && typeof legacy.text === "string" ? { content: legacy.text } : {}),
        ...(legacy.oldText === undefined && typeof legacy.match === "string" ? { oldText: legacy.match } : {}),
      } as Prepared;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const memoryStore = requireStore();
      if (params.action === "list") {
        const branch = await memoryStore.loadBranch(activeName);
        return {
          content: [{ type: "text", text: formatBranch(branch) }],
          details: {
            action: "list",
            branch: activeName,
            changed: false,
            entries: branch.entries.length,
            usedChars: memoryCharCount(branch),
            maxChars: memoryStore.maxChars,
            message: "Memory listed.",
          } satisfies MemoryToolDetails,
        };
      }

      const result = await memoryStore.applyOperation(
        activeName,
        { action: params.action, content: params.content, oldText: params.oldText, importance: params.importance as MemoryImportance | undefined },
        ctx.sessionManager.getSessionId(),
        "assistant_tool",
      );
      if (result.changed) frozenBranch = result.branch;
      refreshStatus(ctx);
      const suffix = result.changed ? " Visible in project context next turn." : "";
      return {
        content: [{ type: "text", text: `${result.message}${suffix}` }],
        details: toolDetails(params.action, result, memoryStore),
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) + theme.fg("muted", args.action);
      if (args.content) text += ` ${theme.fg("dim", `"${firstLine(args.content).slice(0, 80)}"`)}`;
      if (args.oldText) text += ` ${theme.fg("dim", `matching "${firstLine(args.oldText).slice(0, 50)}"`)}`;
      if (args.importance) text += ` ${theme.fg("dim", `[${args.importance}]`)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("dim", "Updating project memory…"), 0, 0);
      const details = result.details as MemoryToolDetails | undefined;
      if (!details) {
        const content = result.content[0];
        return new Text(content?.type === "text" ? content.text : "", 0, 0);
      }
      const glyph = details.changed ? theme.fg("success", "✓") : theme.fg("dim", "◇");
      let text = `${glyph} ${theme.fg("muted", details.message)} ${theme.fg("dim", `${details.entries} entries · ${details.usedChars}/${details.maxChars} chars · ${details.branch}`)}`;
      if (expanded && details.action === "list") {
        const content = result.content.find((part) => part.type === "text");
        if (content?.type === "text") text += `\n${theme.fg("dim", content.text)}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("project-skills", {
    description: "Browse and manage project skills. Usage: /project-skills list|stats|read|edit|undo|pending|approve|reject|review",
    getArgumentCompletions: async (prefix) => {
      const commands = [
        { value: "list", label: "list", description: "List project skills" },
        { value: "stats", label: "stats", description: "Show skill recall and retention stats" },
        { value: "read ", label: "read <name>", description: "Read a project skill" },
        { value: "edit ", label: "edit <name>", description: "Edit a project skill" },
        { value: "undo ", label: "undo <name>", description: "Revert the last change to a project skill" },
        { value: "pending", label: "pending", description: "List pending proposals" },
        { value: "pending ", label: "pending <name>", description: "Inspect a pending proposal" },
        { value: "approve ", label: "approve <name>", description: "Approve a proposal" },
        { value: "reject ", label: "reject <name>", description: "Reject a proposal" },
        { value: "review", label: "review", description: "Run skill review now" },
      ];
      const normalized = prefix.toLowerCase();
      const [action = ""] = normalized.split(" ");
      // Pi fuzzy-filters command names but passes argument suggestions through untouched.
      if (["read ", "edit ", "undo "].some((verb) => normalized.startsWith(verb))) {
        if (!skillStore) return null;
        const skills = await skillStore.listSkills();
        const items = skills.map((skill) => ({ value: `${action} ${skill.name}`, label: skill.name, description: skill.description }));
        const filtered = fuzzyFilter(items, normalized, (item) => item.value);
        return filtered.length ? filtered : null;
      }
      if (["pending ", "approve ", "reject "].some((verb) => normalized.startsWith(verb))) {
        if (!skillStore) return null;
        const pending = await skillStore.listPending();
        const items = pending.map((proposal) => {
          const operation = proposal.operations.at(0);
          return {
            value: `${action} ${operation?.name ?? proposal.id}`,
            label: operation?.name ?? proposal.id,
            description: `${operation?.action ?? "empty"}${operation?.reason ? ` · ${operation.reason}` : ""}`,
          };
        });
        const filtered = fuzzyFilter(items, normalized, (item) => item.value);
        return filtered.length ? filtered : null;
      }
      const filtered = commands.filter((item) => item.value.startsWith(normalized));
      return filtered.length ? filtered : null;
    },
    handler: async (args, ctx) => {
      const projectSkills = requireSkillStore();
      const [subcommand = "list", ...rest] = args.trim().split(/\s+/u).filter(Boolean);
      const value = rest.join(" ");
      const findPending = (pending: SkillProposal[], ref: string): SkillProposal | undefined => {
        try {
          return resolvePendingRef(pending, ref);
        } catch (error) {
          ctx.ui.notify(errorMessage(error), "warning");
          return undefined;
        }
      };
      if (subcommand === "list") {
        await browseProjectSkills(ctx);
        return;
      }
      if (subcommand === "stats") {
        presentCommandOutput(ctx, await projectSkills.usageReport());
        return;
      }
      if (subcommand === "view" || subcommand === "read") {
        if (!value) {
          await browseProjectSkills(ctx);
          return;
        }
        const skill = await projectSkills.viewSkill(value);
        const action = await showSkillViewer(ctx, skill, false, (text) => presentCommandOutput(ctx, text));
        if (action === "edit") await editProjectSkill(skill.name, ctx);
        return;
      }
      if (subcommand === "edit") {
        if (!value) return ctx.ui.notify("Usage: /project-skills edit <name>", "warning");
        await editProjectSkill(value, ctx);
        return;
      }
      if (subcommand === "undo") {
        if (!value) return ctx.ui.notify("Usage: /project-skills undo <name>", "warning");
        if (!ctx.hasUI) throw new Error("Project skill undo requires an interactive UI.");
        const change = await projectSkills.lastChange(value);
        if (!change) return ctx.ui.notify(`No recorded change to undo for '${value}'.`, "warning");
        // The lookup/undo TOCTOU window is closed by undoLastPatch's patchCount CAS.
        const confirmed = await ctx.ui.confirm(
          `Undo the last change to '${value}'?`,
          renderSkillChange(change.current, change.before),
        );
        if (!confirmed) return;
        await ctx.waitForIdle();
        const result = await projectSkills.undoLastPatch(value);
        ctx.ui.notify(result.message, result.changed ? "info" : "warning");
        return;
      }
      if (subcommand === "pending") {
        const pending = await projectSkills.listPending();
        if (value) {
          const proposal = findPending(pending, value);
          if (!proposal) return;
          presentCommandOutput(ctx, formatSkillProposal(proposal));
          return;
        }
        presentCommandOutput(
          ctx,
          pending.length === 0
            ? "No pending project skill proposals."
            : pending.map((proposal) => `${proposal.operations.at(0)?.action ?? "empty"} ${proposal.operations.at(0)?.name ?? ""}`).join("\n"),
        );
        return;
      }
      if (subcommand === "approve") {
        if (!value) return ctx.ui.notify("Usage: /project-skills approve <name>", "warning");
        if (!ctx.hasUI) throw new Error("Project skill approval requires an interactive UI.");
        const proposal = findPending(await projectSkills.listPending(), value);
        if (!proposal) return;
        const operation = proposal.operations.at(0);
        const confirmed = await ctx.ui.confirm(
          `Approve ${operation?.action ?? "empty"} '${operation?.name ?? value}'?`,
          formatSkillProposal(proposal),
        );
        if (!confirmed) return;
        await ctx.waitForIdle();
        const result = await projectSkills.approveProposal(proposal.id);
        if (operation?.action === "create" && result.changed) activeSkillCount += 1;
        if (operation?.action === "archive" && result.changed) activeSkillCount = Math.max(0, activeSkillCount - 1);
        pendingSkillCount = Math.max(0, pendingSkillCount - 1);
        refreshStatus(ctx);
        ctx.ui.notify(result.message, result.changed ? "info" : "warning");
        return;
      }
      if (subcommand === "reject") {
        if (!value) return ctx.ui.notify("Usage: /project-skills reject <name>", "warning");
        if (!ctx.hasUI) throw new Error("Project skill rejection requires an interactive UI.");
        const proposal = findPending(await projectSkills.listPending(), value);
        if (!proposal) return;
        const operation = proposal.operations.at(0);
        const confirmed = await ctx.ui.confirm(
          `Reject ${operation?.action ?? "empty"} '${operation?.name ?? value}'?`,
          proposal.retention
            ? `This keeps the active skill and snoozes automatic retention for ${DEFAULT_SKILL_RETENTION_SESSIONS} project sessions.`
            : "This removes the pending proposal without changing the active skill.",
        );
        if (!confirmed) return;
        await ctx.waitForIdle();
        await projectSkills.rejectProposal(proposal.id);
        pendingSkillCount = Math.max(0, pendingSkillCount - 1);
        refreshStatus(ctx);
        ctx.ui.notify(`Rejected project skill proposal '${operation?.name ?? proposal.id}'.`, "info");
        return;
      }
      if (subcommand === "review") {
        await ctx.waitForIdle();
        await runSkillReview(ctx, true);
        return;
      }
      ctx.ui.notify("Usage: /project-skills list|stats|read <name>|edit <name>|undo <name>|pending [name]|approve <name>|reject <name>|review", "warning");
    },
  });

  pi.registerCommand("memory", {
    description: "Project memory. Usage: /memory status|show|branches|fork|use|review|undo",
    getArgumentCompletions: async (prefix) => {
      const base = [
        { value: "status", label: "status", description: "Show project memory status" },
        { value: "show", label: "show", description: "Show active memory entries" },
        { value: "branches", label: "branches", description: "List memory branches" },
        { value: "fork ", label: "fork <name>", description: "Explicitly clone active memory and switch this session" },
        { value: "use ", label: "use <name>", description: "Switch this session to an existing memory branch" },
        { value: "review", label: "review", description: "Run self-learning memory refinement now" },
        { value: "undo", label: "undo", description: "Undo the last automatic memory review" },
      ];
      if (prefix.startsWith("use ") && store) {
        const names = await store.listBranches();
        const items = names.map((branch) => ({ value: `use ${branch.name}`, label: branch.name, description: branch.parent ? `forked from ${branch.parent}` : "project default" }));
        const filtered = items.filter((item) => item.value.startsWith(prefix.toLowerCase()));
        return filtered.length ? filtered : null;
      }
      const filtered = base.filter((item) => item.value.startsWith(prefix.toLowerCase()));
      return filtered.length ? filtered : null;
    },
    handler: async (args, ctx) => {
      const memoryStore = requireStore();
      const [subcommand = "status", ...rest] = args.trim().split(/\s+/u).filter(Boolean);
      const value = rest.join(" ").trim();

      if (subcommand === "status") {
        const live = await memoryStore.loadBranch(activeName);
        const memory = memoryMonitorSummary(memoryStore, live);
        try {
          const monitor = await dependencies.loadServiceMonitor();
          serviceMonitor = monitor;
          if (ctx.mode === "tui") {
            await showReviewServiceMonitor(ctx, monitor, memory, dependencies.loadServiceMonitor);
          } else {
            presentCommandOutput(ctx, `${formatReviewServiceMonitorText(monitor, memory)}\nstorage: ${memoryStore.projectDir}`);
          }
        } catch (error) {
          presentCommandOutput(ctx, [
            `project: ${memoryStore.projectRoot}`,
            `storage: ${memoryStore.projectDir}`,
            `active memory: ${activeName}`,
            `review authority: ${serviceConfig.mode}`,
            `review spool: ${reviewSpool ? "ready" : "inactive"}`,
            `entries: ${live.entries.length}`,
            `capacity: ${memoryCharCount(live)}/${memoryStore.maxChars} chars`,
            `service monitor: unavailable (${errorMessage(error)})`,
          ].join("\n"), "warning");
        }
        refreshStatus(ctx);
        return;
      }

      if (subcommand === "show" || subcommand === "list") {
        const output = formatBranch(await memoryStore.loadBranch(activeName));
        const readableOutput = ctx.mode === "tui"
          ? output.split("\n").map((line) => ctx.ui.theme.fg("text", line)).join("\n")
          : output;
        presentCommandOutput(ctx, readableOutput);
        return;
      }

      if (subcommand === "branches") {
        const branches = await memoryStore.listBranches();
        presentCommandOutput(ctx, branches.map((branch) => `${branch.name === activeName ? "*" : " "} ${branch.name}${branch.parent ? ` ← ${branch.parent}` : ""} · ${branch.entries.length} entries`).join("\n"));
        return;
      }

      if (subcommand === "fork") {
        if (!value) {
          ctx.ui.notify("Usage: /memory fork <name>", "warning");
          return;
        }
        await ctx.waitForIdle();
        await reviewPromise;
        const boundaryEntryId = ctx.sessionManager.getLeafId();
        const branch = await memoryStore.forkBranch(activeName, value);
        activeName = branch.name;
        frozenBranch = branch;
        pi.appendEntry(ACTIVE_MEMORY_ENTRY, { name: activeName });
        if (boundaryEntryId) appendReviewCursor(activeName, boundaryEntryId, "branch-boundary");
        else reviewCursorId = undefined;
        refreshStatus(ctx);
        const persistence = ctx.sessionManager.getSessionFile() ? "" : " Selection is process-local because session persistence is disabled.";
        ctx.ui.notify(`Forked memory '${branch.parent}' → '${branch.name}' and switched this session.${persistence}`, "info");
        return;
      }

      if (subcommand === "use") {
        if (!value) {
          ctx.ui.notify("Usage: /memory use <name>", "warning");
          return;
        }
        await ctx.waitForIdle();
        await reviewPromise;
        await switchMemory(value, ctx);
        const persistence = ctx.sessionManager.getSessionFile() ? "" : " Selection is process-local because session persistence is disabled.";
        ctx.ui.notify(`Using project memory '${activeName}' for this session.${persistence}`, "info");
        return;
      }

      if (subcommand === "review") {
        await ctx.waitForIdle();
        await runReview(ctx, true);
        return;
      }

      if (subcommand === "undo") {
        await ctx.waitForIdle();
        await reviewPromise;
        const result = await memoryStore.undoReview(activeName);
        frozenBranch = result.branch;
        refreshStatus(ctx);
        ctx.ui.notify(`${result.message} Previous memory will be injected next turn.`, "info");
        return;
      }

      ctx.ui.notify("Usage: /memory status|show|branches|fork|use|review|undo", "warning");
    },
  });

  function consumeCompletedInputs(ctx: ExtensionContext): { inputs: string[]; unseenIds: Set<string> } {
    const unseen = ctx.sessionManager.getBranch().filter((entry) =>
      entry.type === "message" && entry.message.role === "user" && !knownUserEntryIds.has(entry.id)
    );
    for (const entry of unseen) knownUserEntryIds.add(entry.id);
    const completedCount = Math.min(unseen.length, pendingUserInputs.length);
    const inputs = pendingUserInputs.slice(-completedCount);
    pendingUserInputs = [];
    return { inputs, unseenIds: new Set(unseen.map((entry) => entry.id)) };
  }

  async function trackSkillUses(names: string[], ctx: ExtensionContext): Promise<string[]> {
    if (!skillStore || names.length === 0) return [];
    const sessionId = ctx.sessionManager.getSessionId();
    const tracking = await Promise.allSettled(names.map((name) => skillStore!.recordUse(name, sessionId)));
    const summary = summarizeSkillTracking(names, tracking);
    pendingSkillCount = Math.max(0, pendingSkillCount - summary.withdrawn);
    notifySkillTrackingFailures(summary.failed, ctx);
    refreshStatus(ctx);
    return summary.tracked;
  }

  async function completeSkillSession(ctx: ExtensionContext): Promise<void> {
    if (!skillStore) return;
    try {
      const maintenance = await skillStore.completeSession(ctx.sessionManager.getSessionId());
      if (maintenance.proposals.length === 0) return;
      pendingSkillCount += maintenance.proposals.length;
      if (ctx.hasUI) {
        const names = maintenance.proposals.map((proposal) => proposal.operations.at(0)?.name ?? "unknown");
        ctx.ui.notify(`Project skill retention staged archive proposal(s): ${names.join(", ")}.`, "info");
      }
      refreshStatus(ctx);
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Project skill session completion failed: ${errorMessage(error)}`, "warning");
    }
  }

  async function recordCompletedTurnSignals(
    inputs: string[],
    unseenIds: Set<string>,
    ctx: ExtensionContext,
  ): Promise<void> {
    const branch = ctx.sessionManager.getBranch();
    const lastNewUserIndex = branch.reduce((index, entry, currentIndex) => (
      entry.type === "message" && entry.message.role === "user" && unseenIds.has(entry.id) ? currentIndex : index
    ), -1);
    const completedTurnEntries = lastNewUserIndex >= 0 ? branch.slice(lastNewUserIndex) : [];
    const toolResultCount = completedTurnEntries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").length;
    const complexitySignal = toolResultCount >= 5 ? 4 : 0;
    for (const text of inputs) {
      await store!.recordUserTurn(activeName, scoreMemorySignal(text));
      if (skillStore) await skillStore.recordUserTurn(scoreSkillSignal(text) + complexitySignal);
    }
  }

  pi.registerEntryRenderer<{ jobId?: string; mode?: string; status?: string }>(MEMORY_REVIEW_JOB_ENTRY, (entry, _options, theme) => {
    const jobId = typeof entry.data?.jobId === "string" ? entry.data.jobId : "unknown";
    const mode = entry.data?.mode === "external" ? "external" : "shadow";
    const status = typeof entry.data?.status === "string" ? entry.data.status : "queued";
    return new Text(
      theme.fg("dim", `No Forgetti review ${status} · ${mode} · ${jobId.slice(0, 18)}…`),
      1,
      0,
    );
  });

  pi.registerEntryRenderer<{ branch: string; changes: MemoryReviewChange[] }>(MEMORY_REVIEW_ENTRY, (entry, { expanded }, theme) => {
    const changes = Array.isArray(entry.data?.changes)
      ? entry.data.changes.filter((change): change is MemoryReviewChange =>
          Boolean(change) && typeof change.text === "string" && Object.hasOwn(REVIEW_GLYPHS, change.kind))
      : [];
    if (changes.length === 0) return undefined;
    const branchSuffix = typeof entry.data?.branch === "string" && entry.data.branch !== MAIN_MEMORY
      ? ` (${entry.data.branch})`
      : "";
    const rail = theme.fg("dim", "│ ");
    const lines = [theme.fg("dim", `╭ no-forgetti memory updated${branchSuffix}  /memory undo`)];
    for (const change of changes) {
      const glyph = theme.fg(
        change.kind === "add" ? "toolDiffAdded" : change.kind === "remove" ? "toolDiffRemoved" : "accent",
        REVIEW_GLYPHS[change.kind],
      );
      const [head = "", ...rest] = (expanded ? change.text.trim() : clipReviewLine(change.text)).split("\n");
      lines.push(`${rail}${glyph} ${theme.fg("muted", head)}`);
      for (const extra of rest) lines.push(`${rail}  ${theme.fg("muted", extra)}`);
      if (expanded && change.oldText) {
        for (const [index, old] of change.oldText.trim().split("\n").entries()) {
          lines.push(`${rail}  ${theme.fg("dim", index === 0 ? `was: ${old}` : old)}`);
        }
      }
    }
    return new Text(lines.join("\n"), 1, 0);
  });

  async function settleLifecycleWork(): Promise<void> {
    reviewController?.abort();
    skillReviewController?.abort(REVIEW_ABORT_LIFECYCLE);
    await reviewPromise?.catch(() => undefined);
    await skillReviewPromise?.catch(() => undefined);
    await externalFeedbackPromise?.catch(() => undefined);
  }

  pi.on("session_start", async (_event, ctx) => {
    await loadSessionMemory(ctx);
  });

  pi.on("resources_discover", () => {
    if (!skillStore) return;
    return { skillPaths: [skillStore.skillsDir] };
  });

  pi.on("session_tree", async (_event, ctx) => {
    await settleLifecycleWork();
    await loadSessionMemory(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (!store) return;
    frozenBranch = await store.loadBranch(activeName);
    refreshStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!store) return;
    await reconcileExternalReviewFeedback(ctx);
    // Memory is live project state: pick up background, tool, and cross-session
    // writes at every turn boundary without requiring manual refresh.
    frozenBranch = await store.loadBranch(activeName);
    refreshStatus(ctx);
    const blocks = [event.systemPrompt];
    const memoryBlock = formatMemoryContext(frozenBranch, store.maxChars);
    if (memoryBlock) blocks.push(memoryBlock);
    return { systemPrompt: blocks.join("\n\n") };
  });

  pi.on("message_end", (event, ctx) => {
    if (!skillStore) return;
    const name = projectSkillNameFromInvocation({
      message: event.message,
      cwd: ctx.cwd,
      skillsDir: skillStore.skillsDir,
    });
    if (name) observedNativeSkillUses.add(name);
  });

  pi.on("tool_result", (event, ctx) => {
    if (!skillStore || event.toolName !== "read" || event.isError) return;
    const path = event.input.path;
    if (typeof path !== "string") return;
    const name = projectSkillNameFromReadPath({
      path,
      cwd: ctx.cwd,
      skillsDir: skillStore.skillsDir,
    });
    if (name) observedNativeSkillUses.add(name);
  });

  pi.on("input", async (event) => {
    if (event.source === "extension" || !store) return;
    pendingUserInputs.push(event.text);
  });

  pi.on("agent_end", async (event) => {
    const finalAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    // A completed tool loop may end with `length` or `toolUse`; only provider
    // errors/aborts mean there is no usable conversation to review.
    lastAgentRunSuccessful = finalAssistant?.role === "assistant"
      && finalAssistant.stopReason !== "error"
      && finalAssistant.stopReason !== "aborted";
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const settledSkillUses = [...observedNativeSkillUses];
    observedNativeSkillUses.clear();
    if (!store) return;
    const completed = consumeCompletedInputs(ctx);
    if (!lastAgentRunSuccessful || completed.inputs.length === 0) return;

    const trackedSkillUses = await trackSkillUses(settledSkillUses, ctx);
    if (trackedSkillUses.length > 0) pi.appendEntry(PROJECT_SKILL_USE_ENTRY, { names: trackedSkillUses });
    await completeSkillSession(ctx);
    await recordCompletedTurnSignals(completed.inputs, completed.unseenIds, ctx);

    const reviewExisting = reviewExistingSession;
    reviewExistingSession = false;
    const skillReviewExisting = skillReviewExistingSession;
    skillReviewExistingSession = false;
    // Existing sessions are eligible on their first completed turn; fresh
    // sessions use cadence plus explicit correction/complexity signals.
    void runReview(ctx, reviewExisting).catch(() => undefined);
    void runSkillReview(ctx, skillReviewExisting).catch(() => undefined);
  });

  pi.on("session_shutdown", async () => {
    if (serviceMonitorTimer) clearInterval(serviceMonitorTimer);
    serviceMonitorTimer = undefined;
    observedNativeSkillUses.clear();
    pendingUserInputs = [];
    await settleLifecycleWork();
  });
}

export default function projectMemoryExtension(pi: ExtensionAPI): void {
  activateProjectMemoryExtension(pi);
}
