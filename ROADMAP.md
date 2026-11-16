# REAPER MCP roadmap

Assessment: 16 November 2026. Owner: Alexei Udall. Implementation: Codex.
Current delivery: [draft PR #1](https://github.com/SarutobiSasuke8/reaper-mcp/pull/1).

## What parity means

Practical parity means an agent can inspect a real session, compose and edit MIDI/audio, route tracks, control FX and automation, render, measure the result and undo its changes reliably. It does not mean copying every advertised tool name. Keep 12â€“15 top-level tools, progressive discovery and explicit live/offline capability support.

Estimated remaining effort from the offline checkpoint: **18â€“30 engineering days for practical workflow parity**, including integration and regression work; **35â€“55 days total for broad advanced coverage**. These are planning estimates, not elapsed agent runtime or promised delivery dates. Assumptions: one engineer, existing music logic reusable after licence/source review, REAPER available for Windows and Linux testing, no native extension development. Confidence: medium-low until live and fresh-install rendering pass. The earlier 18/23 November targets are provisional v0 targets, not parity commitments.

## Comparison set

Primary repositories reviewed on 16 November. This is a capability benchmark set, not an independently measured popularity or quality ranking. README claims are not proof that every feature passes on Windows. No competitor implementation was copied.

| Reference | Relevant documented capabilities | Implication for this build |
| --- | --- | --- |
| [TwelveTake](https://github.com/TwelveTake-Studios/reaper-mcp) | Broad live track, item, take, MIDI, routing, FX, automation and rendering operations | Benchmark ordinary production workflows, including sidechains and plugin parameters |
| [xDarkzx](https://github.com/xDarkzx/Reaper-MCP) | Advertises 181 tools covering composition, mixing, mastering, batch editing and QC | Match useful workflows through capabilities, not 181 top-level schemas |
| [total-reaper-mcp](https://github.com/shiehn/total-reaper-mcp) | Broad API coverage and smaller selectable tool profiles | Retain compact discovery; exhaustive API coverage is a separate long tail |
| [reaper-daemon](https://github.com/wretcher207/reaper-daemon) | File IPC, undo, FX scanning, automation and before/after audio verification; separate write gates | Reliability, measured outcomes and explicit privileges are parity requirements |
| [mthines](https://github.com/mthines/reaper-mcp) | Installer, startup bridge, doctor, meters and mixing workflows | Installation and diagnosis need acceptance tests, not just documentation |
| [Orpheus](https://github.com/mal0ware/Orpheus) | Analysis and live editing, optional model backends; some edit-plan tools explicitly stubs | Distinguish implemented, hardware-dependent, optional and planned features |

DoomsdayxProductions/Reaper-MCP is excluded under the originating task. Optional model weights, paid plugins and non-commercial backends are not baseline dependencies.

## Current evidence and gaps

Implemented: typed offline song model, conservative RPP read/write, MIDI/audio import, tempo map, sends, JSFX references, mix/stem/region job generation, WAV analysis, workspace confinement, read-only mode, dry-run edits and 14-tool MCP surface. At the initial checkpoint Node 20/22 each passed 15 tests with the installed-render test skipped.

Windows REAPER 7.86 produced a verified 1-second, 44.1 kHz stereo tone at -20 dBFS peak after interaction with an isolated audio-device startup prompt. This proves the generated audio project can render. It does **not** prove unattended fresh-install startup. Three earlier hidden attempts timed out. Linux execution is unverified. No normal user configuration or licence settings were changed.

Missing: live bridge, robust existing-project editing, native plugin discovery/parameters, automation, most music-library ports, native loudness cross-checks, cancellation/recovery and repeatable installation verification. RPP import intentionally rejects unsupported state instead of silently losing it.

## Delivery milestones

Effort ranges below sum to 18â€“30 days. Each item is incomplete until its acceptance evidence exists. Phase PRs remain separate; stacked PRs name their base. No merge, publication or release is implied.

| Key / original phase | Remaining days | Acceptance criteria |
| --- | --- | --- |
| parity-render / P0â€“P1 | 2â€“3 | Fresh isolated Windows and Linux renders; audible mix, bus-aware stems and regions; bounded timeout/cancel; no user config changes; actionable first-run diagnosis |
| parity-live / P2 | 3â€“5 | Bounded Lua defer bridge, correlated atomic IPC, explicit mode and heartbeat; no silent fallback after dispatch; project identity guards; one undo block per mutation; dryRun; disconnected/stale/restart tests |
| parity-edit / P1â€“P2 | 3â€“5 | Track/item/MIDI edits, sends and sidechains, FX discovery/parameters and automation; existing native project state preserved; live/offline workflow fixtures with declared unsupported capabilities |
| parity-music / P3 | 4â€“7 | Map every entry in the existing 138-tool ASV inventory to ported, adapted, replaced, deferred or LMMS-only; source SHA and licence per module; theory/groove/arrangement/persona/style/DJ/audio workflows verified |
| parity-feedback / P4 | 3â€“5 | Render/analyse/adjust/rerender fixtures; native stats cross-check; stable IDs, bounded batches, error recovery and before/after evidence; schema budget under 8k tokens |
| parity-package / P5 | 3â€“5 | Node 20/22 Windows/Linux checks, clean install/doctor/uninstall, documented optional dependencies, real agent workflow evals, package inspection, no binary or credentials bundled |

Dependencies: live and render can progress independently; edit needs live for native-project coverage; feedback needs render+edit; packaging closes after all preceding acceptance. Music pure functions can progress independently, adapters need edit.

Advanced breadth adds approximately **17â€“25 days**: takes/comping, detailed MIDI CC/pitch/program handling, tempo ramps, automation shapes/modulation, plugin-state preservation, larger-session performance, richer composition and reference-mix analysis. Full REAPER API coverage is not estimated as a finite parity commitment.

## Required proof scenarios

- Offline composition: MIDI and audio through a bus, JSFX, tempo changes and regions; save, reopen and render with matching duration and audible output.
- Existing live session: inspect tracks/FX; dry-run then apply edits; verify readback; one undo restores prior state; unrelated native state survives.
- Mixing: inspect parameter units, apply a bounded change, compare measured output; distinguish measurement from subjective musical quality.
- Failure: dead bridge, stale reply, project switch, missing media/plugin, invalid route, timeout and failed write; no accidental replay or silent fallback.
- Installation: fresh Windows and Linux setup with documented first-run interaction, then unattended repeat runs. Evaluation prompts are never bypassed.

## Context and recording

Use the existing ASV `Workspace/Grok/Engineering/2026-11-16 Music tooling inventory.md` as the P3 checklist: 138 tools, 57 portable, 32 adapters, 49 LMMS-only; VST3 hosting extension #60 replaced by REAPER native hosting. Include Atelier instruments/DSP/drum-machine and persona/style data; grok-web authorship must remain distinct from Grok Build.

The uploaded Windows architecture guidance informs isolated configuration, Lua defer work, undo and native render statistics. SWS, ReaPack, themes and other extensions are optional until a specific accepted capability requires them. Lua sockets are not assumed to exist.

Mirrors: main vault `Portfolio/Dev/MCP Servers/REAPER MCP Parity Roadmap.md`; ASV execution roadmap; control-plane project `reaper-mcp` when created. At assessment time the project is absent and Codex has roadmap:write but lacks projects:write; project creation is already assigned to Claude Code by Lingxi. This is a recording dependency, not a build blocker.

## Windows alpha pass, 16 November 2026

Windows render startup fixed using REAPER-generated dummy audio settings. Fresh-profile tone PASS (1 s, 44.1 kHz, -20 dBFS); create/edit/save/reopen arrangement PASS with mix and source stem at -26 dBFS over 2 s, region at -26 dBFS over 1 s. Native live inspection, dryRun, gain/pan writes, one-step undo, stale-revision rejection and real stdio live session verified. Setup/launch/doctor and explicit mode documentation added. Automated Node 20/22 suites: 22 pass, 1 optional integration skipped; native acceptance scripts run separately and pass.

P0/P1 Windows render and the first P2 live slice now have evidence. Full live MIDI/item/routing/FX writes, Linux testing, project-switch/restart stress tests and P3 inventory ports remain open. Alpha is not full parity or completion of all P0–P5 phases.
