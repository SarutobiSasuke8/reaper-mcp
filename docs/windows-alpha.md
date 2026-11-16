# Windows alpha usage

Private review build; install REAPER separately. Tested with REAPER 7.86 and Node 20/22. No SWS, ReaPack, socket library or Python runtime is required by the bridge.

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

Omit `--project alpha.rpp` when starting an empty session, or substitute an existing workspace-relative RPP. Setup prints a client JSON entry. Launch opens a visible isolated REAPER profile and loads the bridge. It does not install a startup script or alter normal preferences. Complete any normal evaluation prompt, then run doctor. Dummy audio permits offline rendering; choose a real output device in this isolated profile if you want to hear playback. Never run two REAPER instances against the same bridge directory.

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
| live | Read project summary/tempo, tracks, track fields and FX inventory; set track name, volume_db, pan and mute; dryRun; native one-step undo |

Use `mode: offline` for composition and rendering. Offline state is separate from the open live project: there is no implicit synchronisation. Open the saved RPP in REAPER to inspect/play it. MIDI needs an instrument to sound; importing notes alone does not install one.

Use `mode: live` for live session work. First `reaper_get` `/tracks`, then `reaper_set` `/tracks/0/volume_db` with `value: -6` and `dryRun: true`. Repeat with false, inspect readback, and use REAPER Undo to restore it. Any project change since the read requires a fresh read. Native unrelated plugin and item state is untouched by these direct track-property edits.

`auto` probes the configured bridge and initially chooses offline if unavailable. After a live connection, loss fails closed rather than editing offline state. Explicit offline remains available. Discovery lists offline editing capabilities and separately describes the supported live paths. Unsupported live operations fail explicitly. Fourteen top-level tools remain exposed with writes enabled.

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
- `bridge_busy`: another client or an unresolved request owns the directory. Stop clients and the bridge first, inspect state, then archive the bridge folder and use a fresh one. Do not delete locks while another client is active.
- Render timeout: check the isolated profile for evaluation, missing plugin or other dialogs. Only the spawned render child is terminated.

To remove: stop the MCP entry and isolated REAPER instance, remove the client entry, and archive the dedicated bridge/profile folders. Keep compositions and render outputs. No normal REAPER startup entry needs removing.

## Still outside this alpha

Live MIDI/item creation, live routing/FX parameter writes, automation, arbitrary complex RPP conversion, Linux verification, cancellation tooling and the full portable music inventory remain incomplete. No release, package publication or merge has been performed.
