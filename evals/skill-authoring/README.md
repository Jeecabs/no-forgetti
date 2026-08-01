# Project-skill semantic eval

Checked-in synthetic cases exercise create, patch, archive, abstention, and adversarial evidence through the production immutable `SkillReviewJob` and tool-less `SkillReviewEngine`.

## Deterministic replay

`tests/skill-eval.test.ts` runs good and bad canned model outputs through the production engine, then scores:

- Semantic grounding: required and forbidden terms in reason and evidence
- Invocation: required and forbidden trigger terms in the projected description
- Downstream use: required and forbidden procedure terms and completion criteria in the projected body
- Exact action and target

Candidate comparison fails closed unless every candidate case passes. It holds on any metric regression, critical failure, invalid output, or runner failure. It also holds when tokens or cost increase by more than 25 percent. Replays bind the requested reviewer profile, dispatch request digests, and exact job IDs and digests.

The checked-in corpus contains 31 labeled cases: 15 proposals and 16 no-change negatives. A reviewer must pass every case before promotion. The gate requires complete dispatch accounting and Wilson lower bounds for proposal precision and negative specificity. It also requires a paired non-inferiority lower bound and no critical, execution, token, or cost regression.

## Live comparison

Live calls require explicit consent, at least two complete model profiles, and hard shared budgets. The command never reads `service.json` and never mutates project memory or skills.

```bash
node --experimental-strip-types scripts/skill-eval.ts \
  --live \
  --candidate baseline --provider PROVIDER --model MODEL_A --reasoning medium \
  --candidate challenger --provider PROVIDER --model MODEL_B --reasoning medium \
  --max-calls 20 \
  --max-tokens 200000 \
  --max-cost-usd 5 \
  --max-output-tokens 4096
```

Credentials come from the normal model runtime for Pi. Output is aggregate-only JSON. It includes case scores, immutable job digests, and requested profile digests. It also includes dispatch request digests, observed model identities, usage totals, and conservative comparisons. It excludes raw model responses, evidence transcripts, proposal bodies, credentials, headers, and provider errors.

The budget reserves the worst-case token and cost hold before each dispatch. It settles to observed usage after a response. If dispatched usage is unknown, the conservative hold remains charged.

Cases use synthetic text and `[REDACTED]` placeholders only. Never add real session transcripts or secrets.
