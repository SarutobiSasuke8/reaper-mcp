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
- Composition: `live_compose_piece` writes a complete piece into the live project as one undo step, from a style or a persona, with tracks, catalogue instruments, MIDI clips, starting levels, a tempo marker and a region per section.
- `live_write_part` writes one melody, accompaniment, bass or drum part over a chord progression onto an existing track.
- `/styles`, `/personas` and `/personas/{id}` read the built-in composition library in either mode: 8 styles and 18 film and DJ personas.
- Vendor the LMMS MCP composer, melody, motif, solo, blueprint, arranger-lint and persona modules byte-for-byte, with their style and persona data.
- Add `scripts/compose-check.mjs`, a native check that composes, reads back, renders and measures a piece.
- Auto-mix: `live_auto_mix` renders a stem per track, sets each track's level from a target for its role, moves the whole mix to a loudness target under a true-peak ceiling and confirms the result on a fresh render. One undo step.
- Live renders are split into a snapshot stage and a render stage, so stems render side by side. `REAPER_MCP_PARALLEL_RENDERS` sets how many at once (1 to 4, default 2).
- Vendor the LMMS MCP balance planner byte-for-byte.
- Add `scripts/automix-check.mjs`, a native check that composes, auto-mixes and verifies the loudness.
- DJ: `dj_analyze_tracks` reports tempo to 0.01 BPM, first beat and bar line, key with its Camelot code, loudness, energy per bar and drops for workspace WAV tracks. Works offline; results are cached.
- DJ: `live_build_dj_set` builds a beatmatched set on two decks as one undo step: harmonic, tempo or given order, one set tempo with pitch kept, bar-aligned crossfades, incoming drops landed on the transition end, loudness-matched items, a region per track and a marker per transition.
- `live_insert_audio` takes `playRate`, `preservePitch`, `offsetSeconds`, `lengthSeconds`, `fadeInSeconds`, `fadeOutSeconds` and `gainDb`. Item views report `playRate` and `preservePitch`.
- Add `scripts/dj-check.mjs`, a native check that builds and renders a set and measures beat alignment through each transition.
- DJ: transitions are a bass swap by default. Each deck gets REAPER's bundled ReaEQ, and the low end moves from the outgoing track to the incoming one over one bar at the middle of each transition. `transition: "crossfade"` leaves the EQ out.
- FX: `live_add_fx` adds any installed effect to a track, `live_remove_fx` removes one, and `live_write_fx_automation` writes automation points for a parameter, creating the envelope when there is none.
- An FX can be confirmed by `fxName` in place of `fxGuid`, and a parameter chosen by `parameterName` in place of its index. This lets one batch add an FX and then set or automate it.

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
