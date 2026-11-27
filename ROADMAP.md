# REAPER MCP roadmap

Assessment: 16 November 2026. Owner: Alexei Udall. Implementation: Codex.
Current delivery: [draft PR #1](https://github.com/SarutobiSasuke8/reaper-mcp/pull/1).

## Production workflow priorities, 26 November 2026

Use an existing session and bundled plugins as the common benchmark. Score each workflow on completion, incorrect edits, recovery, elapsed time and agent calls. Keep the project, renders and version information together so another operator can reproduce the comparison. TwelveTake documents named undo steps and multi-step production tools. ReaMCP documents FX chains, automation and sends. These are benchmarks from their documentation. A comparative ranking still requires equivalent runs. [TwelveTake](https://github.com/TwelveTake-Studios/reaper-mcp) · [ReaMCP](https://github.com/danielkinahan/ReaMCP)

| Order | Producer task | Acceptance evidence |
| --- | --- | --- |
| 1. Adjust a plugin and hear the result | Discover controls, preview one edit, apply it to the intended instance and render the same passage twice. Implemented on this branch through the existing MCP tools. | Bundled ReaSynth fixture tests paged reads, unchanged preview, rejected identity and range errors, actual readback and a measured change in the rendered passage. |
| 2. Audition two versions and keep one | Guarded one-step FX revert is implemented on this branch. Add loudness-matched listening copies for choosing between renders. | Original renders survive. Listening copies match within 0.5 LU on a non-silent fixture. Reject revert after an intervening user edit. |
| 3. Mix across tracks | Add live sends, sidechains and native stem renders, followed by scoped FX automation. | A kick ducks a bass track only during the selected bars. Verify routing, render timing, effect on the bass stem and preservation of unrelated automation. |
| 4. Reproduce the result from a clean install | Give the same brief and project to each server on a second Windows machine. Record versions, cold-start time, interventions, task success and wrong edits. | Publish the fixture and results, including timeouts and recovery after a bridge restart. Add other platforms as they pass this suite. |

On Windows with REAPER 7.86 and Node 22.22.1, the packed-build check changed ReaSynth attack to 0.5 normalised. RMS on the same 1.25-second passage moved from -33.98 to -58.68 dBFS. The native undo test restored the control and rejected a reused token. This fixture measures a change in output. Listening preference and performance on other machines still need evaluation.

## Audition and mix benchmark results, 26 November 2026

The development branch now produces two aligned listening WAVs and an A/B project. A fresh install on a second Windows machine reproduced both native fixtures with REAPER 7.86. The original ReaSynth renders measured −31.14 and −55.41 LUFS. Both listening copies and both REAPER re-renders measured −18.00 LUFS. A separate FFmpeg EBU R128 check on the workstation measured −18.0 LUFS for each copy.

The routing fixture puts an 8-second bass under a kick present only from 2 to 4 seconds. A guarded send feeds ReaComp on channels 3/4. Its stereo bass stem changed by 0.00, −10.49 and 0.00 dB across the three measurement windows. Changing one existing ratio-envelope point restored 10.49 dB in the edited window, leaving the three control windows within 0.2 dB. The fixture checks the dry run, adjacent anchors, wrong GUIDs, duplicate routing, feedback rejection, duration and the absence of the kick from the uncompressed stem.

**Comparative result.** On the same workstation and input files, TwelveTake 1.11.0 also produced approximately 10.5 dB of ducking with matching outside levels. Its combined sidechain tool handles the routing and detector choice in one call. This establishes parity for the measured sidechain task. Audition preferences, larger sessions, other servers and broader agent task success still need separate runs. [Pinned reference server](https://github.com/TwelveTake-Studios/reaper-mcp/tree/3718e0158db96ca59aa9b5c982417770368bde0e)

For reproduction, install the tarball, set `REAPER_MCP_RUN_RELEASE_CHECK=true`, then run `node scripts/editing-check.mjs` and `node scripts/editing-check.mjs --routing` from the installed package. Each creates a disposable profile and a JSON report with timings, tool calls and audio measurements. The Windows PR check retains the listening copies. Add the `benchmark-sidechain` PR label before the next push to run the optional pinned comparison on that same runner. The two harnesses perform different checks, so their total durations and call counts are reported separately.

## What parity means

Practical parity means an agent can inspect a real session, compose and edit MIDI/audio, route tracks, control FX and automation, render, measure the result and undo its changes reliably. It does not mean copying every advertised tool name. Keep 12Ã¢â‚¬â€œ15 top-level tools, progressive discovery and explicit live/offline capability support.

Estimated remaining effort from the offline checkpoint: **18Ã¢â‚¬â€œ30 engineering days for practical workflow parity**, including integration and regression work; **35Ã¢â‚¬â€œ55 days total for broad advanced coverage**. These are planning estimates, not elapsed agent runtime or promised delivery dates. Assumptions: one engineer, existing music logic reusable after licence/source review, REAPER available for Windows and Linux testing, no native extension development. Confidence: medium-low until live and fresh-install rendering pass. The earlier 18/23 November targets are provisional v0 targets, not parity commitments.

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

## Initial checkpoint evidence and gaps (superseded by updates below)

Implemented: typed offline song model, conservative RPP read/write, MIDI/audio import, tempo map, sends, JSFX references, mix/stem/region job generation, WAV analysis, workspace confinement, read-only mode, dry-run edits and 14-tool MCP surface. At the initial checkpoint Node 20/22 each passed 15 tests with the installed-render test skipped.

Windows REAPER 7.86 produced a verified 1-second, 44.1 kHz stereo tone at -20 dBFS peak after interaction with an isolated audio-device startup prompt. This proves the generated audio project can render. It does **not** prove unattended fresh-install startup. Three earlier hidden attempts timed out. Linux execution is unverified. No normal user configuration or licence settings were changed.

Missing: live bridge, robust existing-project editing, native plugin discovery/parameters, automation, most music-library ports, native loudness cross-checks, cancellation/recovery and repeatable installation verification. RPP import intentionally rejects unsupported state instead of silently losing it.

## Delivery milestones

Effort ranges below sum to 18Ã¢â‚¬â€œ30 days. Each item is incomplete until its acceptance evidence exists. Phase PRs remain separate; stacked PRs name their base. No merge, publication or release is implied.

| Key / original phase | Remaining days | Acceptance criteria |
| --- | --- | --- |
| parity-render / P0Ã¢â‚¬â€œP1 | 2Ã¢â‚¬â€œ3 | Fresh isolated Windows and Linux renders; audible mix, bus-aware stems and regions; bounded timeout/cancel; no user config changes; actionable first-run diagnosis |
| parity-live / P2 | 3Ã¢â‚¬â€œ5 | Bounded Lua defer bridge, correlated atomic IPC, explicit mode and heartbeat; no silent fallback after dispatch; project identity guards; one undo block per mutation; dryRun; disconnected/stale/restart tests |
| parity-edit / P1Ã¢â‚¬â€œP2 | 3Ã¢â‚¬â€œ5 | Track/item/MIDI edits, sends and sidechains, FX discovery/parameters and automation; existing native project state preserved; live/offline workflow fixtures with declared unsupported capabilities |
| parity-music / P3 | 4Ã¢â‚¬â€œ7 | Map every entry in the existing 138-tool ASV inventory to ported, adapted, replaced, deferred or LMMS-only; source SHA and licence per module; theory/groove/arrangement/persona/style/DJ/audio workflows verified |
| parity-feedback / P4 | 3Ã¢â‚¬â€œ5 | Render/analyse/adjust/rerender fixtures; native stats cross-check; stable IDs, bounded batches, error recovery and before/after evidence; schema budget under 8k tokens |
| parity-package / P5 | 3Ã¢â‚¬â€œ5 | Node 20/22 Windows/Linux checks, clean install/doctor/uninstall, documented optional dependencies, real agent workflow evals, package inspection, no binary or credentials bundled |

Dependencies: live and render can progress independently; edit needs live for native-project coverage; feedback needs render+edit; packaging closes after all preceding acceptance. Music pure functions can progress independently, adapters need edit.

Advanced breadth adds approximately **17Ã¢â‚¬â€œ25 days**: takes/comping, detailed MIDI CC/pitch/program handling, tempo ramps, automation shapes/modulation, plugin-state preservation, larger-session performance, richer composition and reference-mix analysis. Full REAPER API coverage is not estimated as a finite parity commitment.

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

P0/P1 Windows render and the first P2 live slice now have evidence. Full live MIDI/item/routing/FX writes, Linux testing, project-switch/restart stress tests and P3 inventory ports remain open. Alpha is not full parity or completion of all P0â€“P5 phases.

## Reconnection and Codex registration, 16 November 2026

Protocol 2 replaces the poisoned shared request slot with unique atomic request files and a heartbeat. Managed startup reuses the isolated instance and relaunches after closure; it never kills unsaved sessions. Native lifecycle tests now pass for project-switch and restart stale-write guards, expired-request recovery and concurrent clients. A fresh installed-package acceptance run passed, and the exact enabled Codex registration discovered 14 tools and read the live project after managed restart.

Version 0.1.0-alpha.1 is prepared as Windows-only. Node 20/22 suites: 24 pass, 1 opt-in render skip, with separate native checks passed. Production dependency audit: 0 reported vulnerabilities. See RELEASE_CHECKS.md for evidence, boundaries and remaining human review/publication actions. Advanced live editing, P3 ports and Linux remain open; this is an alpha release candidate, not full parity.

## 2026-11-16: native composition pass

Implemented live track creation, catalogue instrument insertion, beat-based MIDI clips, note readback, native save/open and isolated mix render. Four-instrument real MCP proof passed. The surface remains 14 tools. See [live music](docs/live-music.md) for limits and [all 25 requested instrument/workflow additions](docs/instrument-roadmap.md) for staged priorities; BBC Discover is first.

Remaining: live MIDI CC/pitch bend and editing existing clips, preset browsing/replacement, live stems/regions, BBC/Ample installation and instrument-specific acceptance.


## 2026-11-16: Windows alpha.4 release readiness

PRs #1-#4 merged; stable Codex installation upgraded and verified live with 14 tools. Fresh installed-package composition/render/reconnect/restart acceptance and system-output probe passed without Computer Use. Node 20/22 Windows CI passed. Draft prerelease and checksum prepared; public visibility and npm authentication/publication remain operator actions. See [[RELEASE_CHECKS.md]] and [release evidence](docs/release-alpha-4.md).

The alpha includes MIDI CC ramps and named articulation insertion. Remaining engineering scope: editing existing notes/controllers, transport, live stems/regions, preset replacement, general automation, Linux, independent-machine native acceptance and broader portable music inventory. Paid libraries and vocal synthesis are optional integrations, not release dependencies.


## Public alpha and differentiation priorities, 2026-11-16

Repository is public and [Windows alpha.4](https://github.com/SarutobiSasuke8/reaper-mcp/releases/tag/v0.1.0-alpha.4) is published on GitHub. npm remains pending authentication and scope access.

The proposed next milestone is reliable musical iteration, not maximum action count. These are planned capabilities, not current promises:

1. **Edit existing performances safely.** Stable track/item/take identifiers, note and CC edits, articulation replacement, tempo-map edits and guarded multi-operation changes. Proof: repair a timpani ending in an existing native project while preserving unrelated tracks and plugin state; undo restores it.
2. **Audition revisions quickly.** Native region and stem rendering, before/after variants, loudness-matched listening previews and change reports. Proof: render only a changed eight-bar passage, compare it to the original, then commit the selected version without rebuilding the piece.
3. **Understand instruments.** Catalogue range, articulations, keyswitch timing, CC mappings, legato behaviour, latency and library availability. Proof: reject an unavailable articulation, detect silent/out-of-range parts and substitute only with an explicit explanation. Never claim a patch contains a technique it does not.
4. **Import and interpret scores.** MusicXML with voices, repeats, slurs, dynamics and tempo; measure-level provenance and separate score data from performance decisions. Proof: imported note/rhythm counts match a reference and humanisation remains reversible. PDF transcription is a separate uncertainty-bearing workflow.
5. **Make unattended operation dependable.** Structured startup/job progress, cancellation, actionable missing-plugin errors, safe session ownership and a second-machine acceptance matrix. Proof: recover from closed REAPER, absent samples and interrupted rendering without altering user work or taking desktop focus.

Keep the MCP surface compact, with capability discovery, predictable errors and bounded payloads. Add public example projects using bundled/free instruments, reproducible acceptance outputs and a short installation-to-render walkthrough. Vocal synthesis is a later adapter: audition score-driven singers first, then prove lyric/note alignment and export into REAPER before advertising integration.


## Musical iteration pass: alpha.5

Implemented under the existing 14-tool surface:

- [x] Read MIDI item/take identity and native event indices.
- [x] Edit existing note timing, duration, pitch, velocity and channel, preserving omitted fields.
- [x] Replace a known catalogue keyswitch with another named articulation.
- [x] Replace a bounded CC/channel interval with a sampled dynamics ramp, retaining unrelated events.
- [x] Render an absolute beat range plus optional tail into a unique snapshot/output directory for before/after comparison.
- [x] Reject wrong takes, invalid bounds, duplicate edits, overlapping ramps, repeated loops and pooled MIDI. Keep one native undo block and restore the MIDI buffer on API failure.

Acceptance uses a separately installed tarball, bundled ReaSynth and disposable hidden REAPER processes. See `scripts/editing-check.mjs` and `docs/performance-control.md`. npm authentication is independent of these local workflows.

This completes part of differentiation priorities 1 and 2. Remaining: tempo-map edits, general CC/note deletion, arbitrary automation curves, multi-item transactions, explicit MCP undo, stems, loudness-matched A/B previews, instrument-aware chase and musical acceptance on the full orchestral project. ReaSynth event/readback and audio tests do not certify every third-party library's articulation behaviour.
