import { mkdtemp, writeFile, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { processRef, stopTree } from "../identity/processes.js";
import type { LaunchOptions, TerminalHost } from "./types.js";
/**
 * node-pty 1.1.0's macOS prebuilt `spawn-helper` ships without its executable
 * bit. `scripts/prepare-pty.mjs` sets it at install time, but that runs only
 * if install scripts are permitted — and a global install that skips them
 * leaves a pty launch failing with `posix_spawnp failed`, which names neither
 * the file nor the permission. tmux launches are unaffected, so the breakage
 * is invisible until someone happens to use this host.
 *
 * Re-checked here so a launch repairs itself rather than failing on something
 * an install already knew how to fix. `root` is injectable for tests.
 */
export async function ensureSpawnHelperExecutable(root?: string) {
  if (process.platform !== "darwin") return;
  const base =
    root ??
    dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  for (const file of [
    join(base, "prebuilds", `darwin-${process.arch}`, "spawn-helper"),
    join(base, "build", "Release", "spawn-helper"),
  ]) {
    let info;
    try {
      info = await stat(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    if ((info.mode & 0o111) !== 0) continue;
    try {
      await chmod(file, info.mode | 0o111);
    } catch {
      throw new Error(
        `node-pty's spawn-helper is not executable and could not be fixed: ${file}. ` +
          `Run \`node scripts/prepare-pty.mjs\` from the Muster install, or use --host tmux.`,
      );
    }
  }
}

export class PtyHost implements TerminalHost {
  readonly id = "pty" as const;
  private sessions = new Map<string, { pty: IPty; label: string }>();
  async available() {
    try {
      await import("node-pty");
      return true;
    } catch {
      return false;
    }
  }
  capabilities() {
    return { watchable: false, attachable: false, survivesParentExit: false };
  }
  async launch(opts: LaunchOptions) {
    const module = await import("node-pty");
    await ensureSpawnHelperExecutable();
    const dir = await mkdtemp(join(tmpdir(), "muster-pty-"));
    const file = join(dir, "launch.json");
    await writeFile(file, JSON.stringify(opts), { mode: 0o600 });
    let pty: IPty;
    try {
      pty = module.spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("../../dist/hosts/bootstrap.js", import.meta.url),
          ),
          file,
        ],
        {
          cwd: opts.cwd,
          env: opts.env,
          name: "xterm-256color",
          cols: 120,
          rows: 35,
        },
      );
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    const hostRef = randomUUID();
    this.sessions.set(hostRef, { pty, label: opts.label });
    pty.onData(() => {});
    pty.onExit(() => this.sessions.delete(hostRef));
    return { hostRef, pid: pty.pid };
  }
  async stop(hostRef: string) {
    const s = this.sessions.get(hostRef);
    if (!s) return;
    const ref = await processRef(s.pty.pid);
    if (ref) await stopTree(ref);
    try {
      s.pty.kill();
    } catch {}
    this.sessions.delete(hostRef);
  }
  async list() {
    return [...this.sessions].map(([hostRef, s]) => ({
      hostRef,
      pid: s.pty.pid,
      label: s.label,
    }));
  }
  attachHint() {
    return null;
  }
}
