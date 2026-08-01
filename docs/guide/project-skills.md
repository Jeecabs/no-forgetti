# Project skills

Project skills are procedural memory: durable, repeatable workflows formed from successful work in one project.

## How skills become available

No Forgetti stores active skills outside the repository as standard `SKILL.md` packages. It publishes the project’s active skills directory through Pi’s native resource discovery.

Pi then owns invocation:

- Matching skill metadata appears in Pi’s `<available_skills>` section.
- The model reads `SKILL.md` when a task matches.
- Users can force invocation with `/skill:<name>`.

The body is not injected on every turn. It enters working context only through Pi’s native progressive-disclosure path.

## Authorship

No Forgetti captures the oldest bounded review frontier. The packet contains at most 12 user turns and 32,000 sanitized transcript characters. It removes raw tool arguments, tool results, thinking, images, secrets, and skill-invocation scaffolding.

The packet can include bounded action facts for completed or failed verification commands and project-relative file operations. A strict grammar rejects shell control characters, mutating commands, sensitive paths, ambiguous tool pairs, and symlink escapes. Each proposal reason and evidence item must match an exact transcript span or canonical action fact. Failed action facts are diagnostic evidence. They do not prove a successful procedure.

The reviewer also receives one atomic skill-corpus snapshot. This snapshot contains a ranked catalog, relevant exact skill bodies, pending summaries, omission counts, and content bindings. Allowlisted manifest facts and labeled project-memory beliefs provide project conventions. The reviewer treats every packet field as untrusted data.

The embedded `writing-great-skills` doctrine defines seven phases: evidence, curation, conventions, invocation, information hierarchy, pruning, and safety. Predictability is the root criterion.

Descriptions are compact context pointers. They front-load a leading word. Each genuine branch gets one trigger. The reviewer prunes instead of clipping. The 500-character limit is a safety ceiling, not an authorship target.

Skill bodies put ordered actions before reference. Each step has a checkable completion criterion. Authors remove duplication, no-ops, sediment, sprawl, and avoidable negation.

Each review uses an immutable job and the active model at `xhigh` reasoning. The job binds the evidence packet, prompt version, doctrine, system prompt, user prompt, claim generation, and hashed session identity. A valid proposal also records the requested reviewer profile, actual model provenance, token usage, cost, and operation digest.

Invalid model output does not become a no-change decision. No Forgetti retains the exact evidence and enters review backoff. It also quarantines malformed persisted proposals so one bad record cannot block project-skill commands.

## Review and approval

A skill review produces at most one create, patch, or archive operation.

| Operation | Default behavior |
| --- | --- |
| Create | Applies automatically after generated-package validation |
| Patch | Remains pending for explicit approval |
| Archive | Remains pending for explicit approval |

A patch binds the captured skill generation and content digest. Approval fails closed if the target changes during model latency. A valid patch snapshots a revision before mutation. Archives require approval because they remove a skill from Pi’s discovery surface.

No Forgetti catches only typed target-binding conflicts as stale proposals. Filesystem, lock, and integrity errors remain failures. The review cursor advances only after a valid proposal or explicit no-change outcome settles the exact cadence claim.

::: info External mode boundary
The external worker processes **memory review only**. Project-skill review remains inside Pi in every authority mode. No Forgetti does not treat the memory reviewer profile as consent for external skill authorship.
:::

## Reviewer evaluation

The checked-in skill-authoring smoke corpus runs immutable jobs through the production reviewer engine. It scores action accuracy, semantic grounding, invocation quality, and projected procedure quality.

Run deterministic checks with `pnpm eval:skills:check`. Live comparisons require `pnpm eval:skills:live -- --live` plus two explicit profiles and call, token, cost, and output limits. The live command does not read `service.json` or mutate project state.

The frozen corpus contains 31 labeled cases: 15 proposals and 16 no-change negatives. Admission requires every case to pass. It requires proposal-precision, negative-specificity, and paired non-inferiority lower bounds. It also requires complete dispatch accounting and bounded token and cost changes.

## Manage skills

Run `/project-skills` without arguments to open the interactive browser, or use direct commands:

```text
/project-skills list
/project-skills stats
/project-skills read <name>
/project-skills edit <name>
/project-skills delete <name>
/project-skills undo <name>
/project-skills pending
/project-skills approve <name>
/project-skills approve-all
/project-skills reject <name>
/project-skills review
```

Validated creates and approved patches become visible to Pi after `/reload` or in the next session. The viewer also supports `d` to delete the open skill after confirmation. Deletion removes the skill from discovery and keeps an archived copy.

## Usage and retention

No Forgetti observes successful native reads of active project `SKILL.md` files and persisted `/skill:<name>` expansions. A skill receives at most one usage credit per successful agent run.

Recall tracking stays local. It stores bounded SHA-256 session markers only to deduplicate distinct-session use. It does not store raw Pi session identifiers or send telemetry.

After 20 completed distinct project sessions without recall, No Forgetti stages an archive proposal. Recalling the skill withdraws that automatic proposal. Rejecting it snoozes retention for another 20 sessions. Retention never deletes or archives a skill without explicit approval.

## Editing and undo

The interactive browser supports reading and editing active skill Markdown. Edits snapshot a revision, and `/project-skills undo <name>` shows the rendered diff before confirmation.

Skills remain outside the repository throughout their lifecycle. Use checked-in documentation for facts that need version control. Use project skills for procedures that Pi should invoke on demand.
