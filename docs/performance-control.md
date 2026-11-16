# MIDI performance control and quartet templates

`live_insert_performance` adds notes, controller events, sampled linear ramps and named keyswitches in one native MIDI clip. It uses the existing editing toolset, write permission, dry-run, project/revision guards and undo block. An old bridge rejects this new operation rather than silently ignoring CC data. Use a fresh managed bridge after upgrading; do not restart an unsaved user session.

```json
{
  "mode": "live",
  "capability": "live_insert_performance",
  "args": {
    "track": 0, "startBeat": 0, "lengthBeats": 8,
    "instrument": "vpo-1st-violin-solo",
    "notes": [{"beat": 0.125, "duration": 1.5, "pitch": 67, "velocity": 90}],
    "articulations": [{"beat": 0, "name": "normal"}],
    "controllers": [{"beat": 0, "controller": 1, "value": 0}],
    "ramps": [{"startBeat": 0, "endBeat": 7, "controller": 11, "startValue": 45, "endValue": 115, "steps": 28}]
  }
}
```

Offsets are clip-relative quarter-note beats; readback uses absolute project beats. Channels are 0-15. CC values/numbers are 0-127. A ramp emits `steps + 1` events including both endpoints, rounded to MIDI integer values. Up to 128 expanded events per call, including musical notes and keyswitches. All events must fit; CC/ramp endpoints must precede clip end. Conflicting same-controller/channel/time entries are rejected. REAPER's PPQ resolution still quantises times, so avoid sub-tick event spacing. Empty notes are allowed for controller-only clips. Prefer keeping controls and notes together: overlapping clips can reset or compete for controller state.

Read `/tracks/0/items/0/controllers` to verify CC number, value, channel and absolute beat. REAPER may also expose its end-of-item all-notes-off controller. Read `/tracks/0/items/0/notes` for musical notes and keyswitches.

Catalogue entries can have an optional `articulations` object mapping names to MIDI key numbers, for example `{"normal":38,"staccato":40}`. It is preset-specific. The caller must select the mapping belonging to the track's loaded preset; the API does not infer or replace that preset. Unknown names/IDs fail before mutation. Place the switch shortly before the intended musical note, not at the same timestamp. Direct keyswitch notes remain supported for uncatalogued mappings.

## Local quartet recipes

Four empty tracks: Violin I, Violin II, Viola, Cello. Tempo 120, pans -0.30, -0.10, +0.13, +0.30. Open the saved template with `reaper_project`, then save the new piece to a different, unused filename before working.

- VPO IDs: `vpo-1st-violin-solo`, `vpo-2nd-violin-solo`, `vpo-viola-solo`, `vpo-cello-solo`. Gains -8, -10, -9, -8 dB. Maps: sustain/normal/accent/staccato/pizzicato = 36/38/39/40/41; cello = 84/86/87/88/89. First violin also has tremolo = 37. Start CC1 at 0 for the normal-mod-wheel patch; shape expression with CC11. Presets use local Mozart adaptations with shorter release tails; original library patches remain installed.
- BBC IDs: `bbc-violin1`, `bbc-violin2`, `bbc-viola`, `bbc-cello`. Gains -10 dB. Saved Long presets, section strings. CC1 dynamics and CC11 expression both control level in Discover's single-layer engine. Its keyswitch map has not yet been verified/registered; do not apply VPO mappings to BBC.

These are local templates depending on separately installed plugins, libraries and presets. No third-party samples or binary presets are distributed in this repo. The VPO template is a functional solo workflow, not a sound-quality replacement for BBC; the user prefers BBC's recorded sound. Higher-quality solo strings with recorded legato remain an explicit library gap. Quartet MIDI interpretation is a separate task from this transport API; it does not automatically interpret score notation.

## Verification

Run `scripts/performance-check.mjs` with `REAPER_MCP_RUN_PERFORMANCE_CHECK=true`, a disposable managed workspace, configured VPO catalogue and VST paths. It exercises actual stdio MCP dry runs, named keyswitch and CC/ramps readback, unknown-name rejection, controller-only insertion, save/reopen, native rendering and non-silent/unclipped audio. `REAPER_MCP_TEST_SERVER` can point to an installed package entry point.

Editing existing MIDI events, pitch bend/program changes, verified BBC articulation maps, expressive tempo maps and full score-import semantics remain follow-ups.


## Version reporting and reconnecting

The MCP initialise handshake and health response read the installed package version from package.json. Earlier alpha.3 builds still reported alpha.2 because those two strings were hard-coded. An MCP process already running retains its loaded modules after an on-disk upgrade; reconnect the client to load the new server. Do not restart or terminate an unsaved REAPER project to refresh a stdio MCP client. A fresh client should report the package version and find `live_insert_performance` through capability discovery.


## Editing an existing performance (alpha.5)

Enable the editing toolset. Read `/tracks/0/items/0` for `takeGuid` and clip start/length, then `/tracks/0/items/0/notes` and `/controllers`. Each event now includes its native `index`, selection and mute state. Readback times remain absolute project quarter-note beats; edit offsets are relative to the clip start.

Call `reaper_run` with `capability: "live_edit_performance"`, first with `dryRun: true`:

```json
{
  "track": 0, "item": 0, "takeGuid": "{GUID-FROM-READBACK}",
  "notes": [{"index": 2, "velocity": 72, "duration": 0.75}],
  "instrument": "your-catalogue-id",
  "articulations": [{"index": 0, "from": "long", "to": "short"}],
  "ramps": [{"startBeat": 1, "endBeat": 3, "controller": 11,
    "startValue": 40, "endValue": 95, "steps": 16, "channel": 0}]
}
```

Omit any unused arrays or instrument. Note edits can change beat, duration, pitch, velocity or channel; omitted properties and selection/mute states are preserved. Named articulation edits require the existing note to match the `from` mapping and velocity 1 used by MCP insertion. The catalogue must match the loaded preset. A synth test proves event changes, not how every commercial instrument interprets a keyswitch.

Ramps replace only CC events with the specified number/channel within the inclusive interval, then insert `steps + 1` linear samples. Other CC events, pitch bends, text and SysEx are retained. New ramp samples are unmuted and unselected. Ramps cannot overlap on the same controller/channel or collide at MIDI tick resolution. A call supports up to 128 expanded edits, all validated before mutation. Native errors restore the original MIDI event buffer; successful changes form one REAPER undo block. Re-read event indices after every change because sorting can reorder them.

This first editing pass accepts embedded, unpooled MIDI with no take offset or playback-rate adjustment. Actually repeated loop sources are rejected. A default loop-source checkbox on an unextended clip is accepted. Convert unsupported sources to an independent ordinary MIDI clip first. General controller deletion, note insertion/deletion within existing clips and curve shapes are future work.

## Comparing section renders

Call `reaper_render` in live mode with `target: "mix"` and:

```json
{"section": {"startBeat": 16, "endBeat": 32, "tailSeconds": 1}, "timeoutMs": 240000}
```

Bounds use absolute project quarter-note beats and follow the tempo map. The end is exclusive; optional tail seconds extend it (default 0, maximum 30). Each call saves a native snapshot and renders to a new `live-render-*` directory. The response includes the requested section and snapshot bounds in seconds. Source render settings are restored. Without `section`, full-project rendering remains unchanged. Offline section arguments fail explicitly.

Render before editing, make the change, and render again with identical bounds. Keep the two returned paths with the edit recipe; use `reaper_analyze` to compare levels before listening. These are raw comparison renders, not automatically loudness-matched. For sample instruments, start early enough to include preceding keyswitches and controller initialisation: plugin-specific chase/legato behaviour is not guaranteed when starting mid-phrase.

Native acceptance: `REAPER_MCP_RUN_RELEASE_CHECK=true node scripts/editing-check.mjs`. It uses a disposable hidden profile and bundled ReaSynth, verifies edits and unchanged events, checks equal-duration changed audio, and restarts only its own instance to verify saved edits.
