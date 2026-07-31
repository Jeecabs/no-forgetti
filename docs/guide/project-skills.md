# Project skills

Project skills are procedural memory: durable, repeatable workflows formed from successful work in one project.

## How skills become available

No Forgetti stores active skills outside the repository as standard `SKILL.md` packages. It publishes the project’s active skills directory through Pi’s native resource discovery.

Pi then owns invocation:

- matching skill metadata appears in Pi’s `<available_skills>` section;
- the model reads `SKILL.md` when a task matches; and
- users can force invocation with `/skill:<name>`.

The body is not injected on every turn. It enters working context only through Pi’s native progressive-disclosure path.

## Authorship

The reviewer treats the completed conversation as untrusted evidence. It then applies the embedded `writing-great-skills` doctrine in six phases: evidence, curation, invocation, information hierarchy, pruning, and safety. Predictability is the root criterion.

Descriptions are compact context pointers. They front-load a leading word. Each genuine branch gets one trigger. Prune instead of clip. The 500-character limit is a safety ceiling, not an authorship target.

Skill bodies put ordered actions before reference. Each step has a checkable completion criterion. Authors remove duplication, no-ops, sediment, sprawl, and avoidable negation.

The final authorship audit runs before the model returns one operation. A malformed operation becomes a no-op instead of retry work. No Forgetti quarantines malformed persisted proposals so one bad record cannot block project-skill commands.

## Review and approval

A skill review produces at most one create, patch, or archive operation.

| Operation | Default behavior |
| --- | --- |
| Create | Applies automatically after validation |
| Patch | Applies automatically when its anchor matches exactly once |
| Archive | Remains pending for explicit approval |

A patch snapshots a revision first. If its anchor no longer matches, No Forgetti keeps the proposal pending instead of guessing. Archives require approval because they remove a skill from Pi’s discovery surface.

::: info External mode boundary
The first external review release processes **memory review only**. Project-skill review remains inside Pi in every authority mode.
:::

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

Validated creates and archives become visible to Pi after `/reload` or in the next session. The viewer also supports `d` to delete the open skill after confirmation. Deletion removes the skill from discovery and keeps an archived copy.

## Usage and retention

No Forgetti observes successful native reads of active project `SKILL.md` files and persisted `/skill:<name>` expansions. A skill receives at most one usage credit per successful agent run.

Recall tracking stays local. It stores bounded SHA-256 session markers only to deduplicate distinct-session use; raw Pi session identifiers are not stored and No Forgetti sends no telemetry.

After 20 completed distinct project sessions without recall, No Forgetti stages an archive proposal. Recalling the skill withdraws that automatic proposal. Rejecting it snoozes retention for another 20 sessions. Retention never deletes or archives a skill without explicit approval.

## Editing and undo

The interactive browser supports reading and editing active skill Markdown. Edits snapshot a revision, and `/project-skills undo <name>` shows the rendered diff before confirmation.

Skills remain outside the repository throughout their lifecycle. Use checked-in documentation for facts the whole team should review in version control; use project skills for procedural knowledge Pi should invoke on demand.
