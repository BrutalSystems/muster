import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  CLAUDE_TOKEN_PATTERN,
  captureClaudeToken,
  createTokenFilter,
  redactToken,
  resolveOnPath,
  type SpawnPty,
} from "../src/identity-login.js";

const TOKEN =
  "sk-ant-oat01-p41NahlJ8bCAJSEdzNOUhzVv24PC31Z-H-wdnlcsZQyWQ1XQvE-w28zZc6ao56HKjEep_dmNKjBHh";
const TOKEN2 =
  "sk-ant-oat01-QzT8mNahlJ8bCAJSEdzNOUhzVv24PC31Z-H-wdnlcsZQyWQ1XQvE-w28zZc6ao56aQzT8m";

async function fakeClaude() {
  const bin = await mkdtemp(join(tmpdir(), "mu-login-"));
  const dest = join(bin, "claude");
  await copyFile(new URL("./fakes/claude-login.cjs", import.meta.url), dest);
  await chmod(dest, 0o755);
  return bin;
}

// node-pty spawns into `cwd`, which must exist — unlike the brief's literal
// `/tmp/identity`, this is a real directory so tests fail for the right reason.
async function identityDir() {
  return mkdtemp(join(tmpdir(), "mu-login-dir-"));
}

test("the pattern matches a real token shape and not a bare word", () => {
  expect(CLAUDE_TOKEN_PATTERN.test(TOKEN)).toBe(true);
  expect(CLAUDE_TOKEN_PATTERN.test("sk-ant-oat01-short")).toBe(false);
});

test("redaction keeps enough to recognise and not enough to use", () => {
  const shown = redactToken(TOKEN);
  expect(shown).toContain("sk-ant-oat01");
  expect(shown).not.toContain(TOKEN);
  expect(shown.length).toBeLessThan(30);
});

test("a token split across two chunks is never relayed in halves", () => {
  // The defect this test exists for: buffering on a byte count instead of a
  // live-prefix boundary relays the first part of a token in clear, because
  // the fragment matches no pattern. Both halves then sit in the operator's
  // scrollback and reassemble perfectly. Fed directly rather than through a
  // pty, because the split has to be guaranteed rather than hoped for.
  let relayed = "";
  const filter = createTokenFilter((t) => (relayed += t));
  const half = Math.floor(TOKEN.length / 2);
  filter.push("Your OAuth token:\r\n" + TOKEN.slice(0, half));
  // The regression guard: this must be true straight after the first push,
  // not just after flush(). A fixed-byte-count implementation relays ""
  // here (it holds everything back until its byte threshold), which is
  // exactly the shape of the bug this test is guarding against — it would
  // otherwise still pass the assertions below by getting lucky at flush().
  expect(relayed).toBe("Your OAuth token:\r\n");
  filter.push(TOKEN.slice(half) + "\r\nStore this token securely.\r\n");
  filter.flush();
  expect(filter.token).toBe(TOKEN);
  expect(relayed).not.toContain(TOKEN);
  expect(relayed).not.toContain(TOKEN.slice(0, half));
  expect(relayed).toContain("Store this token securely.");
});

test("two distinct tokens in one block are both redacted", () => {
  // A shared CLAUDE_TOKEN_PATTERN with /g set would carry lastIndex across
  // calls and could skip the second match; createTokenFilter must catch
  // every match in the block, not just the first, while still capturing
  // only the first one as `token`.
  let relayed = "";
  const filter = createTokenFilter((t) => (relayed += t));
  filter.push(`first: ${TOKEN}\r\nsecond: ${TOKEN2}\r\n`);
  filter.flush();
  expect(filter.token).toBe(TOKEN);
  expect(relayed).not.toContain(TOKEN);
  expect(relayed).not.toContain(TOKEN2);
  expect(relayed).toContain("first:");
  expect(relayed).toContain("second:");
});

test("a `\\r`-redrawn spinner reaches onData promptly, not held until flush", () => {
  let relayed = "";
  const filter = createTokenFilter((t) => (relayed += t));
  const frames = "\r⠋ Logging in...\r⠙ Logging in...\r⠹ Logging in...";
  filter.push(frames);
  expect(relayed).toBe(frames);
});

test("a long newline-free non-token stream does not accumulate without bound", () => {
  let relayed = "";
  const filter = createTokenFilter((t) => (relayed += t));
  const chunk = " ".repeat(5000);
  for (let i = 0; i < 10; i++) filter.push(chunk);
  // Released as each chunk arrives, never accumulated waiting for a newline.
  expect(relayed.length).toBe(chunk.length * 10);
});

test("a stream that ends mid-token releases its tail only on flush", () => {
  let relayed = "";
  const filter = createTokenFilter((t) => (relayed += t));
  filter.push("Your OAuth token:\r\n" + TOKEN.slice(0, 20));
  // Still an open run of the literal prefix + body characters — could still
  // extend into a full token, so it stays held.
  expect(relayed).toBe("Your OAuth token:\r\n");
  filter.flush();
  expect(relayed).toContain(TOKEN.slice(0, 20));
});

test("a stream that ends without a newline still releases its tail", () => {
  // Nothing about this text could ever become part of a token, so it must
  // be released as soon as it arrives rather than waiting on a newline that
  // may never come — flush() here should find nothing left to release.
  let relayed = "";
  const filter = createTokenFilter((t) => (relayed += t));
  filter.push("no trailing newline here");
  expect(relayed).toBe("no trailing newline here");
  filter.flush();
  expect(relayed).toBe("no trailing newline here");
});

test("the token is captured and never relayed to the caller", async () => {
  const bin = await fakeClaude();
  const dir = await identityDir();
  let relayed = "";
  const result = await captureClaudeToken({
    stdin: fakeInput(false),
    dir,
    env: {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      MUSTER_FAKE_LOGIN: "ok",
    },
    onData: (c) => (relayed += c),
  });
  expect(result.token).toBe(TOKEN);
  expect(result.redacted).toBe(true);
  expect(result.exitCode).toBe(0);
  // The whole point: the secret must not reach the operator's scrollback.
  expect(relayed).not.toContain(TOKEN);
  // ...while the rest of the flow still does, or the operator is flying blind.
  expect(relayed).toContain("Opening browser");
});

test("an unrecognised format fails open: nothing captured, nothing redacted", async () => {
  // Parsing another tool's output is brittle, so the failure must leave the
  // operator no worse off than today rather than silently leaking or breaking.
  const bin = await fakeClaude();
  const dir = await identityDir();
  let relayed = "";
  const result = await captureClaudeToken({
    stdin: fakeInput(false),
    dir,
    env: {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      MUSTER_FAKE_LOGIN: "changed",
    },
    onData: (c) => (relayed += c),
  });
  expect(result.token).toBeUndefined();
  expect(result.redacted).toBe(false);
  expect(relayed).toContain("OAT!p41NahlJ8bCAJSEdz");
});

test("a failed login reports its exit code and captures nothing", async () => {
  const bin = await fakeClaude();
  const dir = await identityDir();
  const result = await captureClaudeToken({
    stdin: fakeInput(false),
    dir,
    env: {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      MUSTER_FAKE_LOGIN: "fail",
    },
    onData: () => {},
  });
  expect(result.token).toBeUndefined();
  expect(result.exitCode).toBe(3);
});

test("CLAUDE_CONFIG_DIR is pointed at the identity template", async () => {
  const bin = await fakeClaude();
  const dir = await identityDir();
  let relayed = "";
  await captureClaudeToken({
    stdin: fakeInput(false),
    dir,
    env: {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      MUSTER_FAKE_LOGIN: "echo-env",
    },
    onData: (c) => (relayed += c),
  });
  expect(relayed).toContain(dir);
});

test("the pty is wide enough that claude cannot wrap a token across lines", async () => {
  // Regression guard for the `cols` value in captureClaudeToken: `claude`
  // renders the token inside a bordered box and wraps at the terminal
  // width, so a narrow column count reintroduces a newline-inside-the-token
  // failure mode no filter can recover from. Read the source directly so a
  // future "tidy" back toward a narrower, more realistic terminal width
  // fails loudly instead of silently reopening the hole.
  const source = await readFile(
    new URL("../src/identity-login.ts", import.meta.url),
    "utf8",
  );
  expect(source).toMatch(/cols:\s*1000\b/);
});

test("data delivered right at exit is still drained before the promise settles", async () => {
  // Simulates node-pty delivering a final onData chunk after onExit has
  // already fired — an ordering this test can force deterministically,
  // instead of racing a real pty to reproduce it. Without draining on a
  // macrotask after exit, this chunk would arrive after flush() already ran
  // and be silently dropped, along with the token in it.
  let dataHandler: ((chunk: string) => void) | undefined;
  let exitHandler: ((e: { exitCode: number }) => void) | undefined;
  let dataDisposed = false;
  // The capture calls spawn from inside an async function, so the handlers do
  // not exist the instant the promise is created; the test waits for the spawn
  // rather than assuming they are already installed.
  let notifySpawned: () => void;
  const spawned = new Promise<void>((r) => (notifySpawned = r));
  const spawn: SpawnPty = () => {
    notifySpawned();
    return {
      onData(cb: (chunk: string) => void) {
        dataHandler = cb;
        return { dispose: () => void (dataDisposed = true) };
      },
      onExit(cb: (e: { exitCode: number }) => void) {
        exitHandler = cb;
        return { dispose: () => {} };
      },
      write() {},
      kill() {},
    };
  };
  {
    const dir = await identityDir();
    let relayed = "";
    const promise = captureClaudeToken({
      stdin: fakeInput(false),
      dir,
      env: process.env,
      onData: (c) => (relayed += c),
      spawn,
    });
    await spawned;
    exitHandler?.({ exitCode: 0 });
    dataHandler?.("Your OAuth token (valid for 1 year):\r\n" + TOKEN + "\r\n");
    const result = await promise;
    expect(result.token).toBe(TOKEN);
    expect(result.redacted).toBe(true);
    expect(relayed).not.toContain(TOKEN);
    expect(dataDisposed).toBe(true);
  }
});

test("two open occurrences of the literal hold from the FIRST, not the rightmost", () => {
  // The literal's own `-` is a token-body character, so a real token can
  // contain a second occurrence of `sk-ant-oat01-` inside its body. Cutting at
  // the rightmost open occurrence relays the token's own head in clear and
  // then captures only the tail — an unusable credential stored while the
  // command reports success. Holding from the first open occurrence does
  // neither.
  const tricky = "sk-ant-oat01-XY" + TOKEN;
  let relayed = "";
  const filter = createTokenFilter((t) => (relayed += t));
  filter.push("Your OAuth token:\r\n" + tricky);
  expect(relayed).toBe("Your OAuth token:\r\n");
  filter.flush();
  // Nothing of the run escaped, not even its first 15 characters...
  expect(relayed).not.toContain("sk-ant-oat01-XY");
  expect(relayed).not.toContain(TOKEN);
  // ...and what was captured is the whole run, not the truncated tail.
  expect(filter.token).toBe(tricky);
});

/**
 * Stands in for `process.stdin` without a terminal: records every raw-mode
 * transition, lets a test deliver keystrokes, and reports whether the data
 * listener was removed again.
 */
function fakeInput(
  isTTY = true,
  startRaw = false,
  // Which attach step blows up, for the tests that check the half-attached
  // window. It throws BEFORE recording anything, the way a real ioctl failure
  // would leave the terminal untouched.
  throwOn?: "on" | "resume" | "setRawMode",
) {
  const rawCalls: boolean[] = [];
  const listeners: ((c: Buffer | string) => void)[] = [];
  let raw = startRaw;
  let paused = true;
  return {
    isTTY,
    get isRaw() {
      return raw;
    },
    setRawMode(r: boolean) {
      if (throwOn === "setRawMode") throw new Error("setRawMode exploded");
      raw = r;
      rawCalls.push(r);
    },
    on(_event: "data", l: (c: Buffer | string) => void) {
      if (throwOn === "on") throw new Error("on exploded");
      listeners.push(l);
    },
    off(_event: "data", l: (c: Buffer | string) => void) {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
    resume() {
      if (throwOn === "resume") throw new Error("resume exploded");
      paused = false;
    },
    pause() {
      paused = true;
    },
    isPaused() {
      return paused;
    },
    // Test-side controls, not part of the interface under test.
    rawCalls,
    type(text: string) {
      for (const l of [...listeners]) l(text);
    },
    listenerCount() {
      return listeners.length;
    },
  };
}

/**
 * Stands in for `process` as the place the restore's signal net is hooked, so a
 * test can fire a signal at the capture — and count what it left behind —
 * without registering handlers on, or actually signalling, the test runner.
 */
function fakeSignals() {
  const hooks = new Map<string, Set<() => void>>();
  const killed: string[] = [];
  const count = () => [...hooks.values()].reduce((n, s) => n + s.size, 0);
  let peak = 0;
  return {
    pid: 4242,
    once(event: string, listener: () => void) {
      const set = hooks.get(event) ?? new Set<() => void>();
      set.add(listener);
      hooks.set(event, set);
      peak = Math.max(peak, count());
    },
    off(event: string, listener: () => void) {
      hooks.get(event)?.delete(listener);
    },
    kill(pid: number, signal: NodeJS.Signals) {
      killed.push(`${pid}:${signal}`);
    },
    // Test-side controls, not part of the interface under test.
    killed,
    raise(event: string) {
      for (const l of [...(hooks.get(event) ?? [])]) l();
    },
    listenerCount() {
      return count();
    },
    peakListenerCount() {
      return peak;
    },
  };
}

/**
 * A stub child, and the hooks needed to drive it. Handed to the capture through
 * its `spawn` parameter rather than installed over the node-pty module's own
 * export, so there is nothing global to restore and the double has to satisfy
 * only what the capture uses (#74). `onDataThrows` reproduces a failure after
 * stdin has already been attached.
 */
function stubPty(opts: { onDataThrows?: Error } = {}) {
  const written: string[] = [];
  let exitHandler: ((e: { exitCode: number }) => void) | undefined;
  let notifySpawned: () => void = () => {};
  const spawned = new Promise<void>((r) => (notifySpawned = r));
  const spawn: SpawnPty = () => {
    notifySpawned();
    return {
      onData() {
        if (opts.onDataThrows) throw opts.onDataThrows;
        return { dispose() {} };
      },
      onExit(cb: (e: { exitCode: number }) => void) {
        exitHandler = cb;
        return { dispose() {} };
      },
      write(data: string) {
        written.push(data);
      },
      kill() {},
    };
  };
  return {
    spawn,
    written,
    spawned,
    exit: (exitCode: number) => exitHandler?.({ exitCode }),
  };
}

test("the operator's keystrokes reach the child, and raw mode is restored", async () => {
  // Half-attached is the defect: `claude` falls back to `Paste code here if
  // prompted:` whenever the browser callback cannot reach the local listener
  // (every ssh session), and with no stdin piped nothing the operator types
  // arrives, there is no timeout, and Ctrl-C goes to Muster rather than the
  // pty child.
  const pty = stubPty();
  const input = fakeInput();
  try {
    const promise = captureClaudeToken({
      spawn: pty.spawn,
      dir: await identityDir(),
      env: process.env,
      onData: () => {},
      stdin: input,
    });
    await pty.spawned;
    input.type("2f7c1a-code\r");
    expect(pty.written).toEqual(["2f7c1a-code\r"]);
    pty.exit(0);
    await promise;
  } finally {
  }
  expect(input.rawCalls).toEqual([true, false]);
  expect(input.listenerCount()).toBe(0);
  expect(input.isRaw).toBe(false);
});

test("raw mode is restored when the capture throws, not only when it exits", async () => {
  // The path that can actually damage the operator: a throw between attach and
  // exit. If the restore did not run in a `finally`, their shell is left with
  // no echo and no Ctrl-C after Muster is long gone — so this asserts the
  // restore on the error path specifically, with the error still propagating.
  const boom = new Error("pty exploded");
  const pty = stubPty({ onDataThrows: boom });
  const input = fakeInput();
  try {
    await expect(
      captureClaudeToken({
        spawn: pty.spawn,
        dir: await identityDir(),
        env: process.env,
        onData: () => {},
        stdin: input,
      }),
    ).rejects.toThrow("pty exploded");
  } finally {
  }
  expect(input.rawCalls).toEqual([true, false]);
  expect(input.listenerCount()).toBe(0);
  expect(input.isRaw).toBe(false);
});

test("a terminal already in raw mode is restored to raw, not to cooked", async () => {
  const pty = stubPty();
  const input = fakeInput(true, true);
  try {
    const promise = captureClaudeToken({
      spawn: pty.spawn,
      dir: await identityDir(),
      env: process.env,
      onData: () => {},
      stdin: input,
    });
    await pty.spawned;
    pty.exit(0);
    await promise;
  } finally {
  }
  expect(input.rawCalls).toEqual([true, true]);
  expect(input.isRaw).toBe(true);
});

test("a stdin that is not a TTY is never touched", async () => {
  // Nothing to pipe and no raw mode to set: `--interactive` already refuses a
  // non-terminal stdin, so this only has to leave it alone.
  const bin = await fakeClaude();
  const dir = await identityDir();
  const input = fakeInput(false);
  const result = await captureClaudeToken({
    dir,
    env: {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      MUSTER_FAKE_LOGIN: "ok",
    },
    onData: () => {},
    stdin: input,
  });
  expect(result.token).toBe(TOKEN);
  expect(input.rawCalls).toEqual([]);
  expect(input.listenerCount()).toBe(0);
});

test.each(["on", "resume", "setRawMode"] as const)(
  "a throw from the %s step still leaves the terminal usable",
  async (throwOn) => {
    // The window the caller's `finally` cannot reach: `attachInput` throws
    // partway through, so it never returns a restore for anyone else to run. If
    // raw mode were entered first, the operator's shell would be left with no
    // echo and no Ctrl-C while Muster died of an unrelated error, and they would
    // have to blind-type `reset`. Raw mode is therefore entered last, and
    // whatever was set up before the throw is undone here.
    const pty = stubPty();
    const input = fakeInput(true, false, throwOn);
    const signals = fakeSignals();
    try {
      await expect(
        captureClaudeToken({
          spawn: pty.spawn,
          dir: await identityDir(),
          env: process.env,
          onData: () => {},
          stdin: input,
          signals,
        }),
      ).rejects.toThrow("exploded");
    } finally {
    }
    // Never left raw, and nothing of the attach survived it.
    expect(input.isRaw).toBe(false);
    expect(input.rawCalls).not.toContain(true);
    expect(input.listenerCount()).toBe(0);
    expect(signals.listenerCount()).toBe(0);
  },
);

test("a signal restores the terminal and then keeps its normal effect", async () => {
  // A `kill -TERM` from another window ends the process without unwinding the
  // `finally`, so the net has to do the restore. It must not swallow the
  // signal: the handler removes itself and re-raises, which reaches node's
  // default disposition.
  const pty = stubPty();
  const input = fakeInput();
  const signals = fakeSignals();
  try {
    const promise = captureClaudeToken({
      spawn: pty.spawn,
      dir: await identityDir(),
      env: process.env,
      onData: () => {},
      stdin: input,
      signals,
    });
    await pty.spawned;
    expect(input.isRaw).toBe(true);
    expect(signals.listenerCount()).toBe(3);
    signals.raise("SIGTERM");
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount()).toBe(0);
    expect(signals.killed).toEqual(["4242:SIGTERM"]);
    // Removed by its own restore, which is what lets the re-raise through.
    expect(signals.listenerCount()).toBe(0);
    pty.exit(0);
    await promise;
  } finally {
  }
  // Idempotent: the `finally`'s restore did not touch the terminal a second time.
  expect(input.rawCalls).toEqual([true, false]);
});

test("an uncaught exit restores the terminal too", async () => {
  // Nothing signals on an uncaught exception; `exit` is the last chance.
  const pty = stubPty();
  const input = fakeInput();
  const signals = fakeSignals();
  try {
    const promise = captureClaudeToken({
      spawn: pty.spawn,
      dir: await identityDir(),
      env: process.env,
      onData: () => {},
      stdin: input,
      signals,
    });
    await pty.spawned;
    signals.raise("exit");
    expect(input.isRaw).toBe(false);
    expect(signals.killed).toEqual([]);
    pty.exit(0);
    await promise;
  } finally {
  }
});

test("repeated captures leave no signal handlers behind", async () => {
  // Registering on every capture is only safe if the restore takes them off
  // again: a long-lived process that logs in twice must not end up with two.
  const signals = fakeSignals();
  for (let i = 0; i < 3; i++) {
    const pty = stubPty();
    try {
      const promise = captureClaudeToken({
        spawn: pty.spawn,
        dir: await identityDir(),
        env: process.env,
        onData: () => {},
        stdin: fakeInput(),
        signals,
      });
      await pty.spawned;
      pty.exit(0);
      await promise;
    } finally {
    }
    expect(signals.listenerCount()).toBe(0);
  }
  expect(signals.peakListenerCount()).toBe(3);
});

/**
 * #69. `captureClaudeToken` defaulted its `stdin` to `process.stdin`, and five
 * tests here relied on that default. They were safe only because a vitest
 * worker happens to be handed a non-TTY stdin, so `attachInput` returned its
 * no-op before touching anything. Nothing enforced that: a runner that gave a
 * worker a TTY would have put the developer's own terminal into raw mode, from
 * a test that never asked for a keyboard.
 *
 * The default is gone, so a call that omits it now fails loudly instead of
 * reaching a real one. This keeps it that way, because nothing else can: the
 * suite is not typechecked — `tsconfig.json` includes only `src/**` — so a new
 * call site omitting the parameter would raise no compile error.
 */
test("every capture in this file is given a keyboard rather than inheriting one", () => {
  const source = readFileSync(import.meta.filename, "utf8");
  const omissions: number[] = [];
  const call = /captureClaudeToken\(\s*\{/g;
  for (let m = call.exec(source); m; m = call.exec(source)) {
    let depth = 0,
      end = m.index;
    for (let i = source.indexOf("{", m.index); i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (!source.slice(m.index, end).includes("stdin"))
      omissions.push(source.slice(0, m.index).split("\n").length);
  }
  expect(omissions, "captureClaudeToken calls with no injected stdin").toEqual(
    [],
  );
});

/**
 * The platform-independent half of the "could not be started" question.
 *
 * Deciding it from whether the child printed anything was wrong: on macOS a
 * missing executable emits nothing, and on Linux node-pty emits an error into
 * the pty, so the same situation took opposite branches and CI caught it. Asking
 * the filesystem whether the binary is there answers the same question the same
 * way everywhere, before anything is spawned.
 */
test("a command on PATH resolves, and one that is not does not", async () => {
  const bin = await fakeClaude();
  expect(await resolveOnPath("claude", { PATH: bin })).toContain("claude");
  expect(
    await resolveOnPath("claude", { PATH: await identityDir() }),
  ).toBeUndefined();
  expect(await resolveOnPath("claude", {})).toBeUndefined();
});
