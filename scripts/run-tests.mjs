// Node 20 on Windows does not expand shell globs. Pass explicit paths so the
// same regression suite runs on every supported development platform.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(join(root, "tests"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join(root, "tests", name));
files.push(join(root, "experimental", "ownership", "agent-roster.test.cjs"));
if (files.length === 0) throw new Error("No core regression tests found");
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], {
  cwd: root,
  stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
