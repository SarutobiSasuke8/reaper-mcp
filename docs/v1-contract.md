# Windows v1 support contract

This is the development contract for the alpha.7 candidate. The published alpha.6 predates it. A stable operation is in the proposed v1 compatibility surface. An experimental operation is available for use and its behaviour or schema can change before v1. Deferred operations have no v1 support commitment.

## Runtime and discovery

The supported target is Windows 10/11 x64 with Node 20 or 22. Native release fixtures use separately installed REAPER 7.86 x64, its bundled instruments and the packaged Lua bridge, protocol 3. Initialise a local workspace and enable writes explicitly for editing. In read-only mode clients can inspect state. The editing toolset must be enabled before running capabilities. Local stdio is the supported transport.

Use reaper_health to check the package version, required bridge protocol, bridge state, installation and write permissions. An absent heartbeat indicates a missing, stopped or stale bridge. An outdated state indicates an incompatible heartbeat. Save work before restarting the managed session with the matching bridge. Explicit live requests fail when the bridge is unavailable. Explicit offline operations use the workspace model. Inspect the reported mode when using auto selection.

Use reaper_find_capability with an empty query for the complete inventory. Each entry gives its modes, maturity and named acceptance check. reaper_describe returns the same contract beside the argument schema. Capabilities share the existing 14 top-level tools.

| Support | Operations | Evidence |
|---|---|---|
| Stable core | Health, discovery, read/list, guarded writes, supported project save/open and offline MIDI/audio import, mix render, offline stem/region render and WAV measurement | contract-check.mjs, alpha-check.mjs, windows-release-check.mjs, protocol and render tests |
| Stable editing | Typed offline edits, native MIDI and catalogue instrument insertion, guarded performance/FX edits, sends, selected-track stem rendering, atomic batches and matched WAV audition | editing tests, windows-release-check.mjs, editing-check.mjs including routing, batch-check.mjs |
| Experimental | Saved candidate forks, selecting a full render with its associated RPP, arrangement and transport commands, general FX insertion/removal and FX automation writing | windows-release-check.mjs, arrange-check.mjs, dj-check.mjs |
| Experimental | Composition, groove, arrangement lint, auto-mix, DJ analysis and set building | compose-check.mjs, feel-check.mjs, automix-check.mjs, dj-check.mjs |
| Deferred | Recording/comping, arbitrary offline RPP rewriting, macOS/Linux certification, universal third-party patch certification and live region-batch rendering | Reassess after the Windows core passes release acceptance |

Stable scope follows the individual operation's documented limits. Offline conversion supports a conservative RPP subset. Open native projects in REAPER to retain third-party FX state. Track indices can change; use track/take GUIDs and read the current project before editing. A stale revision or missing output is an error. After a timeout inspect the session before retrying a mutation. Optional libraries require a working local installation.

## Candidate workflow

1. Save the source RPP. Preview fork_saved_project with source and candidate workspace paths in the same directory. Apply with the returned sourceSha256. A sibling copy preserves relative media references; external media and plugin installations are shared dependencies.
2. Open the copy, make a guarded edit and save to a new filename. Render source and edited project to separate full WAVs.
3. Pass the aligned WAVs, a section in seconds and optionally projects.a and projects.b to audition_ab. The project paths are caller-supplied associations. The audition records their file fingerprints.
4. Use select_audition_render with the manifest and choice. A changed WAV or associated RPP invalidates the selection. The selection receipt identifies the full audio and editable project for reopening. File hashes cover the RPP and WAV themselves; external media, plugin versions and sample libraries have separate lifecycles.

For a deterministic source, independently render the selected project and call `verify_audition_render` with the selection receipt and new full WAV. The check requires aligned full renders and compares samples inside the approved interval. A relative RMS error above 1% fails. If delivery gain changed, supply that known adjustment in dB. This checks reproducibility; variable sample playback can still require a listening decision. Keep the exact approved WAV when delivery must reproduce that take.

## Scoped gain automation

The experimental `live_add_gain_ride` appends the bundled Volume/Pan Adjustment JSFX to a stereo track by GUID. Supply increasing positions in seconds, quarter notes or zero-based fractional bars and a zero dB first and last point. Preview returns the times resolved against the project's current tempo map. A named instance prevents duplicate application with the same ride ID. The ride affects downstream audio, including post-FX sends. Remove it with the returned FX GUID and index. Applying it requires stopped transport, enabled track FX and trim/read or read automation.

## Release evidence

The read-only `reaper_analyze` accepts a section in seconds. It measures loudness, peaks, clipping, spectrum and stereo image on that interval. If a reference WAV is supplied, the same time window applies to both files. Both must contain the full interval.

### Recoverable mix renders

Enable editing, read the live project and call `start_render_job` with an optional beat section and timeout. It captures a full native snapshot before returning the job ID. Use `reaper_get` on its statusPath, or list `/render_jobs` after a disconnect. Use offline mode for these reads when the bridge is down. States include queued, rendering, cancelling, cancelled, interrupted, failed and completed. Only completed attempts return a delivery path. Each attempt checks the complete PCM WAV structure, channel layout, sample rate and duration before publishing it. The current job format is stereo 24-bit PCM RIFF at 44.1 kHz.

`control_render_job` accepts a job ID, the attempt number from status and either cancel or retry. A detached worker controls only its own render process. Retry uses the fingerprinted RPP and a fresh destination. External sample files and plugin installations remain dependencies. A renderer interrupted outside the MCP may still finish its private attempt without publishing it. Existing synchronous stem, mix and offline region renders retain their original interface.

## One-request gain audition

For an edit and audition in one request, preview `audition_gain_ride` with source and candidate sibling RPP paths, ride arguments and an optional listening section in seconds. Apply with the source fingerprint. The MCP opens a private REAPER session, captures separate full-mix jobs and saves the editable candidate. The response includes the matched listening copies or the job states if the wait expires. After reconnecting, pass `resume` with the candidate filename followed by `.audition.json`. Retry any failed render through its job ID. Select A or B explicitly with `select_audition_render`. The existing audition size limit is 64 MB per full input WAV.

## Instrument readiness

`probe_instrument` accepts a catalogue ID or a workspace-relative saved project and instrument track GUID or unique exact track name. A private REAPER instance loads the catalogue entry or copies just the saved track's instrument onto a fresh track. It plays the requested note on a zero-based MIDI channel with velocity, CC1 and CC11, saves a probe project, renders it and repeats the render in a newly started REAPER process. The report includes host FX/preset observations, two WAVs and note-window RMS levels. The default pass criterion is above −80 dBFS RMS in both renders. Silence identifies a failed test with those inputs. The result alone cannot distinguish an empty patch, channel assignment, sample-loading problem or a note outside the playable range. Track names are producer labels and a sampler may expose only a generic preset name.

## Release evidence

The candidate incorporates the quick start proposed in PR #8 and the registry identifier and metadata from PR #9. Those earlier drafts reference superseded package details. The quick start points at the published alpha.6, while the candidate registry metadata tracks the packed alpha.7.

The Windows workflow installs the packed tarball and exercises discovery over stdio on Node 20 and 22. The native job downloads the Node 22 artifact, starts isolated REAPER, tests restart/reopen and candidate selection, and runs the offline render, batch rollback, lifecycle, editing and routing fixtures. It runs for PRs, main, tags and manual dispatch. Unit, package and native results are separate. The Node 22 job also upgrades an alpha.6 installation in place and reopens its saved MIDI project. A second operator's clean-install run remains a release sign-off step.

Auto-mix verification reports passed, failures and the achievable loudness target. Any measured ceiling overshoot or clipping fails verification. The allowed loudness error is 1 LU. Inspect the result and its undo label before deciding whether to keep a failed mix.
