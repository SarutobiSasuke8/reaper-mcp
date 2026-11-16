import { readFileSync } from "node:fs";

// Compiled modules live in dist/src; package.json is the release source of truth.
export const packageVersion: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;
