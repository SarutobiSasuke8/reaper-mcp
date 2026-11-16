# Port manifest

P3's authoritative checklist is the operator's ASV `2026-11-16 Music tooling inventory`, supplied by the 00:27 amendment to the build ticket. This table records implemented module provenance and pending groups; it does not replace that tool-by-tool inventory. Resolve source heads again when P3 starts. The inventory also includes Atelier instruments, DSP, drum machine, persona packs, styles, Mix Desk and CLIs. LMMS VST3 host/effect-chain machinery is replaced by REAPER-native FX chains, not ported as a second host. The `grok-*` source branches are attributed to grok-web.

| Module | Source | State | Evidence / follow-up |
|---|---|---|---|
| audio.mjs | lmms-mcp, last-modifying SHA `364799c23f7c271d5b0de352935d759230c5ec39` | vendored unchanged | Used by analysis and render probe; source licence included |
| House tool contracts, errors, stdio tests, tsconfig | MCP server template `6e6ba1ce9e2d42fb2f3ce95f80a9964b78938fb4` | adapted | SDK 1.32.2 preserves LMMS stack and Node 20/22 support |
| Song model and RPP parser/writer | new TypeScript | initial subset | Fixtures cover audio, MIDI notes, tempo/meter, explicit sends, JSFX and markers/regions |
| REAPER backend experiment in lmms-mcp | no such open PR found during intake | not copied | Prior comparison evidence reused; no lmms-mcp source changed |
| Music, genres, groove, arrangement, personas, styles, vocal chops, taste/evaluation, atelier | main and open source PR heads in the task brief | pending P3 | Resolve each source head and licence before porting; do not assume the backlog has landed |
| LMMS project XML and rendering | LMMS implementation | remains in lmms-mcp | REAPER uses its own model/RPP/render implementation |
| ReaPlugs / VST state | REAPER-native | pending | JSFX references only in initial writer; unknown plugin state is rejected, not discarded |

This is a partial checkpoint, not a claim that the whole portability audit has been implemented. No LMMS PR was modified, closed or merged.
