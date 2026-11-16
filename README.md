# reaper-mcp

An agent-first MCP server for [REAPER](https://www.reaper.fm/), built by Alexei Udall.

**Status: pre-alpha. Private repository.** Nothing here is released yet.

## Purpose

- A small, well-shaped agent tool surface (about 12–15 tools, toolsets, describe/run) over REAPER, instead of hundreds of raw actions.
- Two modes:
  - **Offline:** write `.RPP` projects from a backend-neutral song model and render headlessly with `reaper -renderproject`.
  - **Live:** a small Lua bridge script in a running REAPER, with object-model get/set paths (for example `/tracks/2/fx/0/params/cutoff`), transport, and track, item, FX and MIDI operations.
- Ports the music logic and thinking from [lmms-mcp](https://github.com/SarutobiSasuke8/lmms-mcp): genre templates, groove, arrangement, DJ personas, vocal chops, evaluation and taste/audition. LMMS remains the free fallback backend.

## REAPER licensing

REAPER is commercial software from Cockos. This repository never contains or redistributes REAPER binaries. You need your own REAPER installation and licence (or evaluation).

## Licence

MIT. See [LICENSE](LICENSE).
