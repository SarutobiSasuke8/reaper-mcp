# Windows alpha installation

Requires Windows 10/11, Node 20 or 22, and REAPER installed separately. An MCP client such as Codex supplies the agent interface. No SWS, ReaPack or Python is required.

## Install from npm

```powershell
npm install --prefix "$env:LOCALAPPDATA/ReaperMCP/app" @sarutobi-sasuke/reaper-mcp@0.1.0-alpha.6 --ignore-scripts
```

To install from GitHub instead, download the tarball from the [Windows alpha release](https://github.com/SarutobiSasuke8/reaper-mcp/releases/tag/v0.1.0-alpha.6) and verify it against the release checksum.

```powershell
npm install --prefix "$env:LOCALAPPDATA/ReaperMCP/app" ./sarutobi-sasuke-reaper-mcp-0.1.0-alpha.6.tgz --ignore-scripts
```

Create the workspace and register Codex using absolute paths. This example enables writes and managed REAPER startup.

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA/ReaperMCP/workspace"
codex mcp add reaper --env "REAPER_MCP_WORKSPACE=$env:LOCALAPPDATA/ReaperMCP/workspace" --env REAPER_MCP_ALLOW_WRITES=true --env REAPER_MCP_AUTOSTART=true --env REAPER_MCP_AUDIO_MODE=dummy -- node "$env:LOCALAPPDATA/ReaperMCP/app/node_modules/@sarutobi-sasuke/reaper-mcp/dist/src/stdio.js"
```

This example selects silent background composition; exported WAVs contain sound. For real-time speaker output use `REAPER_MCP_AUDIO_MODE=system` in a NEW workspace. Windows WaveOut default output is seeded without recording inputs. For interactive preferences, use `REAPER_MCP_SHOW_WINDOW=true`. REAPER remains a native process even when controlled without UI automation; first-run licensing or third-party plugin dialogs can require attention.

Existing profiles and open projects are never overwritten or killed by autostart. Switching audio modes does not modify an existing profile. Save work and change the managed profile's device preferences, or use a new dedicated workspace. Do not run two REAPER processes on one bridge directory.

Refresh/restart the MCP client after registration changes. Check `codex mcp get reaper --json`; registration is not proof of hot-loading in an existing chat. `--doctor` reports REAPER and bridge availability when the same environment is supplied.

## Instruments

REAPER's bundled ReaSynth can verify basic MIDI-to-audio operation. For orchestral sound, install your own instruments and samples. `REAPER_MCP_INSTRUMENTS` points to an absolute JSON catalogue; `REAPER_MCP_VST_PATHS` supplies semicolon-separated scan directories. See [native music workflow](live-music.md) and [performance control](performance-control.md).

## Development and verification

### Candidate acceptance from an MCP client

Use a fresh workspace and the candidate tarball from the Windows CI run. Install the tarball with the GitHub installation command above, substituting its actual filename and a separate installation directory. Point the client registration at that installation. Record the archive SHA-256 with `Get-FileHash` and the versions reported by REAPER and `reaper_health`. The following requests can be made in ordinary conversation with the client.

1. Ask for the active project, bridge state, write permission and support status of `live_add_gain_ride`. Expect a live connection and an experimental ride.
2. Ask for a new 120 BPM project with a stereo track, bundled ReaSynth and four quarter notes, one per beat. Save it as `baseline.rpp`, render a full stereo WAV and play it. Use the installed FX list to identify ReaSynth.
3. Ask to fork the saved project beside its source as `candidate.rpp`. Preview then apply a 6 dB ride over the second note using the track GUID, with zero dB anchors at 0.45 and 1.05 seconds. Save the edited candidate, render its full WAV and request a matched A/B of the first two seconds with both saved project paths attached. Listen to both copies.
4. Select B and retain the receipt. Close the saved candidate, restart the managed REAPER session, reopen the receipt's project, render again and verify the approved passage. For this stock synth, expect a pass. Verify the original WAV against the same receipt and expect a failure. Reopen the original project and check it has no ride.

Record the receipt, both verification results and any manual intervention. If startup or output differs, record the failing step and the health response. A second operator's completed run on the release archive is a v1 sign-off item.

### Developer checks

```powershell
npm ci
npm run check
$env:REAPER_MCP_RUN_RELEASE_CHECK='true'
node scripts/windows-release-check.mjs
```

The release check uses a disposable managed workspace and terminates only its own test instance. Optional render/lifecycle checks are described in [alpha usage](windows-alpha.md). Do not round-trip complex projects through the offline subset converter.
