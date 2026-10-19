import { test, expect } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import { Muster } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import type { LaunchOptions } from "../src/hosts/types.js";

/** A pty host that records what it was asked to launch and launches nothing. */
class Recording extends PtyHost {
  launched: LaunchOptions[] = [];
  override async launch(opts: LaunchOptions): Promise<never> {
    this.launched.push(opts);
    throw new Error("recorded, not launched");
  }
}

async function muster() {
  const f = await fixture();
  await writeFile(
    join(f.home, "config.toml"),
    "allow_dangerous_flags = true\n",
  );
  const host = new Recording();
  const m = await Muster.create({ home: f.home, env: f.env, drivers: [host] });
  const plugin = join(f.root, "a plugin's dir; $(x)");
  await mkdir(plugin);
  return { f, m, host, plugin };
}

const sealed = [
  { level: "read" },
  { level: "work" },
  { level: "open" },
  { permissions: "auto", sandbox: "workspace-write" },
  { permissions: "deny", sandbox: "read-only" },
] as const;

test("a sealed launch with --plugin-dir in any form never reaches the host", async () => {
  const { f, m, host, plugin } = await muster();
  try {
    const forms = [
      ["--plugin-dir", plugin],
      [`--plugin-dir=${plugin}`],
      ["--plugin-dir", plugin, "--plugin-dir", plugin],
      ["--name", "x", `--PLUGIN_DIR=${plugin}`, "--effort", "high"],
    ];
    for (const policy of sealed)
      for (const args of forms)
        await expect(
          m.run({
            runtime: "claude",
            prompt: "hi",
            cwd: f.root,
            host: "pty",
            args,
            ...policy,
          }),
        ).rejects.toThrow(/sealed launch loads no plugins/);
    expect(host.launched).toEqual([]);
    expect(await m.list("session")).toEqual([]); // nothing reserved either
  } finally {
    await m.close();
  }
}, 20000);

test("a normal launch passes each plugin dir to the child's argv exactly as given", async () => {
  const { f, m, host, plugin } = await muster();
  try {
    const args = ["--plugin-dir", plugin, `--plugin-dir=${plugin}`];
    await expect(
      m.run({
        runtime: "claude",
        prompt: "hi",
        cwd: f.root,
        host: "pty",
        args,
      }),
    ).rejects.toThrow(/recorded, not launched/);
    expect(host.launched).toHaveLength(1);
    const argv = host.launched[0]!.argv;
    expect(argv[argv.indexOf("--plugin-dir") + 1]).toBe(plugin);
    expect(argv).toContain(`--plugin-dir=${plugin}`);
  } finally {
    await m.close();
  }
}, 20000);

test("a plugin dir that is missing, a file or empty is refused before the host, in either form", async () => {
  const { f, m, host, plugin } = await muster();
  try {
    await writeFile(join(f.root, "plain.txt"), "");
    const bad = [
      ["--plugin-dir", join(f.root, "no-such-dir")],
      [`--plugin-dir=${join(f.root, "plain.txt")}`],
      ["--plugin-dir="],
      ["--plugin-dir", plugin, "--plugin-dir", "no-such-dir"],
    ];
    for (const args of bad)
      await expect(
        m.run({
          runtime: "claude",
          prompt: "hi",
          cwd: f.root,
          host: "pty",
          args,
        }),
      ).rejects.toThrow(/Runtime option refused: --plugin-dir/);
    expect(host.launched).toEqual([]);
    expect(await m.list("session")).toEqual([]); // nothing reserved either
  } finally {
    await m.close();
  }
}, 20000);

test("a relative plugin dir is found from the launch's cwd", async () => {
  const { f, m, host } = await muster();
  try {
    await mkdir(join(f.root, "rel-plugin"));
    await expect(
      m.run({
        runtime: "claude",
        prompt: "hi",
        cwd: f.root,
        host: "pty",
        args: ["--plugin-dir", "rel-plugin"],
      }),
    ).rejects.toThrow(/recorded, not launched/);
    const argv = host.launched[0]!.argv;
    expect(argv[argv.indexOf("--plugin-dir") + 1]).toBe("rel-plugin");
  } finally {
    await m.close();
  }
}, 20000);

test("a plugin dir is checked as the child will open it, `..` and all", async () => {
  const { f, m, host } = await muster();
  try {
    await mkdir(join(f.root, "plugin2"));
    await writeFile(join(f.root, "plain.txt"), "");
    await mkdir(join(f.root, "real", "inner"), { recursive: true });
    await symlink(join(f.root, "real", "inner"), join(f.root, "link"));
    // each names root/plugin2 lexically, but the system walks the real path:
    // through a file (ENOTDIR), a missing dir (ENOENT), or the link's real parent
    const bad = [
      "plain.txt/../plugin2",
      `${f.root}/plain.txt/../plugin2`,
      "missing/../plugin2",
      `${f.root}/missing/../plugin2`,
      "link/../plugin2",
      `${f.root}/link/../plugin2`,
    ];
    for (const value of bad)
      for (const args of [["--plugin-dir", value], [`--plugin-dir=${value}`]])
        await expect(
          m.run({
            runtime: "claude",
            prompt: "hi",
            cwd: f.root,
            host: "pty",
            args,
          }),
        ).rejects.toThrow(/Runtime option refused: --plugin-dir/);
    expect(host.launched).toEqual([]);
  } finally {
    await m.close();
  }
}, 20000);
