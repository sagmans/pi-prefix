# Changelog

## 0.1.0

First public release.

- Configurable prefix key dispatching a second key to a Pi app action, slash command, or extension event.
- Layered configuration: shipped defaults → global `~/.pi/agent/pi-prefix.json` → trusted project `<project>/.pi/pi-prefix.json`, with `null` removing an inherited binding.
- Zero-keymap by default: inert without an effective prefix and at least one binding.
- Prefix/keybinding conflict guard: a colliding prefix disables pi-prefix and reports the exact keybinding ids; existing bindings are never edited.
- Extension-owned slash commands dispatch through Pi's command pipeline with the editor draft preserved; other submitted commands replace and submit the draft.
- `/pi-prefix` status: state, config paths, trust, effective prefix/timeout/bindings, diagnostics, conflicts.
