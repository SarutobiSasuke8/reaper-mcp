# Windows alpha usage

Windows-only 0.1.0-alpha.4 release candidate; install REAPER separately. Tested with REAPER 7.86 and Node 20/22. No SWS, ReaPack, socket library or Python runtime is required by the bridge.

## Setup and connection

Run `npm ci` and `npm run build`. Choose an existing dedicated music folder:

```powershell
$env:REAPER_MCP_WORKSPACE = 'C:/Music/AgentWorkspace'
$env:REAPER_MCP_ALLOW_WRITES = 'true'
node dist/src/stdio.js --setup
node dist/src/stdio.js --launch --project alpha.rpp
$env:REAPER_MCP_BRIDGE_DIR = "$env:REAPER_MCP_WORKSPACE/reaper-mcp-bridge"
node dist/src/stdio.js --doctor
```

Omit `--project alpha.rpp` when starting an empty session, or substitute an existing workspace-relative RPP. Setup prints a client JSON entry. Launch starts a separate managed REAPER profile and loads the bridge, requesting hidden windows by default. It does not install a startup script or alter normal preferences. Complete any normal evaluation prompt, then run doctor. New live profiles default to Windows WaveOut / Microsoft Sound Mapper with no recording inputs. For unattended composition set REAPER_MCP_AUDIO_MODE=dummy before first launch; rendering still produces audio files. Render workers always use dummy audio. Set REAPER_MCP_SHOW_WINDOW=true only when interactive setup is needed. Existing profiles are never rewritten; changing these settings does not reconfigure an already-running session. Never run two REAPER instances against the same bridge directory.

For Codex, use this equivalent entry in its MCP configuration, substituting absolute paths. Keep the task checkout until its PR is merged; afterwards point to a built installation, not a removed worktree.

```toml
[mcp_servers.reaper]
command = "node"
args = ["C:/path/to/reaper-mcp/dist/src/stdio.js"]
[mcp_servers.reaper.env]
REAPER_MCP_WORKSPACE = "C:/Music/AgentWorkspace"
REAPER_MCP_BRIDGE_DIR = "C:/Music/AgentWorkspace/reaper-mcp-bridge"
REAPER_MCP_ALLOW_WRITES = "true"
```

Writes must be enabled in both the MCP process and REAPER's inherited environment. The bridge has only an allowlisted protocol, no arbitrary ReaScript execution. Its folder is a trusted local IPC boundary, not a network service; keep it private to the local account.

## Adjust a live plugin

Available in the development build after alpha.6. Start its matching Lua bridge. Use `mode: live` throughout.

1. Read `/tracks/0/fx` with `reaper_get`. Pick a slot and copy its `guid`.
2. Call `reaper_list` on `/tracks/0/fx/0/parameters`. Pages contain the index, name, normalised value and display text when the plugin supplies it. Use `offset` and `limit` to page through large instruments.
3. Enable the `editing` toolset. Call `reaper_run` with the following arguments, replacing the GUID and indices with the values you inspected.

```json
{
  "mode": "live",
  "capability": "live_set_fx_parameter",
  "args": {"track": 0, "fx": 0, "fxGuid": "<guid from the FX list>", "parameter": 0, "normalized": 0.5},
  "dryRun": true
}
```

The preview returns the current control and requested value. Apply with `dryRun: false` and use `after` for the actual value. A stepped control can round the request. A changed project revision or mismatched FX GUID rejects the edit. REAPER records the edit in a named undo block. When the value changes and REAPER exposes that block, the result includes an `undoToken`. Pass it to `live_revert_fx_edit` to undo that specific edit. The token expires on use, a revision change, a project switch or a bridge restart. This operation addresses top-level online track FX. To compare audio, render the same beat range before and after the edit, then pass the two WAV paths to `reaper_analyze` as `file` and `referencePath`.

## Audition two versions at matched loudness

Render the same passage twice. Enable the editing toolset, then call `reaper_run` in live or offline mode with:

```json
{
  "capability": "audition_ab",
  "args": {"a": "original/mix.wav", "b": "revision/mix.wav", "targetLufs": -18},
  "dryRun": false
}
```

Open the returned `audition.rpp` or play the two returned WAV files. The project aligns both copies at zero with B muted. To hear B, mute A and unmute B. Both WAVs keep the source timing. The pair must have the same frame count, sample rate and channel count. Use the same timeline start for each render.

The default target is −18 LUFS. A shared lower target accommodates peaks when necessary. The tool applies constant gain, encodes 16-bit PCM, then measures the listening copies again. It returns paths only if they match within 0.5 LU with at least 1 dB of estimated true-peak headroom. Silence or an incompatible pair produces an error. A dry run reports measurements without creating files. Each applied run gets its own folder. Clips shorter than one 400 ms metering block use an ungated estimate and report `gated: false`.

## Live routing, stems and FX automation

- Read `/tracks` for indices and GUIDs. Run `live_add_send` with `source`, `sourceGuid`, `destination`, `destinationGuid`, `pair` and optional `gainDb`. Use `1/2` for a normal stereo send or `3/4` for a sidechain. Both send post-fader audio with MIDI disabled. Read `/tracks/0/sends` to inspect the result. The receiving plugin must use its auxiliary input.
- To render one track, call `reaper_render` in live mode with `target: "stems"` and `stemTrack: {"index": 1, "guid": "..."}`. Optional `section` uses the same beat bounds as a mix render. The worker renders the track from a project snapshot with its incoming sends. The returned stereo WAV is the selected track output before downstream buses and master FX.
- Read `/tracks/1/fx/0/parameters/0/envelope` to inspect existing points. Run `live_edit_fx_envelope_point` with the track, FX slot and GUID, parameter and point indices, the observed `timeSeconds` and a new `normalized` value. Preview with `dryRun`. The returned times identify the adjacent anchors. This operation edits interior points on unscaled 0–1 FX envelopes with linear or square segments, while transport is stopped. It rejects automation items and boundary points.

## Several edits as one undo step

`live_batch` runs 1 to 64 edit capabilities as one transaction. Each step is `{capability, args}` with that capability's normal arguments. REAPER shows one undo entry for the whole batch. If a step fails, the earlier steps are undone and the error names the step.

```json
{"capability": "live_batch", "args": {"steps": [
  {"capability": "live_add_track", "args": {"name": "Bass"}},
  {"capability": "live_insert_midi", "args": {"track": 2, "startBeat": 0, "lengthBeats": 8,
    "notes": [{"beat": 0, "duration": 1, "pitch": 36}]}}
]}}
```

A new track takes the next free index (the current track count), so later steps can address it. With `dryRun`, every step is checked against the project as it is now. A step that depends on an earlier step, as the second step above does, shows `valid: false` in that preview and still runs correctly when applied. `live_revert_fx_edit` and `live_batch` itself cannot be steps.

Anywhere a track index is accepted you can pass the track's GUID from `/tracks` instead, in braces: `/tracks/{GUID}/fx`, or `"track": "{GUID}"` in a capability. The GUID stays correct when tracks are reordered.

One call can carry up to 2048 MIDI events and a request up to 1 MB.

## Compose in a live session

`live_compose_piece` writes a whole piece into the open project as one undo step. It adds a track for each of lead, harmony, pad and bass and one drum track, loads the instruments you name, writes the MIDI, sets starting levels and panning, sets the tempo and adds a region for each section.

1. Read `/styles` and `/personas` to choose a starting point, and `/instruments` for the catalogue IDs on this machine.
2. Preview with `dryRun`. Nothing changes; you get the key, tempo, form, chords and track plan.
3. Apply it, then render and analyse.

```json
{"capability": "live_compose_piece", "args": {
  "style": "swing", "bars": 16, "seed": 3,
  "instruments": {"lead": "piano", "harmony": "piano", "bass": "bass", "drums": "drums"}}}
```

- `style` is one of the 8 built-in styles. `persona` is one of 18 film and DJ briefs, each with its own tempo range, groove, harmony and mix targets. Give either, or neither for the default style.
- `key`, `bpm`, `bars` or `seconds` are optional. The same `seed` always gives the same piece, so change the seed for another take.
- A role with no instrument still gets its track and notes but makes no sound. The result lists those roles.
- Drums are written as General MIDI notes: kick 36, snare 38, hat 42, crash 49. Pass `drumMap` for a kit that differs.
- Tracks start at conservative levels by role so the mix does not clip: lead and bass -10 dB, drums -8 dB, harmony -15 dB, pad -17 dB. Sampled instruments are often quieter than synths, so analyse the render and raise `volume_db` where needed. Set `levels` to false to leave tracks at unity.
- `startBar` places the piece later in the project. `setTempo` and `regions` can be turned off.
- The composer writes 4/4.

`live_write_part` writes one part onto a track that already exists. `chords` is one chord symbol per bar.

```json
{"capability": "live_write_part", "args": {"track": 2, "part": "bass", "style": "walking",
  "chords": ["Dm7", "G7", "Cmaj7", "A7"], "startBar": 8}}
```

| Part | Styles |
| --- | --- |
| melody (needs `key`) | lyrical, driving, swing |
| accompaniment | arpeggio, flowing, broken, block, held, skank, bubble |
| bass | roots, pulse, octaves, walking, syncopated, reggae, sub, wobble |
| drums | rock, four, halftime, ballad, onedrop, rockers, steppers, dubstep, chip, swing |

`low` and `high` bound the register of a pitched part.

The composition code comes from LMMS MCP and is included unchanged. What it gives you is correct, playable material with a form, a motif that returns and parts that fit together. How good it sounds still depends on the instruments, and on listening to the render and adjusting.

## Arrange a live session

Enable the `editing` toolset, read the project, then use `reaper_run`. Positions are quarter-note beats from the project start unless a field says seconds.

| Task | Read first | Capability |
| --- | --- | --- |
| Play, stop, pause, seek, loop | `/project/transport` | `live_transport` |
| Markers and regions | `/markers` | `live_add_marker`, `live_edit_marker`, `live_delete_marker` |
| Tempo and time signature | `/project/tempo_map` | `live_set_tempo`, `live_delete_tempo_marker` |
| Import audio | `/tracks` | `live_insert_audio` |
| Move, trim, mute, gain, fade, rename an item | `/tracks/{index}/items` | `live_edit_item` |
| Split or delete an item | `/tracks/{index}/items` | `live_split_item`, `live_delete_item` |
| Solo or delete a track | `/tracks` | `reaper_set` on `/tracks/{index}/solo`, `live_delete_track` |

```json
{"capability": "live_transport", "args": {"command": "set_loop", "enabled": true, "startBeat": 16, "endBeat": 32}}
{"capability": "live_add_marker", "args": {"name": "Chorus", "beat": 32, "endBeat": 64}}
{"capability": "live_insert_audio", "args": {"track": 0, "file": "loops/kick.wav", "startBeat": 16}}
{"capability": "live_edit_item", "args": {"track": 0, "item": 0, "itemGuid": "{GUID}", "startBeat": 32, "fadeOutSeconds": 0.2}}
```

Points to know:

- Playback is not a project edit. `live_transport` makes no undo step and cannot be a `live_batch` step. It is refused while REAPER is recording, and this server never starts a recording.
- REAPER numbers markers and regions separately, so marker 1 and region 1 can both exist. Edits and deletes take both `id` and `isRegion`.
- A marker name cannot be cleared by an edit. Delete the marker and add it again.
- `live_set_tempo` replaces a tempo marker that is already at that beat and adds one otherwise. A tempo change moves every later beat in seconds, so read positions again afterwards.
- Item indexes follow timeline order and change after a move or split. Every item edit also takes the item GUID and is refused if the two no longer match. List the items again after each change.
- An audio item cannot be made longer than its source unless it is looped.
- `live_insert_audio` takes a workspace-relative wav, flac, mp3, ogg or aiff file.
- `live_delete_track` removes the track with its items, FX and sends. One undo step in REAPER restores it.

## Modes and capabilities

| Mode | Supported now |
| --- | --- |
| offline | New/open/save song JSON and supported RPP subset; WAV/MIDI import; notes, tracks, items, sends, JSFX references, tempo map, regions; transactional edits and batches; render mix/stems/regions; WAV analysis |
| live | Project/track/FX/plugin/instrument inspection; track name/gain/pan/mute edits; track and configured instrument insertion; MIDI notes, CC ramps and named keyswitch articulations; native save/open/new and full mix render; dryRun and guarded undoable edits |

Use `mode: offline` for model-based composition and rendering, or `mode: live` for native instrument/MIDI composition and mix rendering. Offline state is separate from the open live project: there is no implicit synchronisation. Open the saved RPP in REAPER to inspect/play it. MIDI needs an instrument to sound; importing notes alone does not install one.

Use `mode: live` for live session work. First `reaper_get` `/tracks`, then `reaper_set` `/tracks/0/volume_db` with `value: -6` and `dryRun: true`. Repeat with false, inspect readback, and use REAPER Undo to restore it. Any project change since the read requires a fresh read. Native unrelated plugin and item state is untouched by these direct track-property edits.

`auto` uses the heartbeat of the configured bridge. With managed startup enabled it fails clearly while REAPER is starting, rather than silently changing offline state. Without managed startup it initially chooses offline if unavailable. After a live connection, loss fails closed rather than editing offline state. Explicit offline remains available. Discovery lists offline editing capabilities and separately describes the supported live paths. Unsupported live operations fail explicitly. Set `REAPER_MCP_AUTOSTART=true` to start/reuse the isolated REAPER instance automatically while the MCP server runs. It checks again every 10 seconds after closure; it never kills a running session. Optional `REAPER_MCP_START_PROJECT` is a workspace-relative RPP opened on managed startup. Do not point it at a disposable temp file. Fourteen top-level tools remain exposed with writes enabled.

## Repeatable acceptance

```powershell
npm test
$env:REAPER_MCP_RUN_RENDER = 'true'
node scripts/reaper-headless-check.mjs
node scripts/alpha-check.mjs
```

The alpha script creates synthetic audio and a MIDI score, edits notes/gain, saves and reopens RPP, and renders a mix, source stems and a region. It asserts duration and audible gain through a bus. The score intentionally has no instrument, so its stem is silent. Each run creates new output directories and prints their paths. LUFS and true-peak values are analyser estimates, not certified meters.

## Recovery and removal

- `live_read_required`: read the live project before editing.
- `live_rejected`: inspect state and read again; project/bridge identity or revision may have changed.
- `live_timeout`: outcome is unknown. Inspect REAPER before retrying. The server never automatically replays a mutation.
- Requests use unique atomic mailbox files. A timed-out request cannot occupy a shared slot or be replayed. Expired requests are rejected by Lua. Heartbeat expiry reports unavailable while a modal dialog blocks REAPER; after the dialog is resolved the connection recovers.
- Render timeout: check the isolated profile for evaluation, missing plugin or other dialogs. Only the spawned render child is terminated.

To remove: stop the MCP entry and isolated REAPER instance, remove the client entry, and archive the dedicated bridge/profile folders. Keep compositions and render outputs. No normal REAPER startup entry needs removing.

## Still outside this alpha

Instrument replacement, live routing/FX parameter writes, live stems/regions, recording, take comping, general automation, arbitrary complex RPP conversion, Linux verification and cancellation tooling remain outside this alpha. Native MIDI creation, expressive performance insertion, guarded existing-note/keyswitch edits, scoped CC ramps and live mix section renders are included. See `performance-control.md` for source restrictions. No proprietary instruments or sample libraries are bundled.

## Codex registration and release checks

Install the packed tarball to a stable local prefix with `npm install --prefix <prefix> <tarball> --ignore-scripts`. Register with `codex mcp add reaper --env REAPER_MCP_WORKSPACE=<workspace> --env REAPER_MCP_BRIDGE_DIR=<workspace>/reaper-mcp-bridge --env REAPER_MCP_ALLOW_WRITES=true --env REAPER_MCP_AUTOSTART=true -- node <prefix>/node_modules/@sarutobi-sasuke/reaper-mcp/dist/src/stdio.js`. Check with `codex mcp get reaper --json`. Existing chats may need a new session or app restart to load the changed tool configuration; registration alone does not prove tools were hot-loaded.

`npm pack` builds the distribution. `npm publish` runs the check suite, but publication is a separate operator action. This alpha declares Windows support only. Installed package acceptance scripts are included; the development test suite requires the repository. `scripts/lifecycle-check.mjs`, with `REAPER_MCP_RUN_LIVE_CHECK=true`, launches disposable native sessions and verifies project-switch/restart guards, expired-request recovery and multi-client stale edits. Evaluation prompts may still require normal interaction; no licensing state is changed.

## Public-alpha acceptance

Run `scripts/windows-release-check.mjs` from an installed tarball with `REAPER_MCP_RUN_RELEASE_CHECK=true`. It creates a disposable workspace, uses REAPER's bundled ReaSynth, checks MIDI/CC/keyswitch readback, saves and renders audible audio, reconnects the MCP client, then restarts only its own test REAPER process and reopens the saved project. No personal catalogue or purchased library is needed. Evaluation/plugin prompts remain possible; no trial state is modified or bypassed. See [alpha.4 evidence](release-alpha-4.md).
