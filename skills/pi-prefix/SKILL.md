---
name: pi-prefix
description: Configure or troubleshoot @sagmans/pi-prefix (Pi prefix-key package). Use when the user asks to set up, change, or fix pi-prefix prefix keys, bindings, conflicts, or config layers.
---

# pi-prefix configuration

Configure @sagmans/pi-prefix. Two layers: global `~/.pi/agent/pi-prefix.json`
and project `<project>/.pi/pi-prefix.json`. Put user-wide behavior in the
global layer. A project layer can only add new keys bound to registered
extension commands, and loads only after the user runs
`/pi-prefix allow-project` in that project and confirms. Never write
`projectOverlays` approvals for the user; approval is their own decision.

## Before editing

1. Read both existing config layers if present.
2. Read Pi's `~/.pi/agent/keybindings.json` for active bindings.
3. Ask the user for the prefix and each target's intent when missing. Never
   invent third-party event names, payloads, or command names; ask for the
   exact values or check the target extension's documentation with the user.

## Target selection order

Prefer a built-in app action, then a slash command, then a documented
extension event.

## Writing the config

- Bindings take exactly one of `action`, `command` (+ required `submit`),
  or `event` (+ optional `payload`).
- `submit: true` runs the command immediately — commands whose `/commands`
  source is `extension` dispatch directly and keep the editor draft intact,
  anything else replaces the draft; `submit: false` types it for
  argument-taking commands.
- Commands must start with `/`. Timeouts must be positive integers.
- Validate the JSON against schema.json before saving.

## Conflicts

If the prefix collides with an active main-editor binding, pi-prefix reports
the exact keybinding ids and stays disabled. Never silently unbind or reassign
a conflict. Report it and ask the user which existing binding should move.

## After editing

Tell the user to run `/reload`, then `/pi-prefix` to verify the effective
prefix, timeout, bindings, and warnings.
