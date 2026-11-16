# Windows alpha installation

Requires Windows 10/11, Node 20 or 22, and REAPER installed separately. An MCP client such as Codex supplies the agent interface. No SWS, ReaPack or Python is required.

## Install a release tarball

Download the reviewed `.tgz` release artifact. Before npm publication, do not use an unverified `npx` package name.

```powershell
npm install --prefix "$env:LOCALAPPDATA/ReaperMCP/app" ./sarutobi-sasuke-reaper-mcp-0.1.0-alpha.4.tgz --ignore-scripts
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA/ReaperMCP/workspace"
```

Register Codex, using absolute paths:

```powershell
codex mcp add reaper --env "REAPER_MCP_WORKSPACE=$env:LOCALAPPDATA/ReaperMCP/workspace" --env REAPER_MCP_ALLOW_WRITES=true --env REAPER_MCP_AUTOSTART=true --env REAPER_MCP_AUDIO_MODE=dummy -- node "$env:LOCALAPPDATA/ReaperMCP/app/node_modules/@sarutobi-sasuke/reaper-mcp/dist/src/stdio.js"
```

This example selects silent background composition; exported WAVs contain sound. For real-time speaker output use `REAPER_MCP_AUDIO_MODE=system` in a NEW workspace. Windows WaveOut default output is seeded without recording inputs. For interactive preferences, use `REAPER_MCP_SHOW_WINDOW=true`. REAPER remains a native process even when controlled without UI automation; first-run licensing or third-party plugin dialogs can require attention.

Existing profiles and open projects are never overwritten or killed by autostart. Switching audio modes does not modify an existing profile. Save work and change the managed profile's device preferences, or use a new dedicated workspace. Do not run two REAPER processes on one bridge directory.

Refresh/restart the MCP client after registration changes. Check `codex mcp get reaper --json`; registration is not proof of hot-loading in an existing chat. `--doctor` reports REAPER and bridge availability when the same environment is supplied.

## Instruments

REAPER's bundled ReaSynth can verify basic MIDI-to-audio operation. For orchestral sound, install your own instruments and samples. `REAPER_MCP_INSTRUMENTS` points to an absolute JSON catalogue; `REAPER_MCP_VST_PATHS` supplies semicolon-separated scan directories. See [native music workflow](live-music.md) and [performance control](performance-control.md).

## Development and verification

```powershell
npm ci
npm run check
$env:REAPER_MCP_RUN_RELEASE_CHECK='true'
node scripts/windows-release-check.mjs
```

The release check uses a disposable managed workspace and terminates only its own test instance. Optional render/lifecycle checks are described in [alpha usage](windows-alpha.md). Do not round-trip complex projects through the offline subset converter.
