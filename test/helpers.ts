import { execFile } from "node:child_process";
import { promisify } from "node:util";
const python = promisify(execFile)("python3", [
  "-c",
  "import sys;print(sys.executable)",
]).then((r) => r.stdout.trim());
import { mkdtemp, mkdir, copyFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_SERVER } from "./global-setup.js";
/**
 * The variables a fixture must never inherit, exported so a test can assert the
 * isolation rather than trust it. Each relocates an agent's configuration or
 * data directory, and an inherited value would point a fixture launch at the
 * developer's own account.
 */
export const NEUTRALISED = [
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_CONFIG_DIR",
  "XDG_DATA_HOME",
] as const;
export async function fixture(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "mu-"));
  const bin = join(root, "bin"),
    home = join(root, "muster");
  await mkdir(bin);
  await mkdir(home);
  await mkdir(join(root, ".codex"));
  for (const name of ["codex", "claude"]) {
    await copyFile(
      new URL("./fakes/runtime.cjs", import.meta.url),
      join(bin, name),
    );
    await chmod(join(bin, name), 0o755);
  }
  await copyFile(
    new URL("./fakes/opencode.cjs", import.meta.url),
    join(bin, "opencode"),
  );
  await chmod(join(bin, "opencode"), 0o755);
  // Neutralised rather than inherited. A developer who runs a second Claude or
  // OpenCode account exports these in their shell, and now that the policy
  // refusal is gone and the fake runtime honours CLAUDE_CONFIG_DIR, an inherited
  // value would make fixture launches write session records into that
  // developer's REAL configuration directory. Absent is also exactly what a
  // clean machine has, so this is the state every existing test was written
  // against — `extra` still wins, so a test can set one deliberately.
  const inherited = { ...process.env } as Record<string, string | undefined>;
  for (const key of NEUTRALISED) delete inherited[key];
  const env = {
    ...inherited,
    HOME: root,
    CODEX_HOME: join(root, ".codex"),
    PATH: bin + ":" + process.env.PATH,
    MUSTER_FAKE_ROOT: root,
    MUSTER_FAKE_PYTHON: await python,
    MUSTER_TEST_HOME: home,
    MUSTER_TMUX_SERVER: TMUX_SERVER,
    ...extra,
  } as Record<string, string>;
  return { root, bin, home, env };
}
export async function lines(file: string) {
  try {
    return (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
