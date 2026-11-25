# Windows alpha.6 release scope

Windows-only local stdio package for Node.js 20 or 22. See the [installation guide](docs/install-windows.md) and [changelog](CHANGELOG.md) for the current version. The alpha.4 checks below are historical.

# Windows alpha.4 release readiness

Current checkpoint, 2026-11-16. Supersedes the historical checkpoints below.

Repository made public and GitHub Windows alpha.4 prerelease published with the reviewed tarball and SHA-256 checksum. npm remains unpublished pending account authentication and scope access.

- PRs #1, #2, #3 and #4 merged. Runtime/package version: 0.1.0-alpha.4.
- Windows GitHub CI passed on Node 20 and 22; local typecheck and 31 tests passed, with 1 optional native fixture skipped.
- Separate native checks passed: offline mix/stems/regions; bridge lifecycle/concurrent-client guards; fresh installed-package instrument/MIDI/CC/articulation creation, save, audible render, client reconnect, managed restart and reopen.
- Final installed native render: 4 seconds, 44.1 kHz stereo, -26.99 dBFS peak, zero clipped samples, 38.5-second render worker.
- New system-audio profile probe passed: WaveOut / Microsoft Sound Mapper opened. Background dummy mode is explicit; render workers remain silent. Existing profiles are preserved.
- Stable local installation upgraded. A fresh client through the registered Codex transport reports alpha.4, 14 tools and live availability.
- Runtime dependency audit: zero reported vulnerabilities.
- GitHub prerelease published with tarball and SHA-256 checksum; repository is public. npm identity check returns 401, so registry publication remains pending.

See [release evidence and limits](docs/release-alpha-4.md), [installation](docs/install-windows.md) and [draft releases](https://github.com/SarutobiSasuke8/reaper-mcp/releases).

Remaining distribution actions: authenticate an npm account with scope access and publish the reviewed tarball with the alpha dist-tag. These are distinct from technical alpha readiness. Native speaker capture and independent-machine REAPER acceptance are not claimed.

## Historical checkpoints

# 0.1.0-alpha.1 Windows release checks

Observed 16 November 2026. Technical candidate for an explicitly labelled Windows alpha, not stable or full parity. Publication, repository visibility, tagging and merging are separate operator actions and have not occurred.

| Check | Evidence |
| --- | --- |
| TypeScript and unit/protocol tests | Node 22.22.1 and 20.20.2: 24 pass, 1 opt-in native render skip; native tests run separately below |
| Native lifecycle | REAPER 7.86: project switch rejects stale write; expired request has no effect and does not block; heartbeat expires after process closure; same client reconnects after restart; old-session write rejected; fresh read enables writes; concurrent-client stale revision rejected |
| Exact Codex registration | Enabled global `reaper` entry; stable installed package; stdio handshake; 14 tools; managed startup reaches live 3-track alpha project |
| Native live edits | Dry-run unchanged, gain edit/readback, FX listing; one-step native undo and stale revision rejection previously verified |
| Installed-package render | Create/edit/save/reopen passed; 2-second mix and audio source stem at -26 dBFS through bus; 1-second region at -26 dBFS; MIDI score preserved, intentionally no instrument in fixture |
| Package | Fresh local-prefix install from tarball with scripts disabled succeeded; compiled server, Lua bridge, licence, docs and native check scripts included; source/installed bridge SHA256 matched |
| Dependency audit | npm production audit: 0 vulnerabilities reported |
| Targeted content check | No local user-path or credential-shaped matches in src/bridge/docs/README/THIRD_PARTY scan; this is not an independent security audit |
| npm access | Registry package lookup returned 404 (absent or inaccessible); `npm whoami` returned 401 Unauthorized. Publish access is not verified and requires operator authentication. No upload attempted. |
| Git | Changes remain in reviewed-workflow PRs; no merge, tag, npm upload or visibility change |

## Release scope and remaining limits

- Windows only (`os: win32`); REAPER installation/evaluation or licence is the user's responsibility. Startup dialogs may still require normal interaction.
- Offline composition/render and live track controls are separate models; no implicit synchronisation. Live MIDI/item creation, routing/FX parameter writes and automation are not promised.
- Native bootstrap/reconnect checks use disposable isolated projects. Autostart never kills a running process to clear a dialog or stalled bridge.
- No claim of listening quality from numerical audio tests. LUFS/true peak are estimates.
- Codex registration is verified through its exact configured transport. A pre-existing chat may require a new session or app restart to refresh its tool inventory.
- The full portable music inventory and Linux verification remain roadmap items.

## Operator publication steps

Review PR #1 and stacked PR #2, merge approved changes, build from the reviewed commit, rerun `npm run check`, run the native checks on Windows, inspect `npm pack --dry-run`, and verify npm scope access before uploading the selected tarball with an alpha dist-tag. No publish credential is stored by this build. Do not publish it as a stable release or advertise unsupported features.

## 2026-11-16 native composition release check (alpha.2)

- 27 unit/protocol tests passed on Node 22.22.1; 1 opt-in legacy render fixture skipped.
- Real MCP music check passed against both source and installed package: piano/bass/drums/Surge creation, dry runs, MIDI readback, save/reopen and native render. Installed run also checks duplicate instrument rejection.
- Installed output: 11.6 seconds, 44.1 kHz stereo, -22.98 dBFS sample peak, zero clipped samples; every instrument section non-silent. LUFS/true peak remain analyser estimates.
- Exact enabled Codex registration passed: installed transport, 14 tools, live project, MIDI schema and piano catalogue entry. Tool timeout set to 240 seconds for native render jobs.
- Package 0.1.0-alpha.2: 48 files, 58.4 kB; SHA1 3fc84fc65b52b0890630edef4b51a22fa8d5db91. Production audit: 0 vulnerabilities.
- PR #3 is stacked on PR #2. No merge, npm publish, tag or repository visibility change. Prior npm authentication blocker remains.
- New pass tested on Windows only. Current chat has no hot-loaded REAPER tool namespace; actual MCP stdio client execution was verified. New Codex chat/app refresh may be needed for tool discovery.
