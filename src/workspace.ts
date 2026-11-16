import { realpath, stat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./errors.js";

export class Workspace {
  constructor(public readonly root: string) {}
  async resolve(relative: string, writing = false): Promise<string> {
    if (
      !relative ||
      relative.length > 4096 ||
      path.isAbsolute(relative) ||
      relative.includes("\0") ||
      relative.includes(":")
    )
      throw new ToolError("invalid_path", "Use a workspace-relative path");
    const root = await realpath(this.root);
    const target = path.resolve(root, relative);
    const inside = (p: string) =>
      p !== root &&
      !path.relative(root, p).startsWith("..") &&
      !path.isAbsolute(path.relative(root, p));
    if (!inside(target))
      throw new ToolError("invalid_path", "Path leaves workspace");
    let resolved: string;
    try {
      resolved = await realpath(target);
    } catch (error) {
      if (!writing || (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ToolError("not_found", "Workspace file not found");
      // Existing parent required: no path creation through unresolved symlinks.
      resolved = path.join(
        await realpath(path.dirname(target)),
        path.basename(target),
      );
    }
    if (!inside(resolved))
      throw new ToolError("invalid_path", "Symlink leaves workspace");
    return resolved;
  }
  async read(relative: string, maxBytes = 20_000_000): Promise<Buffer> {
    const filename = await this.resolve(relative);
    const info = await stat(filename);
    if (!info.isFile() || info.size > maxBytes)
      throw new ToolError(
        "limit",
        "File is not regular or exceeds the size limit",
      );
    return readFile(filename);
  }
  async writeNew(relative: string, data: string | Buffer): Promise<void> {
    const filename = await this.resolve(relative, true);
    try {
      await writeFile(filename, data, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw new ToolError("exists", "Output exists; choose a new filename");
      throw e;
    }
  }
  static async open(root: string): Promise<Workspace> {
    await mkdir(root, { recursive: true });
    return new Workspace(await realpath(root));
  }
}
