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
import { heartbeat } from "./startup.js";
import { ToolError } from "./errors.js";

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
  request(operation: string, fields: string[] = []): Promise<any> {
    const pending = this.queue.then(() => this.exchange(operation, fields));
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async exchange(operation: string, fields: string[]): Promise<any> {
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
      const deadline = Date.now() + this.timeoutMs;
      const parts = ["2", id, String(deadline), operation, ...fields];
      const body =
        parts.map((s) => Buffer.from(s, "utf8").toString("hex")).join("\n") +
        "\n";
      if (Buffer.byteLength(body) > 16384)
        throw new ToolError("limit", "Live request exceeds 16 KB");
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
    const snapshot = await this.request("get", [objectPath]);
    this.context = { project: snapshot.project, revision: snapshot.revision };
    return snapshot.value;
  }
  async set(
    objectPath: string,
    value: unknown,
    dryRun: boolean,
  ): Promise<unknown> {
    if (!this.context)
      throw new ToolError(
        "live_read_required",
        "Read the live project before editing it",
      );
    const match = /^\/tracks\/(0|[1-9][0-9]*)\/(name|volume_db|pan|mute)$/.exec(
      objectPath,
    );
    if (!match)
      throw new ToolError(
        "unsupported_live",
        "Live set supports track name, volume_db, pan and mute only",
      );
    const field = match[2]!;
    const schema =
      field === "name"
        ? z
            .string()
            .max(200)
            .refine((s) => !/[\r\n\x00]/.test(s))
        : field === "mute"
          ? z.boolean()
          : z
              .number()
              .finite()
              .min(field === "pan" ? -1 : -150)
              .max(field === "pan" ? 1 : 24);
    const validated = schema.parse(value);
    const result = await this.request("set", [
      this.context.project,
      String(this.context.revision),
      match[1]!,
      field,
      String(validated),
      dryRun ? "1" : "0",
    ]);
    this.context = { project: result.project, revision: result.revision };
    return result;
  }
}
