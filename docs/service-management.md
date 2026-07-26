# External review service management

The extension queues review work automatically after eligible settled turns. In `external` mode, register one user-scoped worker so queued work drains without a manual Pi command.

## macOS (`launchd`)

Resolve absolute executable paths first:

```bash
command -v no-forgetti
command -v node
mkdir -p "$PI_CODING_AGENT_DIR/no-forgetti/logs" ~/Library/LaunchAgents
```

Create `~/Library/LaunchAgents/com.jeecabs.no-forgetti-review.plist`. Replace the executable and agent-directory placeholders with absolute paths; `launchd` does not load your interactive shell setup.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jeecabs.no-forgetti-review</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
    <string>/absolute/path/to/no-forgetti</string>
    <string>review</string>
    <string>--agent-dir</string>
    <string>/absolute/path/to/.pi/agent</string>
    <string>--worker-id</string>
    <string>launchd</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/absolute/path/to/.pi/agent/no-forgetti/logs/review.stdout.log</string>
  <key>StandardErrorPath</key><string>/absolute/path/to/.pi/agent/no-forgetti/logs/review.stderr.log</string>
</dict>
</plist>
```

Validate and register it once:

```bash
plutil -lint ~/Library/LaunchAgents/com.jeecabs.no-forgetti-review.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.jeecabs.no-forgetti-review.plist
launchctl enable "gui/$(id -u)/com.jeecabs.no-forgetti-review"
launchctl kickstart -k "gui/$(id -u)/com.jeecabs.no-forgetti-review"
```

After registration, macOS starts and restarts the worker automatically. Unregister it with:

```bash
launchctl bootout "gui/$(id -u)/com.jeecabs.no-forgetti-review"
```

## Linux (`systemd --user`)

Create `~/.config/systemd/user/no-forgetti-review.service` with absolute paths:

```ini
[Unit]
Description=No Forgetti external review worker

[Service]
Type=simple
ExecStart=/absolute/path/to/node /absolute/path/to/no-forgetti review --agent-dir /absolute/path/to/.pi/agent --worker-id systemd
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Enable it once:

```bash
systemctl --user daemon-reload
systemctl --user enable --now no-forgetti-review.service
```

## Observe it from Pi

Run:

```text
/memory status
```

The TUI monitor shows worker heartbeat, queue depth, completed/dead-letter counts, configured reviewer, daily calls/tokens/cost, and visible exhaustion/offline warnings. No manual review command is required after the user service is registered.
