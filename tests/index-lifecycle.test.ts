import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { activateProjectMemoryExtension, resolvePendingRef, type ExtensionDependencies } from "../src/index.ts";
import { PROJECT_SKILL_USE_ENTRY } from "../src/skill-native.ts";
import type { SkillReviewJob } from "../src/skill-review-job.ts";
import type { SkillReviewResult } from "../src/skill-review.ts";
import { ProjectSkillStore } from "../src/skill-store.ts";
import {
  DEFAULT_SKILL_REVIEW_INTERVAL,
  MAX_SKILL_DESCRIPTION_CHARS,
  type SkillOperation,
  type SkillProposal,
} from "../src/skill-types.ts";
import { FileMemoryProposalCommitter } from "../src/service/admission.ts";
import { ReviewDecisionStore } from "../src/service/decisions.ts";
import { createReviewOutcome } from "../src/service/protocol.ts";
import { ReviewSpool } from "../src/service/spool.ts";
import { ProjectMemoryStore } from "../src/store.ts";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown | Promise<unknown>;

class FakeExtension {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, unknown>();
  readonly commands = new Map<string, { handler: (args: string, context: ExtensionContext) => unknown | Promise<unknown> }>();
  readonly entryRenderers = new Map<string, unknown>();
  readonly entries: Array<{ customType: string; data: unknown }> = [];

  readonly api = {
    on: (name: string, handler: Handler) => {
      const handlers = this.handlers.get(name) ?? [];
      handlers.push(handler);
      this.handlers.set(name, handlers);
    },
    registerTool: (tool: { name: string }) => this.tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: (args: string, context: ExtensionContext) => unknown | Promise<unknown> }) => this.commands.set(name, command),
    registerEntryRenderer: (customType: string, renderer: unknown) => this.entryRenderers.set(customType, renderer),
    appendEntry: (customType: string, data: unknown) => this.entries.push({ customType, data }),
  } as unknown as ExtensionAPI;

  async emit(name: string, event: Record<string, unknown>, context: ExtensionContext): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(name) ?? []) results.push(await handler(event, context));
    return results;
  }

  async command(name: string, args: string, context: ExtensionContext): Promise<unknown> {
    const command = this.commands.get(name);
    if (!command) throw new Error(`Unknown command: ${name}`);
    return command.handler(args, context);
  }
}

async function fixture(t: test.TestContext, overrides: Partial<ExtensionDependencies> = {}) {
  const base = await mkdtemp(join(tmpdir(), "no-forgetti-lifecycle-"));
  const project = join(base, "repo");
  await mkdir(join(project, ".git"), { recursive: true });
  const memoryStore = new ProjectMemoryStore(project, { storageRoot: join(base, "state") });
  await memoryStore.initialize();
  const skillStore = new ProjectSkillStore(project, { projectDir: memoryStore.projectDir });
  await skillStore.initialize();
  const proposal = await skillStore.stageProposal([{
    action: "create",
    name: "verification",
    description: "Run the canonical project verification.",
    content: "# Verification\n\n## Procedure\n\n1. Run the canonical check and confirm it exits successfully.",
  }], "setup-session");
  await skillStore.approveProposal(proposal.id);

  const branch: Array<Record<string, unknown>> = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const widgets = new Map<string, unknown>();
  const statuses = new Map<string, string | undefined>();
  const context = {
    cwd: project,
    hasUI: false,
    mode: "print",
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string, type: string) => notifications.push({ message, type }),
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      setWidget: (key: string, value: unknown) => widgets.set(key, value),
    },
    waitForIdle: async () => undefined,
    sessionManager: {
      getSessionId: () => "lifecycle-session",
      getSessionFile: () => undefined,
      getLeafId: () => branch.at(-1)?.id as string | undefined,
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;

  const extension = new FakeExtension();
  const reviewSpool = new ReviewSpool(join(base, "review-spool"));
  activateProjectMemoryExtension(extension.api, {
    isNonPrimaryAgent: () => false,
    createMemoryStore: () => memoryStore,
    createSkillStore: () => skillStore,
    loadServiceConfig: async () => ({ version: 1, mode: "embedded", evidenceTtlHours: 24 }),
    loadServiceMonitor: async () => ({
      mode: "embedded",
      budget: { day: "2026-01-01", calls: 0, tokens: 0, costUsd: 0 },
      spool: { queued: 0, running: 0, outcomes: 0, deadLetter: 0 },
      workerFresh: false,
      exhausted: [],
      observedAt: "2026-01-01T00:00:00.000Z",
    }),
    createReviewSpool: () => reviewSpool,
    createRuntimeReporter: () => ({
      start() {},
      heartbeat() {},
      stop() {},
      async flush() {},
    }),
    ...overrides,
  });
  t.after(async () => {
    await extension.emit("session_shutdown", {}, context);
    await rm(base, { recursive: true, force: true });
  });
  return { branch, context, extension, memoryStore, skillStore, reviewSpool, notifications, statuses, widgets };
}

function userEntry(id: string, text: string): Record<string, unknown> {
  return { id, type: "message", message: { role: "user", content: text } };
}

function skillReviewResult(
  job: Readonly<SkillReviewJob>,
  operations: SkillOperation[] = [],
  disposition: "proposed" | "no-change" | "invalid-output" = operations.length > 0 ? "proposed" : "no-change",
): SkillReviewResult {
  const profile = {
    provider: "test",
    model: "reviewer",
    api: "test-api",
    reasoningEffort: "xhigh",
    maxOutputTokens: 8_192,
  };
  return {
    profile,
    outcome: {
      version: 1,
      kind: "project-skill-review-outcome",
      jobId: job.id,
      jobDigest: job.digest,
      disposition,
      plan: { operations },
      attempts: disposition === "invalid-output" ? [] : [{
        ordinal: 1,
        promptDigest: job.contract.initialPromptDigest,
        requestDigest: job.contract.requestDigest,
        outputDigest: "b".repeat(64),
        provenance: {
          provider: profile.provider,
          model: profile.model,
          api: profile.api,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.100Z",
          durationMs: 100,
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      }],
    },
  };
}

const assistantMessage = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" };
const overlongSkillDescription = `${"x".repeat(MAX_SKILL_DESCRIPTION_CHARS)}.`;

test("registers lifecycle hooks and disables itself for companion agents", async () => {
  const primary = new FakeExtension();
  activateProjectMemoryExtension(primary.api, { isNonPrimaryAgent: () => false });
  for (const name of ["session_start", "resources_discover", "session_tree", "session_compact", "before_agent_start", "message_end", "tool_result", "input", "agent_end", "agent_settled", "session_shutdown"]) {
    assert.equal(primary.handlers.has(name), true, name);
  }
  assert.deepEqual([...primary.tools.keys()], ["project_memory"]);
  assert.deepEqual([...primary.commands.keys()].sort(), ["memory", "project-skills"]);

  const companion = new FakeExtension();
  activateProjectMemoryExtension(companion.api, { isNonPrimaryAgent: () => true });
  assert.equal(companion.handlers.size, 0);
  assert.equal(companion.tools.size, 0);
  assert.equal(companion.commands.size, 0);
});

test("model tool records assessed importance on new memory", async (t) => {
  const { context, extension, memoryStore } = await fixture(t);
  await extension.emit("session_start", {}, context);
  const tool = extension.tools.get("project_memory") as {
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      context: ExtensionContext,
    ) => Promise<unknown>;
  };

  await tool.execute("tool-1", {
    action: "add",
    content: "Canonical deploy workflow is expensive to rediscover.",
    importance: "high",
  }, undefined, undefined, context);

  const entry = (await memoryStore.loadBranch("main")).entries.at(0);
  assert.ok(entry);
  assert.equal(entry.importance, "high");
  assert.ok(entry.importanceAssessedAt);
});

test("skill review advances only through each bounded authorship packet", async (t) => {
  const packets: Array<{ coverage: { frontierEntryId?: string; includedUserEntryIds: string[] } }> = [];
  const { branch, context, extension } = await fixture(t, {
    requestSkillReviewPlan: async (_ctx, job) => {
      packets.push(job);
      return skillReviewResult(job);
    },
  });
  await extension.emit("session_start", {}, context);
  branch.push(...Array.from({ length: 14 }, (_, index) => userEntry(`user-${index + 1}`, `turn ${index + 1}`)));

  await extension.command("project-skills", "review", context);
  await extension.command("project-skills", "review", context);

  assert.equal(packets.length, 2);
  assert.equal(packets[0]?.coverage.frontierEntryId, "user-12");
  assert.deepEqual(packets[0]?.coverage.includedUserEntryIds, Array.from({ length: 12 }, (_, index) => `user-${index + 1}`));
  assert.equal(packets[1]?.coverage.frontierEntryId, "user-14");
  assert.deepEqual(packets[1]?.coverage.includedUserEntryIds, ["user-13", "user-14"]);
  const cursors = extension.entries.filter((entry) => entry.customType === "no-forgetti-skill-review");
  assert.deepEqual(cursors.map((entry) => (entry.data as { throughEntryId: string }).throughEntryId), ["user-12", "user-14"]);
});

test("skill review does not advance coverage when exact cadence settlement fails", async (t) => {
  const { branch, context, extension, skillStore, notifications } = await fixture(t, {
    requestSkillReviewPlan: async (_ctx, job) => skillReviewResult(job),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);
  branch.push(userEntry("user-1", "durable workflow evidence"));
  skillStore.finishReview = async () => false;

  await extension.command("project-skills", "review", context);

  assert.equal(extension.entries.some((entry) => entry.customType === "no-forgetti-skill-review"), false);
  assert.match(notifications.at(-1)?.message ?? "", /evidence remains due/u);
});

test("typed invalid reviewer output retains exact evidence instead of settling no-change", async (t) => {
  let attempts = 0;
  const { branch, context, extension } = await fixture(t, {
    requestSkillReviewPlan: async (_ctx, job) => {
      attempts += 1;
      return skillReviewResult(job, [], "invalid-output");
    },
  });
  await extension.emit("session_start", {}, context);
  branch.push(userEntry("user-1", "durable workflow evidence"));

  await extension.command("project-skills", "review", context);
  await extension.command("project-skills", "review", context);

  assert.equal(attempts, 2);
  assert.equal(extension.entries.some((entry) => entry.customType === "no-forgetti-skill-review"), false);
});

test("skill review automatically adds validated creates", async (t) => {
  const { context, extension, skillStore } = await fixture(t, {
    requestSkillReviewPlan: async (_ctx, job) => skillReviewResult(job, [{
      action: "create",
      name: "release-check",
      description: "Verify a project release.",
      content: "# Release check\n\n## Steps\n\n1. Run release checks. Done when: all checks pass.",
    }]),
  });
  await extension.emit("session_start", {}, context);
  await extension.command("project-skills", "review", context);

  assert.equal((await skillStore.loadSkill("release-check")).state, "active");
  assert.equal((await skillStore.listPending()).length, 0);
});

test("skill review stages patches for explicit approval without mutating the active skill", async (t) => {
  const { context, extension, skillStore, notifications } = await fixture(t, {
    requestSkillReviewPlan: async (_ctx, job) => skillReviewResult(job, [{
      action: "patch",
      name: "verification",
      oldText: "canonical check",
      newText: "canonical verification check",
    }]),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);
  await extension.command("project-skills", "review", context);

  assert.match((await skillStore.loadSkill("verification")).content, /canonical check/u);
  const pending = await skillStore.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.origin, "background_review");
  assert.equal(pending[0]?.operations.at(0)?.action, "patch");
  assert.deepEqual(notifications.at(-1), {
    message: "Project skill review staged patch 'verification'. Inspect with /project-skills pending verification",
    type: "info",
  });
});

test("foreground editing never coalesces with a pending background patch", async (t) => {
  const { context, extension, skillStore } = await fixture(t, {
    requestSkillReviewPlan: async (_ctx, job) => skillReviewResult(job, [{
      action: "patch",
      name: "verification",
      oldText: "canonical check",
      newText: "background verification check",
    }]),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  Object.assign(context.ui, {
    editor: async (_title: string, content: string) => content.replace("canonical check", "foreground verification check"),
  });
  await extension.emit("session_start", {}, context);
  await extension.command("project-skills", "review", context);
  const background = (await skillStore.listPending()).at(0);
  assert.equal(background?.origin, "background_review");

  await extension.command("project-skills", "edit verification", context);

  assert.match((await skillStore.loadSkill("verification")).content, /foreground verification check/u);
  const pending = await skillStore.listPending();
  assert.deepEqual(pending.map(({ id }) => id), [background?.id]);
  assert.equal(pending[0]?.origin, "background_review");
});

test("invalid patch admission retains review evidence without leaving approval work", async (t) => {
  const { context, extension, skillStore, notifications } = await fixture(t, {
    requestSkillReviewPlan: async (_ctx, job) => skillReviewResult(job, [{
      action: "patch",
      name: "verification",
      oldText: "Run the canonical project verification.",
      newText: overlongSkillDescription,
    }]),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);
  await extension.command("project-skills", "review", context);

  assert.equal((await skillStore.loadSkill("verification")).description, "Run the canonical project verification.");
  assert.equal((await skillStore.listPending()).length, 0);
  assert.deepEqual(notifications.at(-1), {
    message: "Project skill review failed: Discarded invalid project skill proposal 'verification'.",
    type: "warning",
  });
});

test("malformed generated creates retain evidence and enter retry backoff", async (t) => {
  const { context, extension, skillStore, notifications } = await fixture(t, {
    requestSkillReviewPlan: async (_ctx, job) => skillReviewResult(job, [{
      action: "create",
      name: "release-check",
      description: overlongSkillDescription,
      content: "# Release check\n\n## Steps\n\n1. Run release checks. Done when: all checks pass.",
    }]),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);
  await extension.command("project-skills", "review", context);

  await assert.rejects(skillStore.loadSkill("release-check"), { code: "ENOENT" });
  assert.equal((await skillStore.listPending()).length, 0);
  const reviewState = JSON.parse(await readFile(skillStore.reviewPath, "utf8")) as { consecutiveFailures: number };
  assert.equal(reviewState.consecutiveFailures, 1);
  assert.deepEqual(notifications.at(-1), {
    message: "Project skill review failed: Discarded invalid project skill proposal.",
    type: "warning",
  });
});

test("approve-all confirms once and applies every pending project skill proposal", async (t) => {
  const { context, extension, skillStore, notifications } = await fixture(t);
  await extension.emit("session_start", {}, context);
  const second = await skillStore.stageProposal([{
    action: "create",
    name: "release-check",
    description: "Verify a project release.",
    content: "# Release check\n\n## Procedure\n\n1. Run release checks. Completion criterion: all checks pass.",
  }], "setup-session");
  await skillStore.approveProposal(second.id);
  await skillStore.stageProposal([{ action: "archive", name: "verification" }], "setup-session");
  await skillStore.stageProposal([{ action: "archive", name: "release-check" }], "setup-session");

  const confirmations: Array<{ title: string; detail: string }> = [];
  Object.assign(context, { hasUI: true, mode: "tui" });
  Object.assign(context.ui, {
    confirm: async (title: string, detail: string) => {
      confirmations.push({ title, detail });
      return true;
    },
  });
  await extension.command("project-skills", "approve-all", context);

  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0]!.title, /Approve all 2 pending/u);
  assert.match(confirmations[0]!.detail, /archive verification/u);
  assert.match(confirmations[0]!.detail, /archive release-check/u);
  assert.equal((await skillStore.listPending()).length, 0);
  assert.equal((await skillStore.listSkills()).length, 0);
  assert.deepEqual(notifications.at(-1), {
    message: "Approved all 2 pending project skill proposals.",
    type: "info",
  });
});

test("project skill deletion archives the skill and clears its pending proposals", async (t) => {
  const { context, extension, skillStore, notifications } = await fixture(t);
  await extension.emit("session_start", {}, context);
  await skillStore.stageProposal([{ action: "archive", name: "verification" }], "setup-session");
  Object.assign(context, { hasUI: true, mode: "tui" });
  Object.assign(context.ui, { confirm: async () => true });

  await extension.command("project-skills", "delete verification", context);

  assert.equal((await skillStore.listSkills()).length, 0);
  assert.equal((await skillStore.listPending()).length, 0);
  assert.deepEqual(notifications.at(-1), {
    message: "Archived project skill 'verification'.",
    type: "info",
  });
});

test("skill review reports timeout accurately and records retry backoff", async (t) => {
  const { context, extension, skillStore, notifications } = await fixture(t, {
    skillReviewTimeoutMs: 5,
    requestSkillReviewPlan: async (_ctx, _packet, signal) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Project skill review was aborted.")), { once: true });
      }),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);
  await extension.command("project-skills", "review", context);

  assert.deepEqual(notifications, [{
    message: "Project skill review took too long. Project skills remain unchanged. No Forgetti will retry automatically.",
    type: "warning",
  }]);
  const state = JSON.parse(await readFile(skillStore.reviewPath, "utf8")) as {
    consecutiveFailures: number;
    nextAttemptAt?: string;
  };
  assert.equal(state.consecutiveFailures, 1);
  assert.ok(state.nextAttemptAt);
});

test("automatic skill review timeout is informational and explains recovery", async (t) => {
  let finishReview!: () => void;
  const reviewFinished = new Promise<void>((resolve) => { finishReview = resolve; });
  const { branch, context, extension, skillStore, notifications } = await fixture(t, {
    skillReviewTimeoutMs: 5,
    requestSkillReviewPlan: async (_ctx, _packet, signal) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Project skill review was aborted.")), { once: true });
      }),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);

  const originalFinishReview = skillStore.finishReview.bind(skillStore);
  skillStore.finishReview = async (request) => {
    try {
      return await originalFinishReview(request);
    } finally {
      finishReview();
    }
  };
  for (let index = 0; index < DEFAULT_SKILL_REVIEW_INTERVAL; index += 1) {
    const entryId = `automatic-timeout-${index + 1}`;
    branch.push(userEntry(entryId, `review evidence ${index + 1}`));
    await skillStore.recordUserTurn({ sessionId: "lifecycle-session", entryId });
  }
  const currentInput = "ordinary completed work that triggers the due review";
  await extension.emit("input", { source: "user", text: currentInput }, context);
  branch.push(userEntry("automatic-timeout-current", currentInput));
  await extension.emit("agent_end", { messages: [assistantMessage] }, context);
  await extension.emit("agent_settled", {}, context);
  await reviewFinished;

  assert.deepEqual(notifications, [{
    message: "Project skill review took too long. Project skills remain unchanged. No Forgetti will retry automatically.",
    type: "info",
  }]);
});

test("skill review timeout settles when the reviewer ignores cancellation", async (t) => {
  let release!: () => void;
  const { context, extension, notifications } = await fixture(t, {
    skillReviewTimeoutMs: 5,
    requestSkillReviewPlan: async (_ctx, job) => new Promise<SkillReviewResult>((resolve) => {
      release = () => resolve(skillReviewResult(job));
    }),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);

  const review = extension.command("project-skills", "review", context);
  const settledBeforeReviewer = await Promise.race([
    review.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  release();
  await review;

  assert.equal(settledBeforeReviewer, true);
  assert.deepEqual(notifications, [{
    message: "Project skill review took too long. Project skills remain unchanged. No Forgetti will retry automatically.",
    type: "warning",
  }]);
});

test("skill review lifecycle cancellation stays silent and preserves cadence", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const { context, extension, skillStore, notifications } = await fixture(t, {
    requestSkillReviewPlan: async (_ctx, _packet, signal) => {
      entered();
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Project skill review was aborted.")), { once: true });
      });
    },
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);
  const entryIds = Array.from({ length: 10 }, (_, index) => `cancel-user-${index + 1}`);
  for (const entryId of entryIds) {
    await skillStore.recordUserTurn({ sessionId: "lifecycle-session", entryId });
  }
  const review = extension.command("project-skills", "review", context);
  await started;
  await extension.emit("session_shutdown", {}, context);
  await review;

  assert.deepEqual(notifications, []);
  const state = JSON.parse(await readFile(skillStore.reviewPath, "utf8")) as {
    consecutiveFailures: number;
    nextAttemptAt?: string;
  };
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.nextAttemptAt, undefined);
  assert.ok(await skillStore.claimReviewIfDue({
    sessionId: "lifecycle-session",
    selectedEntryIds: entryIds,
    eligibleEntryIds: entryIds,
  }));
});

test("skill review cancellation during a delayed claim releases its fenced lease", async (t) => {
  let claimEntered!: () => void;
  let releaseClaim!: () => void;
  const claimStarted = new Promise<void>((resolve) => { claimEntered = resolve; });
  const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
  let modelCalls = 0;
  const { context, extension, skillStore, notifications } = await fixture(t, {
    requestSkillReviewPlan: async (_ctx, job) => {
      modelCalls += 1;
      return skillReviewResult(job);
    },
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);
  const entryIds = Array.from({ length: 10 }, (_, index) => `delayed-user-${index + 1}`);
  for (const entryId of entryIds) {
    await skillStore.recordUserTurn({ sessionId: "lifecycle-session", entryId });
  }
  const originalClaim = skillStore.claimReviewIfDue.bind(skillStore);
  skillStore.claimReviewIfDue = async (...args) => {
    claimEntered();
    await claimBarrier;
    return originalClaim(...args);
  };

  const review = extension.command("project-skills", "review", context);
  await claimStarted;
  const shutdown = extension.emit("session_shutdown", {}, context);
  releaseClaim();
  await Promise.all([review, shutdown]);

  assert.equal(modelCalls, 0);
  assert.deepEqual(notifications, []);
  assert.ok(await originalClaim({
    sessionId: "lifecycle-session",
    selectedEntryIds: entryIds,
    eligibleEntryIds: entryIds,
  }), "cancelled claim leaves cadence due");
});

test("validated skill plans finish atomic admission after the commit point", async (t) => {
  let submitEntered!: () => void;
  let releaseSubmit!: () => void;
  const submitStarted = new Promise<void>((resolve) => { submitEntered = resolve; });
  const submitBarrier = new Promise<void>((resolve) => { releaseSubmit = resolve; });
  const { context, extension, skillStore, notifications } = await fixture(t, {
    skillReviewTimeoutMs: 5,
    requestSkillReviewPlan: async (_ctx, job) => skillReviewResult(job, [{
      action: "create",
      name: "commit-after-plan",
      description: "Commit a validated skill plan.",
      content: "# Commit after plan\n\n## Steps\n\n1. Commit validated output. Done when: admission succeeds.",
    }]),
  });
  const originalSubmit = skillStore.submitProposal.bind(skillStore);
  skillStore.submitProposal = async (...args) => {
    submitEntered();
    await submitBarrier;
    return originalSubmit(...args);
  };
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);

  const review = extension.command("project-skills", "review", context);
  await submitStarted;
  const shutdown = extension.emit("session_shutdown", {}, context);
  releaseSubmit();
  await Promise.all([review, shutdown]);

  assert.equal((await skillStore.loadSkill("commit-after-plan")).state, "active");
  assert.deepEqual(notifications, [{
    message: "Project skill review added 'commit-after-plan' automatically. It becomes a native Pi skill after /reload or next session.",
    type: "info",
  }]);
});

test("publishes project skills and tracks slash invocation without rendering duplicate history", async (t) => {
  const { branch, context, extension, skillStore } = await fixture(t);
  await extension.emit("session_start", {}, context);

  const [resources] = await extension.emit("resources_discover", {
    cwd: context.cwd,
    reason: "startup",
  }, context) as Array<{ skillPaths: string[] }>;
  assert.deepEqual(resources, { skillPaths: [skillStore.skillsDir] });
  assert.equal(extension.handlers.has("context"), false);

  const path = join(skillStore.skillsDir, "verification", "SKILL.md");
  const invocation = `<skill name="verification" location="${path}">\nReferences are relative to ${join(skillStore.skillsDir, "verification")}.\n\n# Verification\n</skill>\n\nrun checks`;
  await extension.emit("input", { text: "/skill:verification run checks", source: "interactive" }, context);
  branch.push(userEntry("user-1", invocation));
  await extension.emit("message_end", {
    message: { role: "user", content: invocation, timestamp: 0 },
  }, context);
  assert.equal((await skillStore.loadSkill("verification")).useCount, 0);

  await extension.emit("agent_end", { messages: [assistantMessage] }, context);
  await extension.emit("agent_settled", {}, context);
  const used = await skillStore.loadSkill("verification");
  assert.equal(used.useCount, 1);
  assert.equal(used.useSessionCount, 1);
  assert.equal(await skillStore.activity.completedCount(), 1);
  assert.equal(extension.entryRenderers.has(PROJECT_SKILL_USE_ENTRY), false);
  assert.deepEqual(extension.entries.filter((entry) => entry.customType === PROJECT_SKILL_USE_ENTRY), [{
    customType: PROJECT_SKILL_USE_ENTRY,
    data: { names: ["verification"] },
  }]);
});

test("tracks successful native SKILL.md reads once per settled run", async (t) => {
  const { branch, context, extension, skillStore } = await fixture(t);
  await extension.emit("session_start", {}, context);
  await extension.emit("input", { text: "verify the canonical project checks", source: "interactive" }, context);
  branch.push(userEntry("user-read", "verify the canonical project checks"));
  const path = join(skillStore.skillsDir, "verification", "SKILL.md");
  const result = {
    toolName: "read",
    toolCallId: "read-skill",
    input: { path },
    content: [{ type: "text", text: "# Verification" }],
    details: undefined,
    isError: false,
  };
  await extension.emit("tool_result", result, context);
  await extension.emit("tool_result", { ...result, toolCallId: "read-skill-again" }, context);
  await extension.emit("tool_result", { ...result, toolCallId: "read-failed", isError: true }, context);

  await extension.emit("agent_end", { messages: [assistantMessage] }, context);
  await extension.emit("agent_settled", {}, context);
  const used = await skillStore.loadSkill("verification");
  assert.equal(used.useCount, 1);
  assert.equal(used.useSessionCount, 1);
});

test("routes read-only command output in print and JSON modes", async (t) => {
  const output: string[] = [];
  const { context, extension } = await fixture(t, { writeCommandOutput: (text) => output.push(text) });
  await extension.emit("session_start", {}, context);
  await extension.command("memory", "status", context);
  await extension.command("project-skills", "stats", context);
  assert.equal(output.length, 2);
  assert.match(output[0]!, /active memory: main/u);
  assert.match(output[1]!, /completed project sessions/u);

  Object.assign(context, { mode: "json", hasUI: false });
  await assert.rejects(extension.command("memory", "status", context), /corresponding model tool/u);
  await assert.rejects(extension.command("project-skills", "stats", context), /corresponding model tool/u);
});

test("memory show uses primary text color in the TUI", async (t) => {
  const { context, extension, memoryStore, notifications } = await fixture(t);
  await extension.emit("session_start", {}, context);
  await memoryStore.applyOperation("main", { action: "add", content: "Readable project fact." });
  Object.assign(context, { hasUI: true, mode: "tui" });
  context.ui.theme.fg = (color: string, text: string) => `<${color}>${text}</${color}>`;

  await extension.command("memory", "show", context);

  assert.deepEqual(notifications, [{
    message: "<text>1. [normal?] Readable project fact.</text>",
    type: "info",
  }]);
});

test("memory review applies immediately and next turn injects live state", async (t) => {
  const { context, extension, memoryStore } = await fixture(t, {
    requestReviewPlan: async () => ({
      operations: [{ action: "add", content: "Tests run with pnpm test.", importance: "normal" }],
    }),
  });
  await extension.emit("session_start", {}, context);
  await extension.command("memory", "review", context);
  assert.deepEqual(
    (await memoryStore.loadBranch("main")).entries.map((entry) => entry.text),
    ["Tests run with pnpm test."],
  );

  await memoryStore.applyOperation("main", { action: "add", content: "Type checks run with pnpm check." });
  const [before] = await extension.emit("before_agent_start", {
    systemPrompt: "base prompt",
    prompt: "continue",
  }, context) as Array<{ systemPrompt: string }>;
  assert.match(before.systemPrompt, /Tests run with pnpm test\./u);
  assert.match(before.systemPrompt, /Type checks run with pnpm check\./u);
});

test("capacity-violating embedded reviews safely no-op without a failure warning", async (t) => {
  const { context, extension, memoryStore, notifications } = await fixture(t, {
    requestReviewPlan: async () => ({
      operations: [{ action: "add", content: "overflow", importance: "normal" }],
    }),
  });
  for (const content of ["a", "b", "c", "d", "e"]) {
    await memoryStore.applyOperation("main", { action: "add", content: content.repeat(800) });
  }
  await memoryStore.applyOperation("main", { action: "add", content: "f".repeat(500) });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);

  await extension.command("memory", "review", context);

  assert.equal((await memoryStore.loadBranch("main")).entries.length, 6);
  assert.equal(notifications.some((item) => item.message.includes("review failed")), false);
  assert.equal(notifications.some((item) => item.message.includes("nothing durable to save")), true);
});

test("external review authority durably queues bounded evidence without an in-process model call", async (t) => {
  let modelCalls = 0;
  const { branch, context, extension, memoryStore, reviewSpool } = await fixture(t, {
    loadServiceConfig: async () => ({
      version: 1,
      mode: "external",
      evidenceTtlHours: 24,
      reviewer: {
        provider: "fake",
        model: "reviewer",
        reasoningEffort: "high",
        maxCallsPerDay: 10,
        maxTokensPerDay: 10_000,
        maxCostPerDayUsd: 1,
      },
    }),
    requestReviewPlan: async () => {
      modelCalls += 1;
      return { operations: [] };
    },
  });
  branch.push(userEntry("external-user", "Remember that verification uses pnpm check."));
  await extension.emit("session_start", {}, context);
  await extension.command("memory", "review", context);

  assert.equal(modelCalls, 0);
  assert.equal((await memoryStore.loadBranch("main")).entries.length, 0);
  const claim = await reviewSpool.claim({ workerId: "test-worker", leaseMs: 1_000 });
  assert.ok(claim);
  assert.equal(claim.job.throughEntryId, "external-user");
  assert.match(claim.job.transcript, /verification uses pnpm check/u);
  assert.equal(claim.job.baseBranchDigest, memoryStore.branchDigest(await memoryStore.loadBranch("main")));
  const jobEntry = extension.entries.find((entry) => entry.customType === "no-forgetti-memory-review-job");
  assert.ok(jobEntry);
  const renderer = extension.entryRenderers.get("no-forgetti-memory-review-job") as (
    entry: { data: unknown },
    options: { expanded: boolean },
    theme: { fg: (color: string, text: string) => string },
  ) => { render: (width: number) => string[] } | undefined;
  assert.equal(renderer(jobEntry, { expanded: false }, { fg: (_color, text) => text }), undefined);
  const expanded = renderer(jobEntry, { expanded: true }, { fg: (_color, text) => text });
  assert.match(expanded!.render(120).join("\n"), new RegExp(claim.job.id, "u"));
});

test("external review widget follows the current project job from queue to worker", async (t) => {
  const externalConfig = {
    version: 1 as const,
    mode: "external" as const,
    evidenceTtlHours: 24,
    reviewer: {
      provider: "fake",
      model: "reviewer",
      reasoningEffort: "high" as const,
      maxCallsPerDay: 10,
      maxTokensPerDay: 10_000,
      maxCostPerDayUsd: 1,
    },
  };
  const { branch, context, extension, reviewSpool, statuses, widgets } = await fixture(t, {
    loadServiceConfig: async () => externalConfig,
    loadServiceMonitor: async () => ({
      mode: "external",
      budget: { day: "2026-01-01", calls: 0, tokens: 0, costUsd: 0 },
      spool: { queued: 1, running: 0, outcomes: 0, deadLetter: 0 },
      workerFresh: true,
      workerCompatible: true,
      exhausted: [],
      observedAt: "2026-01-01T00:00:00.000Z",
    }),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  branch.push(userEntry("widget-user", "Remember that verification uses pnpm check."));
  await extension.emit("session_start", {}, context);
  await extension.command("memory", "review", context);

  const renderWidget = () => {
    const factory = widgets.get("no-forgetti") as (
      tui: { requestRender: () => void },
      theme: { fg: (color: string, text: string) => string },
    ) => { render: () => string[]; dispose: () => void };
    const widget = factory({ requestRender: () => undefined }, { fg: (_color, text) => text });
    const rendered = widget.render().join("\n");
    widget.dispose();
    return rendered;
  };
  assert.match(renderWidget(), /memory review queued/u);
  assert.doesNotMatch(renderWidget(), /review_[0-9a-f]+/u);
  assert.match(statuses.get("no-forgetti") ?? "", /review:queued/u);

  assert.ok(await reviewSpool.claim({ workerId: "widget-worker", leaseMs: 60_000 }));
  await extension.emit("before_agent_start", { systemPrompt: "base", prompt: "continue" }, context);
  assert.match(renderWidget(), /reviewing project memory/u);
  assert.match(statuses.get("no-forgetti") ?? "", /review:reviewing/u);
});

test("external review keeps evidence unqueued when the worker memory policy is stale", async (t) => {
  const { branch, context, extension, reviewSpool, notifications } = await fixture(t, {
    loadServiceConfig: async () => ({
      version: 1,
      mode: "external",
      evidenceTtlHours: 24,
      reviewer: {
        provider: "fake",
        model: "reviewer",
        reasoningEffort: "high",
        maxCallsPerDay: 10,
        maxTokensPerDay: 10_000,
        maxCostPerDayUsd: 1,
      },
    }),
    loadServiceMonitor: async () => ({
      mode: "external",
      budget: { day: "2026-01-01", calls: 0, tokens: 0, costUsd: 0 },
      spool: { queued: 0, running: 0, outcomes: 0, deadLetter: 0 },
      worker: {
        version: 1,
        workerId: "legacy-worker",
        pid: 123,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        state: "idle",
      },
      workerFresh: true,
      workerCompatible: false,
      exhausted: [],
      observedAt: "2026-01-01T00:00:00.000Z",
    }),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  branch.push(userEntry("stale-policy-user", "Remember that verification uses pnpm check."));
  await extension.emit("session_start", {}, context);
  await extension.command("memory", "review", context);

  assert.equal(await reviewSpool.claim({ workerId: "test-worker", leaseMs: 1_000 }), undefined);
  assert.equal(extension.entries.some((entry) => entry.customType === "no-forgetti-memory-review-job"), false);
  assert.equal(notifications.some((entry) => entry.message.includes("restart required")), true);
});

test("external review receipt appends a compact content diff to the next Pi session", async (t) => {
  const externalConfig = {
    version: 1 as const,
    mode: "external" as const,
    evidenceTtlHours: 24,
    reviewer: {
      provider: "fake",
      model: "reviewer",
      reasoningEffort: "high" as const,
      maxCallsPerDay: 10,
      maxTokensPerDay: 10_000,
      maxCostPerDayUsd: 1,
    },
  };
  const { branch, context, extension, memoryStore, skillStore, reviewSpool } = await fixture(t, {
    loadServiceConfig: async () => externalConfig,
  });
  const tests = await memoryStore.applyOperation("main", { action: "add", content: "Tests run with pnpm test." });
  const ci = await memoryStore.applyOperation("main", { action: "add", content: "CI runs on Node 18." });
  const testsId = tests.branch.entries.at(0)!.id;
  const ciId = ci.branch.entries.at(1)!.id;
  branch.push(userEntry("external-feedback-user", "Remember that verification uses pnpm check."));
  await extension.emit("session_start", {}, context);
  await extension.command("memory", "review", context);

  const claim = await reviewSpool.claim({ workerId: "feedback-worker", leaseMs: 1_000 });
  assert.ok(claim);
  const completedAt = "2026-01-01T00:00:01.000Z";
  const outcome = createReviewOutcome(claim.job, {
    status: "completed",
    operations: [
      { action: "replace", entryId: testsId, content: "Tests run with pnpm check.", importance: "high" },
      { action: "remove", entryId: ciId },
      { action: "add", content: "Deploys use the release workflow.", importance: "normal" },
    ],
    completedAt,
    provenance: {
      provider: "fake",
      model: "reviewer",
      api: "fake-api",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt,
      durationMs: 1_000,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
  const agentDir = join(memoryStore.projectDir, "..", "..");
  await new FileMemoryProposalCommitter(agentDir).commit(claim.job, outcome);
  await reviewSpool.finish(claim, outcome);
  await extension.emit("session_shutdown", {}, context);

  const receiving = new FakeExtension();
  activateProjectMemoryExtension(receiving.api, {
    isNonPrimaryAgent: () => false,
    createMemoryStore: () => memoryStore,
    createSkillStore: () => skillStore,
    loadServiceConfig: async () => externalConfig,
    loadServiceMonitor: async () => ({
      mode: "external",
      budget: { day: "2026-01-01", calls: 1, tokens: 2, costUsd: 0 },
      spool: { queued: 0, running: 0, outcomes: 1, deadLetter: 0 },
      workerFresh: true,
      exhausted: [],
      observedAt: "2026-01-01T00:00:02.000Z",
    }),
    createReviewSpool: () => reviewSpool,
  });
  await receiving.emit("session_start", {}, context);
  const feedback = receiving.entries.find((entry) =>
    entry.customType === "no-forgetti-memory-review"
      && (entry.data as { jobId?: string }).jobId === claim.job.id
  );
  assert.deepEqual(feedback?.data, {
    projectKey: memoryStore.projectKey,
    jobId: claim.job.id,
    branch: "main",
    status: "applied",
    changes: [
      { kind: "add", text: "Deploys use the release workflow." },
      { kind: "replace", text: "Tests run with pnpm check.", oldText: "Tests run with pnpm test." },
      { kind: "remove", text: "CI runs on Node 18." },
    ],
    messages: ["Memory replaced.", "Memory removed.", "Memory added."],
    requestedBy: "manual",
  });

  const renderer = receiving.entryRenderers.get("no-forgetti-memory-review") as (
    entry: { data: unknown },
    options: { expanded: boolean },
    theme: { fg: (color: string, text: string) => string },
  ) => { render: (width: number) => string[] };
  const rendered = renderer(feedback!, { expanded: true }, { fg: (_color, text) => text }).render(120).join("\n");
  assert.match(rendered, /no-forgetti memory updated/u);
  assert.match(rendered, /\+ Deploys use the release workflow\./u);
  assert.match(rendered, /~ Tests run with pnpm check\./u);
  assert.match(rendered, /was: Tests run with pnpm test\./u);
  assert.match(rendered, /- CI runs on Node 18\./u);

  await receiving.emit("before_agent_start", { systemPrompt: "base", prompt: "again" }, context);
  assert.equal(receiving.entries.filter((entry) =>
    entry.customType === "no-forgetti-memory-review"
      && (entry.data as { jobId?: string }).jobId === claim.job.id
  ).length, 1);
  await receiving.emit("session_shutdown", {}, context);
});

test("manual external no-op reports nothing durable after terminal delivery", async (t) => {
  const externalConfig = {
    version: 1 as const,
    mode: "external" as const,
    evidenceTtlHours: 24,
    reviewer: {
      provider: "fake",
      model: "reviewer",
      reasoningEffort: "high" as const,
      maxCallsPerDay: 10,
      maxTokensPerDay: 10_000,
      maxCostPerDayUsd: 1,
    },
  };
  const { branch, context, extension, memoryStore, reviewSpool, notifications } = await fixture(t, {
    loadServiceConfig: async () => externalConfig,
    loadServiceMonitor: async () => ({
      mode: "external",
      budget: { day: "2026-01-01", calls: 1, tokens: 2, costUsd: 0 },
      spool: { queued: 0, running: 0, outcomes: 1, deadLetter: 0 },
      workerFresh: true,
      workerCompatible: true,
      exhausted: [],
      observedAt: "2026-01-01T00:00:02.000Z",
    }),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  branch.push(userEntry("noop-user", "Check whether anything durable changed."));
  await extension.emit("session_start", {}, context);
  await extension.command("memory", "review", context);

  const claim = await reviewSpool.claim({ workerId: "noop-worker", leaseMs: 1_000 });
  assert.ok(claim);
  const completedAt = "2026-01-01T00:00:01.000Z";
  const outcome = createReviewOutcome(claim.job, {
    status: "completed",
    completedAt,
    operations: [],
    provenance: {
      provider: "fake",
      model: "reviewer",
      api: "fake-api",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt,
      durationMs: 1_000,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
  const agentDir = join(memoryStore.projectDir, "..", "..");
  const receipt = await new FileMemoryProposalCommitter(agentDir).commit(claim.job, outcome);
  assert.equal(receipt.status, "noop");
  await reviewSpool.finish(claim, outcome);
  await extension.emit("before_agent_start", { systemPrompt: "base", prompt: "continue" }, context);

  assert.deepEqual(notifications.filter((item) => item.message.includes("nothing durable")), [{
    message: "Project memory review: nothing durable to save.",
    type: "info",
  }]);
});

test("external review dead-letter surfaces a failure warning in the next Pi session", async (t) => {
  const externalConfig = {
    version: 1 as const,
    mode: "external" as const,
    evidenceTtlHours: 24,
    reviewer: {
      provider: "fake",
      model: "reviewer",
      reasoningEffort: "high" as const,
      maxCallsPerDay: 10,
      maxTokensPerDay: 10_000,
      maxCostPerDayUsd: 1,
    },
  };
  const { branch, context, extension, memoryStore, skillStore, reviewSpool, notifications } = await fixture(t, {
    loadServiceConfig: async () => externalConfig,
  });
  branch.push(userEntry("dead-letter-user", "Remember that verification uses pnpm check."));
  await extension.emit("session_start", {}, context);
  await extension.command("memory", "review", context);

  const claim = await reviewSpool.claim({ workerId: "dead-letter-worker", leaseMs: 1_000 });
  assert.ok(claim);
  const failure = { code: "provider_error", message: "Provider exploded.", retryable: false };
  await reviewSpool.finish(claim, createReviewOutcome(claim.job, { status: "failed", error: failure }));
  const agentDir = join(memoryStore.projectDir, "..", "..");
  await new FileMemoryProposalCommitter(agentDir).failed(claim.job, failure);
  await extension.emit("session_shutdown", {}, context);

  const receiving = new FakeExtension();
  activateProjectMemoryExtension(receiving.api, {
    isNonPrimaryAgent: () => false,
    createMemoryStore: () => memoryStore,
    createSkillStore: () => skillStore,
    loadServiceConfig: async () => externalConfig,
    loadServiceMonitor: async () => ({
      mode: "external",
      budget: { day: "2026-01-01", calls: 1, tokens: 2, costUsd: 0 },
      spool: { queued: 0, running: 0, outcomes: 1, deadLetter: 1 },
      workerFresh: true,
      exhausted: [],
      observedAt: "2026-01-01T00:00:02.000Z",
    }),
    createReviewSpool: () => reviewSpool,
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await receiving.emit("session_start", {}, context);
  const feedback = receiving.entries.find((entry) =>
    entry.customType === "no-forgetti-memory-review"
      && (entry.data as { jobId?: string }).jobId === claim.job.id
  );
  assert.deepEqual(feedback?.data, {
    projectKey: memoryStore.projectKey,
    jobId: claim.job.id,
    branch: "main",
    status: "failed",
    changes: [],
    messages: ["Provider exploded."],
    requestedBy: "manual",
  });
  assert.deepEqual(notifications.filter((entry) => entry.message.includes("review stopped")), [{
    message: "Project memory review stopped: Provider exploded.",
    type: "warning",
  }]);

  const renderer = receiving.entryRenderers.get("no-forgetti-memory-review") as (
    entry: { data: unknown },
    options: { expanded: boolean },
    theme: { fg: (color: string, text: string) => string },
  ) => { render: (width: number) => string[] };
  const rendered = renderer(feedback!, { expanded: true }, { fg: (_color, text) => text }).render(120).join("\n");
  assert.match(rendered, /memory review stopped/u);
  assert.match(rendered, /Provider exploded\./u);
  assert.match(rendered, /\/memory review/u);

  await receiving.emit("before_agent_start", { systemPrompt: "base", prompt: "again" }, context);
  assert.equal(receiving.entries.filter((entry) =>
    entry.customType === "no-forgetti-memory-review"
      && (entry.data as { jobId?: string }).jobId === claim.job.id
  ).length, 1);
  await receiving.emit("session_shutdown", {}, context);
});

test("manual retry requeues retained external evidence as a new job generation", async (t) => {
  const externalConfig = {
    version: 1 as const,
    mode: "external" as const,
    evidenceTtlHours: 24,
    reviewer: {
      provider: "fake",
      model: "reviewer",
      reasoningEffort: "high" as const,
      maxCallsPerDay: 10,
      maxTokensPerDay: 10_000,
      maxCostPerDayUsd: 1,
    },
  };
  const { branch, context, extension, memoryStore, reviewSpool, notifications } = await fixture(t, {
    loadServiceConfig: async () => externalConfig,
    loadServiceMonitor: async () => ({
      mode: "external",
      budget: { day: "2026-01-01", calls: 1, tokens: 2, costUsd: 0 },
      spool: { queued: 0, running: 0, outcomes: 1, deadLetter: 1 },
      workerFresh: true,
      workerCompatible: true,
      exhausted: [],
      observedAt: "2026-01-01T00:00:02.000Z",
    }),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  branch.push(userEntry("retry-user", "Remember that verification uses pnpm check."));
  await extension.emit("session_start", {}, context);
  await extension.command("memory", "review", context);

  const original = await reviewSpool.claim({ workerId: "retry-worker", leaseMs: 60_000 });
  assert.ok(original);
  const failure = { code: "invalid_proposal", message: "Proposal exceeded the entry limit.", retryable: false };
  const decisions = new ReviewDecisionStore(reviewSpool.root);
  await decisions.recordAttempt("retry-source-attempt", original.job, {
    status: "failed",
    completedAt: "2026-01-01T00:00:01.000Z",
    error: failure,
  });
  await reviewSpool.finish(original, createReviewOutcome(original.job, { status: "failed", error: failure }));
  const agentDir = join(memoryStore.projectDir, "..", "..");
  await new FileMemoryProposalCommitter(agentDir).failed(original.job, failure);
  await extension.emit("before_agent_start", { systemPrompt: "base", prompt: "continue" }, context);

  await extension.command("memory", `review retry ${original.job.id}`, context);
  const replay = await reviewSpool.claim({ workerId: "retry-worker", leaseMs: 60_000 });
  assert.ok(replay);
  assert.equal(replay.job.generation, 1);
  assert.notEqual(replay.job.id, original.job.id);
  assert.equal(replay.job.transcript, original.job.transcript);
  assert.equal(replay.job.baseBranchDigest, memoryStore.branchDigest(await memoryStore.loadBranch("main")));
  assert.equal(notifications.some((item) => item.message.includes("requeued")), true);
});

test("memory review appends a change entry with resolved entry IDs", async (t) => {
  let testsId = "";
  let ciId = "";
  const { context, extension, memoryStore } = await fixture(t, {
    requestReviewPlan: async () => ({
      operations: [
        { action: "replace", entryId: testsId, content: "Tests run with pnpm check.", importance: "high" },
        { action: "remove", entryId: ciId },
        { action: "add", content: "Deploys go through the release workflow.", importance: "normal" },
      ],
    }),
  });
  testsId = (await memoryStore.applyOperation("main", { action: "add", content: "Tests run with pnpm test." })).branch.entries.at(0)!.id;
  ciId = (await memoryStore.applyOperation("main", { action: "add", content: "CI runs on Node 18." })).branch.entries.at(1)!.id;
  await extension.emit("session_start", {}, context);
  await extension.command("memory", "review", context);

  const entry = extension.entries.find((item) => item.customType === "no-forgetti-memory-review");
  assert.deepEqual(entry?.data, {
    branch: "main",
    changes: [
      { kind: "replace", text: "Tests run with pnpm check.", oldText: "Tests run with pnpm test." },
      { kind: "remove", text: "CI runs on Node 18." },
      { kind: "add", text: "Deploys go through the release workflow." },
    ],
  });
});

test("shutdown prevents a review from starting after a delayed claim", async (t) => {
  let modelStarted = false;
  const { context, extension, memoryStore } = await fixture(t, {
    requestReviewPlan: async () => {
      modelStarted = true;
      return { operations: [] };
    },
  });
  await extension.emit("session_start", {}, context);
  let releaseClaim!: () => void;
  let claimEntered!: () => void;
  const claimStarted = new Promise<void>((resolve) => { claimEntered = resolve; });
  const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
  const originalClaim = memoryStore.claimReview.bind(memoryStore);
  memoryStore.claimReview = async (...args) => {
    claimEntered();
    await claimBarrier;
    return originalClaim(...args);
  };

  const review = extension.command("memory", "review", context);
  await claimStarted;
  const shutdown = extension.emit("session_shutdown", {}, context);
  releaseClaim();
  await Promise.all([review, shutdown]);
  assert.equal(modelStarted, false);
});

test("shutdown aborts and waits for an active review", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let reviewSignal: AbortSignal | undefined;
  const { context, extension, skillStore } = await fixture(t, {
    requestReviewPlan: async (_ctx, { signal }) => {
      reviewSignal = signal;
      entered();
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("review aborted")), { once: true });
      });
    },
  });
  await extension.emit("session_start", {}, context);
  const review = extension.command("memory", "review", context);
  await started;
  const shutdown = extension.emit("session_shutdown", {}, context);
  await Promise.all([review, shutdown]);
  assert.equal(reviewSignal?.aborted, true);
  assert.equal((await skillStore.listPending()).length, 0);
});

test("does not credit a native skill observed in an aborted run", async (t) => {
  const { branch, context, extension, skillStore } = await fixture(t);
  await extension.emit("session_start", {}, context);
  await extension.emit("input", { text: "/skill:verification", source: "interactive" }, context);
  const path = join(skillStore.skillsDir, "verification", "SKILL.md");
  const invocation = `<skill name="verification" location="${path}">\n# Verification\n</skill>`;
  branch.push(userEntry("user-aborted", invocation));
  await extension.emit("message_end", {
    message: { role: "user", content: invocation, timestamp: 0 },
  }, context);
  await extension.emit("agent_end", { messages: [{ ...assistantMessage, stopReason: "aborted" }] }, context);
  await extension.emit("agent_settled", {}, context);
  assert.equal((await skillStore.loadSkill("verification")).useCount, 0);
  assert.equal(await skillStore.activity.completedCount(), 0);
});

function pendingProposal(id: string, action: "patch" | "archive", name: string): SkillProposal {
  return { version: 1, id, createdAt: "2026-07-28T00:00:00.000Z", operations: [{ action, name }] };
}

test("resolves pending proposals by skill name, by id, and by qualified ref", () => {
  const archive = pendingProposal("20260728000000-aaaaaaaa", "archive", "verification");
  const patch = pendingProposal("20260728000001-bbbbbbbb", "patch", "verification");
  const other = pendingProposal("20260728000002-cccccccc", "archive", "release-check");

  assert.equal(resolvePendingRef([archive, other], "verification"), archive);
  assert.equal(resolvePendingRef([archive, other], archive.id), archive);
  assert.throws(() => resolvePendingRef([archive], "missing"), /No pending proposal 'missing'/u);

  assert.throws(
    () => resolvePendingRef([archive, patch], "verification"),
    /more than one pending proposal; use 'archive verification' or 'patch verification'/u,
  );
  assert.equal(resolvePendingRef([archive, patch], "patch verification"), patch);
});
