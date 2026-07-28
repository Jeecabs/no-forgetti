# External review service management

External-mode documentation is now split by task so setup prerequisites are not hidden inside OS service definitions.

## Start here

1. Read [How external mode works](./external-mode/index.md).
2. Complete [Set up external mode](./external-mode/setup.md), including the one-off worker check.
3. Register the worker for [macOS](./external-mode/macos.md) or [Linux](./external-mode/linux.md).
4. Use [Operations and troubleshooting](./external-mode/operations.md) for upgrades, status, failures, and disabling the service.

The old one-page service guide mixed configuration, executable discovery, authentication, and service registration. These pages preserve the same `launchd` and `systemd --user` workflows while making the required order explicit.
