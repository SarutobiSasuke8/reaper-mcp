# reaper-mcp

An agent-first MCP server for [REAPER](https://www.reaper.fm/), built by Alexei Udall.

**Status: Windows public-alpha candidate, 0.1.0-alpha.4.** Package prepared for release; see the release evidence before publishing.

Compose native MIDI tracks, insert configured instruments, shape CC dynamics and keyswitch articulations, save projects and render audio through 14 MCP tools. Offline workflows also support a conservative RPP subset, MIDI/WAV import, mix/stem/region rendering and audio measurements.

Windows 10/11 with a separately installed REAPER is the supported alpha target. Native acceptance is tested on REAPER 7.86. [Install and configure](docs/install-windows.md), [supported operations and limits](docs/windows-alpha.md), [release evidence](docs/release-alpha-4.md).

```sh
npm ci
npm run check
```

See [Windows setup](docs/install-windows.md), [architecture](docs/architecture.md), [tool contract](docs/PROJECT_BRIEF.md), [headless evidence](docs/headless.md), and [port manifest](docs/porting.md).

RPP conversion currently supports audio items, MIDI notes, step tempo changes, explicit sends, JSFX references and markers/regions. Unknown structures fail explicitly; existing complex DAW projects are not safe to round-trip through this subset converter. The offline converter does not support arbitrary VST state, controllers, take lanes or automation. Use native live operations to preserve existing plugin state and insert CC/articulation performances.

## Purpose

- A small, well-shaped agent tool surface (about 12Ã¢â‚¬â€œ15 tools, toolsets, describe/run) over REAPER, instead of hundreds of raw actions.
- Two modes:
  - **Offline:** write `.RPP` projects from a backend-neutral song model and render headlessly with `reaper -renderproject`.
  - **Live today:** Lua bridge inspection of projects, tracks and FX, plus guarded track name/gain/pan/mute edits. Native track/instrument insertion, MIDI clips, CC/dynamics ramps, named keyswitch articulations and save/reopen/render are also available. Transport and FX parameter editing remain roadmap work.
- Ports the music logic and thinking from [lmms-mcp](https://github.com/SarutobiSasuke8/lmms-mcp): genre templates, groove, arrangement, DJ personas, vocal chops, evaluation and taste/audition. LMMS remains the free fallback backend.

## REAPER licensing

REAPER is commercial software from Cockos. This repository never contains or redistributes REAPER binaries. You need your own REAPER installation and licence (or evaluation).

## Licence

MIT. See [LICENSE](LICENSE).

Live composition: [MIDI and instrument workflow](docs/live-music.md). Optional additions: [instrument and workflow expansion plan](docs/instrument-roadmap.md).

Performance control and local quartet templates: [usage](docs/performance-control.md). BBC palette and solo-string limitations: [instrument reference](docs/bbc-discover.md).
