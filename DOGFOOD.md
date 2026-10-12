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
| Model | not required; only S8, B7 and V4 send a prompt. Use a local mock OpenAI-compatible endpoint in `models.json` that streams slowly, then start Pi with `--model mock/slow`. No credentials or paid model needed |

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

Mock model for rows that need a running turn (`$RUN/mock/slow_openai.py`,
started with `python3 $RUN/mock/slow_openai.py &`). It streams one token a
second for 12 seconds, so the agent stays busy long enough to press keys:

```python
import json, time, http.server

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for i in range(12):
            chunk = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": "slow",
                     "choices": [{"index": 0, "delta": {"content": f"tick{i} "}, "finish_reason": None}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode()); self.wfile.flush(); time.sleep(1)
        done = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": "slow",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
        self.wfile.write(f"data: {json.dumps(done)}\n\ndata: [DONE]\n\n".encode()); self.wfile.flush()

http.server.ThreadingHTTPServer(("127.0.0.1", 18765), Handler).serve_forever()
```

`$RUN/home/.pi/agent/models.json`:

```json
{"providers":{"mock":{"baseUrl":"http://127.0.0.1:18765/v1","api":"openai-completions","apiKey":"mock","models":[{"id":"slow"}]}}}
```

Older Pi versions (rows V2, V3): install each in its own directory, for
example `$RUN/pi-0.84.4`, and put its `node_modules/.bin` first on `PATH` in
the start script.

In tmux, send the prefix as `C-\` and Escape as `Escape`.

## Matrix

Last run: 2026-10-13. Rows run on published 0.1.5 say `v=0.1.5`; rows run on the pre-release build of the 0.1.6 fixes (`8d39dbe`) say so. Row I6 checks the published 0.1.6.

### Install and load

| ID | Scenario | Steps | Expected | Last verified |
| --- | --- | --- | --- | --- |
| I1 | npm install | `pi install npm:@sagmans/pi-prefix`, `pi list` | exit 0; package listed; no peer warning | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`01-install`) |
| I2 | Registry signature | `npm audit signatures` in `home/.pi/agent/npm` | 1 verified signature; version 0.1.5 | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`02-version-signatures`) |
| I3 | Local path install | `pi install <checkout>` | package loads; same behavior as I1 | pass, v=0.1.6 (pre-release build `8d39dbe`), Pi 1.1.0, 2026-10-13 (`50-I3-local-install`, `51a-fix-startup`) |
| I4 | Startup | start Pi | `[Extensions]` lists `@sagmans/pi-prefix`; `[Skills]` lists `pi-prefix`; no error | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`03-startup`) |
| I5 | Shortcut listed | `/hotkeys` | `Extensions` table shows prefix key with "Activate the pi-prefix prefix key" | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`11-command-hotkeys`) |
| I6 | Published 0.1.6 update | `pi update --extensions`; `/pi-prefix`; prefix `p`, `o`; `p` during a turn; invalid config `/pi-prefix` | 0.1.6 installed with a verified signature and SLSA provenance; dispatch works; inactive status lists errors | pass, v=0.1.6, Pi 1.1.0, 2026-10-13 (`70c-npm-016-update`, `71a` to `71e`, `probe.log`) |

### Config sources

| ID | Scenario | Steps | Expected | Last verified |
| --- | --- | --- | --- | --- |
| C1 | No config | remove both config files, start, `/pi-prefix` | `pi-prefix: inactive`; prefix key does nothing | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`30a-C1-no-config`, `30b-C1-prefix-noop`) |
| C2 | Global only | global config, no overlay, `/pi-prefix` | `active`; all 5 bindings; project path without `(loaded)` | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`04-status`) |
| C3 | Project overlay after `/reload` | add overlay, `/reload`, `/pi-prefix` | project path `(loaded)`; `o` gone; `w` added | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`13-reload-overlay-status`) |
| C4 | Overlay binding dispatch | prefix, `w` | probe log `args="overlay"` | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`14-overlay-dispatch`, `probe.log`) |
| C5 | `null` removal | prefix, `o` with overlay | no event; `o` goes to the editor as text | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`14-overlay-dispatch`) |
| C6 | Untrusted project | decline trust (`pi --no-approve`), `/pi-prefix` | `project trusted: no`; overlay not loaded | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`45c-C6-no-approve`) |
| C7 | Overlay overrides scalars | overlay sets `prefix` or `timeoutMs` | overlay value shown in `/pi-prefix` | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`40a-C7-overlay-scalars`, `40c-C7-overlay-f8` to `40e-C7-still-armed-2.5s`) |
| C8 | Invalid JSON | broken global file, start | error notice with path and `invalid JSON`; inactive | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`31-C8-invalid-json`) |
| C9 | Invalid prefix key | `"prefix": "notakey"` | error `is not a valid key id`; inactive | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`32-C9-invalid-prefix`) |
| C10 | Invalid `timeoutMs` | `"timeoutMs": 0` | error `timeoutMs must be a positive integer`; inactive | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`33-C10-timeout-zero`) |
| C11 | Invalid target | binding with two kinds, unknown property, command without `/`, payload on non-event | matching error; whole config inactive | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`34-C11-invalid-targets`, `34b`, `34c`, `34d`). Only the first invalid binding is reported per load |
| C12 | Prefix without bindings | `prefix` only | inactive; no error | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`35-C12-prefix-only`) |
| C13 | Status while inactive | invalid config, `/pi-prefix` | `inactive` plus each `error:` line | pass, v=0.1.6 (pre-release build `8d39dbe`), Pi 1.1.0, 2026-10-13 (`52-fix-ASG-731-status-errors`); 0.1.5 showed no reason (`31` to `33`) |

### Prefix key choice

| ID | Scenario | Steps | Expected | Last verified |
| --- | --- | --- | --- | --- |
| K1 | Free key `ctrl+\` | start, prefix | status line `prefix ctrl+\` | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`05-prefix-statusline`, `16-restored-ctrl-backslash`) |
| K2 | Conflict `ctrl+x` | set prefix `ctrl+x`, `/reload` | error `prefix ctrl+x conflicts with app.message.copy`; no keybinding changed | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`15a-ctrlx-reload`) |
| K3 | Conflict status | `/pi-prefix` in K2 state | `disabled (conflicts)`; `conflict: ctrl+x is bound to app.message.copy` | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`15b-ctrlx-status`) |
| K4 | Conflict key press | press `ctrl+x`, then `p` | Pi copy action runs; `p` typed; no dispatch | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`15c-ctrlx-pressed`) |
| K5 | Restore free key | set `ctrl+\`, `/reload` | active again | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`16-restored-ctrl-backslash`) |
| K6 | Terminal-reserved key | prefix `ctrl+s`, `ctrl+q`, `ctrl+z`, or `ctrl+c` | pi-prefix reports conflict, or the terminal takes the key; record which | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`41-K6-*`, `42-K6-*-press`): `ctrl+z` and `ctrl+c` are reported as conflicts; `ctrl+s` and `ctrl+q` reach Pi and work as prefix; `ctrl+s` also makes Pi list a picker-only `app.models.save` clash under `[Extension issues]` |
| K7 | Keys that need terminal setup | `alt+x` (macOS Option-as-Meta), `f9` (macOS fn) | prefix works only with terminal setup | partial, v=0.1.5, Pi 1.1.0, 2026-10-13 (`43a-K7-*`, `43b-K7-*`): `alt+x` and `f9` work in tmux on Linux; macOS terminal setup not testable on the run machine |
| K8 | Third-party shortcut collision | second extension registers the same key | Pi lists it under `[Extension issues]` | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`44a-K8-startup`, `44b-K8-press`): Pi lists the clash and keeps the later-loaded pi-prefix |

### Binding kinds

| ID | Scenario | Steps | Expected | Last verified |
| --- | --- | --- | --- | --- |
| B1 | Extension command, `submit: true`, with draft | type `draft text kept`, prefix, `p` | `PROBE COMMAND RAN`; draft kept | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`07-command-submit`, `probe.log`) |
| B2 | Built-in command, `submit: true` | prefix, `h` | `/hotkeys` output shown | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`11-command-hotkeys`) |
| B3 | Built-in command replaces draft | type draft, prefix, `h` | draft replaced by `/hotkeys` and submitted | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`26-B3-builtin-replaces-draft`) |
| B4 | Insert-only, `submit: false` | prefix, `a` | editor shows `/probe-mark typed`; no run | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`09-insert-only`) |
| B5 | Event with payload | prefix, `o` | probe log `payload={"source":"pi-prefix"}` | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`08-event`, `probe.log`) |
| B6 | Built-in action | prefix, `m` | model picker opens | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`10-action-model-select`) |
| B7 | Special actions | bind `app.interrupt`, `app.exit`, `app.clipboard.pasteImage` | same effect as the native key | partial, v=0.1.5, Pi 1.1.0, 2026-10-13: `app.interrupt` aborts a running turn (`39a-B7-interrupt`); `app.exit` exits Pi (`39c-B7-exit`); `app.clipboard.pasteImage` matches native `ctrl+v` only with an empty clipboard (`39d`, `39e`) |
| B8 | Unknown action | bind `app.does.not.exist` | warning `action "..." is unavailable`; no crash | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`38-B8-unknown-action`) |
| B9 | Second key enter, tab, arrow | bind `enter`, `tab`, `up` | each dispatches | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`37-B9-enter-tab-up`, `probe.log`) |
| B10 | `escape` binding | bind `escape` | load warning `can never dispatch`; Escape cancels | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`36a-B10-startup-warning`, `36b-B10-escape-cancels`) |

### States

| ID | Scenario | Steps | Expected | Last verified |
| --- | --- | --- | --- | --- |
| S1 | Empty editor | prefix, `p` with empty editor | dispatch; editor stays empty | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`25-S1-empty-editor`, `probe.log`) |
| S2 | Draft text | see B1 | draft kept | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`07-command-submit`) |
| S3 | Escape cancel | type draft, prefix, `Escape` | status line clears; draft kept; Pi interrupt not triggered | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`06-escape-cancel`) |
| S4 | Timeout | prefix, wait more than `timeoutMs` | status line clears | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`12a-timeout-armed`, `12b-timeout-after`) |
| S5 | Key after timeout | S4, then `q` | `q` typed; no dispatch | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`12c-key-after-timeout`) |
| S6 | Unknown second key | prefix, unbound key `z` | prefix clears; `z` goes to the editor | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`20-S6-armed`, `21-S6-unknown-z`) |
| S7 | After `/reload` | `/reload`, prefix, `p` | dispatch works; one shortcut only | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`13`, `14`) |
| S8 | Busy agent turn | send prompt, prefix and `p` while agent runs | command runs or queues as Pi does for typed commands; no crash | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`29a` to `29e`); v=0.1.6 (pre-release build `8d39dbe`), Pi 1.1.0, 2026-10-13 (`51d-fix-S8-busy`, `51e-fix-S8-after`). Model: local mock endpoint (see Setup). Insert-only replaces the draft while busy too (`29c`) |
| S9 | Prefix twice | prefix, prefix | prefix mode stays active; timer restarts | pass, v=0.1.5, Pi 1.1.0, 2026-10-13 (`22-S9-prefix-twice-1`, `23-S9-still-armed`, `24-S9-expired`) |
| S10 | Session switch | `/new` or `/resume`, prefix, `p` | dispatch works in new session; status line clean | pass for `/new`, v=0.1.5, Pi 1.1.0, 2026-10-13 (`27a` to `27c`); `/resume` had no saved session to pick (`28a`) |

### Pi versions and modes

| ID | Scenario | Steps | Expected | Last verified |
| --- | --- | --- | --- | --- |
| V1 | Pi 1.1.0, normal mode | all rows above | as listed | see rows |
| V2 | Locked baseline Pi 0.84.4, live | install Pi 0.84.4; run core rows I4, C2, K1, B1, B4-B6, S3, S4 | same results | pass, v=0.1.6 pre-release build, Pi 0.84.4, 2026-10-13 (`60-V-0.84.4-*`) |
| V3 | Pi 0.99.1 | core rows | same results | pass, v=0.1.6 pre-release build, Pi 0.99.1, 2026-10-13 (`60-V-0.99.1-*`) |
| V4 | Regular mode | Pi 1.1.0 defaults to fullscreen, so V1 ran fullscreen; set `"tuiMode": "regular"`, core rows | same results; status line visible | pass, v=0.1.6 pre-release build, Pi 1.1.0, 2026-10-13 (`61-V4-default-mode`, `62-V4-regular-1.1.0-*`) |

## Summary of last run

| Result | Rows |
| --- | --- |
| pass | 48 |
| partial | 2 (K7, B7) |
| fail | 0 |
| not yet run | 0 |
| aggregate (V1) | 1 |

Findings from this run: the inactive status gave no reason for an invalid config (fixed in 0.1.6, row C13), and insert-only bindings replace the draft (now stated in the README).
