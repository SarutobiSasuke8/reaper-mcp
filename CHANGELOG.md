# Changelog

## Unreleased

- Bridge protocol 3. Requests are one JSON object with named arguments in place of positional hex lines. The request limit rises from 16 KB to 1 MB and MIDI clips and edits from 128 to 2048 events per call.
- The Lua bridge is a registry with one handler per capability, so a new live capability is one `define` block.
- Tracks can be addressed by GUID in braces wherever an index is accepted, in object paths (`/tracks/{GUID}/fx`) and in capability arguments.
- New `live_batch` capability: 1 to 64 edit steps in one native undo step. A failed step undoes the earlier steps.
- A REAPER session still running the protocol 2 bridge is reported as `bridge_upgrade_required`. Managed startup does not launch a second instance beside it. Restart that REAPER session after upgrading the package.
- Add `scripts/batch-check.mjs`, a native acceptance check for the new protocol.
- Transport: `live_transport` plays, stops, pauses, seeks and sets the loop range. `/project/transport` reports state and position. Recording is not controlled.
- Markers and regions: `live_add_marker`, `live_edit_marker`, `live_delete_marker`, read from `/markers`.
- Tempo map: `live_set_tempo` and `live_delete_tempo_marker`, read from `/project/tempo_map`.
- Items: `/tracks/{index}/items` lists audio and MIDI items. `live_insert_audio`, `live_edit_item`, `live_split_item` and `live_delete_item` import, move, trim, fade, split and delete them.
- Tracks: `live_delete_track`, and `solo` joins the settable track fields.
- Add `scripts/arrange-check.mjs`, a native acceptance check for these capabilities.

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
