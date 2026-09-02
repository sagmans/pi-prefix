# @sagmans/pi-prefix

A prefix key for [Pi](https://github.com/earendil-works/pi-coding-agent): press
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

After publication:

```bash
pi install npm:@sagmans/pi-prefix@0.1.0
```

Then restart Pi (or run `/reload`).

## Ask your agent

Ask your coding agent to configure pi-prefix for you, for example:

> Set up @sagmans/pi-prefix for me: prefix ctrl+x, with m for model picker,
> h for /hotkeys submitted, and a binding for the open event of the extension
> I use.

The package ships a skill that guides agents through the same steps.

## Configuration

Two layers, merged in order **defaults → global → project**:

| Layer | Path | When loaded |
| --- | --- | --- |
| Global | `~/.pi/agent/pi-prefix.json` | always |
| Project | `<project>/.pi/pi-prefix.json` | only when the project is trusted |

Project scalar values (`prefix`, `timeoutMs`) replace global values. Project
bindings add or replace global bindings by normalized key; `null` removes an
inherited binding. Activation needs an effective `prefix` and at least one
effective binding. Any parse or validation error fails the whole effective
config with the source path and reason.

`~/.pi/agent/pi-prefix.json` example:

```json
{
  "$schema": "https://unpkg.com/@sagmans/pi-prefix/schema.json",
  "prefix": "ctrl+x",
  "timeoutMs": 2000,
  "bindings": {
    "m": { "action": "app.model.select" },
    "h": { "command": "/hotkeys", "submit": true },
    "a": { "command": "/third-party-command", "submit": false },
    "o": { "event": "example-extension:open", "payload": { "source": "pi-prefix" } }
  }
}
```

Trusted project overlay example (`<project>/.pi/pi-prefix.json`):

```json
{
  "bindings": {
    "o": null,
    "w": { "command": "/project-command", "submit": true }
  }
}
```

### Schema reference

All properties are optional at layer level.

- `prefix` — one key id, e.g. `ctrl+x`, `f9`, `alt+shift+p`. See Pi's
  keybinding format (`modifier+key`, modifiers `ctrl`, `shift`, `alt`,
  `super`; aliases `esc`/`return` are normalized to `escape`/`enter`).
- `timeoutMs` — positive integer; prefix mode clears after this idle time.
  Default `2000`.
- `bindings` — map of second key id to exactly one target, or `null` to
  remove an inherited binding:
  - `{ "action": "app.model.select" }` — a Pi app action. Unknown or
    context-only actions notify when pressed instead of throwing.
  - `{ "command": "/hotkeys", "submit": true }` — a slash command.
    `submit: true` replaces the draft and submits immediately.
    `submit: false` types the command and stops.
  - `{ "event": "example-extension:open", "payload": {} }` — emits the event
    name and exact JSON payload through `pi.events`. The extension that owns
    the event defines valid names and payloads.

Escape is reserved for canceling prefix mode; a binding on `escape` loads
with a warning and can never dispatch. Enter, tab, and arrows are valid second
keys.

### Command behavior

A `command` target **replaces the current editor draft**. Anything typed
before pressing the prefix is discarded. With `submit: true` the command runs
immediately (submission still respects Pi's disabled-submission state); with
`submit: false` the command text sits in the editor until you press Enter,
which is the right form for commands that take an argument.

## Conflicts and /pi-prefix

On startup pi-prefix scans Pi's main-editor bindings. A colliding prefix
disables pi-prefix with an error naming the exact keybinding ids. Existing
bindings are never changed. Fix by choosing another prefix or rebinding the
conflicting action yourself in `~/.pi/agent/keybindings.json`, then `/reload`.

Third-party extension shortcuts cannot be inventoried publicly: Pi reports
those collisions under **[Extension issues]** and resolves them by load order.
That limitation is Pi's, not pi-prefix's.

`/pi-prefix` prints active/inactive state, loaded config paths, trust state,
effective prefix, timeout, a binding summary, config errors and warnings, and
any Pi keybinding conflicts.

## What pi-prefix does not do

- No shipped prefix, keymap, or bindings.
- No self-registration protocol for other extensions.
- No arbitrary-code targets and no private Pi APIs.
- No automatic conflict edits; reports only.
- No raw global terminal input interception; activation goes through Pi's
  native shortcut registration.

## Development

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run   # package-content gate
```
