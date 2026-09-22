# Changelog

## 0.1.3

- Widen Pi peer and dev ranges to `<0.88.0`. Verified against 0.84.4, 0.86.1, 0.87.0, and 0.87.1 hosts: typecheck, test suite, and a live TUI dogfood driving prefix activation, dispatch, draft preservation, and cancel. No behavior change.
- Note on Pi status display: 0.85.0-0.87.0 could embed working, compaction, and retry status in the editor border for editors that opted in; pi-prefix never opted in, and Pi removed the opt-in again in 0.87.1, so status renders beside the editor for every editor. Nothing to configure.
- The package-content gate accepts npm 12's name-keyed `pack --json` manifest alongside the npm <=11 array form, so local npm versions no longer fail the test.

## 0.1.2

- Docs only: unpinned README install line (pinned specs are skipped by `pi update`) and 0.1.1 provenance note. No code change.

## 0.1.1

- Widen Pi peer and dev ranges to `<0.86.0`, covering the evidenced 0.85.x hosts. No behavior change.
- First workflow-attested release: published from CI with SLSA provenance. (0.1.0 was published directly and carries no attestation.)

## 0.1.0

First public release.

- Configurable prefix key dispatching a second key to a Pi app action, slash command, or extension event.
- Layered configuration: shipped defaults → global `~/.pi/agent/pi-prefix.json` → trusted project `<project>/.pi/pi-prefix.json`, with `null` removing an inherited binding.
- Zero-keymap by default: inert without an effective prefix and at least one binding.
- Prefix/keybinding conflict guard: a colliding prefix disables pi-prefix and reports the exact keybinding ids; existing bindings are never edited.
- Extension-owned slash commands dispatch through Pi's command pipeline with the editor draft preserved; other submitted commands replace and submit the draft.
- `/pi-prefix` status: state, config paths, trust, effective prefix/timeout/bindings, diagnostics, conflicts.
