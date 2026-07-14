import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { formatMemoryContext, memoryCharCount } from "./context.ts";
import { scoreMemorySignal } from "./heuristics.ts";
import { resolveProjectRoot } from "./project.ts";
import { safeContextText } from "./security.ts";
import { requestReviewPlan } from "./review.ts";
import {
  ACTIVE_MEMORY_ENTRY,
  REVIEW_CURSOR_ENTRY,
  restoreActiveMemory,
  restoreReviewCursor,
} from "./session-state.ts";
import { ProjectMemoryStore } from "./store.ts";
import {
  DEFAULT_REVIEW_INTERVAL,
  DEFAULT_REVIEW_SIGNAL_THRESHOLD,
  MAIN_MEMORY,
  type MemoryAction,
  type MemoryBranch,
  type MutationResult,
} from "./types.ts";

const STATUS_KEY = "no-forgetti";
const TOOL_NAME = "project_memory";
const REVIEW_TIMEOUT_MS = 60_000;

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBranch(branch: MemoryBranch): string {
  if (branch.entries.length === 0) return `(project memory '${branch.name}' is empty)`;
  return branch.entries.map((entry, index) => `${index + 1}. ${safeContextText(entry.text)}`).join("\n");
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

export default function projectMemoryExtension(pi: ExtensionAPI): void {
  let store: ProjectMemoryStore | undefined;
  let activeName = MAIN_MEMORY;
  let frozenBranch: MemoryBranch | undefined;
  let snapshotDirty = false;
  let reviewPromise: Promise<void> | undefined;
  let reviewController: AbortController | undefined;
  let pendingUserInputs: string[] = [];
  let reviewCursorId: string | undefined;
  let knownUserEntryIds = new Set<string>();
  let lastAgentRunSuccessful = false;

  function requireStore(): ProjectMemoryStore {
    if (!store) throw new Error("Project memory has not initialized yet.");
    return store;
  }

  function appendReviewCursor(name: string, throughEntryId: string, outcome: "reviewed" | "branch-boundary"): void {
    const memoryStore = requireStore();
    pi.appendEntry(REVIEW_CURSOR_ENTRY, {
      projectKey: memoryStore.projectKey,
      name,
      throughEntryId,
      outcome,
    });
    if (name === activeName) reviewCursorId = throughEntryId;
  }

  function refreshStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !store || !frozenBranch) return;
    const t = ctx.ui.theme;
    const marker = snapshotDirty ? "*" : "";
    const color = snapshotDirty ? "warning" : "muted";
    ctx.ui.setStatus(
      STATUS_KEY,
      `${t.fg(color, snapshotDirty ? "◆" : "◇")} ${t.fg("muted", `memory:${activeName}${marker} · ${frozenBranch.entries.length}`)}`,
    );
  }

  async function loadSessionMemory(ctx: ExtensionContext): Promise<void> {
    const projectRoot = resolveProjectRoot(ctx.cwd);
    const nextStore = new ProjectMemoryStore(projectRoot);
    try {
      await nextStore.initialize();
    } catch (error) {
      store = undefined;
      frozenBranch = undefined;
      if (ctx.hasUI) ctx.ui.notify(`No Forgetti disabled for this project: ${errorMessage(error)}`, "warning");
      return;
    }
    store = nextStore;
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
    knownUserEntryIds = new Set(
      ctx.sessionManager.getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .map((entry) => entry.id),
    );
    pendingUserInputs = [];
    lastAgentRunSuccessful = false;
    snapshotDirty = false;
    refreshStatus(ctx);
  }

  async function switchMemory(name: string, ctx: ExtensionContext): Promise<void> {
    const memoryStore = requireStore();
    const branch = await memoryStore.loadBranch(name);
    const boundaryEntryId = ctx.sessionManager.getLeafId();
    activeName = branch.name;
    frozenBranch = branch;
    snapshotDirty = false;
    pi.appendEntry(ACTIVE_MEMORY_ENTRY, { name: activeName });
    if (boundaryEntryId) appendReviewCursor(activeName, boundaryEntryId, "branch-boundary");
    else reviewCursorId = undefined;
    refreshStatus(ctx);
  }

  async function runReview(ctx: ExtensionContext, force: boolean): Promise<void> {
    if (reviewPromise) {
      if (force && ctx.hasUI) ctx.ui.notify("Project memory review already running.", "info");
      return reviewPromise;
    }
    const memoryStore = requireStore();
    const reviewBranchName = activeName;
    const reviewAfterEntryId = reviewCursorId;
    const throughEntryId = ctx.sessionManager.getLeafId();
    const claimed = await memoryStore.claimReviewIfDue(
      reviewBranchName,
      DEFAULT_REVIEW_INTERVAL,
      DEFAULT_REVIEW_SIGNAL_THRESHOLD,
      force,
    );
    if (!claimed) return;

    reviewController = new AbortController();
    const reviewTimeout = setTimeout(() => reviewController?.abort(), REVIEW_TIMEOUT_MS);
    reviewPromise = (async () => {
      let success = false;
      try {
        const branch = await memoryStore.loadBranch(reviewBranchName);
        const plan = await requestReviewPlan(ctx, branch, reviewController?.signal, reviewAfterEntryId);
        const results = await memoryStore.applyOperations(
          reviewBranchName,
          plan.operations,
          ctx.sessionManager.getSessionId(),
          "background_review",
        );
        const changed = results.filter((result) => result.changed);
        const rejected = results.some((result) => result.message.startsWith("Review batch rejected;"));
        if (reviewBranchName === activeName) snapshotDirty ||= changed.length > 0;
        if (!rejected && throughEntryId) appendReviewCursor(reviewBranchName, throughEntryId, "reviewed");
        success = !rejected;
        if (ctx.hasUI && (force || changed.length > 0)) {
          const summary = changed.length > 0
            ? `Project memory review (${reviewBranchName}): ${changed.map((result) => result.message).join(" ")} Changes load next session or after /memory refresh; /memory undo restores the prior state.`
            : "Project memory review: nothing durable to save.";
          ctx.ui.notify(summary, "info");
          refreshStatus(ctx);
        }
      } catch (error) {
        if (force && ctx.hasUI) {
          ctx.ui.notify(`Project memory review failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      } finally {
        clearTimeout(reviewTimeout);
        await memoryStore.finishReview(reviewBranchName, success).catch(() => undefined);
        reviewController = undefined;
        reviewPromise = undefined;
      }
    })();
    return reviewPromise;
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: "No Forgetti",
    description:
      "Manage durable memory scoped to this project. Actions: list, add, replace, remove. " +
      "Save stable project conventions, architecture facts, verification commands, recurring preferences, and non-obvious durable workflows. " +
      "Never save secrets, temporary task progress, completed-work logs, issue/PR numbers, commit hashes, or raw tool output. " +
      "replace/remove use oldText as a unique substring. Writes persist immediately but the injected context stays frozen until the next session or explicit /memory refresh.",
    promptSnippet: "Read or update durable project-scoped memory",
    promptGuidelines: [
      `Use ${TOOL_NAME} after durable project-specific learning that would prevent future rediscovery or correction.`,
      `Use ${TOOL_NAME} action=replace to consolidate overlapping entries instead of growing memory indefinitely.`,
      `Do not use ${TOOL_NAME} for task progress, transient failures, secrets, or facts already present in AGENTS.md or checked-in docs.`,
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      action: StringEnum(["list", "add", "replace", "remove"] as const),
      content: Type.Optional(Type.String({ description: "Memory text for add/replace" })),
      oldText: Type.Optional(Type.String({ description: "Unique substring for replace/remove" })),
    }),
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
        { action: params.action, content: params.content, oldText: params.oldText },
        ctx.sessionManager.getSessionId(),
        "assistant_tool",
      );
      snapshotDirty ||= result.changed;
      refreshStatus(ctx);
      const suffix = result.changed ? " Injected context remains frozen; visible next session or after /memory refresh." : "";
      return {
        content: [{ type: "text", text: `${result.message}${suffix}` }],
        details: toolDetails(params.action, result, memoryStore),
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) + theme.fg("muted", args.action);
      if (args.content) text += ` ${theme.fg("dim", `"${firstLine(args.content).slice(0, 80)}"`)}`;
      if (args.oldText) text += ` ${theme.fg("dim", `matching "${firstLine(args.oldText).slice(0, 50)}"`)}`;
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

  pi.registerCommand("memory", {
    description: "Project memory. Usage: /memory status|show|branches|fork <name>|use <name>|refresh|review|undo",
    getArgumentCompletions: async (prefix) => {
      const base = [
        { value: "status", label: "status", description: "Show project memory status" },
        { value: "show", label: "show", description: "Show active memory entries" },
        { value: "branches", label: "branches", description: "List memory branches" },
        { value: "fork ", label: "fork <name>", description: "Explicitly clone active memory and switch this session" },
        { value: "use ", label: "use <name>", description: "Switch this session to an existing memory branch" },
        { value: "refresh", label: "refresh", description: "Reload live memory into this session context" },
        { value: "review", label: "review", description: "Run self-learning review now" },
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
        ctx.ui.notify([
          `project: ${memoryStore.projectRoot}`,
          `storage: ${memoryStore.projectDir}`,
          `active memory: ${activeName}${snapshotDirty ? " (live writes not injected yet)" : ""}`,
          `entries: ${live.entries.length}`,
          `capacity: ${memoryCharCount(live)}/${memoryStore.maxChars} chars`,
          "session forks share this memory branch unless you explicitly run /memory fork <name>",
        ].join("\n"), "info");
        refreshStatus(ctx);
        return;
      }

      if (subcommand === "show" || subcommand === "list") {
        ctx.ui.notify(formatBranch(await memoryStore.loadBranch(activeName)), "info");
        return;
      }

      if (subcommand === "branches") {
        const branches = await memoryStore.listBranches();
        ctx.ui.notify(branches.map((branch) => `${branch.name === activeName ? "*" : " "} ${branch.name}${branch.parent ? ` ← ${branch.parent}` : ""} · ${branch.entries.length} entries`).join("\n"), "info");
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
        snapshotDirty = false;
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

      if (subcommand === "refresh") {
        await ctx.waitForIdle();
        await reviewPromise;
        frozenBranch = await memoryStore.loadBranch(activeName);
        snapshotDirty = false;
        refreshStatus(ctx);
        ctx.ui.notify(`Reloaded project memory '${activeName}'. Next turn uses the fresh snapshot.`, "info");
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
        snapshotDirty = !frozenBranch || JSON.stringify(result.branch.entries) !== JSON.stringify(frozenBranch.entries);
        refreshStatus(ctx);
        ctx.ui.notify(`${result.message} Injected context remains unchanged until /memory refresh or the next session.`, "info");
        return;
      }

      ctx.ui.notify("Usage: /memory status|show|branches|fork <name>|use <name>|refresh|review|undo", "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await loadSessionMemory(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    reviewController?.abort();
    await reviewPromise?.catch(() => undefined);
    await loadSessionMemory(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (!store) return;
    frozenBranch = await store.loadBranch(activeName);
    snapshotDirty = false;
    refreshStatus(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!store || !frozenBranch) return;
    const block = formatMemoryContext(frozenBranch, store.maxChars);
    if (!block) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.on("input", async (event) => {
    if (event.source === "extension" || !store) return;
    pendingUserInputs.push(event.text);
  });

  pi.on("agent_end", async (event) => {
    const finalAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    lastAgentRunSuccessful = finalAssistant?.role === "assistant" && finalAssistant.stopReason === "stop";
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!store) return;
    const unseenUserEntries = ctx.sessionManager.getBranch().filter((entry) =>
      entry.type === "message" && entry.message.role === "user" && !knownUserEntryIds.has(entry.id)
    );
    for (const entry of unseenUserEntries) knownUserEntryIds.add(entry.id);
    const completedCount = Math.min(unseenUserEntries.length, pendingUserInputs.length);
    const completedInputs = pendingUserInputs.slice(-completedCount);
    pendingUserInputs = [];
    if (!lastAgentRunSuccessful || completedInputs.length === 0) return;

    const completedBranchName = activeName;
    for (const text of completedInputs) {
      await store.recordUserTurn(completedBranchName, scoreMemorySignal(text));
    }
    void runReview(ctx, false);
  });

  pi.on("session_shutdown", async () => {
    pendingUserInputs = [];
    reviewController?.abort();
    await reviewPromise?.catch(() => undefined);
  });
}
