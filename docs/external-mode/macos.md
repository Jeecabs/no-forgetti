# Run the worker on macOS

Use a user-scoped `launchd` agent after the [one-off setup check](./setup.md) succeeds.

## Capture absolute paths

In an interactive shell, print the three paths the agent needs:

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
NODE_BIN="$(command -v node)"
WORKER_BIN="$(command -v no-forgetti 2>/dev/null || true)"
if [ -z "$WORKER_BIN" ]; then
  WORKER_BIN="$AGENT_DIR/git/github.com/Jeecabs/no-forgetti/bin/no-forgetti.mjs"
fi

printf 'NODE_BIN=%s\nWORKER_BIN=%s\nAGENT_DIR=%s\n' \
  "$NODE_BIN" "$WORKER_BIN" "$AGENT_DIR"
mkdir -p "$AGENT_DIR/no-forgetti/logs" "$HOME/Library/LaunchAgents"
```

Use the printed absolute values below. `launchd` does not load shell startup files, aliases, or Node version-manager initialization.

## Create the LaunchAgent

Create `~/Library/LaunchAgents/com.jeecabs.no-forgetti-review.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.jeecabs.no-forgetti-review</string>

  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
    <string>/absolute/path/to/no-forgetti/bin/no-forgetti.mjs</string>
    <string>review</string>
    <string>--agent-dir</string>
    <string>/absolute/path/to/.pi/agent</string>
    <string>--worker-id</string>
    <string>launchd</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>/absolute/path/to/.pi/agent/no-forgetti/logs/review.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/absolute/path/to/.pi/agent/no-forgetti/logs/review.stderr.log</string>
</dict>
</plist>
```

Replace every placeholder, including the three log paths. Do not use `~` or shell variables in the plist.

## Validate and register

```bash
plutil -lint "$HOME/Library/LaunchAgents/com.jeecabs.no-forgetti-review.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.jeecabs.no-forgetti-review.plist"
launchctl enable "gui/$(id -u)/com.jeecabs.no-forgetti-review"
launchctl kickstart -k "gui/$(id -u)/com.jeecabs.no-forgetti-review"
```

`bootstrap` reports an error if the same agent is already loaded. In that case, inspect it first or run the bootout command below before bootstrapping the edited plist again.

## Verify

```bash
launchctl print "gui/$(id -u)/com.jeecabs.no-forgetti-review"
tail -n 50 "$AGENT_DIR/no-forgetti/logs/review.stderr.log"
```

Inside Pi, run:

```text
/memory status
```

The worker heartbeat should become healthy. Queue depth should fall as eligible jobs complete.

## Restart after updates

No Forgetti’s worker loads its model profile and memory-policy version at process startup. Restart it after updating the package or changing the reviewer profile:

```bash
launchctl kickstart -k "gui/$(id -u)/com.jeecabs.no-forgetti-review"
```

If a Node version manager moved the Node executable, or the package checkout path changed, update the plist, boot it out, and bootstrap it again.

## Stop or unregister

Stop and unregister the agent:

```bash
launchctl bootout "gui/$(id -u)/com.jeecabs.no-forgetti-review"
```

This does not delete queued work, configuration, budgets, or review evidence. See [Disable external mode](./operations.md#disable-external-mode) for the complete sequence.

## Authentication note

Credentials stored through Pi’s `/login` are read from the configured agent directory’s `auth.json`. If you instead depend on shell environment variables, this agent will not see them unless you explicitly configure a launchd environment. Avoid placing literal credentials in a world-readable plist; prefer `auth.json` or your existing secure credential mechanism.
