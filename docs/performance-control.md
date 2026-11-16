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
