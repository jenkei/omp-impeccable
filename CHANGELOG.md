# Changelog

## 0.1.0 - 2026-06-21

Initial OMP-native release, adapted from `pi-impeccable`.

- Add `/impeccable` OMP command backed by upstream `impeccable`.
- Publish plugin metadata under `omp.extensions`.
- Stage upstream Codex-flavored Impeccable skills and store the managed project copy at `.omp/skills/impeccable` without vendoring skill files.
- Run `/impeccable live` polling in the background so OMP stays usable.
- Inject Impeccable live events and command work as hidden extension messages, not visible user prompts.
- Add `impeccable_live_reply` and `impeccable_live_complete` tools for live event responses.
- Add quiet live status UI via OMP extension status for `/impeccable live`.
- Add OMP-native `/impeccable pin` and `/impeccable unpin` command shortcuts.
- Treat upstream hook manifests as non-native and direct users to OMP live mode instead.
- Add transient status feedback for queued Impeccable commands without replacing live status.
- Stop argument autocomplete after the first word so `/impeccable craft foo` cannot collapse back to `/impeccable craft`.
- Handle `stop live` and `/impeccable stop` quietly.
- Summarize `/impeccable status` instead of dumping raw JSON.
