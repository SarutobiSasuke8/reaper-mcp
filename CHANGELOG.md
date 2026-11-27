# Changelog

## Unreleased

- Vendor sidechain pump analysis and mid-beat trigger advice from LMMS source `0dff284533eb23af408bc1b596d348d6410640bb` (#85).

- Vendor tempo-grid bar-energy curves, peak bar, range and drop detection from green LMMS PR #83, with the same targeted arrangement advice.

## 0.1.0-alpha.6

- Add the official MCP Registry manifest and npm package identity.
- Update the Windows installation guide for the npm package and matching GitHub prerelease.
- Add LMMS-derived dynamic range, loudness range, stereo, and tempo measurements.

- Vendor reference-track comparison from green LMMS PR #81; `reaper_analyze` accepts an optional workspace-relative `referencePath` WAV.

- Vendor onset density and swing analysis from LMMS MCP, with requested-swing regression coverage.

- Vendor key and Camelot analysis from LMMS MCP, with requested-key compatibility regression coverage.

## 0.1.0-alpha.5

- Published the Windows package on npm on 16 November 2026 and mirrored it to GitHub Releases.
- Added guarded edits to existing MIDI notes, named keyswitch replacement, controller ramp replacement and beat-range renders.

## 0.1.0-alpha.4 - GitHub alpha published 2026-11-16

- Added explicit system-output versus dummy-audio configuration for new managed profiles; startup requests hidden windows by default.
- Included native MIDI/instrument insertion, CC ramps and named keyswitch articulation workflows from alpha.2/alpha.3.
- Read MCP handshake/health versions from package metadata.
- Added installed-package acceptance using bundled ReaSynth, plus a native system-output probe and Windows Node 20/22 CI.
- Updated installation, scope and recovery documentation. GitHub prerelease published; npm publication pending authentication.

## Earlier candidates

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

## 0.1.0-alpha.2

Native live track, instrument and MIDI creation through progressive capabilities. Adds catalogue/plugin/note discovery, native project save/open and isolated mix rendering. Longer bounded loading requests and post-load heartbeat refresh fix cold-plugin workflow interruptions. See docs/live-music.md and docs/instrument-roadmap.md.
