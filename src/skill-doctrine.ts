// The subset of `writing-great-skills` that bears on authoring a No Forgetti
// project skill: one self-contained SKILL.md, retrieval-injected, never a Pi
// slash command. The invocation axis (model- vs user-invoked, router skills,
// context/cognitive load, disclosure into sibling files) is deliberately
// omitted — none of it applies to a single injected file, and including it
// would be the sediment the doctrine warns against. Single source of truth for
// the principles; skill-review.ts owns the request mechanics.
export const SKILL_DOCTRINE = `A skill wrangles determinism out of a stochastic agent. Predictability — the agent taking the SAME process every run, not producing the same output — is the root virtue; every rule below serves it.

LEADING WORD. Anchor the process on a leading word: a compact concept the model already holds from pretraining (lesson, tracer bullets, fog of war, red/green, dry run). Repeated as a token — in the title, the steps, and the description — it accumulates a distributed meaning and pulls the agent toward the same behaviour every time it appears. A made-up word recruits no priors, so reach for an existing one first. A leading word too weak to change behaviour is a no-op; fix it with a stronger word (relentless over thorough), not a longer sentence.

STEPS AND COMPLETION CRITERIA. Steps are the ordered actions, the primary content. Every step ends on a completion criterion — the condition the agent judges "done" against — with two edges. Clarity: can the agent tell done from not-done? A vague bound ("understanding reached") lets it declare victory and drift to the next step (premature completion); a checkable bound ("the test exits 0") holds it. Demand: how much the criterion asks for sets the legwork the agent does behind the scenes — "every modified model accounted for" forces real digging where "produce a list" does not. The strongest criteria are both checkable and exhaustive.

REFERENCE. Facts, commands, parameters, and conditionals the steps consult. Co-locate a concept's definition, rules, and caveats under one heading, so reading one part brings its neighbours. A skill can be all steps, all reference, or both.

PRUNE TO A SINGLE SOURCE OF TRUTH — each meaning in exactly one place, so changing behaviour is a one-place edit. Hunt these failure modes line by line:
- Duplication: the same meaning in two places. Costs maintenance and tokens, and inflates the meaning past its real weight. (The accidental inverse of a leading word, which repeats a token, never a meaning.)
- Sediment: stale layers that settle because adding feels safe and removing feels risky. Core them out.
- Sprawl: simply too long, even when every line is live. Cut it, or fold an occasional case into one conditional line rather than a second procedure.
- No-op: a line the model already obeys by default — tokens spent to say nothing. Test each line: does it change behaviour versus the default? If not, delete it.

PROMPT THE POSITIVE. "Don't think of an elephant" names the elephant and makes it MORE available. Steer by stating the target behaviour ("write one-line comments"), so the banned one is never spoken. Keep a prohibition only as a hard guardrail you cannot phrase positively (secrets, destructive actions), and even then pair it with what to do instead.`;
