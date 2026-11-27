import { candidateCapability } from "./candidate.js";
import { capabilities } from "./editing.js";
import { musicCapabilities } from "./music.js";
import { auditionCapability, selectAuditionCapability } from "./audition.js";
import { autoMixCapability } from "./automix.js";
import { djAnalyzeCapability, djBuildCapability } from "./dj.js";
import { lintCapability } from "./lint.js";
import { grooveCapability } from "./groove.js";

const groups: [string, "stable" | "experimental", string[]][] = [
  ["test/editing.test.ts", "stable", ["add_track","add_item","add_fx","delete_track","delete_item","duplicate_item","move_item","add_notes","transpose_notes","quantize_notes","add_send","add_marker","batch_edit"]],
  ["scripts/windows-release-check.mjs", "stable", ["live_add_track", "live_insert_instrument", "live_insert_performance"]],
  ["scripts/editing-check.mjs", "stable", ["live_edit_performance", "live_set_fx_parameter", "live_revert_fx_edit"]],
  ["scripts/editing-check.mjs --routing", "stable", ["live_edit_fx_envelope_point", "live_add_send", "audition_ab"]],
  ["scripts/batch-check.mjs", "stable", ["live_batch", "live_insert_midi"]],
  ["scripts/windows-release-check.mjs", "experimental", ["fork_saved_project"]],
  ["test/audition.test.ts", "experimental", ["select_audition_render"]],
  ["scripts/arrange-check.mjs", "experimental", ["live_transport", "live_add_marker", "live_edit_marker", "live_delete_marker", "live_set_tempo", "live_delete_tempo_marker", "live_insert_audio", "live_edit_item", "live_split_item", "live_delete_item", "live_delete_track"]],
  ["scripts/compose-check.mjs", "experimental", ["live_compose_piece", "live_write_part"]],
  ["scripts/automix-check.mjs", "experimental", ["live_auto_mix"]],
  ["scripts/dj-check.mjs", "experimental", ["dj_analyze_tracks", "live_build_dj_set", "live_add_fx", "live_remove_fx", "live_write_fx_automation"]],
  ["scripts/feel-check.mjs", "experimental", ["live_lint_arrangement", "live_apply_groove"]],
];
const status = new Map(groups.flatMap(([acceptance, maturity, names]) =>
  names.map(name => [name, { acceptance, maturity }] as const)));

export const capabilityCatalogue = [
  ...capabilities.map(c => ({ ...c, modes: ["offline"] })),
  ...musicCapabilities, candidateCapability, auditionCapability, selectAuditionCapability, autoMixCapability,
  djAnalyzeCapability, djBuildCapability, lintCapability, grooveCapability,
].map(capability => {
  const contract = status.get(capability.name);
  if (!contract) throw new Error("Missing release classification for " + capability.name);
  return { ...capability, ...contract };
});
