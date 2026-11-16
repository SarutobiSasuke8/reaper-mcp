import { isolatedIni } from "./render.js";

/** Only used to seed a NEW managed profile. Never rewrite a running profile. */
export function liveIni(
  platform = process.platform,
  audioMode = process.env.REAPER_MCP_AUDIO_MODE ?? "system",
  vst = process.env.REAPER_MCP_VST_PATHS,
): string {
  if (!["system", "dummy"].includes(audioMode))
    throw Error("REAPER_MCP_AUDIO_MODE must be system or dummy");
  if (vst && /[\r\n]/.test(vst)) throw Error("Invalid VST search paths");
  // WaveOut / Microsoft Sound Mapper settings observed in REAPER 7.86.
  // No recording inputs, licence state or normal user profile is imported.
  const ini = audioMode === "dummy" ? isolatedIni(platform)
    : platform === "win32"
      ? "[REAPER]\n[audioconfig]\nmode=2\nwaveout_srate=44100\nwaveout_bps=16\nwaveout_devicein=-1\nwaveout_deviceout=-1\nwaveout_nch_in=0\nwaveout_nch_out=2\nwaveout_bs=1024\nwaveout_numblocks=8\n"
      : "[REAPER]\n";
  return ini.replace("[REAPER]\n", `[REAPER]\n${vst ? `vstpath64=${vst}\n` : ""}`);
}
