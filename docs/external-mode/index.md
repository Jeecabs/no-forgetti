# External mode

External mode gives accepted memory-review work a durable owner outside the Pi process. Use it when a review should continue even if you close Pi immediately after a turn.

It is optional. The default embedded mode is the right choice when process durability is not important.

## What changes

In embedded mode, Pi captures evidence, calls the reviewer, validates the proposal, and admits any safe memory change in process.

In external mode, responsibility splits:

1. **Pi captures.** After a successful settled turn, the extension builds the oldest bounded unreviewed evidence window.
2. **Pi queues.** The sanitized job is durably published to a local spool. Once accepted, the service owns it, not the embedded reviewer.
3. **The worker reviews.** A user-scoped process claims the job, reserves budget, and calls the configured model without coding tools.
4. **The worker checkpoints.** Provider results and the elected proposal are persisted before any project effect.
5. **The project store admits.** The proposal is revalidated and commits only if the captured branch digest still matches current memory.
6. **Pi reports.** An open Pi shows project-local progress and receives the terminal result. Otherwise, the next project session displays the result.

[![External mode durability and authority flow](/external-mode-explainer.svg)](/external-mode-explainer.svg)

[Open the full-size diagram](/external-mode-explainer.svg)

## What does not change

- Foreground `project_memory` writes remain immediate inside Pi.
- Existing project JSON remains canonical.
- A newer foreground write wins over a stale external proposal.
- Project-skill review remains inside Pi.
- No coding tools, shell, project filesystem, or generic network tools are exposed to review evidence.
- Historical Pi sessions are not imported automatically.

## Choose an authority mode

| Mode | Review authority | Durable job spool | External admission |
| --- | --- | --- | --- |
| `embedded` | Pi process | No | No |
| `shadow` | Pi process | Yes, for transport and evaluation inspection | No |
| `external` | Worker service | Yes | Yes, after validation and exact CAS |

`shadow` is not a lighter form of external authority. Pi still reviews and admits memory changes; the mirrored jobs exist for inspection and evaluation.

## Failure boundaries

External mode is designed to survive common local failures:

- Pi can exit after durable enqueue.
- A worker crash releases its lease for later recovery.
- A mid-admission crash rolls the frozen intent forward; it never rolls canonical memory backward.
- A stale proposal fails closed rather than overwriting newer memory.
- A terminal failure retains its evidence for `/memory review retry` until the configured evidence timeout.

It does **not** guarantee provider exactly-once execution. A crash after dispatch can leave an attempt `unknown`; retry may duplicate provider cost. No Forgetti retains conservative budget exposure and prevents duplicate memory effects.

## Before you enable it

You need:

- a persistent No Forgetti installation, not `pi -e`;
- Node.js 22.19 or newer;
- a reviewer provider and exact model ID known to Pi;
- provider credentials available to the worker;
- one writable Pi agent directory on a trustworthy local filesystem; and
- a user service manager such as `launchd` or `systemd --user`.

Do not place the agent directory on NFS, cloud-synced storage, shared multi-host storage, or media with weak flush semantics.

## Set it up

Follow [Set up external mode](./setup.md) first. That guide validates paths, authentication, configuration, and one-off review before you register a long-running process.

Then register the worker for your operating system:

- [macOS with `launchd`](./macos.md)
- [Linux with `systemd --user`](./linux.md)
