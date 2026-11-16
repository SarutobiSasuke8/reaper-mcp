# REAPER MCP contract

Local stdio server for agents composing and editing music. One mode-independent object vocabulary serves offline song data and, in phase 2, an explicitly installed live bridge. No network listener, shell tool, arbitrary Lua execution, downloads, publishing or licence management.

Derived from the house MCP template's tool-contract, error-boundary and protocol-testing patterns. Uses the same SDK 1.x dependency as LMMS MCP to retain its Node 20/22 stack; it does not copy the template's HTTP or publishing components.

## Surface

| Tool | Effect | Bounds and result |
|---|---|---|
| reaper_health | read | Mode availability, version |
| reaper_list_toolsets | read | Supported capability groups |
| reaper_enable_toolset | session write | Enable a named group |
| reaper_describe | read | Model/path schema with units and limits |
| reaper_find_capability | read | Bounded capability search |
| reaper_get | read | One supported object path |
| reaper_list | read | Up to 200 array members |
| reaper_set | write | Validated model edit, optional dryRun |
| reaper_project | write | New/open/save a project under workspace |
| reaper_import_midi | write | Bounded SMF import, preserves PPQ and tempo |
| reaper_import_audio | write | Bounded WAV import, duration in seconds |
| reaper_render | write | Isolated render job, WAV output, bounded timeout |
| reaper_analyze | read | WAV measurements from LMMS audio module |
| reaper_run | write | Enabled capability, validated arguments |

All tool names share the `reaper_` prefix. Results state `mode`. Offline is implemented first; explicit live requests must fail while unavailable. Auto fallback happens only before executing an operation, never after an ambiguous write failure.

Writes require `REAPER_MCP_ALLOW_WRITES=true`. File access stays within an operator-selected `REAPER_MCP_WORKSPACE`, including symlink resolution. Imported paths are data, never shell commands. The render executable is operator configuration, not a tool argument. New files never overwrite existing files. Imported RPP files are never executed automatically.

## Model

Track and item indexes are zero-based. MIDI notes use integer ticks with explicit PPQ, velocity 1–127, channel 0–15. Timeline audio and markers use seconds; tempo points use beats. Volume uses dB, pan is -1..1. Unsupported structures fail explicitly rather than being silently discarded when converting an external RPP.

## Checkpoints

P1: model, RPP round trips, offline rendering, MIDI/WAV import, measured audio, protocol tests. P2: live bridge parity. P3: source-attributed music ports. P4: expanded capability and schema guards. P5: packaging and launch review. Passing P1 does not prove later phases.
