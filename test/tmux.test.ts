import { test, expect } from "vitest";
import { testServer } from "./global-setup.js";
import { spawn, type IPty } from "node-pty";
import {
  TmuxHost,
  parseWindowRow,
  parseWindowList,
  LAUNCH_FORMAT,
  LIST_FORMAT,
  CLEANUP_FORMAT,
} from "../src/hosts/tmux.js";
import { command, delay, processRef } from "../src/identity/processes.js";

test.each([0, 1])(
  "two attached agents stay independent when client %i receives Ctrl+C",
  async (exitIndex) => {
    const server = testServer(`isolation-${exitIndex}`);
    const host = new TmuxHost(server);
    const refs: string[] = [];
    const clients: IPty[] = [];
    const launch = async (label: string) => {
      const peer = await host.launch({
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        label,
      });
      refs.push(peer.hostRef);
      const client = spawn("/bin/sh", ["-c", host.attachHint(peer.hostRef)], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        env: { ...process.env, TMUX: "" },
      });
      client.onData(() => {});
      clients.push(client);
      return peer;
    };
    const windows = async () =>
      (
        await command("tmux", [
          "-L",
          server,
          "list-clients",
          "-F",
          "#{window_id}",
        ])
      )
        .trim()
        .split("\n")
        .sort();
    try {
      const first = await launch("first-agent");
      await expect.poll(windows).toEqual([first.hostRef]);
      const second = await launch("second-agent");
      await expect
        .poll(windows)
        .toEqual([first.hostRef, second.hostRef].sort());
      const survivor = [second, first][exitIndex]!;
      clients[exitIndex]!.write("\x03");
      await expect
        .poll(async () => (await host.list()).map((p) => p.hostRef))
        .toEqual([survivor.hostRef]);
      expect(await processRef(survivor.pid)).toBeDefined();
      await expect.poll(windows).toEqual([survivor.hostRef]);
    } finally {
      for (const client of clients) {
        try {
          client.kill();
        } catch {}
      }
      for (const ref of refs) await host.stop(ref);
      await delay(50);
    }
  },
  15000,
);

test("legacy muster windows remain manageable and unrelated sessions are excluded", async () => {
  const server = testServer("legacy");
  const host = new TmuxHost(server);
  const create = async (session: string) =>
    (
      await command("tmux", [
        "-L",
        server,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        session,
        "-P",
        "-F",
        "#{window_id}",
        "sleep 60",
      ])
    ).trim();
  try {
    const legacy = await create("muster");
    const unrelated = await create("personal");
    expect((await host.list()).map((p) => p.hostRef)).toEqual([legacy]);
    await host.stop(legacy);
    expect(await host.list()).toEqual([]);
    expect(
      (
        await command("tmux", [
          "-L",
          server,
          "list-windows",
          "-a",
          "-F",
          "#{window_id}",
        ])
      ).trim(),
    ).toBe(unrelated);
  } finally {
    await command("tmux", ["-L", server, "kill-server"]).catch(() => {});
  }
});

test("no tmux format depends on a character tmux may rewrite", () => {
  // The whole of #21: without a UTF-8 locale tmux turns every control
  // character in -F output into an underscore, so "@0\ttab" arrived as
  // "@0_11657" and the launch failed. Printable ASCII is left alone.
  for (const format of [LAUNCH_FORMAT, LIST_FORMAT, CLEANUP_FORMAT]) {
    expect(format).not.toMatch(/[\u0000-\u001f]/);
    expect(format).toContain("|");
  }
});

test("an unparseable window row reports the bytes tmux actually returned", () => {
  expect(parseWindowRow("@0|7175\n")).toEqual({ hostRef: "@0", pid: 7175 });
  // The shape #21 was filed about. Quoting it is what turned that report from
  // inference into a five-minute diagnosis.
  expect(() => parseWindowRow("@0_7175\n")).toThrow(
    'tmux returned an invalid window identity: "@0_7175\\n"',
  );
  expect(() => parseWindowRow("")).toThrow(/invalid window identity: ""/);
  expect(() => parseWindowRow("0|7175")).toThrow(/invalid window identity/);
  expect(() => parseWindowRow("@0|notapid")).toThrow(/invalid window identity/);
  // Bounded: a runaway tmux cannot paste an entire buffer into an error.
  const message = (() => {
    try {
      parseWindowRow("x".repeat(5000));
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  })();
  expect(message.length).toBeLessThan(300);
  expect(message).toContain("\u2026");
});

test("a pipe inside a window name shifts no field the filter depends on", () => {
  const rows = [
    "@0|100|muster|plain",
    "@1|101|muster-00000000-0000-4000-8000-000000000000|bad|name",
    "@2|102|personal|unrelated",
    // A foreign session whose own name carries the delimiter must not match by
    // accident — it shifts, fails the pattern, and is dropped.
    "@3|103|per|sonal|unrelated",
  ].join("\n");
  expect(parseWindowList(rows)).toEqual([
    { hostRef: "@0", pid: 100, label: "plain" },
    // Kept whole rather than truncated at the delimiter, and still addressable.
    { hostRef: "@1", pid: 101, label: "bad|name" },
  ]);
  expect(parseWindowList("")).toEqual([]);
});

test("launch, list and stop work with no UTF-8 locale set", async () => {
  const server = testServer("locale");
  const host = new TmuxHost(server);
  const saved: Record<string, string | undefined> = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_CTYPE: process.env.LC_CTYPE,
  };
  let ref: string | undefined;
  try {
    // tmux inherits this environment through execFile, and an agent harness,
    // launchd job or `ssh host cmd` supplies exactly this one. #21 was filed as
    // a hardware and version report; it is only ever this.
    for (const key of Object.keys(saved)) delete process.env[key];
    const launched = await host.launch({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      label: "no locale",
    });
    ref = launched.hostRef;
    expect(ref).toMatch(/^@\d+$/);
    expect(launched.pid).toBeGreaterThan(0);
    const listed = await host.list();
    expect(listed.map((w) => w.hostRef)).toEqual([ref]);
    expect(listed[0]!.pid).toBe(launched.pid);
    await host.stop(ref);
    ref = undefined;
    expect(await host.list()).toEqual([]);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    if (ref) await host.stop(ref).catch(() => {});
    await command("tmux", ["-L", server, "kill-server"]).catch(() => {});
  }
}, 20000);
