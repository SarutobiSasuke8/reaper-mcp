# Headless evaluation checkpoint

## Current result: blocked, not verified

On 16 November 2026 the Windows 7.86 installation was found. Three isolated one-second tone render probes timed out after 30 seconds each. The generated resource directories contained REAPER startup resources but no completed output WAV. A native-window inventory during the second probe exposed no REAPER window. The cause remains undiagnosed: startup, a device prompt, an evaluation prompt or another modal condition may be responsible. Do not label this as a successful unattended render or a confirmed licence problem.

The prior Windows comparison from 15 November did render audio after a first-run audio-device prompt was manually dismissed. Its minimal audio RPP structure is represented by `test/fixtures/audio-project.rpp`. That prior result does not verify the new isolated configuration.

## Reproduce

```powershell
npm ci
npm run build
$env:REAPER_MCP_RUN_RENDER = 'true'
node scripts/reaper-headless-check.mjs
```

Without the opt-in flag or a detected REAPER installation the script prints SKIP. It never downloads REAPER. With the flag it creates a synthetic one-second tone, launches a separate instance, checks process completion, output existence, duration and audibility, then prints PASS or FAIL with measurements. A timeout terminates only the child it launched, not another REAPER session.

Invocation: `reaper -newinst -nosplash -cfgfile <job>/isolated.ini -renderproject <job>/mix.rpp -close:nosave:exit`. The configuration is generated without reading the user's normal preferences or licence. Its device values are candidates, not a verified portable setup. Auto-close render uses bit 0 (`renderclosewhendone=1`). No nag, trial-state or licence fields are changed.

Each job currently creates a fresh resource directory; startup resource copying is an efficiency issue to address after a working configuration is established. A validated persistent agent resource directory may be preferable, with fresh project/output directories per job.

## Outstanding P0 evidence

- Diagnose the Windows startup in an explicitly visible isolated test instance; verify dummy-device configuration and process exit.
- Run Linux x86_64 official REAPER evaluation with Xvfb and compare the official WDL NOGDK build. No Linux runtime is provisioned for this work; only Docker Desktop appears in WSL. No VPS connection or new distribution was installed.
- Record evaluation-nag behaviour as observed. Expired-trial behaviour is untested and must not be simulated by modifying licence or trial state.
- Record real mix/stem/region renders and timing. Current source-stem rendering preserves downstream sends but needs native parity evidence for buses, sidechains and instrument FX.

No binary, installer, generated resource directory or licence file belongs in this repository.
