# reaper-mcp

An agent-first MCP server for [REAPER](https://www.reaper.fm/), built by Alexei Udall.

**Status: Windows public alpha, 0.1.0-alpha.4.** [Download the GitHub prerelease](https://github.com/SarutobiSasuke8/reaper-mcp/releases/tag/v0.1.0-alpha.4). The npm package is [`@sarutobi-sasuke/reaper-mcp`](https://www.npmjs.com/package/@sarutobi-sasuke/reaper-mcp) on the `alpha` dist-tag.

Compose native MIDI tracks, insert configured instruments, shape CC dynamics and keyswitch articulations, save projects and render audio through 14 MCP tools. Offline workflows also support a conservative RPP subset, MIDI/WAV import, mix/stem/region rendering and audio measurements.

Windows 10/11 with a separately installed REAPER is the supported alpha target. Native acceptance is tested on REAPER 7.86. [Install and configure](docs/install-windows.md), [supported operations and limits](docs/windows-alpha.md), [release evidence](docs/release-alpha-4.md).

```sh
npm ci
npm run check
```

See [Windows setup](docs/install-windows.md), [architecture](docs/architecture.md), [tool contract](docs/PROJECT_BRIEF.md), [headless evidence](docs/headless.md), and [port manifest](docs/porting.md).

RPP conversion currently supports audio items, MIDI notes, step tempo changes, explicit sends, JSFX references and markers/regions. Unknown structures fail explicitly; existing complex DAW projects are not safe to round-trip through this subset converter. The offline converter does not support arbitrary VST state, controllers, take lanes or automation. Use native live operations to preserve existing plugin state and insert CC/articulation performances.

## Quick start

Install REAPER separately, then register the server with your MCP client over stdio. With Codex on Windows:

```powershell
codex mcp add reaper --env "REAPER_MCP_WORKSPACE=$env:LOCALAPPDATA/ReaperMCP/workspace" --env REAPER_MCP_ALLOW_WRITES=true -- node "<install dir>/node_modules/@sarutobi-sasuke/reaper-mcp/dist/src/stdio.js"
```

Any stdio client works the same way: command `node`, the path to `dist/src/stdio.js` as its argument, and `REAPER_MCP_WORKSPACE` set to the absolute path of an existing folder. The seven write tools are only registered when `REAPER_MCP_ALLOW_WRITES=true`; without it the server is read-only. Full options, audio modes and autostart are in [Windows setup](docs/install-windows.md).

## Tools

| Tool | What it does |
| --- | --- |
| `reaper_health` | Report offline/live availability and REAPER installation status |
| `reaper_list_toolsets`, `reaper_enable_toolset` | List and enable capability groups for the session |
| `reaper_describe`, `reaper_find_capability` | Describe a song, object path or capability with its schema; search capabilities |
| `reaper_get`, `reaper_list` | Read an object path or a bounded page of an array path |
| `reaper_set` | Set an existing object path after validating the whole song (`dryRun` validates only) |
| `reaper_project` | Create, open or save a song JSON/RPP project; saving never overwrites |
| `reaper_import_midi`, `reaper_import_audio` | Import MIDI notes or a WAV item |
| `reaper_render` | Render a mix, stems or regions to WAV with a separately installed REAPER |
| `reaper_analyze` | Measure a WAV (LUFS and true-peak estimates) |
| `reaper_run` | Run an enabled capability after `reaper_describe`, with schema-checked arguments |

All file arguments are workspace-relative; paths that leave the workspace, including through symlinks, are rejected.

## Purpose

- A compact surface of 14 MCP tools, with capability discovery and guarded execution.
- Two modes:
  - **Offline:** write `.RPP` projects from a backend-neutral song model and render headlessly with `reaper -renderproject`.
  - **Live today:** Lua bridge inspection of projects, tracks and FX, plus guarded track name/gain/pan/mute edits. Native track/instrument insertion, MIDI clips, CC/dynamics ramps, named keyswitch articulations guarded existing-note/keyswitch edits, scoped CC ramp replacement and save/reopen/section renders are also available. See [performance editing](docs/performance-control.md). Transport and FX parameter editing remain roadmap work.
- Builds on MIT-licensed audio-analysis code from [lmms-mcp](https://github.com/SarutobiSasuke8/lmms-mcp). Broader genre, arrangement and vocal workflows remain roadmap work.

## REAPER licensing

REAPER is commercial software from Cockos. This repository never contains or redistributes REAPER binaries. You need your own REAPER installation and licence (or evaluation).

## Licence

MIT. See [LICENSE](LICENSE).

Live composition: [MIDI and instrument workflow](docs/live-music.md). Optional additions: [instrument and workflow expansion plan](docs/instrument-roadmap.md).

Performance control and local quartet templates: [usage](docs/performance-control.md). BBC palette and solo-string limitations: [instrument reference](docs/bbc-discover.md).
