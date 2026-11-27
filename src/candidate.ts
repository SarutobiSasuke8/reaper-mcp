import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { Workspace } from "./workspace.js";
import { ToolError } from "./errors.js";

export const candidateCapability = {
  name: "fork_saved_project", toolset: "editing", modes: ["offline", "live"],
  description: "Copy a saved native RPP to a new sibling RPP, preserving relative media references. Preview to obtain the source SHA-256, then supply it when applying. Open the copy explicitly to edit it.",
  schema: z.object({
    source: z.string().min(1).max(4096).regex(/\.rpp$/i),
    candidate: z.string().min(1).max(4096).regex(/\.rpp$/i),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict(),
};

export async function savedProjectBytes(workspace: Workspace, file: string) {
  const bytes = await workspace.read(file, 64_000_000);
  if (!bytes.subarray(0, 128).toString("utf8").trimStart().startsWith("<REAPER_PROJECT "))
    throw new ToolError("invalid_project", "Expected a saved REAPER project");
  return bytes;
}

export async function forkSavedProject(workspace: Workspace, args: z.infer<typeof candidateCapability.schema>, dryRun: boolean) {
  const source = await workspace.resolve(args.source);
  const destination = await workspace.resolve(args.candidate, true);
  if (path.dirname(source) !== path.dirname(destination))
    throw new ToolError("invalid_path", "Keep the candidate beside its source so relative media paths resolve");
  const bytes = await savedProjectBytes(workspace, args.source);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  if ((!dryRun || args.sourceSha256 !== undefined) && sourceSha256 !== args.sourceSha256)
    throw new ToolError("source_revision", "Preview the current saved source and supply its sourceSha256");
  if (!dryRun) await workspace.writeNew(args.candidate, bytes);
  return { source: args.source, candidate: args.candidate, sourceSha256, dryRun };
}
