import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { resolveTitle, runSchema, sanitiseTitle } from "../src/guard.js";
import { configSchema } from "../src/config.js";
import { TmuxHost } from "../src/hosts/tmux.js";
import { PtyHost } from "../src/hosts/pty.js";
import { Muster } from "../src/run.js";
import { command } from "../src/identity/processes.js";
import { fixture } from "./helpers.js";
import { asSession, asTask } from "./narrow.js";
import { Registry } from "../src/registry.js";
import { testServer } from "./global-setup.js";

const req = (over: Record<string, unknown>) =>
  runSchema.parse({ runtime: "claude", prompt: "ping", ...over });

/** One tmux option as tmux stores it, read the way a terminal would get it. */
const option = (server: string, hostRef: string, name: string) =>
  command("tmux", [
    "-L",
    server,
    "show-options",
    "-v",
    "-t",
    hostRef,
    name,
  ]).then((s) => s.trim());

test("a title loses every control character, since it reaches a terminal escape", () => {
  // ESC and BEL would end the OSC sequence tmux writes and start another.
  expect(sanitiseTitle("a\u001b]2;evil\u0007b\u009bc\u007fd\n")).toBe(
    "a]2;evilbcd",
  );
});

test("a title is trimmed and capped", () => {
  expect(sanitiseTitle("  review  ")).toBe("review");
  expect(sanitiseTitle("x".repeat(500))).toHaveLength(100);
});

test("a title with nothing printable in it is refused, not launched blank", () => {
  expect(() => sanitiseTitle("\u001b\u0007  ")).toThrow(
    /--title must contain printable text/,
  );
});

test("--title is sanitised on the way in", () => {
  expect(resolveTitle(req({ title: "ship\u0007 it" }), true)).toBe("ship it");
});

test("no --title resolves to nothing, leaving the default to the launch", () => {
  expect(resolveTitle(req({}), true)).toBeUndefined();
});

test("--title is refused where no tmux session will carry it", () => {
  expect(() => resolveTitle(req({ kind: "task", title: "x" }), false)).toThrow(
    /--title applies to tmux sessions; this launch is a task/,
  );
  expect(() => resolveTitle(req({ host: "pty", title: "x" }), false)).toThrow(
    /--title applies to tmux sessions; this launch is hosted on pty/,
  );
});

test("title_from_agent is off unless configured", () => {
  expect(configSchema.parse({}).session.title_from_agent).toBe(false);
  expect(
    configSchema.parse({ session: { title_from_agent: true } }).session
      .title_from_agent,
  ).toBe(true);
});

test("a tmux launch with a title shows muster's title, not the agent's", async () => {
  const server = testServer("title-launch");
  const host = new TmuxHost(server);
  const { hostRef } = await host.launch({
    argv: ["sleep", "30"],
    cwd: tmpdir(),
    env: process.env as Record<string, string>,
    label: "titled",
    title: { text: "review · claude", fromAgent: false },
  });
  try {
    expect(await option(server, hostRef, "set-titles")).toBe("on");
    expect(await option(server, hostRef, "@muster_title")).toBe(
      "review · claude",
    );
    // A user option rather than #T: an agent's OSC 2 rewrites #T, and
    // allow-rename (already off) governs only the window name.
    expect(await option(server, hostRef, "set-titles-string")).toBe(
      "#{@muster_title}",
    );
  } finally {
    await host.stop(hostRef);
  }
});

test("title_from_agent hands the terminal the agent's own title", async () => {
  const server = testServer("title-agent");
  const host = new TmuxHost(server);
  const { hostRef } = await host.launch({
    argv: ["sleep", "30"],
    cwd: tmpdir(),
    env: process.env as Record<string, string>,
    label: "agent-titled",
    title: { text: "review · claude", fromAgent: true },
  });
  try {
    expect(await option(server, hostRef, "set-titles-string")).toBe("#T");
  } finally {
    await host.stop(hostRef);
  }
});

test("a live tmux session can be retitled", async () => {
  const server = testServer("title-set");
  const host = new TmuxHost(server);
  const { hostRef } = await host.launch({
    argv: ["sleep", "30"],
    cwd: tmpdir(),
    env: process.env as Record<string, string>,
    label: "retitled",
    title: { text: "first", fromAgent: false },
  });
  try {
    // A value tmux would otherwise read as a flag or a format stays verbatim.
    await host.setTitle(hostRef, "-renamed #{pane_pid}");
    expect(await option(server, hostRef, "@muster_title")).toBe(
      "-renamed #{pane_pid}",
    );
  } finally {
    await host.stop(hostRef);
  }
});

async function launched(name: string, over: Record<string, unknown> = {}) {
  const f = await fixture();
  const server = testServer(name);
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new TmuxHost(server)],
  });
  const peer = asSession(
    await m.run({
      runtime: "claude",
      prompt: "title me",
      cwd: f.root,
      host: "tmux",
      idleTimeout: "off",
      ...over,
    }),
  );
  // The window id is Muster's own bookkeeping, not part of the peer record.
  const [entry] = await new Registry(f.home).all();
  return { f, m, server, peer, id: peer.session_id!, hostRef: entry!.hostRef! };
}

test("a session launched with --title carries it, and reports it", async () => {
  const { m, server, peer, hostRef } = await launched("title-e2e-explicit", {
    title: "reviewer",
  });
  try {
    expect(peer).toMatchObject({ title: "reviewer" });
    expect(await option(server, hostRef, "@muster_title")).toBe("reviewer");
  } finally {
    await m.close();
  }
}, 30000);

test("a session launched without --title is titled with its muster name", async () => {
  const { m, server, peer, hostRef } = await launched("title-e2e-default");
  try {
    const expected = `${peer.name} · claude`;
    expect(peer).toMatchObject({ title: expected });
    expect(await option(server, hostRef, "@muster_title")).toBe(expected);
  } finally {
    await m.close();
  }
}, 30000);

test("muster title renames a running session and list reports it", async () => {
  const { m, server, id, hostRef } = await launched("title-e2e-rename");
  try {
    expect(await m.title(id, "now\u001b deploying")).toEqual({
      id: id,
      title: "now deploying",
    });
    expect(await option(server, hostRef, "@muster_title")).toBe(
      "now deploying",
    );
    const [listed] = await m.list("session");
    expect(listed).toMatchObject({ title: "now deploying" });
  } finally {
    await m.close();
  }
}, 30000);

test("muster title refuses a session that has ended", async () => {
  const { m, id } = await launched("title-e2e-ended");
  try {
    await m.stop(id);
    await expect(m.title(id, "late")).rejects.toThrow(
      /title applies to a running tmux session; this session is stopped/,
    );
  } finally {
    await m.close();
  }
}, 30000);

test("muster title refuses a task", async () => {
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
    await expect(m.title(task.id, "x")).rejects.toThrow(
      /title applies to a running tmux session; this is a task/,
    );
  } finally {
    await m.close();
  }
}, 30000);

test("--title and muster title are refused for a pty session", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    await expect(
      m.run({
        runtime: "claude",
        prompt: "pty",
        cwd: f.root,
        host: "pty",
        title: "x",
      }),
    ).rejects.toThrow(
      /--title applies to tmux sessions; this launch is hosted on pty/,
    );
    const peer = asSession(
      await m.run({
        runtime: "claude",
        prompt: "pty",
        cwd: f.root,
        host: "pty",
      }),
    );
    // No window of muster's own, so nothing to title and nothing to report.
    expect(peer.title).toBeUndefined();
    await expect(m.title(peer.session_id!, "x")).rejects.toThrow(
      /title applies to a running tmux session; this session is hosted on pty/,
    );
  } finally {
    await m.close();
  }
}, 30000);
