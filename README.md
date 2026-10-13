# @sagmans/pi-prefix

A prefix key for [Pi](https://github.com/earendil-works/pi): press
one configurable prefix key, then a second key, to trigger a Pi app action, a
slash command, or an extension event.

- **Zero-keymap by default.** No prefix and no bindings ship with the package.
  Without configuration the extension is completely inert.
- **Your keybindings stay authoritative.** A prefix that collides with an
  active main-editor binding disables pi-prefix and reports the exact
  keybinding ids. pi-prefix never edits `keybindings.json`.
- **No arbitrary code.** Targets are app actions, slash commands, and events.
  There is no executable target.

## Security warning

Pi packages execute with your user privileges. Review this repository before
installing. Report vulnerabilities privately (see SECURITY.md).

## Install

```bash
pi install npm:@sagmans/pi-prefix
```

Unpinned on purpose: pinned specs are skipped by `pi update`, so pinning
hides future upgrades. Then restart Pi (or run `/reload`).

## Ask your agent

Ask your coding agent to configure pi-prefix for you, for example:

> Set up @sagmans/pi-prefix for me: prefix ctrl+\, with m for model picker,
> h for /hotkeys submitted, and a binding for the open event of the extension
> I use.

The package ships a skill that guides agents through the same steps.

## Configuration

Two layers, merged in order **defaults → global → project**:

| Layer | Path | When loaded |
| --- | --- | --- |
| Global | `~/.pi/agent/pi-prefix.json` | always |
| Project | `<project>/.pi/pi-prefix.json` | only when you approved it and Pi trusts the project (see [Project overlays](#project-overlays)) |

`prefix` and `timeoutMs` come from the global layer. A project overlay can
only add command bindings. Activation needs an effective `prefix` and at least
one effective binding. Any parse or validation error in the global layer fails
the whole effective config with the source path and reason.

The prefix is configurable: pick any key that no Pi or terminal binding
already uses. pi-prefix disables itself when the prefix conflicts with a Pi
binding. For example, `ctrl+x` is bound to `app.message.copy` in Pi 1.1.0, so
the examples use `ctrl+\` (written `"ctrl+\\"` in JSON), which is free.

`~/.pi/agent/pi-prefix.json` example:

```json
{
  "$schema": "https://unpkg.com/@sagmans/pi-prefix/schema.json",
  "prefix": "ctrl+\\",
  "timeoutMs": 2000,
  "bindings": {
    "m": { "action": "app.model.select" },
    "h": { "command": "/hotkeys", "submit": true },
    "a": { "command": "/third-party-command", "submit": false },
    "o": { "event": "example-extension:open", "payload": { "source": "pi-prefix" } }
  }
}
```

Project overlay example (`<project>/.pi/pi-prefix.json`):

```json
{
  "bindings": {
    "w": { "command": "/project-command", "submit": true }
  }
}
```

### Project overlays

A project overlay is opt-in per project. pi-prefix loads it only when both
are true:

1. Pi trusts the project.
2. Your global config approves this project path and the exact overlay
   content.

To approve, open Pi in the project and run `/pi-prefix allow-project`. Pi
shows the project path, the overlay's sha256, and its content. If you
confirm, pi-prefix adds an entry to `projectOverlays.allow` in your global
config. Run `/reload` to apply it. If the overlay file changes later,
pi-prefix ignores it and asks you to approve it again. To revoke, remove the
entry from your global config.

```json
{
  "projectOverlays": {
    "allow": [
      { "path": "/home/me/src/app", "sha256": "<64 hex characters>" }
    ]
  }
}
```

An overlay can only add new keys that run commands registered by an
extension (the `extension` source in `/commands`). It cannot set `prefix` or
`timeoutMs`, change or remove (`null`) your global bindings, or bind actions,
events, built-in commands, or plain text. `/share`, `/export`, `/login`,
`/trust`, and `/quit` are always refused. A project key whose command is not
a registered extension command is refused with a warning when pressed.

While an overlay is active, pi-prefix shows a notice at startup and the
status line shows `prefix [project]`.

### Schema reference

All properties are optional at layer level.

- `prefix` — one key id, e.g. `ctrl+\`, `f9`, `alt+shift+p`. See Pi's
  keybinding format (`modifier+key`, modifiers `ctrl`, `shift`, `alt`,
  `super`; aliases `esc`/`return` are normalized to `escape`/`enter`).
- `timeoutMs` — positive integer; prefix mode clears after this idle time.
  Default `2000`.
- `bindings` — map of second key id to exactly one target (`null` is accepted
  in the global layer and has no effect there):
  - `{ "action": "app.model.select" }` — a Pi app action. Unknown or
    context-only actions notify when pressed instead of throwing.
  - `{ "command": "/hotkeys", "submit": true }` — a slash command.
    `submit: true` runs the command immediately; extension commands run
    without touching the editor draft, anything else replaces the draft and
    submits. `submit: false` replaces the draft with the command and stops.
  - `{ "event": "example-extension:open", "payload": {} }` — emits the event
    name and exact JSON payload through `pi.events`. The extension that owns
    the event defines valid names and payloads.

Escape is reserved for canceling prefix mode; a binding on `escape` loads
with a warning and can never dispatch. Enter, tab, and arrows are valid second
keys.

### Command behavior

With `submit: true`, **extension commands** (those listed by `/commands` with
the `extension` source, e.g. a mode toggle installed from another package) are
dispatched directly through Pi's command pipeline and the current editor draft
is preserved untouched. Any other command — built-ins like `/model` or
third-party commands Pi reports without the `extension` source — replaces the
draft and submits it through the editor,
matching manual typing. With `submit: false` the command text replaces the
current draft and sits in the editor until you press Enter, which is the right
form for commands that take an argument.

## Conflicts and /pi-prefix

On startup pi-prefix scans Pi's main-editor bindings. A colliding prefix
disables pi-prefix with an error naming the exact keybinding ids. Existing
bindings are never changed. Fix by choosing another prefix or rebinding the
conflicting action yourself in `~/.pi/agent/keybindings.json`, then `/reload`.

Third-party extension shortcuts cannot be inventoried publicly: Pi reports
those collisions under **[Extension issues]** and resolves them by load order.
That limitation is Pi's, not pi-prefix's.

`/pi-prefix` prints active/inactive state, loaded config paths, trust state,
the project overlay state (`absent`, `untrusted`, `not-allowed`, `changed`,
`rejected`, or `loaded`),
effective prefix, timeout, a binding summary, config errors and warnings, and
any Pi keybinding conflicts.

## Compatibility

Supports Pi hosts `>=0.84.4 <0.88.0 || >=0.99.1 <0.100.0 || >=1.0.0 <2.0.0`.
The existing baseline covers 0.84.4, 0.86.1, 0.87.0, and 0.87.1.
A separate CI job checks Pi 1.1.0 without changing the baseline lockfile.
Other intervening minor versions are not claimed as supported.
Pi 0.99.1 passed combined stash, history, and prefix smoke checks in regular
and fullscreen modes, including `/reload`. Pi 1.1.0 passed a live TUI smoke
check of prefix activation, dispatch, and cancel.

pi-prefix builds only on public extension surface: `CustomEditor` wrapping,
the editor-component factory, native shortcut registration, command
dispatch, and the extension event bus. pi-prefix does not opt into embedded
working-status rendering. Pi controls the fallback status placement.

## What pi-prefix does not do

- No shipped prefix, keymap, or bindings.
- No self-registration protocol for other extensions.
- No arbitrary-code targets and no private Pi APIs.
- No automatic conflict edits; reports only.
- No raw global terminal input interception; activation goes through Pi's
  native shortcut registration.

## Development

The locked baseline retains Pi 0.84.4. A development-only npm override patches
its pinned Undici dependency without changing the host API under test.
Consumers supply Pi's runtime modules. npm does not apply this package's
overrides when it is installed as a dependency.

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run   # package-content gate
```

Before each release, run the live checks in [DOGFOOD.md](DOGFOOD.md).
