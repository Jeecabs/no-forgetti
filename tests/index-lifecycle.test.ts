import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { activateProjectMemoryExtension, type ExtensionDependencies } from "../src/index.ts";
import { ProjectSkillStore } from "../src/skill-store.ts";
import { ProjectMemoryStore } from "../src/store.ts";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown | Promise<unknown>;

class FakeExtension {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, unknown>();
  readonly commands = new Map<string, { handler: (args: string, context: ExtensionContext) => unknown | Promise<unknown> }>();
  readonly entries: Array<{ customType: string; data: unknown }> = [];

  readonly api = {
    on: (name: string, handler: Handler) => {
      const handlers = this.handlers.get(name) ?? [];
      handlers.push(handler);
      this.handlers.set(name, handlers);
    },
    registerTool: (tool: { name: string }) => this.tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: (args: string, context: ExtensionContext) => unknown | Promise<unknown> }) => this.commands.set(name, command),
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
  const context = {
    cwd: project,
    hasUI: false,
    mode: "print",
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: () => undefined,
      setStatus: () => undefined,
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
  activateProjectMemoryExtension(extension.api, {
    isNonPrimaryAgent: () => false,
    createMemoryStore: () => memoryStore,
    createSkillStore: () => skillStore,
    ...overrides,
  });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { branch, context, extension, memoryStore, skillStore };
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
  const originalClaim = memoryStore.claimReviewIfDue.bind(memoryStore);
  memoryStore.claimReviewIfDue = async (...args) => {
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
    requestReviewPlan: async (_ctx, _branch, signal) => {
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
