import { test, expect } from "vitest";
import { mkdtemp, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxHost } from "../src/hosts/tmux.js";
import { testServer } from "./global-setup.js";
import { PtyHost } from "../src/hosts/pty.js";
import { hosts } from "../src/hosts/index.js";
import { configSchema } from "../src/config.js";
import { processRef, isSame, delay } from "../src/identity/processes.js";
for (const host of [new TmuxHost(testServer("hosts")), new PtyHost()]) {
  test(`${host.id} preserves argv, supplies a terminal, lists and stops its process`, async () => {
    expect(await host.available()).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "muster-host-"));
    const path = join(dir, "seen.json");
    const literal = '--flag $(touch BAD) " \n ; echo nope';
    const inlineConfig = JSON.stringify({
      provider: { fixture: { token: "not-a-shell; $(touch BAD_ENV)" } },
    });
    const script =
      'require("fs").writeFileSync(process.argv[1],JSON.stringify({argv:process.argv[2],tty:!!process.stdin.isTTY,env:process.env.MUSTER_MARKER,inlineConfig:process.env.OPENCODE_CONFIG_CONTENT}));setInterval(()=>{},1000)';
    const result = await host.launch({
      argv: [process.execPath, "-e", script, path, literal],
      cwd: dir,
      env: {
        PATH: process.env.PATH!,
        MUSTER_MARKER: "expected",
        OPENCODE_CONFIG_CONTENT: inlineConfig,
      },
      label: "test agent",
    });
    const ref = await processRef(result.pid);
    expect(ref).toBeDefined();
    try {
      let seen;
      for (let i = 0; i < 50; i++) {
        try {
          seen = JSON.parse(await readFile(path, "utf8"));
          break;
        } catch {
          await delay(50);
        }
      }
      expect(seen).toEqual({
        argv: literal,
        tty: true,
        env: "expected",
        inlineConfig,
      });
      await expect(readFile(join(dir, "BAD"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(join(dir, "BAD_ENV"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        (await host.list()).some((x) => x.hostRef === result.hostRef),
      ).toBe(true);
      expect(host.capabilities()).toEqual(
        host.id === "tmux"
          ? { watchable: true, attachable: true, survivesParentExit: true }
          : { watchable: false, attachable: false, survivesParentExit: false },
      );
    } finally {
      await host.stop(result.hostRef);
    }
    for (let i = 0; i < 20 && (await isSame(ref!)); i++) await delay(50);
    expect(await isSame(ref!)).toBe(false);
  }, 10000);
}

test("a pty launch repairs node-pty's non-executable spawn-helper", async () => {
  const { ensureSpawnHelperExecutable } = await import("../src/hosts/pty.js");
  if (process.platform !== "darwin") return; // the defect is macOS-only

  const root = await mkdtemp(join(tmpdir(), "muster-spawnhelper-"));
  const dir = join(root, "prebuilds", `darwin-${process.arch}`);
  await mkdir(dir, { recursive: true });
  const helper = join(dir, "spawn-helper");
  await writeFile(helper, "#!/bin/sh\n", { mode: 0o644 });

  // As shipped: readable, not executable. posix_spawnp fails on this.
  expect((await stat(helper)).mode & 0o111).toBe(0);
  await ensureSpawnHelperExecutable(root);
  expect((await stat(helper)).mode & 0o111).not.toBe(0);

  // Idempotent, and a missing helper is not an error — a source build, or a
  // platform whose prebuild lives elsewhere, simply has nothing to repair.
  await ensureSpawnHelperExecutable(root);
  expect((await stat(helper)).mode & 0o111).not.toBe(0);
  await expect(
    ensureSpawnHelperExecutable(join(root, "absent")),
  ).resolves.toBeUndefined();
});

/**
 * Muster's tmux runs on its own socket with `-f /dev/null`, so the bar a
 * launched agent shows is tmux's stock default and never the developer's
 * configured one. A muster session is one window running one agent, so the bar
 * reports nothing the caller does not already know, and hiding it is safe here
 * in a way it would not be on the user's own server.
 */
async function statusOption(server: string, hostRef: string) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  // `display-message`, not `show-options`: the latter prints nothing for an
  // option still at its default, so it cannot tell "on" from "unset" — which is
  // exactly the distinction these two tests turn on.
  const { stdout } = await promisify(execFile)("tmux", [
    "-L",
    server,
    "-f",
    "/dev/null",
    "display-message",
    "-p",
    "-t",
    hostRef,
    "#{status}",
  ]);
  return stdout.trim();
}
async function launchIdle(host: TmuxHost) {
  const dir = await mkdtemp(join(tmpdir(), "muster-status-"));
  return host.launch({
    argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: dir,
    env: { PATH: process.env.PATH! },
    label: "status probe",
  });
}

test("a tmux launch hides the status bar", async () => {
  const server = testServer("status-off");
  const host = new TmuxHost(server);
  const launched = await launchIdle(host);
  try {
    expect(await statusOption(server, launched.hostRef)).toBe("off");
  } finally {
    await host.stop(launched.hostRef);
  }
});

test("tmux_status = on keeps the bar for callers who want it", async () => {
  const server = testServer("status-on");
  const host = new TmuxHost(server, "on");
  const launched = await launchIdle(host);
  try {
    expect(await statusOption(server, launched.hostRef)).toBe("on");
  } finally {
    await host.stop(launched.hostRef);
  }
});

test("the status bar default is off, and config carries it to the host", () => {
  expect(configSchema.parse({}).tmux_status).toBe("off");
  expect(configSchema.parse({ tmux_status: "on" }).tmux_status).toBe("on");
  expect(() => configSchema.parse({ tmux_status: "hidden" })).toThrow();
  // The factory is what Muster.create calls, so this is the seam between the
  // config key and the host that acts on it.
  const [offHost] = hosts({}, "off");
  const [onHost] = hosts({}, "on");
  expect((offHost as TmuxHost).status).toBe("off");
  expect((onHost as TmuxHost).status).toBe("on");
  expect((hosts({})[0] as TmuxHost).status).toBe("off");
});
