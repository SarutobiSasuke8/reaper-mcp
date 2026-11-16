import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
// Node 20 on Windows does not expand test globs. Supply explicit filenames.
const files = readdirSync(new URL("../dist/test/", import.meta.url))
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => `dist/test/${f}`);
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  shell: false,
});
process.exitCode = result.status ?? 1;
