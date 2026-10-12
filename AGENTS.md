# Repository agent guidance

## Maintainer paths

- Setup: run `npm ci --ignore-scripts` from the repository root.
- Verification: run `npm run typecheck`, `npm test`, and
  `npm pack --dry-run` before pushing.
- Live dogfooding: run the [live dogfooding matrix](DOGFOOD.md) in a real Pi
  TUI before each release. Update the status of each row you run. Never mark a
  row `pass` without live evidence. Add rows for new features or new Pi
  versions.
- Security: follow [`SECURITY.md`](SECURITY.md), including private
  vulnerability reporting.
- Changelog: update [`CHANGELOG.md`](CHANGELOG.md) before merging any pull
  request.

## Privacy invariants

Never read, copy, log, or mutate the real `~/.pi/agent`. Runtime checks must
use the disposable `HOME` from the DOGFOOD.md setup.
