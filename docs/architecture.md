# Architecture and Windows setup

## Shared live/offline vocabulary

The server exposes a small fixed set of tools. Toolsets add capabilities behind `describe` and `run`, not hundreds of top-level registrations. A model and object-path grammar separate musical intent from the DAW backend. Every result states its selected backend. An explicit live request never falls back silently; an auto request may choose offline only before the operation starts.

## Isolation

Offline jobs use a fresh job directory, a generated minimal configuration and a separate REAPER instance. They never copy the user's REAPER configuration or licence. A portable installation is a useful optional setup for repeatable agent evaluation, but not a prerequisite for editing an existing live session. Version only deliberately selected, licence-free configuration examples and scripts, never a whole portable installation or arbitrary user state.

## Bridge

Phase 2 starts with atomic file IPC and a bounded `reaper.defer` poll. Stock REAPER must suffice. Deferred callbacks still execute on the DAW thread; socket accept/read, HTTP work and large edits must never block it. A socket bridge would require an explicit supported dependency and latency evidence, not an assumption that Lua includes a socket server. Compare measured file IPC latency before changing transport.

One validated edit call creates one undo step. Validate the entire request before touching the project; `dryRun` reports planned changes. Undo grouping is not automatic rollback on exceptions. Large MIDI changes need bounded chunks and a clear failure/rollback policy. Transport and file rendering have different reversibility from project edits.

## Extensions and optional workstation setup

Core project, track, item, MIDI and FX operations use the native API. Detect SWS, ReaPack and js_ReaScriptAPI at runtime and describe capabilities that need them; do not silently install extensions or make all three mandatory. Use `APIExists` and named action lookup rather than assuming numeric extension action IDs are portable.

Themes, auto-colour rules, mouse modifiers, samplers, search tools and game-audio variation scripts are optional human-workstation choices. Verify each source, compatibility, licence and current cost before proposing installation. They are not part of the server's baseline dependency set. Monitoring FX affect auditioning, so measurement reports must say whether they concern rendered output or the monitored signal.

## Audio evidence

Offline WAV analysis reuses the source-attributed LMMS module. Its LUFS and true-peak values are algorithmic estimates, not a certification. Phase 2 should capture native `GetSetProjectInfo_String(..., 'RENDER_STATS', ...)` output after an identified render, preserve its provenance and compare it with independent WAV measurements. Never report stale native statistics as belonging to a newer job. HTML render statistics may be an optional human-readable artifact; parsing HTML is not required for the API path.

## Sources

- Operator-supplied architecture context, 16 November 2026, reviewed during this build.
- [Cockos ReaScript overview](https://www.reaper.fm/sdk/reascript/reascript.php).
- [Cockos API reference](https://www.reaper.fm/sdk/reascript/reascripthelp.html), including `defer`, undo blocks, `APIExists`, `NamedCommandLookup` and `RENDER_STATS`.

This document distinguishes design requirements from verified implementation. P1 does not yet supply the live bridge or extension/native-statistics integration.
