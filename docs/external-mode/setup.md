# Set up external mode

Complete these steps in order. The one-off worker run near the end catches path and configuration mistakes before they become a service-manager restart loop.

## 1. Confirm a persistent installation

Use a normal global installation unless you intentionally need a project-local checkout:

```bash
pi install https://github.com/Jeecabs/no-forgetti
pi list
```

A temporary `pi -e` checkout disappears after Pi exits and cannot back a persistent worker.

## 2. Resolve the shared agent directory

Pi and the worker must use the **same** agent directory.

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
printf 'Agent directory: %s\n' "$AGENT_DIR"
mkdir -p "$AGENT_DIR/no-forgetti/logs"
```

Do not use `"$PI_CODING_AGENT_DIR/no-forgetti"` directly: when the variable is unset, that expression points at `/no-forgetti`. Resolve the default first as shown above.

If you use a custom `PI_CODING_AGENT_DIR`, pass its resolved absolute path to every worker command with `--agent-dir`.

## 3. Authenticate the reviewer

The worker uses Pi’s normal model registry and credential store:

- `$AGENT_DIR/auth.json`
- `$AGENT_DIR/models.json`, when present

The most reliable service setup is to run `/login` in Pi and store credentials in `auth.json`. This avoids depending on environment variables that `launchd` or `systemd --user` may not inherit.

```text
/login
```

Then use `/model` to confirm the provider and exact model ID you intend to configure:

```text
/model
```

The reviewer profile is dedicated and stable. It does not silently inherit whichever foreground model happens to be active. It may use the same provider as your foreground session, but its `provider` and `model` values must match Pi’s registered identifiers exactly.

::: warning Environment-only credentials
If you rely on a variable such as `ANTHROPIC_API_KEY`, the worker service must receive that variable itself. Exporting it in an interactive shell does not make it available to `launchd`, and may not make it available to the systemd user manager. Prefer Pi’s `auth.json` unless you already have secure service-environment management.
:::

## 4. Locate stable executables

A Pi Git-package install loads the extension but does not guarantee a `no-forgetti` command on your shell `PATH`. Resolve the worker script explicitly.

For the recommended global HTTPS or Git install:

```bash
NODE_BIN="$(command -v node)"
WORKER_BIN="$(command -v no-forgetti 2>/dev/null || true)"
if [ -z "$WORKER_BIN" ]; then
  WORKER_BIN="$AGENT_DIR/git/github.com/Jeecabs/no-forgetti/bin/no-forgetti.mjs"
fi

printf 'Node: %s\nWorker: %s\n' "$NODE_BIN" "$WORKER_BIN"
test -x "$NODE_BIN"
test -f "$WORKER_BIN"
```

For a project-local Pi install, the checkout is normally beneath the project’s `.pi/git/` directory. For `pi install .`, use the absolute path to that local checkout’s `bin/no-forgetti.mjs`.

Keep both absolute paths. Your OS service definition will use them because service managers do not load interactive shell aliases or version-manager setup.

## 5. Create the reviewer profile

Create `$AGENT_DIR/no-forgetti/service.json`:

```bash
cat > "$AGENT_DIR/no-forgetti/service.json" <<'JSON'
{
  "version": 1,
  "mode": "external",
  "evidenceTtlHours": 24,
  "reviewer": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "reasoningEffort": "high",
    "maxCallsPerDay": 100,
    "maxTokensPerDay": 500000,
    "maxCostPerDayUsd": 10
  }
}
JSON
chmod 600 "$AGENT_DIR/no-forgetti/service.json"
```

Replace the example provider and model with the exact values you confirmed in `/model`. Set budgets intentionally; they are daily UTC limits, not recommendations.

### Configuration fields

| Field | Meaning |
| --- | --- |
| `version` | Must be `1` |
| `mode` | `embedded`, `shadow`, or `external` |
| `evidenceTtlHours` | Retention window for terminal spool, decision, and closed-day accounting records |
| `reviewer.provider` | Exact Pi provider ID |
| `reviewer.model` | Exact registered model ID for that provider |
| `reviewer.reasoningEffort` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `maxCallsPerDay` | Positive integer call limit |
| `maxTokensPerDay` | Positive integer token limit |
| `maxCostPerDayUsd` | Positive numeric cost limit in US dollars |

The schema rejects unknown fields. Credentials do not belong in this file.

Daily calls are reserved atomically before dispatch. Token and cost thresholds use actual provider usage, so one in-flight call can cross a threshold; subsequent calls stop until the next UTC day.

## 6. Reload Pi

No Forgetti reads the authority mode when a project session loads. After creating or changing `service.json`, restart Pi or run:

```text
/reload
```

Then check:

```text
/memory status
```

The monitor should show `external` mode. An offline-worker warning is expected until you start the worker.

## 7. Validate worker startup once

Run the worker in one-off mode with the same absolute paths you will give the service manager:

```bash
"$NODE_BIN" "$WORKER_BIN" review \
  --once \
  --agent-dir "$AGENT_DIR" \
  --worker-id setup-check
```

A successful empty run ends with a JSON `drained` event and exit code 0. This validates the script path, agent directory, service configuration, spool initialization, and local ledger startup.

An empty run does **not** call the provider. To test the complete path:

1. Complete at least one normal user turn in Pi.
2. Run `/memory review`.
3. Wait for that turn to settle and check `/memory status` for queued work.
4. Run the one-off command again.
5. Reopen `/memory status` and inspect the resulting completed, retry, or dead-letter state.

A valid review can make no memory change. A `noop` result is successful.

## 8. Register the long-running worker

Once the one-off run succeeds, continue with:

- [Run on macOS](./macos.md)
- [Run on Linux](./linux.md)

Register exactly one normal worker unless you are deliberately testing contention behavior. Use a stable `--worker-id` for each registered process.

After the worker starts, run the machine check:

```bash
"$NODE_BIN" "$WORKER_BIN" doctor --agent-dir "$AGENT_DIR" --projects-root /path/to/projects
```

The command exits with status 1 until each live Pi process reloads the installed release.
