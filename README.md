# reaper-mcp

An agent-first MCP server for [REAPER](https://www.reaper.fm/), built by Alexei Udall.

**Windows public alpha `0.1.0-alpha.6`.** Install from [npm](https://www.npmjs.com/package/@sarutobi-sasuke/reaper-mcp/v/0.1.0-alpha.6) or download the [GitHub prerelease](https://github.com/SarutobiSasuke8/reaper-mcp/releases/tag/v0.1.0-alpha.6).

Compose native MIDI tracks, insert configured instruments, shape CC dynamics and keyswitch articulations, save projects and render audio through 14 MCP tools. Offline workflows also support a conservative RPP subset, MIDI/WAV import, mix/stem/region rendering and audio measurements.

For development builds, see the [v1 capability classifications and release tests](docs/v1-contract.md).

Windows 10/11 with a separately installed REAPER is the supported alpha target. Native acceptance is tested on REAPER 7.86. [Install and configure](docs/install-windows.md), [supported operations and limits](docs/windows-alpha.md), [release evidence](docs/release-alpha-4.md).

```sh
npm ci
npm run check
```

See [Windows setup](docs/install-windows.md), [architecture](docs/architecture.md), [tool contract](docs/PROJECT_BRIEF.md), [headless evidence](docs/headless.md), and [port manifest](docs/porting.md).

RPP conversion currently supports audio items, MIDI notes, step tempo changes, explicit sends, JSFX references and markers/regions. Unknown structures fail explicitly; existing complex DAW projects are not safe to round-trip through this subset converter. The offline converter does not support arbitrary VST state, controllers, take lanes or automation. Use native live operations to preserve existing plugin state and insert CC/articulation performances.

## Quick start

On Windows, install REAPER separately and use Node.js 20 or 22. The server starts in read-only mode.

```powershell
$workspace = "$env:LOCALAPPDATA/ReaperMCP/workspace"
New-Item -ItemType Directory -Force $workspace
codex mcp add reaper --env "REAPER_MCP_WORKSPACE=$workspace" -- npx -y @sarutobi-sasuke/reaper-mcp@0.1.0-alpha.6
```

For another stdio client, use `npx` with arguments `-y @sarutobi-sasuke/reaper-mcp@0.1.0-alpha.6` and set `REAPER_MCP_WORKSPACE` to an existing absolute folder. See the [Windows setup guide](docs/install-windows.md) for write access, bridge setup and audio modes.

## Purpose

- A compact surface of 14 MCP tools, with capability discovery and guarded execution.
- Two modes:
  - **Offline:** write `.RPP` projects from a backend-neutral song model and render headlessly with `reaper -renderproject`.
  - **Live today:** Lua bridge inspection of projects, tracks and FX, plus guarded track name/gain/pan/mute edits. Native track/instrument insertion, MIDI clips, CC/dynamics ramps, named keyswitch articulations, guarded existing-note/keyswitch edits, scoped CC ramp replacement and save/reopen/section renders are also available. See [performance editing](docs/performance-control.md). The development branch adds guarded [live FX parameter editing](docs/windows-alpha.md#adjust-a-live-plugin). It also adds [loudness-matched A/B listening projects, sidechain sends, native stems and scoped FX automation](docs/windows-alpha.md#audition-two-versions-at-matched-loudness). Several edits can run as one undo step with `live_batch`, and tracks can be addressed by GUID; see [batches](docs/windows-alpha.md#several-edits-as-one-undo-step). Transport, markers and regions, the tempo map and audio items are covered in [arranging a live session](docs/windows-alpha.md#arrange-a-live-session).
- Builds on MIT-licensed audio-analysis and composition code from [lmms-mcp](https://github.com/SarutobiSasuke8/lmms-mcp). `live_compose_piece` writes a whole piece from a style or persona into the live project, and `live_write_part` writes single parts; see [composing](docs/windows-alpha.md#compose-in-a-live-session). `live_auto_mix` then balances the tracks and sets the loudness by measuring stems, and confirms the result on a fresh render; see [auto-mix](docs/windows-alpha.md#auto-mix-a-live-session). `live_build_dj_set` analyses WAV tracks and builds a beatmatched, harmonically ordered set on two decks; see [DJ sets](docs/windows-alpha.md#build-a-dj-set). `live_lint_arrangement` checks the notes for clashes and gives fixes, and `live_apply_groove` adds swing and humanise; see [notes](docs/windows-alpha.md#check-and-loosen-the-notes). Vocal workflows remain roadmap work.

## REAPER licensing

REAPER is commercial software from Cockos. This repository never contains or redistributes REAPER binaries. You need your own REAPER installation and licence (or evaluation).

## Licence

MIT. See [LICENSE](LICENSE).

Live composition: [MIDI and instrument workflow](docs/live-music.md). Optional additions: [instrument and workflow expansion plan](docs/instrument-roadmap.md).

Performance control and local quartet templates: [usage](docs/performance-control.md). BBC palette and solo-string limitations: [instrument reference](docs/bbc-discover.md).

`reaper_analyze` accepts an optional workspace-relative `referencePath` WAV, validated with the same path and size rules as `file`. When supplied, `referenceMatch` reports RMS level-match gain and band, slope and width deltas. Missing or undecodable references return a tool error.
