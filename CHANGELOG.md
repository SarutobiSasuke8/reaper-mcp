# Changelog

## Unreleased

### 0.1.0-alpha.1 Windows release candidate

- Native Lua bridge for live project/track/FX inspection and guarded name/gain/pan/mute edits, dry-run and one-step undo.
- Protocol 2 uses unique atomic request files and a heartbeat; timed-out requests no longer poison a shared slot. Expired edits are rejected and mutations are never replayed automatically.
- Project/session/revision guards reject stale writes across project changes, process restarts and concurrent clients.
- Managed startup reuses a live instance and relaunches after process closure without killing unsaved sessions. Stable Codex installation and registration verified.
- Fixed isolated Windows dummy-device settings; installed-package mix/stem/region acceptance passed.
- Windows-only package with prepack build, prepublish checks and native acceptance scripts. Linux and advanced live editing remain outside this alpha.

### Earlier offline checkpoint

- Initial offline checkpoint using house MCP template patterns and the LMMS SDK stack.
- Backend-neutral validated song model, bounded object paths, MIDI/WAV import and conservative RPP subset parser/writer.
- Fourteen-tool stdio surface with opt-in writes, capability discovery and source-attributed audio measurements.
- Draft render wrapper and explicit failed Windows startup evidence. Live mode, ReaPlugs, complete music ports and release packaging remain pending.
