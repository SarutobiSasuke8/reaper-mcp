# Port manifest

P3's authoritative checklist is the operator's ASV `2026-11-16 Music tooling inventory`, supplied by the 00:27 amendment to the build ticket. This table records implemented module provenance and pending groups; it does not replace that tool-by-tool inventory. Resolve source heads again when P3 starts. The inventory also includes Atelier instruments, DSP, drum machine, persona packs, styles, Mix Desk and CLIs. LMMS VST3 host/effect-chain machinery is replaced by REAPER-native FX chains, not ported as a second host. The `grok-*` source branches are attributed to grok-web.

Additional ReaScript capability gaps (from 2026-11-16 07:45 amendment to lingxi-codex-20261116-01) are listed below and folded into P2â€“P4 (P5 optional). Community ReaPack scripts are reference only; do not vendor or copy their code. Note any read in this file.

| Module | Source | State | Evidence / follow-up |
|---|---|---|---|
| audio.mjs | lmms-mcp, source SHA `55faafe0286b8c3bb051ea1e99b818dfb09fdb8b` | vendored unchanged | Includes dynamic range, LRA and stereo measurements; byte-preserved source and licence included |
| House tool contracts, errors, stdio tests, tsconfig | MCP server template `6e6ba1ce9e2d42fb2f3ce95f80a9964b78938fb4` | adapted | SDK 1.32.2 preserves LMMS stack and Node 20/22 support |
| Song model and RPP parser/writer | new TypeScript | initial subset | Fixtures cover audio, MIDI notes, tempo/meter, explicit sends, JSFX and markers/regions |
| REAPER backend experiment in lmms-mcp | no such open PR found during intake | not copied | Prior comparison evidence reused; no lmms-mcp source changed |
| Music, genres, groove, arrangement, personas, styles, vocal chops, taste/evaluation, atelier | main and open source PR heads in the task brief | pending P3 | Resolve each source head and licence before porting; do not assume the backlog has landed |
| LMMS project XML and rendering | LMMS implementation | remains in lmms-mcp | REAPER uses its own model/RPP/render implementation |
| ReaPlugs / VST state | REAPER-native | pending | JSFX references only in initial writer; unknown plugin state is rejected, not discarded |
| MIDI expression and articulations (CC curves, keyswitches) | REAPER-native / new | pending P2â€“P4 | Atomic inject_midi_with_expression; works live and offline; one undo step, dryRun |
| Session scaffolding (folder tracks, colours/icons, named regions, sidechain sends) | REAPER-native / new | pending P2â€“P4 | From arrangement_plan; sidechain e.g. kick ducks bass via ReaComp |
| Track template inspector (.RTrackTemplate parse, load) | REAPER-native / new | pending P2â€“P4 | Read-only manifest of instrument/routing/keyswitches; load onto new track |
| Gain staging (peak/RMS/LUFS measure and trim) | REAPER-native / new | pending P2â€“P4 | Default -18 dBFS pre-fader; report every change |
| Wet/dry and bypass A/B for FX chains | REAPER-native | pending P2â€“P4 | Replaces LMMS-only live_update_effect |
| Variation generator (seeded N variations) | REAPER-native / new | pending P2â€“P4 | Pitch/rate/volume/FX params; timeline or render to files; game audio/foley |
| Slice to sampler (chop_break to ReaSamplOmatic5000) | REAPER-native / new | pending P2â€“P4 | Transient slices mapped to MIDI keys, drum-rack style |
| Render and audit (region LUFS/true peak) | REAPER-native | pending P1 confirmation | Confirm region render returns integrated LUFS and true peak |
| ReaImGui status panel (optional) | REAPER-native / optional | pending P5 | Floating panel for current tool/undo/mode; only if ReaImGui present; never hard dependency |

This is a partial checkpoint, not a claim that the whole portability audit has been implemented. No LMMS PR was modified, closed or merged. New items from the 07:45 amendment are recorded with pending status; implementations to follow existing phase plan, toolset + describe/get-set design, offline fixtures, live tests skip without REAPER.
