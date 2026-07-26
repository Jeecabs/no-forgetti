import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { activateProjectMemoryExtension, type ExtensionDependencies } from "../src/index.ts";
import { ProjectSkillStore } from "../src/skill-store.ts";
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
  const context = {
    cwd: project,
    hasUI: false,
    mode: "print",
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string, type: string) => notifications.push({ message, type }),
      setStatus: () => undefined,
      setWidget: () => undefined,
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
    ...overrides,
  });
  t.after(async () => {
    await extension.emit("session_shutdown", {}, context);
    await rm(base, { recursive: true, force: true });
  });
  return { branch, context, extension, memoryStore, skillStore, reviewSpool, notifications };
}

function userEntry(id: string, text: string): Record<string, unknown> {
  return { id, type: "message", message: { role: "user", content: text } };
}

const assistantMessage = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" };

test("registers lifecycle hooks and disables itself for companion agents", async () => {
  const primary = new FakeExtension();
  activateProjectMemoryExtension(primary.api, { isNonPrimaryAgent: () => false });
  for (const name of ["session_start", "session_tree", "session_compact", "before_agent_start", "context", "input", "agent_end", "agent_settled", "session_shutdown"]) {
    assert.equal(primary.handlers.has(name), true, name);
  }
  assert.deepEqual([...primary.tools.keys()].sort(), ["project_memory", "project_skill"]);
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

test("skill review automatically adds validated creates", async (t) => {
  const { context, extension, skillStore } = await fixture(t, {
    requestSkillReviewPlan: async () => ({ operations: [{
      action: "create",
      name: "release-check",
      description: "Verify a project release.",
      content: "# Release check\n\n## Steps\n\n1. Run release checks. Done when: all checks pass.",
    }] }),
  });
  await extension.emit("session_start", {}, context);
  await extension.command("project-skills", "review", context);

  assert.equal((await skillStore.loadSkill("release-check")).state, "active");
  assert.equal((await skillStore.listPending()).length, 0);
});

test("skill review reports timeout accurately and records retry backoff", async (t) => {
  const { context, extension, skillStore, notifications } = await fixture(t, {
    reviewTimeoutMs: 5,
    requestSkillReviewPlan: async (_ctx, _store, _afterEntryId, signal) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Project skill review was aborted.")), { once: true });
      }),
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);
  await extension.command("project-skills", "review", context);

  assert.deepEqual(notifications, [{
    message: "Project skill review timed out; it will retry after backoff on a future completed turn.",
    type: "warning",
  }]);
  const state = JSON.parse(await readFile(skillStore.reviewPath, "utf8")) as {
    consecutiveFailures: number;
    nextAttemptAt?: string;
  };
  assert.equal(state.consecutiveFailures, 1);
  assert.ok(state.nextAttemptAt);
});

test("skill review timeout settles when the reviewer ignores cancellation", async (t) => {
  let release!: (plan: { operations: [] }) => void;
  const ignoredCancellation = new Promise<{ operations: [] }>((resolve) => { release = resolve; });
  const { context, extension, notifications } = await fixture(t, {
    reviewTimeoutMs: 5,
    requestSkillReviewPlan: async () => ignoredCancellation,
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);

  const review = extension.command("project-skills", "review", context);
  const settledBeforeReviewer = await Promise.race([
    review.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  release({ operations: [] });
  await review;

  assert.equal(settledBeforeReviewer, true);
  assert.deepEqual(notifications, [{
    message: "Project skill review timed out; it will retry after backoff on a future completed turn.",
    type: "warning",
  }]);
});

test("skill review lifecycle cancellation stays silent and preserves cadence", async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const { context, extension, skillStore, notifications } = await fixture(t, {
    requestSkillReviewPlan: async (_ctx, _store, _afterEntryId, signal) => {
      entered();
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Project skill review was aborted.")), { once: true });
      });
    },
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);
  for (let turn = 0; turn < 10; turn += 1) await skillStore.recordUserTurn();
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
  assert.ok(await skillStore.claimReviewIfDue());
});

test("skill review cancellation during a delayed claim releases its fenced lease", async (t) => {
  let claimEntered!: () => void;
  let releaseClaim!: () => void;
  const claimStarted = new Promise<void>((resolve) => { claimEntered = resolve; });
  const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
  let modelCalls = 0;
  const { context, extension, skillStore, notifications } = await fixture(t, {
    requestSkillReviewPlan: async () => {
      modelCalls += 1;
      return { operations: [] };
    },
  });
  Object.assign(context, { hasUI: true, mode: "tui" });
  await extension.emit("session_start", {}, context);
  for (let turn = 0; turn < 10; turn += 1) await skillStore.recordUserTurn();
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
  assert.ok(await originalClaim(), "cancelled claim leaves cadence due");
});

test("validated skill plans finish atomic admission after the commit point", async (t) => {
  let submitEntered!: () => void;
  let releaseSubmit!: () => void;
  const submitStarted = new Promise<void>((resolve) => { submitEntered = resolve; });
  const submitBarrier = new Promise<void>((resolve) => { releaseSubmit = resolve; });
  const { context, extension, skillStore, notifications } = await fixture(t, {
    reviewTimeoutMs: 5,
    requestSkillReviewPlan: async () => ({ operations: [{
      action: "create",
      name: "commit-after-plan",
      description: "Commit a validated skill plan.",
      content: "# Commit after plan\n\n## Steps\n\n1. Commit validated output. Done when: admission succeeds.",
    }] }),
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
    message: "Project skill review added 'commit-after-plan' automatically.",
    type: "info",
  }]);
});

test("injects a recalled skill transiently and credits it only after successful settlement", async (t) => {
  const { branch, context, extension, skillStore } = await fixture(t);
  await extension.emit("session_start", {}, context);
  await extension.emit("input", { text: "verify the canonical project checks", source: "interactive" }, context);
  branch.push(userEntry("user-1", "verify the canonical project checks"));

  const [before] = await extension.emit("before_agent_start", {
    systemPrompt: "base prompt",
    prompt: "verify the canonical project checks",
  }, context) as Array<{ systemPrompt: string }>;
  assert.equal(before.systemPrompt.includes("<project-skill"), false);

  const messages = [{ role: "user", content: [
    { type: "text", text: "verify the canonical project checks" },
    { type: "image", data: "abc", mimeType: "image/png" },
  ] }];
  const [injected] = await extension.emit("context", { messages }, context) as Array<{ messages: Array<{ content: unknown[] }> }>;
  assert.match(JSON.stringify(injected.messages), /<project-skill name=\\?"verification\\?">/u);
  assert.deepEqual(injected.messages[0]?.content[1], messages[0]?.content[1]);
  assert.equal(JSON.stringify(messages).includes("<project-skill"), false);
  assert.equal((await skillStore.loadSkill("verification")).useCount, 0);

  await extension.emit("agent_end", { messages: [assistantMessage] }, context);
  await extension.emit("agent_settled", {}, context);
  const used = await skillStore.loadSkill("verification");
  assert.equal(used.useCount, 1);
  assert.equal(used.useSessionCount, 1);
  assert.equal(await skillStore.activity.completedCount(), 1);
});

test("appends one visible chat entry after a recalled skill is injected", async (t) => {
  const { branch, context, extension } = await fixture(t);
  await extension.emit("session_start", {}, context);
  await extension.emit("input", { text: "verify the canonical project checks", source: "interactive" }, context);
  branch.push(userEntry("user-status", "verify the canonical project checks"));

  await extension.emit("before_agent_start", {
    systemPrompt: "base prompt",
    prompt: "verify the canonical project checks",
  }, context);
  assert.equal(extension.entries.some((entry) => entry.customType === "no-forgetti-skill-recall"), false);

  const contextEvent = {
    messages: [{ role: "user", content: "verify the canonical project checks" }],
  };
  await extension.emit("context", contextEvent, context);
  await extension.emit("context", contextEvent, context);

  const recalls = extension.entries.filter((entry) => entry.customType === "no-forgetti-skill-recall");
  assert.deepEqual(recalls, [{ customType: "no-forgetti-skill-recall", data: { names: ["verification"] } }]);
  assert.equal(extension.entryRenderers.has("no-forgetti-skill-recall"), true);
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
  assert.equal(extension.entries.some((entry) => entry.customType === "no-forgetti-memory-review-job"), true);
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

test("does not credit an unpresented or aborted recall", async (t) => {
  const { branch, context, extension, skillStore } = await fixture(t);
  await extension.emit("session_start", {}, context);
  await extension.emit("input", { text: "verify the canonical project checks", source: "interactive" }, context);
  branch.push(userEntry("user-1", "verify the canonical project checks"));
  await extension.emit("before_agent_start", {
    systemPrompt: "base prompt",
    prompt: "verify the canonical project checks",
  }, context);
  await extension.emit("agent_end", { messages: [assistantMessage] }, context);
  await extension.emit("agent_settled", {}, context);
  assert.equal((await skillStore.loadSkill("verification")).useCount, 0);

  await extension.emit("input", { text: "verify the canonical project checks", source: "interactive" }, context);
  branch.push(userEntry("user-2", "verify the canonical project checks"));
  await extension.emit("before_agent_start", {
    systemPrompt: "base prompt",
    prompt: "verify the canonical project checks",
  }, context);
  await extension.emit("context", { messages: [{ role: "user", content: "verify the canonical project checks" }] }, context);
  await extension.emit("agent_end", { messages: [{ ...assistantMessage, stopReason: "aborted" }] }, context);
  await extension.emit("agent_settled", {}, context);
  assert.equal((await skillStore.loadSkill("verification")).useCount, 0);
  assert.equal(await skillStore.activity.completedCount(), 1);
});
