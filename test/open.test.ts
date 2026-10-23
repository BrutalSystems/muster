import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { TmuxHost } from "../src/hosts/tmux.js";
import { PtyHost } from "../src/hosts/pty.js";
import { Muster } from "../src/run.js";
import { Registry } from "../src/registry.js";
import { fixture } from "./helpers.js";
import { asSession, asTask } from "./narrow.js";
import { testServer } from "./global-setup.js";

const wez = ["wez", "{server}", "{target}"];

/**
 * A running tmux session whose host records what `open` was asked to do
 * instead of starting a real terminal.
 */
async function launched(name: string, available = true) {
  const f = await fixture();
  await writeFile(
    join(f.home, "config.toml"),
    `terminal = "wez"\n[open.apps.wez]\ncommand = ${JSON.stringify(wez)}\n[open.apps.kit]\ncommand = ["kit", "{target}"]\n`,
  );
  const host = new TmuxHost(testServer(name));
  const seen: unknown[] = [];
  host.openAvailable = async () => available;
  host.open = async (hostRef, _deadline, terminal, opener) => {
    seen.push([hostRef, terminal, opener]);
  };
  const m = await Muster.create({ home: f.home, env: f.env, drivers: [host] });
  const peer = asSession(
    await m.run({
      runtime: "claude",
      prompt: "open me",
      cwd: f.root,
      host: "tmux",
      idleTimeout: "off",
    }),
  );
  const [entry] = await new Registry(f.home).all();
  return { f, m, host, seen, peer, id: peer.session_id!, entry: entry! };
}

test("muster open attaches the configured default app to a running session", async () => {
  const { m, seen, id, entry } = await launched("open-default");
  try {
    expect(await m.open(id)).toEqual({ id, opened: true, terminal: "wez" });
    expect(seen).toEqual([[entry.hostRef, "wez", wez]]);
  } finally {
    await m.close();
  }
}, 30000);

test("muster open takes a named app, and by launch id or peer name", async () => {
  const { m, seen, peer, entry } = await launched("open-named");
  try {
    await m.open(entry.launchId, "kit");
    await m.open(String(peer.name), "kit");
    expect(seen).toEqual([
      [entry.hostRef, "kit", ["kit", "{target}"]],
      [entry.hostRef, "kit", ["kit", "{target}"]],
    ]);
  } finally {
    await m.close();
  }
}, 30000);

test("muster open refuses an app that is not configured", async () => {
  const { m, seen, id } = await launched("open-unknown-app");
  try {
    await expect(m.open(id, "nope")).rejects.toThrow(/Unknown terminal "nope"/);
    expect(seen).toEqual([]);
  } finally {
    await m.close();
  }
}, 30000);

test("muster open refuses an app whose command cannot be found", async () => {
  const { m, seen, id } = await launched("open-unavailable", false);
  try {
    await expect(m.open(id)).rejects.toThrow(
      /open: the command for "wez" was not found \(wez\)/,
    );
    expect(seen).toEqual([]);
  } finally {
    await m.close();
  }
}, 30000);

test("muster open refuses a session that has ended", async () => {
  const { m, seen, id } = await launched("open-ended");
  try {
    await m.stop(id);
    await expect(m.open(id)).rejects.toThrow(
      /open applies to a running tmux session; this session is stopped/,
    );
    expect(seen).toEqual([]);
  } finally {
    await m.close();
  }
}, 30000);

test("muster open refuses a session whose window has gone", async () => {
  const { m, host, seen, id, entry } = await launched("open-gone");
  try {
    // The window dies under Muster without a stop being recorded.
    await host.stop(entry.hostRef!);
    await expect(m.open(id)).rejects.toThrow(
      /open applies to a running tmux session; (this session is (exited|stopped)|its tmux window is gone)/,
    );
    expect(seen).toEqual([]);
  } finally {
    await m.close();
  }
}, 30000);

test("muster open refuses an unknown id", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env, drivers: [] });
  try {
    await expect(m.open("no-such-session")).rejects.toThrow();
  } finally {
    await m.close();
  }
});

test("muster open refuses a task", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env, drivers: [] });
  try {
    const task = asTask(
      await m.run({
        runtime: "claude",
        prompt: "task",
        cwd: f.root,
        kind: "task",
      }),
    );
    await expect(m.open(task.id)).rejects.toThrow(
      /open applies to a running tmux session; this is a task/,
    );
  } finally {
    await m.close();
  }
}, 30000);

test("muster open refuses a pty session, which has no window to attach", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    const peer = asSession(
      await m.run({
        runtime: "claude",
        prompt: "pty",
        cwd: f.root,
        host: "pty",
      }),
    );
    await expect(m.open(peer.session_id!)).rejects.toThrow(
      /open applies to a running tmux session; this session is hosted on pty/,
    );
    await m.stop(peer.session_id!);
  } finally {
    await m.close();
  }
}, 30000);
