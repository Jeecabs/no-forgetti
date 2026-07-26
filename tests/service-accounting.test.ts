import assert from "node:assert/strict";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileReviewAttemptAccounting, reviewAttemptId } from "../src/service/accounting.ts";

const claim = {
  jobDigest: "a".repeat(64),
  attempt: 1,
  leaseToken: "b".repeat(32),
};
const limits = { maxCalls: 1, maxTokens: 1_000, maxCostNanodollars: 2_000_000_000 };
const hold = { tokens: 400, costNanodollars: 500_000_000 };

test("concurrent reservations cannot both consume the final provider slot", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-accounting-"));
  const now = () => new Date("2026-02-01T23:59:00.000Z");
  const first = new FileReviewAttemptAccounting(root, { now });
  const second = new FileReviewAttemptAccounting(root, { now });
  await Promise.all([first.initialize(), second.initialize()]);

  const results = await Promise.all([
    first.reserve({ claim, provider: "anthropic", limits, hold }),
    second.reserve({
      claim: { ...claim, jobDigest: "c".repeat(64) },
      provider: "anthropic",
      limits,
      hold,
    }),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(await first.snapshot("anthropic"), {
    version: 1,
    day: "2026-02-01",
    provider: "anthropic",
    charged: { calls: 0, tokens: 0, costNanodollars: 0 },
    held: { calls: 1, tokens: 400, costNanodollars: 500_000_000 },
    unknown: { calls: 0, tokens: 0, costNanodollars: 0 },
    effective: { calls: 1, tokens: 400, costNanodollars: 500_000_000 },
  });
});

function provenance(tokens = 12, cost = 0.25) {
  return {
    provider: "anthropic",
    model: "review-model",
    api: "messages",
    startedAt: "2026-02-01T23:59:01.000Z",
    completedAt: "2026-02-02T00:00:01.000Z",
    durationMs: 60_000,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0.2, output: 0.05, cacheRead: 0, cacheWrite: 0, total: cost },
    },
  };
}

test("attempt settlement stays charged to its fixed reservation day across UTC rollover", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-accounting-rollover-"));
  let time = Date.parse("2026-02-01T23:59:00.000Z");
  const account = new FileReviewAttemptAccounting(root, { now: () => new Date(time) });
  const reservation = await account.reserve({ claim, provider: "anthropic", limits, hold });
  assert.ok(reservation);
  await account.commitDispatch(reservation);

  time += 2 * 60_000;
  await account.settle(reservation, provenance());

  assert.deepEqual((await account.snapshot("anthropic", "2026-02-01")).charged, {
    calls: 1,
    tokens: 12,
    costNanodollars: 250_000_000,
  });
  assert.deepEqual((await account.snapshot("anthropic")).effective, {
    calls: 0,
    tokens: 0,
    costNanodollars: 0,
  });
  assert.ok(await account.reserve({ claim: { ...claim, attempt: 2 }, provider: "anthropic", limits, hold }));
});

test("unknown dispatched usage retains its conservative hold separately", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-accounting-unknown-"));
  const account = new FileReviewAttemptAccounting(root, { now: () => new Date("2026-02-01T12:00:00.000Z") });
  const reservation = await account.reserve({ claim, provider: "anthropic", limits, hold });
  assert.ok(reservation);
  await account.commitDispatch(reservation);
  await account.markUnknown(reservation);

  const snapshot = await account.snapshot("anthropic");
  assert.deepEqual(snapshot.charged, { calls: 0, tokens: 0, costNanodollars: 0 });
  assert.deepEqual(snapshot.held, { calls: 0, tokens: 0, costNanodollars: 0 });
  assert.deepEqual(snapshot.unknown, { calls: 1, tokens: 400, costNanodollars: 500_000_000 });
  assert.deepEqual(snapshot.effective, snapshot.unknown);
  assert.equal(await account.reserve({ claim: { ...claim, attempt: 2 }, provider: "anthropic", limits, hold }), undefined);
});

test("pre-dispatch cancellation releases holds and preserves secure filesystem modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-accounting-cancel-"));
  const account = new FileReviewAttemptAccounting(root, { now: () => new Date("2026-02-01T12:00:00.000Z") });
  const reservation = await account.reserve({ claim, provider: "anthropic", limits, hold });
  assert.ok(reservation);
  await account.cancelPreDispatch(reservation);
  await account.cancelPreDispatch(reservation);

  assert.deepEqual((await account.snapshot("anthropic")).effective, { calls: 0, tokens: 0, costNanodollars: 0 });
  assert.ok(await account.reserve({ claim: { ...claim, attempt: 2 }, provider: "anthropic", limits, hold }));
  assert.equal((await stat(join(root, "accounting"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "accounting", "days"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "accounting", "days", "2026-02-01"))).mode & 0o777, 0o600);
});

test("retention keeps current and unresolved budget authority while purging closed days", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-accounting-retention-"));
  let time = Date.parse("2026-02-01T12:00:00.000Z");
  const account = new FileReviewAttemptAccounting(root, { now: () => new Date(time) });
  const reserveOnDay = async (day: number, attempt: number) => {
    time = Date.parse(`2026-02-${String(day).padStart(2, "0")}T12:00:00.000Z`);
    const reservation = await account.reserve({ claim: { ...claim, attempt }, provider: "anthropic", limits, hold });
    assert.ok(reservation);
    return reservation;
  };

  const settled = await reserveOnDay(1, 1);
  await account.commitDispatch(settled);
  await account.settle(settled, provenance());
  await reserveOnDay(2, 2);
  const dispatched = await reserveOnDay(3, 3);
  await account.commitDispatch(dispatched);
  const unknown = await reserveOnDay(4, 4);
  await account.commitDispatch(unknown);
  await account.markUnknown(unknown);
  const canceled = await reserveOnDay(5, 5);
  await account.cancelPreDispatch(canceled);
  const current = await reserveOnDay(6, 6);
  await account.cancelPreDispatch(current);

  assert.equal(await account.purgeClosedDaysBefore(new Date("2027-01-01T00:00:00.000Z")), 2);
  assert.deepEqual((await readdir(account.daysDir)).sort(), [
    "2026-02-02",
    "2026-02-03",
    "2026-02-04",
    "2026-02-06",
  ]);
  assert.deepEqual((await account.snapshot("anthropic", "2026-02-01")).charged, {
    calls: 0,
    tokens: 0,
    costNanodollars: 0,
  });
  assert.deepEqual((await account.snapshot("anthropic", "2026-02-04")).unknown, {
    calls: 1,
    tokens: hold.tokens,
    costNanodollars: hold.costNanodollars,
  });
  assert.equal((await stat(join(account.daysDir, "2026-02-02"))).mode & 0o777, 0o600);
  assert.equal((await stat(account.daysDir)).mode & 0o777, 0o700);
});

test("retention removes abandoned old accounting temporaries but not current-day temporaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-accounting-temp-retention-"));
  const account = new FileReviewAttemptAccounting(root, { now: () => new Date("2026-02-06T12:00:00.000Z") });
  await account.initialize();
  const uuid = "12345678-1234-1234-1234-123456789abc";
  await writeFile(join(account.daysDir, `2026-02-01.123.${uuid}.tmp`), "old", { mode: 0o600 });
  await writeFile(join(account.daysDir, `2026-02-06.123.${uuid}.tmp`), "current", { mode: 0o600 });

  assert.equal(await account.purgeClosedDaysBefore(new Date("2027-01-01T00:00:00.000Z")), 1);
  assert.deepEqual(await readdir(account.daysDir), [`2026-02-06.123.${uuid}.tmp`]);
});

test("attempt ids bind job digest, claim attempt, and lease token", () => {
  const id = reviewAttemptId(claim);
  assert.match(id, /^review_attempt_[0-9a-f]{40}$/u);
  assert.notEqual(reviewAttemptId({ ...claim, jobDigest: "c".repeat(64) }), id);
  assert.notEqual(reviewAttemptId({ ...claim, attempt: 2 }), id);
  assert.notEqual(reviewAttemptId({ ...claim, leaseToken: "d".repeat(32) }), id);
});

test("known settlement replay is idempotent and conflicting settlement fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-accounting-settle-"));
  let time = Date.parse("2026-02-01T12:00:00.000Z");
  const account = new FileReviewAttemptAccounting(root, { now: () => new Date(time) });
  const reservation = await account.reserve({ claim, provider: "anthropic", limits, hold });
  assert.ok(reservation);
  await account.commitDispatch(reservation);
  const known = provenance();
  await account.settle(reservation, known);
  time += 60_000;
  await account.settle(reservation, known);
  await assert.rejects(account.settle(reservation, provenance(13, 0.25)), /Conflicting review accounting settlement/u);

  const snapshot = await account.snapshot("anthropic");
  assert.deepEqual(snapshot.charged, { calls: 1, tokens: 12, costNanodollars: 250_000_000 });
  assert.deepEqual(snapshot.held, { calls: 0, tokens: 0, costNanodollars: 0 });
  assert.deepEqual(snapshot.effective, snapshot.charged);
});

const dispatch = {
  requestDigest: "d".repeat(64),
  model: "review-model",
  api: "messages",
};

test("dispatch identity survives restart and rejects conflicting replays and provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-accounting-dispatch-"));
  const now = () => new Date("2026-02-01T12:00:00.000Z");
  const account = new FileReviewAttemptAccounting(root, { now });
  const reservation = await account.reserve({ claim, provider: "anthropic", limits, hold });
  assert.ok(reservation);
  await account.commitDispatch(reservation, dispatch);

  const restarted = new FileReviewAttemptAccounting(root, { now });
  await restarted.commitDispatch(reservation, dispatch);
  await assert.rejects(
    restarted.commitDispatch(reservation, { ...dispatch, requestDigest: "e".repeat(64) }),
    /Conflicting review accounting dispatch replay/u,
  );
  await assert.rejects(
    restarted.settle(reservation, { ...provenance(), model: "other-model" }),
    /does not match dispatched model\/API/u,
  );
  await restarted.settle(reservation, provenance());
});

test("global immutable identity prevents one deterministic attempt spanning UTC days", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-accounting-global-id-"));
  const before = new FileReviewAttemptAccounting(root, { now: () => new Date("2026-02-01T23:59:59.999Z") });
  const after = new FileReviewAttemptAccounting(root, { now: () => new Date("2026-02-02T00:00:00.000Z") });
  const [first, second] = await Promise.all([
    before.reserve({ claim, provider: "anthropic", limits, hold }),
    after.reserve({ claim, provider: "anthropic", limits, hold }),
  ]);
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(second, first);

  const totalHeld = (await before.snapshot("anthropic", "2026-02-01")).held.calls
    + (await after.snapshot("anthropic", "2026-02-02")).held.calls;
  assert.equal(totalHeld, 1);
  assert.equal((await stat(join(before.identitiesDir, first.id))).mode & 0o777, 0o600);
  assert.equal((await stat(before.identitiesDir)).mode & 0o777, 0o700);
});

test("bounded recovery cancels reserved orphans, marks dispatched unknown, settles results, and keeps live claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-accounting-recovery-"));
  let time = Date.parse("2026-02-01T12:00:00.000Z");
  const account = new FileReviewAttemptAccounting(root, { now: () => new Date(time) });
  const roomy = { maxCalls: 10, maxTokens: 10_000, maxCostNanodollars: 10_000_000_000 };
  const reserve = async (attempt: number, leaseToken: string) => {
    const reservation = await account.reserve({
      claim: { ...claim, attempt, leaseToken },
      provider: "anthropic",
      limits: roomy,
      hold,
    });
    assert.ok(reservation);
    return reservation;
  };
  const canceled = await reserve(1, "1".repeat(32));
  const unknown = await reserve(2, "2".repeat(32));
  await account.commitDispatch(unknown, dispatch);
  const settled = await reserve(3, "3".repeat(32));
  const live = await reserve(4, "4".repeat(32));

  time = Date.parse("2026-02-02T12:00:00.000Z");
  const candidates = [];
  let cursor: string | undefined;
  do {
    const page = await account.listRecoveryCandidates({ limit: 2, ...(cursor ? { cursor } : {}) });
    candidates.push(...page.candidates);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(candidates.length, 4);

  const report = await account.reconcileRecovery({
    candidates: candidates.map((candidate) => candidate.reservation),
    liveLeaseTokens: ["4".repeat(32)],
    results: [{ reservation: settled, provenance: provenance(), dispatch }],
    expiresBefore: "2026-02-02T00:00:00.000Z",
  });
  assert.deepEqual(report.canceled, [canceled.id]);
  assert.deepEqual(report.unknown, [unknown.id]);
  assert.deepEqual(report.settled, [settled.id]);
  assert.deepEqual(report.unchanged, [live.id]);
  assert.deepEqual(await account.snapshot("anthropic", "2026-02-01"), {
    version: 1,
    day: "2026-02-01",
    provider: "anthropic",
    charged: { calls: 1, tokens: 12, costNanodollars: 250_000_000 },
    held: { calls: 1, tokens: hold.tokens, costNanodollars: hold.costNanodollars },
    unknown: { calls: 1, tokens: hold.tokens, costNanodollars: hold.costNanodollars },
    effective: { calls: 3, tokens: 812, costNanodollars: 1_250_000_000 },
  });
});

test("legacy same-day aggregate imports once as conservative carry under concurrency", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-accounting-legacy-"));
  const now = () => new Date("2026-02-01T12:00:00.000Z");
  const first = new FileReviewAttemptAccounting(root, { now });
  const second = new FileReviewAttemptAccounting(root, { now });
  const legacy = { version: 1 as const, day: "2026-02-01", calls: 3, tokens: 123, costUsd: 0.25 };
  const imported = await Promise.all([
    first.importLegacyDailyBudget("anthropic", legacy),
    second.importLegacyDailyBudget("anthropic", legacy),
  ]);
  assert.deepEqual(imported.sort(), [false, true]);
  assert.deepEqual((await first.snapshot("anthropic")).unknown, {
    calls: 3,
    tokens: 123,
    costNanodollars: 250_000_000,
  });
  assert.equal(await first.importLegacyDailyBudget("anthropic", legacy), false);
  await assert.rejects(
    first.importLegacyDailyBudget("anthropic", { ...legacy, calls: 4 }),
    /Conflicting legacy review budget import/u,
  );
  assert.equal(await first.importLegacyDailyBudget("openai", { ...legacy, day: "2026-01-31" }), false);
});
