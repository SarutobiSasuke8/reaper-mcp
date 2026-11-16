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

Existing-note/CC editing, instrument replacement, live routing/FX parameter writes, live stems/regions, transport control, general automation, arbitrary complex RPP conversion, Linux verification and cancellation tooling remain outside this alpha. Native MIDI creation and expressive performance insertion are included. No proprietary instruments or sample libraries are bundled.

## Codex registration and release checks

Install the packed tarball to a stable local prefix with `npm install --prefix <prefix> <tarball> --ignore-scripts`. Register with `codex mcp add reaper --env REAPER_MCP_WORKSPACE=<workspace> --env REAPER_MCP_BRIDGE_DIR=<workspace>/reaper-mcp-bridge --env REAPER_MCP_ALLOW_WRITES=true --env REAPER_MCP_AUTOSTART=true -- node <prefix>/node_modules/@sarutobi-sasuke/reaper-mcp/dist/src/stdio.js`. Check with `codex mcp get reaper --json`. Existing chats may need a new session or app restart to load the changed tool configuration; registration alone does not prove tools were hot-loaded.

`npm pack` builds the distribution. `npm publish` runs the check suite, but publication is a separate operator action. This alpha declares Windows support only. Installed package acceptance scripts are included; the development test suite requires the repository. `scripts/lifecycle-check.mjs`, with `REAPER_MCP_RUN_LIVE_CHECK=true`, launches disposable native sessions and verifies project-switch/restart guards, expired-request recovery and multi-client stale edits. Evaluation prompts may still require normal interaction; no licensing state is changed.

## Public-alpha acceptance

Run `scripts/windows-release-check.mjs` from an installed tarball with `REAPER_MCP_RUN_RELEASE_CHECK=true`. It creates a disposable workspace, uses REAPER's bundled ReaSynth, checks MIDI/CC/keyswitch readback, saves and renders audible audio, reconnects the MCP client, then restarts only its own test REAPER process and reopens the saved project. No personal catalogue or purchased library is needed. Evaluation/plugin prompts remain possible; no trial state is modified or bypassed. See [alpha.4 evidence](release-alpha-4.md).
