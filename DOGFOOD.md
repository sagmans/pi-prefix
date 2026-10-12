# Live dogfooding matrix

Run this matrix in a real Pi TUI before each release. Record the result of
each row. Do not mark a row `pass` without evidence from a live session.

Status format: `pass` / `fail` / `not yet run`, with pi-prefix version, Pi
version, and date. Evidence file names refer to the run directory (see Setup).

## Setup

Use a disposable environment. Do not use your real `~/.pi/agent`.

| Item | Value |
| --- | --- |
| Run directory | `$RUN` (for example `/tmp/dogfood-pi-prefix`) |
| Isolated home | `HOME=$RUN/home`; Pi reads `$RUN/home/.pi/agent` |
| Project | `$RUN/proj` (trust it when Pi asks) |
| Node | 24.x (last run: 24.21.0). `package.json` requires `>=22.19.0` |
| Pi | local install: `cd $RUN && npm install @earendil-works/pi-coding-agent@<version>` |
| Driver | `tmux` session, 160x50; send keys with `tmux send-keys`, capture with `tmux capture-pane -p` |
| Model | not required; only S8 sends a prompt to a model |

Start script (`$RUN/start.sh`):

```bash
#!/bin/bash
cd "$RUN/proj"
export HOME="$RUN/home" PATH="$RUN/node_modules/.bin:$PATH"
exec pi
```

Install the package under test:

- npm: `HOME=$RUN/home pi install npm:@sagmans/pi-prefix`
- local path: `HOME=$RUN/home pi install <path-to-checkout>`

Probe extension (`$RUN/home/.pi/agent/extensions/probe.ts`). It proves that
commands and events arrive:

```ts
import { appendFileSync } from "node:fs";
const LOG = `${process.env.HOME}/probe.log`;
export default function (pi: any) {
  pi.registerCommand("probe-mark", {
    description: "dogfood probe",
    handler: async (args: string, ctx: any) => {
      appendFileSync(LOG, `command probe-mark args=${JSON.stringify(args)} ${new Date().toISOString()}\n`);
      ctx.ui.notify("PROBE COMMAND RAN", "info");
    },
  });
  pi.events.on("dogfood:open", (payload: unknown) => {
    appendFileSync(LOG, `event dogfood:open payload=${JSON.stringify(payload)} ${new Date().toISOString()}\n`);
  });
}
```

Global config (`$RUN/home/.pi/agent/pi-prefix.json`):

```json
{
  "prefix": "ctrl+\\",
  "timeoutMs": 2000,
  "bindings": {
    "m": { "action": "app.model.select" },
    "h": { "command": "/hotkeys", "submit": true },
    "p": { "command": "/probe-mark", "submit": true },
    "a": { "command": "/probe-mark typed", "submit": false },
    "o": { "event": "dogfood:open", "payload": { "source": "pi-prefix" } }
  }
}
```

Project overlay (`$RUN/proj/.pi/pi-prefix.json`), used from row C3:

```json
{
  "bindings": {
    "o": null,
    "w": { "command": "/probe-mark overlay", "submit": true }
  }
}
```

In tmux, send the prefix as `C-\` and Escape as `Escape`.

## Matrix

Last run: 0.1.5 on Pi 1.1.0, 2026-10-13 (`v=0.1.5, Pi 1.1.0, 2026-10-13`).

### Install and load

| ID | Scenario | Steps | Expected | Last verified |
| --- | --- | --- | --- | --- |
| I1 | npm install | `pi install npm:@sagmans/pi-prefix`, `pi list` | exit 0; package listed; no peer warning | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`01-install`) |
| I2 | Registry signature | `npm audit signatures` in `home/.pi/agent/npm` | 1 verified signature; version 0.1.5 | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`02-version-signatures`) |
| I3 | Local path install | `pi install <checkout>` | package loads; same behavior as I1 | not yet run |
| I4 | Startup | start Pi | `[Extensions]` lists `@sagmans/pi-prefix`; `[Skills]` lists `pi-prefix`; no error | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`03-startup`) |
| I5 | Shortcut listed | `/hotkeys` | `Extensions` table shows prefix key with "Activate the pi-prefix prefix key" | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`11-command-hotkeys`) |

### Config sources

| ID | Scenario | Steps | Expected | Last verified |
| --- | --- | --- | --- | --- |
| C1 | No config | remove both config files, start, `/pi-prefix` | `pi-prefix: inactive`; prefix key does nothing | not yet run |
| C2 | Global only | global config, no overlay, `/pi-prefix` | `active`; all 5 bindings; project path without `(loaded)` | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`04-status`) |
| C3 | Project overlay after `/reload` | add overlay, `/reload`, `/pi-prefix` | project path `(loaded)`; `o` gone; `w` added | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`13-reload-overlay-status`) |
| C4 | Overlay binding dispatch | prefix, `w` | probe log `args="overlay"` | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`14-overlay-dispatch`, `probe.log`) |
| C5 | `null` removal | prefix, `o` with overlay | no event; `o` goes to the editor as text | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`14-overlay-dispatch`) |
| C6 | Untrusted project | decline trust, `/pi-prefix` | `project trusted: no`; overlay not loaded | not yet run |
| C7 | Overlay overrides scalars | overlay sets `prefix` or `timeoutMs` | overlay value shown in `/pi-prefix` | not yet run |
| C8 | Invalid JSON | broken global file, start | error notice with path and `invalid JSON`; inactive | not yet run |
| C9 | Invalid prefix key | `"prefix": "notakey"` | error `is not a valid key id`; inactive | not yet run |
| C10 | Invalid `timeoutMs` | `"timeoutMs": 0` | error `timeoutMs must be a positive integer`; inactive | not yet run |
| C11 | Invalid target | binding with two kinds, unknown property, command without `/`, payload on non-event | matching error; whole config inactive | not yet run |
| C12 | Prefix without bindings | `prefix` only | inactive; no error | not yet run |

### Prefix key choice

| ID | Scenario | Steps | Expected | Last verified |
| --- | --- | --- | --- | --- |
| K1 | Free key `ctrl+\` | start, prefix | status line `prefix ctrl+\` | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`05-prefix-statusline`, `16-restored-ctrl-backslash`) |
| K2 | Conflict `ctrl+x` | set prefix `ctrl+x`, `/reload` | error `prefix ctrl+x conflicts with app.message.copy`; no keybinding changed | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`15a-ctrlx-reload`) |
| K3 | Conflict status | `/pi-prefix` in K2 state | `disabled (conflicts)`; `conflict: ctrl+x is bound to app.message.copy` | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`15b-ctrlx-status`) |
| K4 | Conflict key press | press `ctrl+x`, then `p` | Pi copy action runs; `p` typed; no dispatch | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`15c-ctrlx-pressed`) |
| K5 | Restore free key | set `ctrl+\`, `/reload` | active again | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`16-restored-ctrl-backslash`) |
| K6 | Terminal-reserved key | prefix `ctrl+s`, `ctrl+q`, `ctrl+z`, or `ctrl+c` | pi-prefix reports conflict, or the terminal takes the key; record which | not yet run |
| K7 | Keys that need terminal setup | `alt+x` (macOS Option-as-Meta), `f9` (macOS fn) | prefix works only with terminal setup | not yet run |
| K8 | Third-party shortcut collision | second extension registers the same key | Pi lists it under `[Extension issues]` | not yet run |

### Binding kinds

| ID | Scenario | Steps | Expected | Last verified |
| --- | --- | --- | --- | --- |
| B1 | Extension command, `submit: true`, with draft | type `draft text kept`, prefix, `p` | `PROBE COMMAND RAN`; draft kept | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`07-command-submit`, `probe.log`) |
| B2 | Built-in command, `submit: true` | prefix, `h` | `/hotkeys` output shown | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`11-command-hotkeys`) |
| B3 | Built-in command replaces draft | type draft, prefix, `h` | draft replaced by `/hotkeys` and submitted | not yet run |
| B4 | Insert-only, `submit: false` | prefix, `a` | editor shows `/probe-mark typed`; no run | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`09-insert-only`) |
| B5 | Event with payload | prefix, `o` | probe log `payload={"source":"pi-prefix"}` | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`08-event`, `probe.log`) |
| B6 | Built-in action | prefix, `m` | model picker opens | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`10-action-model-select`) |
| B7 | Special actions | bind `app.interrupt`, `app.exit`, `app.clipboard.pasteImage` | same effect as the native key | not yet run |
| B8 | Unknown action | bind `app.does.not.exist` | warning `action "..." is unavailable`; no crash | not yet run |
| B9 | Second key enter, tab, arrow | bind `enter`, `tab`, `up` | each dispatches | not yet run |
| B10 | `escape` binding | bind `escape` | load warning `can never dispatch`; Escape cancels | not yet run |

### States

| ID | Scenario | Steps | Expected | Last verified |
| --- | --- | --- | --- | --- |
| S1 | Empty editor | prefix, `p` with empty editor | dispatch; editor stays empty | not yet run |
| S2 | Draft text | see B1 | draft kept | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`07-command-submit`) |
| S3 | Escape cancel | type draft, prefix, `Escape` | status line clears; draft kept; Pi interrupt not triggered | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`06-escape-cancel`) |
| S4 | Timeout | prefix, wait more than `timeoutMs` | status line clears | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`12a-timeout-armed`, `12b-timeout-after`) |
| S5 | Key after timeout | S4, then `q` | `q` typed; no dispatch | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`12c-key-after-timeout`) |
| S6 | Unknown second key | prefix, unbound key `z` | prefix clears; `z` goes to the editor | partial: unbound `o` after C5 went to the editor (`14-overlay-dispatch`); `z` with draft not yet run |
| S7 | After `/reload` | `/reload`, prefix, `p` | dispatch works; one shortcut only | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`13`, `14`) |
| S8 | Busy agent turn | send prompt, prefix and `p` while agent runs | command runs or queues as Pi does for typed commands; no crash | not yet run (needs a model) |
| S9 | Prefix twice | prefix, prefix | prefix mode stays active; timer restarts | not yet run |
| S10 | Session switch | `/new` or `/resume`, prefix, `p` | dispatch works in new session; status line clean | not yet run |

### Pi versions and modes

| ID | Scenario | Steps | Expected | Last verified |
| --- | --- | --- | --- | --- |
| V1 | Pi 1.1.0, normal mode | all rows above | as listed | see rows |
| V2 | Locked baseline Pi 0.84.4, live | install Pi 0.84.4; run core rows I4, C2, K1, B1, B4-B6, S3, S4 | same results | not yet run (CI tests only) |
| V3 | Pi 0.99.1 | core rows | same results | not yet run for 0.1.5 |
| V4 | Fullscreen mode | enable fullscreen; core rows | same results; status line visible | not yet run for 0.1.5 |

## Summary of last run

| Result | Rows |
| --- | --- |
| pass | 23 |
| partial | 1 |
| fail | 0 |
| not yet run | 24 |
| aggregate (V1) | 1 |
