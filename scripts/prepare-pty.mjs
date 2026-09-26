// node-pty 1.1.0's macOS prebuilt helper ships without its executable bit.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chmod, stat } from "node:fs/promises";
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const file of [
    join(root, "prebuilds", `darwin-${process.arch}`, "spawn-helper"),
    join(root, "build", "Release", "spawn-helper"),
  ]) {
    try {
      const info = await stat(file);
      await chmod(file, info.mode | 0o111);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}
