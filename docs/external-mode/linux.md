# Run the worker on Linux

Use a user-scoped systemd service after the [one-off setup check](./setup.md) succeeds.

## Capture absolute paths

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
NODE_BIN="$(command -v node)"
WORKER_BIN="$(command -v no-forgetti 2>/dev/null || true)"
if [ -z "$WORKER_BIN" ]; then
  WORKER_BIN="$AGENT_DIR/git/github.com/Jeecabs/no-forgetti/bin/no-forgetti.mjs"
fi

printf 'NODE_BIN=%s\nWORKER_BIN=%s\nAGENT_DIR=%s\n' \
  "$NODE_BIN" "$WORKER_BIN" "$AGENT_DIR"
mkdir -p "$HOME/.config/systemd/user"
```

Use the printed absolute values in the unit. systemd does not evaluate shell variables in `ExecStart` and should not depend on an interactive Node version-manager setup.

## Create the user unit

Create `~/.config/systemd/user/no-forgetti-review.service`:

```ini
[Unit]
Description=No Forgetti external review worker
Documentation=https://jeecabs.github.io/no-forgetti/external-mode/

[Service]
Type=simple
ExecStart=/absolute/path/to/node /absolute/path/to/no-forgetti/bin/no-forgetti.mjs review --agent-dir /absolute/path/to/.pi/agent --worker-id systemd
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Replace each placeholder. If a path contains spaces, quote that complete argument according to systemd’s command-line syntax.

## Enable and start

```bash
systemctl --user daemon-reload
systemctl --user enable --now no-forgetti-review.service
```

The service starts with your user manager, normally when you log in. If it must continue after logout, ask your system administrator whether user lingering is appropriate for this machine:

```bash
loginctl enable-linger "$USER"
```

Lingering is optional and changes user-session behavior beyond No Forgetti.

## Verify

```bash
systemctl --user status no-forgetti-review.service
journalctl --user -u no-forgetti-review.service -n 50 --no-pager
```

Inside Pi, run:

```text
/memory status
```

The worker heartbeat should become healthy. Queue depth should fall as eligible jobs complete.

## Restart after updates

Restart the worker after updating No Forgetti or changing the reviewer profile:

```bash
systemctl --user restart no-forgetti-review.service
```

If an update moved the Node executable or package checkout, edit the unit and run:

```bash
systemctl --user daemon-reload
systemctl --user restart no-forgetti-review.service
```

## Stop or disable

Stop it temporarily:

```bash
systemctl --user stop no-forgetti-review.service
```

Disable future starts and stop it now:

```bash
systemctl --user disable --now no-forgetti-review.service
```

This does not delete queued work, configuration, budgets, or review evidence. See [Disable external mode](./operations.md#disable-external-mode) for the complete sequence.

## Authentication note

Credentials stored through Pi’s `/login` are read from the configured agent directory’s `auth.json`. Environment-only credentials must be available to the systemd user service itself; an export in a later terminal does not reliably update the user manager’s environment. Prefer `auth.json` or an appropriately permissioned environment file managed according to your system policy.
