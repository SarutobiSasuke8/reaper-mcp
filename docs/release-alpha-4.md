# Windows alpha.4 release candidate

Date: 2026-11-16. Scope: Windows 10/11; native checks on Windows with REAPER 7.86 and Node 22.22.1. CI also checks Node 20 and 22 without requiring REAPER.

## Included

- Native instrument and track insertion, MIDI notes, CC expression ramps and named keyswitch articulations.
- Native project save/reopen and isolated full-mix WAV rendering.
- Explicit system-output and dummy-audio modes for new managed profiles; hidden startup requested by default.
- Package-derived MCP handshake and health versions.
- Conservative offline model editing, MIDI/WAV import, mix/stem/region rendering and audio measurements.
- Client reconnect, process restart and stale-edit guards.

## Evidence

- Typecheck and automated suite: 31 passed, 1 optional installed-REAPER test skipped. Native rendering is covered by the separate acceptance runs below.
- Fresh installed tarball, without the development checkout or private instruments: PASS. Bundled ReaSynth insertion, dry-run immutability, MIDI and articulation readback, 13 CC expression points, save, render, client reconnect, managed restart and reopen.
- Native render from that installed package: 4 seconds, 44.1 kHz stereo, peak -26.99 dBFS, zero clipped samples. Render worker completed in 24.3 seconds.
- Native lifecycle: PASS for project-switch guards, expired-request handling, heartbeat loss, existing-client reconnect after restart and concurrent-client revision checks.
- Offline mix/stem/region acceptance: PASS. Audio reaches its bus; mix and audio stem are 2 seconds at -26 dBFS, selected region is 1 second. The MIDI-only fixture has no instrument and is intentionally silent.
- System-output native probe: PASS. A fresh profile opened WaveOut / Microsoft Sound Mapper with no input channels; the probe ran an empty transport and queried REAPER directly. This verifies device opening, not a physical-speaker recording.
- GitHub Windows CI: Node 20 and Node 22 both passed checks and package creation.
- Runtime dependency audit: zero reported vulnerabilities.

Acceptance creates disposable workspaces and terminates only its own test processes. No Computer Use, personal configuration import or trial/licence-state changes were used.

## Boundaries

This is an alpha, not feature parity with REAPER. Existing-note/CC editing, live stem/region rendering, transport control, arbitrary FX parameters, instrument replacement and general automation remain follow-ups. The offline parser rejects unsupported complex project state. Optional instruments are separately installed and licensed. Native sample-library presets are not bundled.

Existing profiles are preserved. New audio-mode settings do not retroactively migrate their device configuration. Hidden launch is a Windows process-start request, not a guarantee that third-party plugin/licensing dialogs cannot appear. First-run plugin scanning and external library prompts can delay or block a session; the MCP reports unavailable rather than silently editing an offline project.

## Release procedure

1. System-audio probe and remote CI completed; rerun checks when changing runtime code.
2. Build and inspect `npm pack`, install it in a clean prefix, and run the installed acceptance script.
3. Merge the reviewed PR stack, then prepare a draft prerelease with the tarball and SHA-256 checksum.
4. Public distribution is separate: the repository is currently private; npm publication requires an authorised account for the package scope. Do not label a draft or local installation as publicly published.

Publication status: npm identity check returned HTTP 401 on 2026-11-16. No npm publication was attempted. Repository visibility remains private pending an explicit public-release action.
