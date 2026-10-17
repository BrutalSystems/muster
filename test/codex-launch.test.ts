import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { fixture } from "./helpers.js";
import { asSession } from "./narrow.js";
import { testServer } from "./global-setup.js";
import { Muster } from "../src/run.js";
import { TmuxHost } from "../src/hosts/tmux.js";

const cli = join(process.cwd(), "dist/muster.js");

/**
 * `--options auto-approve-path` wrote trust only into a NAMED configuration
 * home. With no CODEX_HOME and no identity there was none, so the option did
 * nothing and the launch sat on Codex's "Trust this folder?" dialog until it
 * failed with "no descendant runtime identity found". Codex's default home is
 * where that launch's Codex reads trust, so that is where it goes.
 */
test("auto-approve-path trusts the folder in ~/.codex when CODEX_HOME is unset", async () => {
  const f = await fixture();
  const env = { ...f.env };
  delete env.CODEX_HOME;
  const m = await Muster.create({
    home: f.home,
    env,
    drivers: [new TmuxHost(testServer("codex-trust"))],
  });
  try {
    const peer = asSession(
      await m.run({
        runtime: "codex",
        prompt: "trusted by default home",
        cwd: f.root,
        host: "tmux",
        options: ["auto-approve-path"],
      }),
    );
    // HOME is f.root, so the default home is f.root/.codex.
    const data: any = TOML.parse(
      await readFile(join(f.root, ".codex", "config.toml"), "utf8"),
    );
    expect(data.projects[await realpath(f.root)].trust_level).toBe("trusted");
    await m.stop(peer.thread_id!);
  } finally {
    await m.close();
  }
}, 20000);

/**
 * Readiness talks to Codex over a `codex app-server` child of the launching
 * process. Nothing closed it, so its pipes held the event loop open and the
 * `muster run codex` that started a session printed its record and then never
 * exited.
 */
test("a Codex session launch leaves no app-server child behind", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new TmuxHost(testServer("codex-rpc"))],
  });
  try {
    const peer = asSession(
      await m.run({
        runtime: "codex",
        prompt: "no leftover rpc",
        cwd: f.root,
        host: "tmux",
      }),
    );
    const children = await promisify(execFile)("pgrep", [
      "-P",
      String(process.pid),
      "-f",
      "app-server",
    ]).then(
      (r) => r.stdout.trim(),
      () => "",
    );
    expect(children).toBe("");
    await m.stop(peer.thread_id!);
  } finally {
    await m.close();
  }
}, 20000);

test("the CLI that launches a Codex session exits once it has printed the record", async () => {
  const f = await fixture();
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [cli, "run", "codex", "--prompt", "exits after", "--cwd", f.root],
    // A hang is the failure: execFile kills the CLI and rejects at the timeout.
    { env: f.env, timeout: 15000 },
  );
  const record = JSON.parse(stdout);
  expect(record).toMatchObject({ kind: "session", runtime: "codex" });
  await promisify(execFile)(process.execPath, [cli, "stop", record.thread_id], {
    env: f.env,
  });
}, 30000);
