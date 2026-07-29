# Operate and troubleshoot external mode

Use `/memory status` as the primary operational view. Service-manager status and logs explain process failures; the Pi monitor explains No Forgetti state.

## Read the status view

```text
/memory status
```

The monitor reports:

- configured authority mode and reviewer
- worker heartbeat and compatibility
- queued, running, completed, and dead-letter counts
- daily calls, tokens, and cost
- budget exhaustion and offline warnings
- active project branch and memory capacity
- current-project review phase, attempt, and job ID

An external worker publishes a heartbeat every 10 seconds. A newly started worker may take one monitor tick to appear.

## Normal job lifecycle

A healthy job usually moves through:

```text
queued → reviewing → applying → completed
```

A transient failure returns the job for a bounded retry. The project widget shows this retry without adding transcript entries.

A completed provider call can produce these admission results:

- `applied`: The store committed one or more validated memory operations.
- `noop`: The reviewer made no durable change.
- `stale`: Current memory did not match the captured digest.
- `rejected`: Validation or admission refused the proposal.

A terminal worker failure moves the job to dead-letter. Pi writes a durable failure card with `/memory review retry`. This command uses retained evidence and current memory to create a new job generation.

A no-op, a stale result, and a safe rejection are not worker crashes. A stale result lets a foreground write win over delayed review.

## Updates and configuration changes

After updating No Forgetti:

1. Stop the external worker.
2. Install one pinned global No Forgetti release.
3. Start the external worker.
4. Run `/reload` in each live Pi process.
5. Run the doctor command.

```bash
"$NODE_BIN" "$WORKER_BIN" doctor --agent-dir "$AGENT_DIR" --projects-root /path/to/projects
```

The doctor fails if a live Pi process or worker uses another release. It also fails if a scanned project has a local No Forgetti override.

The heartbeat carries the worker’s memory-policy version and capacity. When `/memory status` shows `restart required`, new evidence remains unqueued and its cursor does not advance. Already queued candidates remain durable until a compatible worker starts.

Changing `reviewer.provider`, `reviewer.model`, `reasoningEffort`, budgets, or authority mode also requires a worker restart. Reload Pi after any mode change because the extension reads authority when the project session loads.

`evidenceTtlHours` is re-read during worker maintenance, but restarting after configuration edits is still the simplest operational rule.

## Common failures

### `no-forgetti: command not found`

Pi package installation does not guarantee that package binaries appear on your shell `PATH`. Run the worker script through Node:

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
node "$AGENT_DIR/git/github.com/Jeecabs/no-forgetti/bin/no-forgetti.mjs" \
  review --once --agent-dir "$AGENT_DIR"
```

Adjust the script path for project-local or local-path installs.

### Service config rejected

Check that:

- the file is `$AGENT_DIR/no-forgetti/service.json`;
- `version` is `1`;
- `mode` is one of `embedded`, `shadow`, or `external`;
- external mode includes a reviewer;
- budget numbers are positive and within documented limits; and
- no unknown fields are present.

Run the [one-off startup check](./setup.md) to get the parser error directly.

### Reviewer configuration required

The worker can start only when `service.json` includes a reviewer profile. `external` mode requires one by schema. A reviewer may also be present in `shadow` or `embedded` configuration for controlled worker inspection, but only external mode enables project admission.

### Model not found

`reviewer.provider` and `reviewer.model` must identify a model registered in Pi’s persistent model runtime. Open Pi, run `/model`, and copy the exact provider and model IDs. If the model comes from custom configuration, confirm it exists in the same agent directory’s `models.json`.

### Authentication unavailable

Run `/login` in Pi for the configured provider and ensure Pi and the worker use the same agent directory. If credentials exist only in environment variables, confirm the service manager actually supplies them to the worker.

### Worker is offline

Check the process first:

```bash
# macOS
launchctl print "gui/$(id -u)/com.jeecabs.no-forgetti-review"

# Linux
systemctl --user status no-forgetti-review.service
```

Then inspect logs:

```bash
# macOS
tail -n 50 "$AGENT_DIR/no-forgetti/logs/review.stderr.log"

# Linux
journalctl --user -u no-forgetti-review.service -n 50 --no-pager
```

Common causes are stale absolute paths after a Node upgrade, a moved project-local checkout, invalid JSON, and environment-only credentials.

### Queue does not drain

Check, in order:

1. worker heartbeat is fresh and compatible;
2. mode is `external` in both `service.json` and `/memory status`;
3. daily call, token, and cost budgets are not exhausted;
4. the configured model and credentials are available;
5. worker logs do not show repeated retryable provider failures; and
6. the job has not moved to dead-letter.

Do not start several duplicate workers to “unstick” a queue. One healthy worker is sufficient.

### A review finished but memory did not change

The outcome may be a no-op, stale, rejected, or a valid partial no-op. External UI feedback uses the actual post-validation content diff. Pi does not show an applied-change card when there is no applied diff.

If Pi shows a durable failure card, run:

```text
/memory review retry
```

Use `/memory review retry <job-id>` when more than one failed review is present. Retained evidence expires with `evidenceTtlHours`.

## Disable external mode

To return safely to embedded review:

1. Let the queue drain while the worker is still running, if you want accepted jobs completed.
2. Stop and unregister or disable the OS service.
3. Change `mode` to `embedded`, or remove `service.json` to use the default.
4. Restart Pi or run `/reload`.
5. Confirm `embedded` mode in `/memory status`.

Queued external jobs are not reassigned to the embedded reviewer. Switching modes before they drain leaves them in durable storage until an external worker processes them or you deliberately remove that state.

## Remove retained external-review state

Review evidence and operational checkpoints are sensitive even though jobs exclude resolved credentials. To forget them, stop **every** worker first, then review the deletion guidance in [SECURITY.md](https://github.com/Jeecabs/no-forgetti/blob/main/SECURITY.md).

At minimum, external state can include:

- `review-spool/`
- `review-budget.json*`
- `review-ledger.sqlite*`
- `runtimes/`
- per-project `service/` records
- active review-admission intents

Deleting unresolved attempts, decisions, budget records, or admission state abandons recovery and accounting guarantees. Do not remove these files while a worker is running.
