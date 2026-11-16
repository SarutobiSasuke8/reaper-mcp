# Live MIDI and instrument workflow

Available since 0.1.0-alpha.2. The same 14 top-level tools are retained. These commands operate on native REAPER state; they do not round-trip it through the conservative offline RPP parser.

1. `reaper_get({mode:"live",path:"/project"})` establishes a project/revision context.
2. `reaper_project({mode:"live",operation:"new",song:{tempo:100}})` opens a new tab without replacing the user's existing project. Live new accepts only tempo, not the offline song model.
3. `reaper_get({mode:"live",path:"/instruments"})` lists configured library IDs; `/plugins` lists REAPER's scanned plugins.
4. `reaper_enable_toolset({mode:"live",name:"editing"})` enables composition.
5. Describe and run the capabilities below. All support `dryRun:true`; dry runs validate without adding tracks, FX or notes. Plugin instantiation and preset parsing are necessarily verified on the real insertion.

```json
{"mode":"live","capability":"live_add_track","args":{"name":"Piano"}}
{"mode":"live","capability":"live_insert_instrument","args":{"track":0,"instrument":"piano"}}
{"mode":"live","capability":"live_insert_midi","args":{"track":0,"name":"Phrase","startBeat":0,"lengthBeats":4,"notes":[{"beat":0,"duration":1,"pitch":60,"velocity":80,"channel":0},{"beat":1,"duration":1,"pitch":64,"velocity":85,"channel":0}]}}
```

Use these objects as `reaper_run` arguments. `reaper_describe` returns their full schemas; `reaper_find_capability` reports live/offline support. Read notes back through `/tracks/0/items/0/notes` (absolute project quarter-note positions). Note `beat` offsets in insertion are relative to the new clip. Tempo maps are handled by REAPER's QN/PPQ conversion. Channels are zero-based. Maximum 128 notes per clip; create successive clips for longer arrangements. The 16 KB wire limit also applies, so unusually verbose numeric values can require smaller batches.

Save with `reaper_project({mode:"live",operation:"save",file:"song.rpp"})`. The path is confined to the configured workspace and must not already exist. Open uses a new tab. Failed/uncertain saves may leave a reserved output; inspect rather than overwriting it. Saving and project-tab actions are not undo edits. Track/FX/MIDI mutations each create one undo block; a failed preset or MIDI population removes only the object it just inserted. Existing instruments are not silently stacked or replaced.

`reaper_render({mode:"live",target:"mix",timeoutMs:180000})` snapshots native project state, temporarily supplies WAV render settings and restores the live settings, then renders in an isolated process. Returns workspace-relative files for `reaper_analyze`. The live render is the full project plus a 2-second tail, 44.1 kHz stereo 24-bit WAV. Live stems/regions remain unsupported. Plugins and their sample libraries must be available to the render worker. Missing/interactive plugins may still require attention; no silent offline-model fallback occurs.

## Configuration

`REAPER_MCP_INSTRUMENTS` is an operator-controlled absolute JSON catalogue path:

```json
[
  {"id":"piano","name":"Piano","plugin":"VST3i: sfizz (SFZTools)","preset":"C:/Audio/Presets/Piano.vstpreset"},
  {"id":"surge","name":"Surge XT","plugin":"VST3i: Surge XT (Surge Synth Team) (2->6ch)"}
]
```

Use exact names/identifiers from `/plugins`. The MCP caller selects an ID, not an arbitrary binary/preset path. Presets must be existing bounded `.vstpreset` files; samples referenced by those presets remain separately installed assets. No proprietary sounds or plugin binaries are bundled.

`REAPER_MCP_VST_PATHS` supplies semicolon-separated Windows scan directories for new managed profiles and isolated renders. Existing profiles are preserved: rescan/configure their paths separately. Restart the managed instance when deploying a new bridge; an already-running Lua bridge does not hot-reload. The registered server may require a new Codex chat/app refresh before newly discovered capabilities appear.

Native operations have a 60-second bridge deadline for cold plugin/project loads. Simple reads retain a 10-second deadline. After a timeout, outcome is unknown: inspect before retrying. Project/revision guards reject stale context. Heartbeats refresh after blocking loads before replies, preventing the next serialized request from seeing a stale heartbeat.

## Acceptance

`scripts/music-check.mjs` uses actual MCP stdio calls, with a disposable workspace and configured piano/bass/drums/surge IDs. It checks dry-run immutability, track/FX insertion, MIDI readback, duplicate instrument rejection, native save/reopen, isolated rendering and non-silent audio in each instrument's section. Opt in with `REAPER_MCP_RUN_MUSIC_CHECK=true` and set workspace, catalogue and VST paths. Test results are written to `music-proof.json` in that workspace.

Editing existing CC events, program/pitch-bend editing, instrument replacement/preset browsing, MIDI file import into a live project and live stem/region rendering remain separate follow-ups. See [the full instrument and extension plan](instrument-roadmap.md).


New in alpha.3: [performance control](performance-control.md) inserts CC events, dynamics ramps and named articulations directly through MCP, with controller readback and reusable local quartet recipes.
