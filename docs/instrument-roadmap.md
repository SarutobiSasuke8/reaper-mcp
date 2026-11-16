# Instrument and workflow expansion plan

Reviewed 16 November 2026. This records every item requested by Alexei; it is not a bulk-install instruction. Priorities below are recommendations. No new products from this list were installed during this pass.

## Existing baseline and audit scope

Confirmed: REAPER 7.86 stock instruments/effects, Surge XT 1.3.4 with 3,008 presets, sfizz 1.2.3, Splendid Grand Piano, D. Smolken plucked/bowed bass, and Virtuosity Drums. Native audio tests already exist for piano, bass, synth and drums.

Checked standard system/user VST3 locations, the normal REAPER UserPlugins/Scripts/ColorThemes locations, managed test profile plugin caches, and common application install directories. Of the requested additions, only Surge XT was found. **Not found means not found in those locations**, not proof that no portable copy or installer exists anywhere. Existing LMMS Decent Sampler preset files are not evidence that the player or their referenced samples are installed; the inspected Salamander sample path is missing.

## Recommended stages

1. Finish MCP composition and saved-project rendering with the existing library.
2. BBC Symphony Orchestra Discover first, then Ample Guitar M Lite and Ample Bass P Lite to fill actual acoustic gaps. Add SPAN and Youlean for human mix checks. Account-based downloads remain a separate setup step.
3. ReaPack and SWS for manual workflows; js_ReaScriptAPI only for scripts that require it. These are optional, not core MCP dependencies.
4. Decent Sampler plus a small, licensed selection of libraries; Dexed for a distinct FM sound. Compare Berlin Free Orchestra after trying BBC, rather than acquiring overlapping orchestras immediately.
5. Add alternate synths, drum kits and workflow scripts when a track or editing task demonstrates a need. Keep demo/licence-restricted tools out of the default production template.

## Extensions, scripts and meters

| Requested item / primary source | Existing evidence | Recommendation and conditions |
|---|---|---|
| [SWS / S&M](https://sws-extension.org/) | Not found | High-value optional extension; free/open source. Install after core MCP proof, then confirm API availability in the actual managed resource path. |
| [ReaPack](https://reapack.com/) / [source](https://github.com/cfillion/reapack) | Not found | High-value package manager. Install to the intended REAPER resource profile; add only trusted repositories and required scripts. |
| [js_ReaScriptAPI](https://github.com/juliansader/ReaExtensions) | Not found | Dependency-driven. Use the release repository through ReaPack; the similarly named js_ReaScriptAPI repository also contains experimental builds. |
| [Reapertips Theme](https://www.reapertips.com/products/reapertips-theme) | Not found | Optional visual preference, no MCP capability gain. Pay-what-you-want including zero; checkout email route. Keep a theme backup before switching. |
| [Global Sampler / BirdBird repository](https://github.com/Bird-Bird/ReaScript_Testing) | Not found | Useful for capturing sound-design improvisation. Defer until sampling workflow; inspect package dependencies and recording behaviour before enabling. |
| [nvk_SEARCH](https://nvk.tools/search/) / [docs](https://nvk.tools/docs/search/) and Quick Adder | Not found | Useful human FX/action/template search. Current nvk_SEARCH is free/pay-what-you-want including zero, with a Gumroad licence key. Requires ReaPack, SWS, ReaImGui and js_ReaScriptAPI; updates through ReaPack. “Quick Adder” is recorded separately as an ambiguous name; confirm exact author/package before installation. |
| MK Slicer | Not found | Useful for transient slicing, quantisation and breakbeat work. Defer until audio-loop editing; verify exact current ReaPack package/author and dependencies at install time. Current primary package identity was not resolved in this review. |
| [LKC Variator](https://lkc.studio/) / [LKC tools](https://www.lkctools.com/reascripts) | Not found | Useful for SFX/game-audio variation. Classic is open-source but deprecated; Variator 2 advertises free and paid tiers with beta access. Record version explicitly; do not assume the classic ReaPack workflow applies to v2. |
| [Voxengo SPAN](https://www.voxengo.com/product/span/) | Not found | Next utility: free spectrum/stereo analysis. Human visual aid; MCP still needs explicit measurement APIs for automated feedback. |
| [Youlean Loudness Meter](https://youlean.co/youlean-loudness-meter/) | Not found | Next utility: free loudness/true-peak checking; distinguish Free from Pro features. Cross-check the MCP analyser's estimated LUFS rather than treating estimates as equivalent. |

## Instruments

| Requested item / primary source | Existing evidence | Recommendation and conditions |
|---|---|---|
| [Vital](https://vital.audio/) | Not found | Later: free Basic tier, strong wavetable sound design but overlaps Surge. Choose when a patch workflow calls for it. |
| [Surge XT](https://surge-synthesizer.github.io/downloads/) | Installed and audio-tested | Keep as primary synth; preserve adjacent factory data. Already covers broad bass/pad/lead/keys territory. |
| [u-he TyrellN6](https://u-he.com/products/tyrelln6/) | Not found | Later: free analogue-style palette. Official page currently labels the release Beta; test the selected build before relying on it. |
| [discoDSP OB-Xd](https://www.discodsp.com/en/obxd/) | Not found | Hold: current free trial explicitly prohibits commercial use; do not categorise as an unrestricted free production instrument. A licence is a separate purchase decision. |
| [Dexed](https://asb2m10.github.io/dexed/) | Not found | Medium priority: free GPL DX7-style FM adds a distinct palette and supports DX7 cartridges. Check rights for imported third-party patch banks. |
| [Steven Slate Drums 5.5 Free](https://stevenslatedrums.com/ssd5/free) | Not found | Later: one Deluxe 2 kit plus presets, account download. Useful alternative to jazz-oriented Virtuosity; validate mapping before reusing GM arrangements. |
| [MT Power DrumKit 2](https://www.powerdrumkit.com/) | Not found | Later alternative for processed pop/rock drums. Free product; check first-run prompts and MIDI mapping in unattended rendering. Choose this or SSD initially, not both. |
| [Sitala](https://decomposer.de/sitala/faq.html) | Not found | Optional one-shot drum workflow. Version 1 remains free; Sitala 2 is paid. The statement “Sitala is fully free” needs this version qualifier. |
| [TAL-Drum](https://tal-software.com/products/tal-drum) | Not found | Defer: paid sampler with a demo, not a permanent free production dependency. Current product has 64 pads; no need while sfizz/RS5k cover immediate sampling. |
| [Spitfire LABS / Splice INSTRUMENT](https://splice.com/instrument) | Not found | Medium priority for textures and unusual sounds. LABS has transitioned to INSTRUMENT; distinguish the free library from subscription/premium sounds. Record account, entitlement and offline/reopen behaviour per selected pack. |
| [Decent Sampler](https://www.decentsamples.com/product/decent-sampler-plugin/) | Preset files found; player not found | Medium priority for Pianobook/community libraries. Player availability does not grant rights to every library. Some old presets reference absent samples; repair/library acquisition is a separate task. Product page was blocked to this research client; verify current installer/licence when installing. |
| [BBC Symphony Orchestra Discover](https://www.spitfireaudio.com/products/bbc-symphony-orchestra-discover) | Not found | **First new instrument priority, matching Alexei's preference.** Official product is free, currently lists 34 instruments including concert grand. Spitfire account/app installation; test strings, brass, woodwinds and percussion, articulation switching and reopen/offline rendering. It is an entry-level orchestral palette, not the full Core/Professional editions. |
| [Orchestral Tools SINEfactory / Berlin Free Orchestra](https://www.orchestraltools.com/free-virtual-instruments) | Not found | Second orchestral option after BBC. Free collections require an Orchestral Tools account and SINE player. Choose individual gaps (electric piano, organ, bass, voices) before duplicating everything. |
| [Ample Bass P Lite II](https://www.amplesound.net/en/pro-pd.asp?id=19) | Not found | High priority: electric bass fills a real gap alongside our acoustic double bass. Vendor now lists “Ample Bass P Lite”; verify current version/format and library path when installing. |
| [Ample Guitar M Lite II](https://www.amplesound.net/en/pro-pd.asp?id=7) | Not found | High priority: acoustic guitar fills a real gap. Vendor lists “Ample Guitar M Lite”; verify current build, articulations and note range before writing parts. |

## Acceptance for each addition

Record exact version, official source, installation and sample paths, library licence/attribution, account or activation dependency and an instrument catalogue ID where relevant. Prove MIDI input produces non-silent audio, save/reopen preserves the sound, and isolated offline render succeeds. Installation alone does not satisfy this check. Script/theme additions instead need a reversible profile test and verified dependencies.

## Next actions

- [ ] Set up BBC Discover through the official Spitfire account/app route and verify representative orchestral sections.
- [ ] Evaluate/install the two Ample Lite instruments for acoustic guitar and electric bass.
- [ ] Add SPAN and Youlean Free for measurement cross-checks.
- [ ] Add ReaPack/SWS to the intended resource profile, then install only needed script dependencies.
- [ ] Select a small Decent Sampler library set with per-library licence records; reconcile old missing LMMS sample references.
- [ ] Resolve the exact Quick Adder and MK Slicer package identities before scheduling installation.
