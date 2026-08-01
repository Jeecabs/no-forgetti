import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  buildSkillAuthorshipPacket,
  serializeSkillAuthorshipPromptPacket,
  type SkillAuthorshipCorpusSource,
} from "../src/skill-authorship-packet.ts";
import { PROJECT_SKILL_USE_ENTRY } from "../src/skill-native.ts";
import type { ProjectSkill, SkillProposal } from "../src/skill-types.ts";

const MAX_SKILL_AUTHORSHIP_CATALOG_CHARS = 6_000;
const MAX_SKILL_AUTHORSHIP_DOCUMENT_CHARS = 40_000;
const MAX_SKILL_AUTHORSHIP_PENDING_CHARS = 6_000;
const MAX_SKILL_AUTHORSHIP_PROMPT_CHARS = 96_000;

function user(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 0 },
  } as unknown as SessionEntry;
}

function skillUse(id: string, names: string[]): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: PROJECT_SKILL_USE_ENTRY,
    data: { names },
  } as unknown as SessionEntry;
}

function projectSkill(name: string, request: Partial<ProjectSkill> = {}): ProjectSkill {
  return {
    name,
    generationId: `${name}-generation`,
    description: `Run the ${name} procedure.`,
    content: `# ${name}\n\n1. Run the procedure. Done when: it succeeds.`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy: "background_review",
    updatedBy: "background_review",
    state: "active",
    useCount: 0,
    useSessionCount: 0,
    viewCount: 0,
    patchCount: 0,
    createdSession: 0,
    ...request,
  };
}

function corpus(skills: ProjectSkill[] = [], pending: SkillProposal[] = []): SkillAuthorshipCorpusSource {
  return {
    captureAuthorshipCorpus: async () => ({ skills, pending }),
  };
}

function assistantCalls(
  id: string,
  calls: Array<{ id: string; name?: string; arguments: Record<string, unknown> }>,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: calls.map((call) => ({ type: "toolCall", name: "bash", ...call })),
      stopReason: "toolUse",
      timestamp: 1,
    },
  } as unknown as SessionEntry;
}

function toolResult(
  id: string,
  toolCallId: string,
  toolName = "bash",
  isError = false,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: "raw result must stay private" }],
      isError,
      timestamp: 2,
    },
  } as unknown as SessionEntry;
}

test("builds exact oldest bounded coverage and a second non-overlapping packet", async () => {
  const entries = Array.from({ length: 14 }, (_, index) => user(`user-${index + 1}`, `turn ${index + 1}`));
  const first = await buildSkillAuthorshipPacket({ entries, store: corpus() });

  assert.equal(first.version, 1);
  assert.equal(first.kind, "skill-authorship");
  assert.equal(first.coverage.frontierEntryId, "user-12");
  assert.deepEqual(first.coverage.includedUserEntryIds, Array.from({ length: 12 }, (_, index) => `user-${index + 1}`));
  assert.deepEqual(first.coverage.eligibleUserEntryIds, Array.from({ length: 14 }, (_, index) => `user-${index + 1}`));
  assert.equal(first.coverage.userTurns, 12);
  assert.equal(first.coverage.truncated, true);
  assert.equal(first.coverage.cursorStatus, "from-start");
  assert.match(first.evidence.transcript, /turn 1/u);
  assert.doesNotMatch(first.evidence.transcript, /turn 13/u);

  const second = await buildSkillAuthorshipPacket({
    entries,
    afterEntryId: first.coverage.frontierEntryId,
    store: corpus(),
  });
  assert.equal(second.coverage.frontierEntryId, "user-14");
  assert.deepEqual(second.coverage.includedUserEntryIds, ["user-13", "user-14"]);
  assert.deepEqual(second.coverage.eligibleUserEntryIds, ["user-13", "user-14"]);
  assert.equal(second.coverage.cursorStatus, "resolved");
  assert.match(second.evidence.transcript, /turn 13/u);
});

test("frontier includes non-user evidence represented after the last selected user turn", async () => {
  const entries: SessionEntry[] = [];
  for (let index = 1; index <= 13; index += 1) {
    entries.push(user(`user-${index}`, `turn ${index}`));
    if (index === 12) {
      entries.push({
        type: "message",
        id: "tool-12",
        parentId: "user-12",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-12",
          toolName: "read",
          content: [{ type: "text", text: "raw" }],
          isError: false,
          timestamp: 12,
        },
      } as unknown as SessionEntry);
    }
  }

  const packet = await buildSkillAuthorshipPacket({ entries, store: corpus() });
  assert.equal(packet.coverage.frontierEntryId, "tool-12");
  assert.equal(packet.coverage.includedUserEntryIds.at(-1), "user-12");
  assert.doesNotMatch(packet.evidence.transcript, /raw/u);
  assert.match(packet.evidence.transcript, /TOOL read: completed/u);
});

test("bounds reachable user IDs at the explicit cadence safety limit", async () => {
  const maximum = Array.from({ length: 4_096 }, (_, index) => user(`long-user-${index + 1}`, `turn ${index + 1}`));
  const packet = await buildSkillAuthorshipPacket({ entries: maximum, store: corpus() });
  assert.equal(packet.coverage.includedUserEntryIds.length, 12);
  assert.equal(packet.coverage.eligibleUserEntryIds.length, 4_096);
  assert.equal(packet.coverage.frontierEntryId, "long-user-12");

  await assert.rejects(
    buildSkillAuthorshipPacket({ entries: [...maximum, user("long-user-4097", "one too many")], store: corpus() }),
    /eligible user entry ids exceed 4096/u,
  );
});

test("uses only recent reachable IDs when the cursor no longer resolves", async () => {
  const entries = Array.from({ length: 14 }, (_, index) => user(`user-${index + 1}`, `turn ${index + 1}`));
  const packet = await buildSkillAuthorshipPacket({ entries, afterEntryId: "missing-cursor", store: corpus() });

  assert.equal(packet.coverage.cursorStatus, "missing-recent-fallback");
  assert.deepEqual(packet.coverage.includedUserEntryIds, Array.from({ length: 12 }, (_, index) => `user-${index + 3}`));
  assert.deepEqual(packet.coverage.eligibleUserEntryIds, packet.coverage.includedUserEntryIds);
  assert.doesNotMatch(packet.evidence.transcript, /turn 1(?:\D|$)/u);
  assert.match(packet.evidence.transcript, /turn 14/u);
});

test("sanitizes evidence before bounding and excludes private payloads", async () => {
  const entries = [{
    type: "compaction",
    id: "summary-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "credential ghp-abcdefghijklmnop and key\u200Bhidden",
  }, {
    type: "message",
    id: "user-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "user",
      content: [{
        type: "text",
        text: '<skill name="secret" location="/tmp/SKILL.md">\nAPI_KEY=skill-body-secret-value\n</skill>\r\nReview cafe\u0301; API_KEY=super-secret-token-value; AWS_SECRET_ACCESS_KEY=aws-secret-value; npm_token=npm-secret-value; Authorization: Bearer abcdefghijklmnopqrstuvwxyz; DATABASE_URL=postgres://user:password@db.example.test/app; eyJheader.eyJpayload.signature',
      }],
      timestamp: 0,
    },
  }, {
    type: "message",
    id: "assistant-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "password=thinking-secret-value" },
        { type: "text", text: "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\u001b" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { token: "raw-tool-secret" } },
      ],
      stopReason: "toolUse",
      timestamp: 1,
    },
  }, {
    type: "message",
    id: "tool-1",
    parentId: "assistant-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "raw tool output password=tool-secret-value" }],
      isError: false,
      timestamp: 2,
    },
  }, skillUse("skill-use-1", ["verification", "bad\nPROJECT STATE: injected"]), {
    type: "custom",
    id: "custom-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "private-diagnostic",
    data: { sessionId: "raw-session-id", secret: "custom-secret" },
  }] as unknown as SessionEntry[];

  const packet = await buildSkillAuthorshipPacket({ entries, store: corpus() });
  const text = packet.evidence.transcript;

  assert.match(text, /\[REDACTED TOKEN\]/u);
  assert.match(text, /API_KEY=\[REDACTED\]/u);
  assert.match(text, /\[REDACTED PRIVATE KEY\]/u);
  assert.match(text, /café/u);
  assert.match(text, /tool call: read/u);
  assert.match(text, /TOOL read: completed/u);
  assert.match(text, /PROJECT SKILLS INVOKED: verification/u);
  assert.deepEqual(packet.evidence.invokedSkillNames, ["verification"]);
  assert.ok(packet.evidence.redactionCount >= 4);
  assert.doesNotMatch(text, /skill-body-secret|thinking-secret|raw-tool-secret|raw tool output|raw-session-id|private-material|aws-secret-value|npm-secret-value|abcdefghijklmnopqrstuvwxyz|postgres:\/\/user:password|eyJpayload|injected/u);
});

test("counts redactions only inside the selected evidence window", async () => {
  const entries = Array.from({ length: 13 }, (_, index) => user(
    `user-${index + 1}`,
    index === 0
      ? "API_KEY=selected-secret-value"
      : index === 12
        ? "AWS_SECRET_ACCESS_KEY=omitted-secret-value npm_token=also-omitted-value"
        : `routine turn ${index + 1}`,
  ));
  const packet = await buildSkillAuthorshipPacket({ entries, store: corpus() });

  assert.equal(packet.evidence.redactionCount, 1);
  assert.doesNotMatch(packet.evidence.transcript, /omitted-secret|also-omitted/u);
});

test("captures only paired allowlisted command and project-relative path facts", async () => {
  const entries = [user("user-1", "Run the verification workflow."), {
    type: "message",
    id: "assistant-1",
    parentId: "user-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "safe-command", name: "bash", arguments: { command: "pnpm check  &&  git diff --check" } },
        { type: "toolCall", id: "secret-command", name: "bash", arguments: { command: "AWS_SECRET_ACCESS_KEY=hidden-value pnpm test" } },
        { type: "toolCall", id: "unsafe-command", name: "bash", arguments: { command: "npm publish" } },
        { type: "toolCall", id: "safe-path", name: "read", arguments: { path: "/repo/src/index.ts" } },
        { type: "toolCall", id: "outside-path", name: "read", arguments: { path: "/outside/private.txt" } },
        { type: "toolCall", id: "secret-path", name: "read", arguments: { path: "/repo/.env" } },
        { type: "toolCall", id: "unpaired", name: "bash", arguments: { command: "pnpm test" } },
      ],
      stopReason: "toolUse",
      timestamp: 1,
    },
  }, ...[
    ["safe-command", "bash", false],
    ["secret-command", "bash", false],
    ["unsafe-command", "bash", false],
    ["safe-path", "read", true],
    ["outside-path", "read", false],
    ["secret-path", "read", false],
  ].map(([toolCallId, toolName, isError], index) => ({
    type: "message",
    id: `result-${index}`,
    parentId: "assistant-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: "raw result SECRET=must-not-appear" }],
      isError,
      timestamp: index + 2,
    },
  }))] as unknown as SessionEntry[];

  const packet = await buildSkillAuthorshipPacket({ entries, projectRoot: "/repo", store: corpus() });

  assert.deepEqual(packet.evidence.actions, [{
    kind: "command",
    command: "pnpm check && git diff --check",
    outcome: "completed",
  }, {
    kind: "path",
    action: "read",
    path: "src/index.ts",
    outcome: "failed",
  }]);
  assert.doesNotMatch(JSON.stringify(packet.evidence.actions), /hidden-value|publish|outside|\.env|raw result/u);
});

test("rejects raw C0 command separators while normalizing tabs", async () => {
  const calls = [
    { id: "tab", arguments: { command: "pnpm\tcheck" } },
    { id: "newline", arguments: { command: "pnpm check\nnpm publish" } },
    { id: "carriage", arguments: { command: "pnpm check\rnpm publish" } },
    { id: "vertical-tab", arguments: { command: "pnpm check\u000bnpm publish" } },
    { id: "form-feed", arguments: { command: "pnpm check\u000cnpm publish" } },
  ];
  const entries = [
    user("user-1", "Verify the project."),
    assistantCalls("assistant-1", calls),
    ...calls.map((call, index) => toolResult(`result-${index}`, call.id)),
  ];
  const packet = await buildSkillAuthorshipPacket({ entries, projectRoot: "/repo", store: corpus() });

  assert.deepEqual(packet.evidence.actions, [{ kind: "command", command: "pnpm check", outcome: "completed" }]);
});

test("rejects embedded paths and mutating commands while retaining strict verification productions", async () => {
  const commands = [
    ["absolute-option", "node --test=/Users/alice/private.js"],
    ["drive-option", "node --test=C:/Users/alice/private.js"],
    ["file-option", "node --test=file:///Users/alice/private.js"],
    ["traversal-option", "node --test=../outside/private.js"],
    ["lifecycle", "pnpm run postinstall"],
    ["arbitrary-node", "node scripts/destructive.js"],
    ["eslint-fix", "eslint . --fix"],
    ["eslint-fix-assigned", "eslint . --fix=true"],
    ["jest-update", "jest -u"],
    ["jest-update-assigned", "jest --updateSnapshot=true"],
    ["jest-watch-assigned", "jest --watchAll=true"],
    ["git-secret-ref", "git show HEAD:.env"],
    ["git-secret-path", "git diff -- .env"],
    ["node-secret-path", "node --test .env"],
    ["git-secret-key", "git show HEAD:.ssh/id_rsa"],
    ["filter-test", "pnpm --filter @scope/app test"],
    ["exec-tsc", "pnpm exec tsc --noEmit"],
    ["python-test", "python -m pytest"],
    ["make-test", "make test"],
    ["git-safe", "git diff -- src/index.ts"],
  ] as const;
  const entries = [
    user("user-1", "Verify the project."),
    assistantCalls("assistant-1", commands.map(([id, command]) => ({ id, arguments: { command } }))),
    ...commands.map(([id], index) => toolResult(`result-${index}`, id)),
  ];
  const packet = await buildSkillAuthorshipPacket({ entries, projectRoot: "/repo", store: corpus() });

  assert.deepEqual(packet.evidence.actions, [
    { kind: "command", command: "pnpm --filter @scope/app test", outcome: "completed" },
    { kind: "command", command: "pnpm exec tsc --noEmit", outcome: "completed" },
    { kind: "command", command: "python -m pytest", outcome: "completed" },
    { kind: "command", command: "make test", outcome: "completed" },
    { kind: "command", command: "git diff -- src/index.ts", outcome: "completed" },
  ]);
});

test("omits duplicate, mismatched, and result-before-call tool pairs", async () => {
  const entries = [
    user("user-1", "Verify the project."),
    toolResult("before-result", "before"),
    assistantCalls("assistant-1", [
      { id: "duplicate-call", arguments: { command: "pnpm check" } },
      { id: "duplicate-call", arguments: { command: "npm test" } },
      { id: "mismatch", arguments: { command: "pnpm check" } },
      { id: "duplicate-result", arguments: { command: "pnpm check" } },
      { id: "before", arguments: { command: "pnpm check" } },
      { id: "unique", arguments: { command: "pnpm test" } },
    ]),
    toolResult("duplicate-call-result", "duplicate-call"),
    toolResult("mismatch-result", "mismatch", "read"),
    toolResult("duplicate-result-a", "duplicate-result"),
    toolResult("duplicate-result-b", "duplicate-result"),
    toolResult("unique-result", "unique"),
  ];
  const packet = await buildSkillAuthorshipPacket({ entries, projectRoot: "/repo", store: corpus() });

  assert.deepEqual(packet.evidence.actions, [{ kind: "command", command: "pnpm test", outcome: "completed" }]);
});

test("omits sensitive project paths and canonical symlink escapes", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "skill-actions-"));
  const root = join(base, "repo");
  const outside = join(base, "outside");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export {};\n");
  await writeFile(join(outside, "private.txt"), "private\n");
  await symlink(outside, join(root, "linked-outside"), "dir");
  t.after(() => rm(base, { recursive: true, force: true }));

  const paths = [
    ["safe", join(root, "src", "index.ts")],
    ["aws", join(root, ".aws", "config")],
    ["docker", join(root, ".docker", "config.json")],
    ["netrc", join(root, ".netrc")],
    ["private-key", join(root, "id_rsa")],
    ["pem", join(root, "certificate.pem")],
    ["symlink", join(root, "linked-outside", "private.txt")],
  ] as const;
  const entries = [
    user("user-1", "Inspect project files."),
    assistantCalls("assistant-1", paths.map(([id, path]) => ({ id, name: "read", arguments: { path } }))),
    ...paths.map(([id], index) => toolResult(`result-${index}`, id, "read")),
  ];
  const packet = await buildSkillAuthorshipPacket({ entries, projectRoot: root, store: corpus() });

  assert.deepEqual(packet.evidence.actions, [{ kind: "path", action: "read", path: "src/index.ts", outcome: "completed" }]);
});

test("fails closed on tool-record overflow and omits oversized raw action values", async () => {
  const overflowCalls = Array.from({ length: 129 }, (_, index) => ({
    id: `call-${index}`,
    arguments: { command: "pnpm check" },
  }));
  const overflow = await buildSkillAuthorshipPacket({
    entries: [user("user-1", "Verify."), assistantCalls("assistant-1", overflowCalls)],
    projectRoot: "/repo",
    store: corpus(),
  });
  assert.deepEqual(overflow.evidence.actions, []);

  const calls = [
    { id: "oversized-command", arguments: { command: `pnpm check ${"x".repeat(1_024)}` } },
    { id: "oversized-path", name: "read", arguments: { path: `/repo/${"x".repeat(1_024)}` } },
    { id: "safe", arguments: { command: "pnpm test" } },
  ];
  const bounded = await buildSkillAuthorshipPacket({
    entries: [
      user("user-2", "Verify."),
      assistantCalls("assistant-2", calls),
      toolResult("oversized-command-result", "oversized-command"),
      toolResult("oversized-path-result", "oversized-path", "read"),
      toolResult("safe-result", "safe"),
    ],
    projectRoot: "/repo",
    store: corpus(),
  });
  assert.deepEqual(bounded.evidence.actions, [{ kind: "command", command: "pnpm test", outcome: "completed" }]);
});

test("selects invoked and relevant exact skill documents deterministically", async () => {
  const release = projectSkill("release-check", {
    description: "Verify deployment releases and rollback readiness.",
    content: "# Release check\n\n1. Verify deployment. Done when: rollback is ready.",
    useSessionCount: 2,
  });
  const database = projectSkill("database-backup", {
    description: "Back up the Postgres database before migrations.",
    content: "# Database backup\n\n1. Back up Postgres. Done when: restore succeeds.",
  });
  const unrelated = projectSkill("aaa-formatting", { useSessionCount: 99 });
  const entries = [
    user("user-1", "We need the Postgres database backup and release deployment workflow."),
    skillUse("skill-use-1", ["release-check"]),
  ];

  const first = await buildSkillAuthorshipPacket({ entries, store: corpus([unrelated, database, release]) });
  const shuffled = await buildSkillAuthorshipPacket({ entries, store: corpus([release, unrelated, database]) });

  assert.deepEqual(first, shuffled);
  assert.deepEqual(first.corpus.documents.map((skill) => skill.name).slice(0, 2), ["release-check", "database-backup"]);
  assert.equal(first.corpus.documents[0]?.content, release.content);
  assert.equal(first.corpus.catalog.find((skill) => skill.name === "release-check")?.bodyAvailable, true);
});

test("uses token boundaries for mentions and reports only signaled document omissions", async () => {
  const release = projectSkill("release", { description: "Publish a stable version." });
  const prerelease = projectSkill("prerelease", { description: "Publish a prerelease candidate." });
  const unrelated = projectSkill("database-backup", { description: "Back up the database." });
  const packet = await buildSkillAuthorshipPacket({
    entries: [user("user-1", "Update the prerelease candidate procedure.")],
    store: corpus([release, unrelated, prerelease]),
  });

  assert.equal(packet.corpus.documents.at(0)?.name, "prerelease");
  assert.equal(packet.corpus.documents.some((document) => document.name === "release"), false);
  assert.equal(packet.corpus.documentsOmitted, 0);

  const unmentioned = await buildSkillAuthorshipPacket({
    entries: [user("user-2", "Handle an unrelated request.")],
    store: corpus([release, unrelated]),
  });
  assert.equal(unmentioned.corpus.documents.length, 0);
  assert.equal(unmentioned.corpus.documentsOmitted, 0);
  assert.equal(unmentioned.corpus.truncated, false);
  assert.equal(Object.hasOwn(JSON.parse(serializeSkillAuthorshipPromptPacket(unmentioned)) as object, "coverage"), false);
});

test("omits exact bodies containing any centralized credential form", async () => {
  const secretBodies = [
    projectSkill("aws-secret", { content: "AWS_SECRET_ACCESS_KEY=super-secret-value" }),
    projectSkill("bearer-secret", { content: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" }),
    projectSkill("npm-secret", { content: "npm_token=npm-super-secret-value" }),
    projectSkill("provider-key", { content: "OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz" }),
    projectSkill("private-key-assignment", { content: "PRIVATE_KEY=abcdefghijklmnopqrstuvwxyz" }),
    projectSkill("json-provider-key", { content: '{"OPENAI_API_KEY":"abcdefghijklmnopqrstuvwxyz"}' }),
    projectSkill("yaml-provider-key", { content: "'PRIVATE_KEY': abcdefghijklmnopqrstuvwxyz" }),
    projectSkill("database-secret", { content: "DATABASE_URL=postgres://user:password@db.example.test/app" }),
    projectSkill("url-secret", { content: "Connect to https://user:password@example.test/private" }),
    projectSkill("jwt-secret", { content: "eyJheader.eyJpayload.signature" }),
  ];
  const packet = await buildSkillAuthorshipPacket({
    entries: [user("user-1", "Use the credential procedures."), skillUse("use-1", secretBodies.map((skill) => skill.name))],
    store: corpus(secretBodies),
  });

  assert.equal(packet.corpus.documents.length, 0);
  assert.equal(packet.corpus.documentsOmitted, secretBodies.length);
  assert.doesNotMatch(JSON.stringify(packet), /super-secret|abcdefghijklmnopqrstuvwxyz|postgres:\/\/user:password|https:\/\/user:password|eyJpayload/u);
});

test("packs whole documents, skips non-fitting bodies, and never sanitizes an unsafe body", async () => {
  const huge = projectSkill("huge-skill", { content: "x".repeat(32_000) });
  const medium = projectSkill("medium-skill", { content: "m".repeat(12_000) });
  const small = projectSkill("small-skill", { content: "# Small\n\nDone when: complete." });
  const unsafe = projectSkill("unsafe-skill", { content: "AWS_SECRET_ACCESS_KEY=super-secret-token-value" });
  const entries = [user("user-1", "Use these procedures."), skillUse("use-1", ["huge-skill", "medium-skill", "small-skill", "unsafe-skill"])];

  const packet = await buildSkillAuthorshipPacket({ entries, store: corpus([medium, unsafe, small, huge]) });
  const names = packet.corpus.documents.map((skill) => skill.name);
  const renderedDocuments = JSON.stringify(packet.corpus.documents);

  assert.equal(packet.corpus.documents[0]?.name, "huge-skill");
  assert.equal(packet.corpus.documents[0]?.content.length, 32_000);
  assert.ok(renderedDocuments.length <= MAX_SKILL_AUTHORSHIP_DOCUMENT_CHARS);
  assert.doesNotMatch(renderedDocuments, /\[REDACTED/u);
  assert.doesNotMatch(renderedDocuments, /super-secret-token-value/u);
  assert.equal(names.includes("medium-skill"), false);
  assert.equal(names.includes("small-skill"), true);
  assert.equal(names.includes("unsafe-skill"), false);
  assert.equal(packet.corpus.catalog.find((skill) => skill.name === "unsafe-skill")?.bodyAvailable, false);
  assert.ok(packet.corpus.documentsOmitted >= 2);
});

test("bounds catalog and pending summaries without exposing raw proposal provenance or payloads", async () => {
  const skills = Array.from({ length: 30 }, (_, index) => projectSkill(`procedure-${index}`, {
    description: `${String(index).padStart(2, "0")} ${"description ".repeat(38)}procedure.`,
  }));
  const pending: SkillProposal[] = [{
    version: 1,
    id: "20260101000000-deadbeef",
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceSessionId: "raw-source-session",
    operations: [{
      action: "create",
      name: "release-check",
      description: "Verify release readiness.",
      content: "RAW PENDING BODY",
      reason: "Deployment workflow recurs.",
      evidence: ["RAW EVIDENCE EXCERPT"],
    }],
  }, ...Array.from({ length: 40 }, (_, index): SkillProposal => ({
    version: 1,
    id: `2026010100${String(index).padStart(4, "0")}-deadbeef`,
    createdAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
    operations: [{ action: "archive", name: `old-${index}`, reason: `${"stale ".repeat(70)}now` }],
  }))];

  const entries = [user("user-1", "Check release readiness."), skillUse("use-1", ["release-check"])];
  const packet = await buildSkillAuthorshipPacket({ entries, store: corpus(skills, pending) });
  const shuffled = await buildSkillAuthorshipPacket({
    entries,
    store: corpus([...skills].reverse(), [...pending].reverse()),
  });
  const encoded = JSON.stringify(packet);
  const proposal = packet.corpus.pending.find((item) => item.name === "release-check");

  assert.deepEqual(packet, shuffled);
  assert.deepEqual(proposal, {
    action: "create",
    name: "release-check",
    retention: false,
    reason: "Deployment workflow recurs.",
    description: "Verify release readiness.",
  });
  assert.ok(JSON.stringify(packet.corpus.catalog).length <= MAX_SKILL_AUTHORSHIP_CATALOG_CHARS);
  assert.ok(JSON.stringify(packet.corpus.pending).length <= MAX_SKILL_AUTHORSHIP_PENDING_CHARS);
  assert.ok(packet.corpus.catalogOmitted > 0);
  assert.ok(packet.corpus.pendingOmitted > 0);
  assert.equal(packet.corpus.truncated, true);
  assert.doesNotMatch(encoded, /raw-source-session|2026-01-01|20260101000000|RAW PENDING BODY|RAW EVIDENCE EXCERPT/u);
});

test("prompt projection structurally excludes coverage IDs and stays within its exact serialization bound", async () => {
  const skill = projectSkill("large-procedure", { content: "x".repeat(32_000) });
  const packet = await buildSkillAuthorshipPacket({
    entries: [user("private-user-id", "\\".repeat(31_000)), skillUse("private-use-id", ["large-procedure"])],
    store: corpus([skill]),
  });
  const serialized = serializeSkillAuthorshipPromptPacket(packet);
  const projected = JSON.parse(serialized) as object;

  assert.equal(Object.hasOwn(projected, "coverage"), false);
  assert.doesNotMatch(serialized, /private-user-id|private-use-id/u);
  assert.ok(serialized.length <= MAX_SKILL_AUTHORSHIP_PROMPT_CHARS);
  for (const document of packet.corpus.documents) assert.equal(document.content, skill.content);
});

test("fails closed on unsafe entry IDs instead of publishing ambiguous coverage", async () => {
  await assert.rejects(
    buildSkillAuthorshipPacket({ entries: [user("bad\nentry", "workflow")], store: corpus() }),
    /entry id/u,
  );
});
