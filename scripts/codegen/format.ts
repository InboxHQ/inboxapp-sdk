import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** Generated output is committed formatted, so a regeneration only shows real changes. */
export function format(root: string, paths: string[]): void {
  const bin = join(root, "node_modules/.bin/oxfmt");
  const result = spawnSync(bin, paths, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`oxfmt failed on ${paths.join(", ")}`);
}
