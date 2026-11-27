import {
  readFile,
  writeFile,
  rename,
  unlink,
  mkdir,
  realpath,
  open,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { heartbeat, BRIDGE_PROTOCOL } from "./startup.js";
import { ToolError } from "./errors.js";

export const MAX_REQUEST_BYTES = 1_048_576;
// REAPER writes GUIDs as {8-4-4-4-12} hexadecimal groups in braces.
export const TRACK_GUID = "\\{[0-9A-Fa-f-]{36}\\}";
export const trackRef = (token: string): number | string =>
  token.startsWith("{") ? token : Number(token);
const replySchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export class LiveBridge {
  private queue: Promise<unknown> = Promise.resolve();
  private context?: { project: string; revision: number };
  constructor(
    public directory: string,
    public timeoutMs = 10000,
  ) {
    if (!path.isAbsolute(directory))
      throw new ToolError("bridge_config", "Bridge directory must be absolute");
  }
  // Protocol 3: one JSON envelope per request file. `body` holds the operation's named fields.
  request(
    operation: string,
    body: Record<string, unknown> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<any> {
    const pending = this.queue.then(() =>
      this.exchange(operation, body, timeoutMs),
    );
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async exchange(
    operation: string,
    fields: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<any> {
    const root = await realpath(this.directory).catch(() => {
      throw new ToolError(
        "live_unavailable",
        "Bridge directory does not exist",
      );
    });
    const id = randomUUID(),
      request = path.join(root, `${id}.request`),
      response = path.join(root, `${id}.json`),
      temp = path.join(root, `${id}.tmp`);
    try {
      const deadline = Date.now() + timeoutMs;
      // The bridge decoder rejects null, so absent values are dropped rather than sent.
      const body = JSON.stringify(
        { ...fields, protocol: BRIDGE_PROTOCOL, id, deadline, op: operation },
        (_key, value) => (value === null ? undefined : value),
      );
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
        throw new ToolError("limit", "Live request exceeds 1 MB");
      await writeFile(temp, body, { flag: "wx" });
      await rename(temp, request);
      while (Date.now() < deadline) {
        let content: string | undefined;
        try {
          const handle = await open(response, "r");
          try {
            if ((await handle.stat()).size > 2_000_000)
              throw new ToolError("limit", "Live response exceeds 2 MB");
            content = await handle.readFile("utf8");
          } finally {
            await handle.close();
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        if (content) {
          const result = replySchema.parse(JSON.parse(content));
          if (result.id !== id)
            throw new ToolError("bridge_protocol", "Mismatched response ID");
          if (!result.ok)
            throw new ToolError(
              "live_rejected",
              result.error?.slice(0, 300) ?? "Bridge rejected operation",
            );
          return result.result;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new ToolError(
        "live_timeout",
        "Bridge timed out; mutation outcome is unknown. Inspect live state before retrying; no offline fallback occurred",
      );
    } finally {
      // The bridge owns request removal. Removing it here races an in-flight mutation.
      await unlink(temp).catch(() => {});
      await unlink(response).catch(() => {});
      // A queued request is safe to remove: if already claimed, its reply still cannot be replayed.
      await unlink(request).catch(() => {});
    }
  }
  async available(): Promise<boolean> {
    return heartbeat(this.directory);
  }
  async get(objectPath: string): Promise<unknown> {
    const snapshot = await this.request("get", { path: objectPath });
    this.context = { project: snapshot.project, revision: snapshot.revision };
    return snapshot.value;
  }
  async list(objectPath: string, offset: number, limit: number): Promise<unknown> {
    if (/^\/tracks\/[^/]+\/fx\/\d+\/parameters$/.test(objectPath))
      return this.get(`${objectPath}/page/${offset}/${limit}`);
    const all = await this.get(objectPath);
    if (!Array.isArray(all))
      throw new ToolError("invalid_path", "List requires an array path");
    return { total: all.length, offset, items: all.slice(offset, offset + limit) };
  }
  private guard(): { project: string; revision: number } {
    if (!this.context)
      throw new ToolError(
        "live_read_required",
        "Read the live project before editing it",
      );
    return this.context;
  }
  async mutate(
    action: string,
    args: Record<string, unknown>,
    dryRun: boolean,
  ): Promise<any> {
    const result = await this.request(
      "call",
      { ...this.guard(), action, args, dryRun },
      60000,
    );
    this.context = { project: result.project, revision: result.revision };
    return result;
  }
  // Runs every step inside one native undo block. A failed step rolls the earlier ones back.
  async batch(
    steps: { action: string; args: Record<string, unknown> }[],
    dryRun: boolean,
  ): Promise<any> {
    const result = await this.request(
      "batch",
      { ...this.guard(), steps, dryRun },
      60000,
    );
    this.context = { project: result.project, revision: result.revision };
    return result;
  }
  async set(
    objectPath: string,
    value: unknown,
    dryRun: boolean,
  ): Promise<unknown> {
    this.guard();
    const match = new RegExp(
      `^/tracks/(0|[1-9][0-9]*|${TRACK_GUID})/(name|volume_db|pan|mute|solo)$`,
    ).exec(objectPath);
    if (!match)
      throw new ToolError(
        "unsupported_live",
        "Live set supports track name, volume_db, pan, mute and solo only",
      );
    const field = match[2]!;
    const schema =
      field === "name"
        ? z
            .string()
            .max(200)
            .refine((s) => !/[\r\n\x00]/.test(s))
        : field === "mute" || field === "solo"
          ? z.boolean()
          : z
              .number()
              .finite()
              .min(field === "pan" ? -1 : -150)
              .max(field === "pan" ? 1 : 24);
    const validated = schema.parse(value);
    return this.mutate(
      "set_track",
      { track: trackRef(match[1]!), field, value: validated },
      dryRun,
    );
  }
}
