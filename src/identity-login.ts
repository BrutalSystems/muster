import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
/**
 * Where `name` is on PATH, or undefined. The same lookup `tmuxExecutable` does,
 * and the reason the login asks it: whether a child "could not be started" has
 * to be decided before spawning, not inferred from what it printed. node-pty
 * does not throw for a missing executable — it exits 1, emitting nothing on
 * macOS and an error into the pty on Linux, so output was never the discriminator
 * it appeared to be (#69).
 */
export async function resolveOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable. Keep looking.
    }
  }
  return undefined;
}
/**
 * The part of node-pty's `IPty` this module touches, and a spawn that returns
 * one. Narrow for the same reason `CaptureInput` and `SignalTarget` below are:
 * a test double should have to implement what is used, not a whole terminal,
 * and `IPty` is broad enough that a double could only ever be cast to it (#74).
 */
export type SpawnedPty = {
  onData(cb: (chunk: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  write(data: string): void;
  kill(): void;
};
export type SpawnPty = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    name: string;
    cols: number;
    rows: number;
  },
) => SpawnedPty;
/**
 * A Claude long-lived OAuth token, as `claude setup-token` prints it. The length
 * floor is what separates a real token from the literal word in help text.
 */
export const CLAUDE_TOKEN_PATTERN = /sk-ant-oat01-[A-Za-z0-9_-]{40,}/;
/** The token's fixed literal prefix, used to detect an in-progress match. */
const TOKEN_PREFIX = "sk-ant-oat01-";
/** The character class the token body is drawn from, after the prefix. */
const TOKEN_BODY_CHAR = /[A-Za-z0-9_-]/;
/** Enough to recognise which token this is; never enough to use it. */
export function redactToken(token: string): string {
  return `${token.slice(0, 12)}…${token.slice(-5)}`;
}
/**
 * How many leading characters of `text` are safe to release right now — the
 * rest, a trailing suffix, could still turn into (part of) a token given more
 * input and must be held back.
 *
 * Two shapes count as "could still turn into a token":
 *  - a trailing partial prefix of the literal `sk-ant-oat01-` (e.g. text
 *    ending in `sk-ant-o` might still complete into the literal on the next
 *    push), and
 *  - an already-open run: the literal prefix followed by an unbroken run of
 *    token-body characters that reaches all the way to the end of `text` —
 *    the body has no upper bound, so more valid characters could still
 *    arrive and extend it.
 *
 * Everything else — including a run of token-body characters that is *not*
 * preceded by the literal prefix, and ordinary prose — is not a live prefix
 * of the pattern and is safe to release immediately. That is what keeps the
 * held-back tail bounded for realistic non-token output (prompts with no
 * trailing newline, a `\r`-redrawn spinner) instead of waiting on a newline
 * that may never come.
 */
function livePrefixStart(text: string): number {
  // An open run: the FIRST literal occurrence with nothing but body characters
  // between it and the end of `text`. First, not rightmost, and that direction
  // is load-bearing. The literal's own `-` is a body character, so a token can
  // contain a second occurrence of the literal inside its body. Cutting at the
  // rightmost one releases everything before it — the token's own head — in
  // clear, and then captures only the truncated tail as the token, storing an
  // unusable credential while reporting success. Holding from the first open
  // occurrence is strictly more conservative and still exactly minimal: every
  // later occurrence lies inside the run being held.
  for (let i = 0; i + TOKEN_PREFIX.length <= text.length; i++) {
    if (!text.startsWith(TOKEN_PREFIX, i)) continue;
    let open = true;
    for (let j = i + TOKEN_PREFIX.length; j < text.length; j++) {
      if (!TOKEN_BODY_CHAR.test(text.charAt(j))) {
        open = false;
        break;
      }
    }
    if (open) return i;
  }
  // A partial prefix of the literal itself, still trailing at the very end.
  for (let n = Math.min(TOKEN_PREFIX.length - 1, text.length); n >= 1; n--) {
    if (text.endsWith(TOKEN_PREFIX.slice(0, n))) return text.length - n;
  }
  return text.length;
}
/**
 * Relays a stream while holding back any token it contains.
 *
 * Buffers on the boundary of what could still become a token match — never a
 * fixed byte count, and never "wait for the next newline". A byte-count tail
 * can split a token across two relayed pieces, neither of which matches the
 * pattern, and the operator's scrollback then holds both halves in clear:
 * that is the exact leak this object exists to prevent. Waiting for a
 * newline is wrong in the other direction: it holds back ordinary, non-token
 * output — a prompt printed with no trailing newline, a `\r`-redrawn spinner
 * — until the process exits, and grows the held-back tail without bound for
 * as long as no newline arrives. `livePrefixStart` computes the exact
 * minimal suffix that could still extend into a match, so anything else
 * streams through immediately, and a real, complete token is still always
 * relayed whole or not at all.
 *
 * A run of token-body characters that never terminates — the child never
 * stops emitting, or line-wraps the token before the pattern's length floor
 * is reached — stays held until `flush()`. That is the one place an
 * unbounded hold is both correct and expected: the stream has ended, so
 * whatever's left is exactly as complete as it will ever be.
 *
 * Matches are found with a fresh, local `/g` regex built from
 * `CLAUDE_TOKEN_PATTERN.source` on every call, never by setting `g` on
 * `CLAUDE_TOKEN_PATTERN` itself — a shared exported regex with `g` set
 * carries `lastIndex` across unrelated calls and would silently skip matches
 * for every other caller of the pattern.
 */
export function createTokenFilter(onData: (text: string) => void) {
  let carry = "";
  let token: string | undefined;
  let redacted = false;
  const relay = (text: string) => {
    if (!text) return;
    const matches = text.match(new RegExp(CLAUDE_TOKEN_PATTERN.source, "g"));
    if (!matches) return onData(text);
    token ??= matches[0];
    redacted = true;
    let out = text;
    for (const m of matches) out = out.split(m).join(redactToken(m));
    onData(out);
  };
  return {
    push(chunk: string) {
      const text = carry + chunk;
      const cut = livePrefixStart(text);
      carry = text.slice(cut);
      if (cut > 0) relay(text.slice(0, cut));
    },
    flush() {
      const rest = carry;
      carry = "";
      relay(rest);
    },
    get token() {
      return token;
    },
    get redacted() {
      return redacted;
    },
  };
}
/**
 * The part of `process.stdin` this module touches. Narrow on purpose: it is
 * what lets a test drive the attach/restore without a real terminal.
 */
export interface CaptureInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(raw: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  isPaused(): boolean;
}
/**
 * The part of `process` the signal safety net touches. Narrow for the same
 * reason as `CaptureInput`: a test can assert the net is installed, fires, and
 * is removed again without registering handlers on — or signalling — the test
 * runner's own process.
 */
export interface SignalTarget {
  pid: number;
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
}
/**
 * Attach the operator's keyboard to the child for the life of the capture, and
 * return the function that puts the terminal back.
 *
 * Without this the login is half-attached: the operator sees `Paste code here
 * if prompted:` — the documented fallback whenever the browser callback cannot
 * reach the local listener, which is every ssh session — and nothing they type
 * reaches the child. There is deliberately no timeout, and Ctrl-C goes to
 * Muster rather than the pty child (node-pty puts it in its own session), so
 * the flow hangs until the operator kills Muster.
 *
 * Raw mode is what makes that keyboard useful (no local echo of a pasted code,
 * single keypresses delivered immediately) and it is also the one thing in this
 * whole change that can damage the operator's shell: a leaked raw mode leaves
 * their terminal with no echo and no Ctrl-C long after Muster has exited. So
 * the returned restore is the requirement, the caller runs it in a `finally`,
 * it is idempotent, and it puts raw mode back FIRST — before anything else that
 * could throw and skip it.
 *
 * Two things guard the window the caller's `finally` cannot reach — the one
 * between entering raw mode and the restore being in the caller's hands:
 *
 *  - **Raw mode is entered LAST**, after the listener is attached and the
 *    stream resumed. That is the whole of the fix, and it is why the attach
 *    order below must not be "tidied". Guarding the call site instead cannot
 *    work: a throw partway through this function never returns a restore for
 *    any `finally` to run, so the ordering has to make the window not exist.
 *    The `catch` is only for the stragglers — a throw before raw mode still
 *    has a resumed stream and a live listener to undo.
 *  - **A signal net.** A `kill -TERM` from another window, or an uncaught
 *    exception raised outside the capture's promise chain, ends the process
 *    without unwinding any `finally`. So SIGINT/SIGTERM/`exit` handlers run
 *    the same restore. They are removed by that restore, so repeated captures
 *    cannot accumulate handlers and a completed one leaves none behind — and
 *    because the handler is gone by the time it re-raises, the signal keeps
 *    its normal effect (node's default disposition: terminate, 128 + signum).
 *
 * Only a TTY is touched. A piped stdin has no raw mode to set, and nothing is
 * forwarded from it: `--interactive` already refuses a non-terminal stdin.
 */
function attachInput(
  pty: SpawnedPty,
  input: CaptureInput,
  signals: SignalTarget,
): () => void {
  if (!input.isTTY) return () => {};
  const wasRaw = input.isRaw === true;
  const wasPaused = input.isPaused();
  const forward = (chunk: Buffer | string) => {
    try {
      pty.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    } catch {
      // The child is gone and the exit path is already settling; a keystroke
      // that lands in that window is not worth failing the login over.
    }
  };
  const hooked: [string, () => void][] = [];
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      input.setRawMode(wasRaw);
    } catch {
      // Nothing better to do: the terminal is whatever it is.
    }
    try {
      input.off("data", forward);
    } catch {
      // Ditto.
    }
    if (wasPaused)
      try {
        input.pause();
      } catch {
        // Ditto.
      }
    for (const [event, handler] of hooked.splice(0))
      try {
        signals.off(event, handler);
      } catch {
        // Ditto.
      }
  };
  try {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        restore();
        // The restore above removed this handler, so this re-raise reaches
        // node's default disposition rather than looping back in here.
        signals.kill(signals.pid, signal);
      };
      hooked.push([signal, handler]);
      signals.once(signal, handler);
    }
    // Covers what no signal does: an uncaught exception, or a `process.exit`
    // from somewhere else entirely.
    const onExit = () => restore();
    hooked.push(["exit", onExit]);
    signals.once("exit", onExit);
    input.on("data", forward);
    input.resume();
    // LAST. See the ordering note above; do not move this up.
    input.setRawMode(true);
  } catch (err) {
    restore();
    throw err;
  }
  return restore;
}
/**
 * Run `claude setup-token` against an identity's template and capture the token
 * it prints, relaying everything else so the operator still sees and approves
 * the browser step.
 *
 * Fails OPEN. If the output format changes and the pattern stops matching,
 * nothing is redacted and nothing is captured: the operator sees exactly what
 * they see today, and — the login itself having succeeded — the caller reports
 * that it could not recognise a token and points at `--token-env` to record the
 * one now in their scrollback. (Re-running `--interactive` cannot: it mints a
 * different token.) The alternatives — silently leaking because redaction
 * broke, or silently refusing because capture broke — are both worse than the
 * status quo.
 */
export async function captureClaudeToken(opts: {
  dir: string;
  env: NodeJS.ProcessEnv;
  onData: (chunk: string) => void;
  /** The operator's keyboard. Required, and deliberately not defaulted: a
   *  default of `process.stdin` reached the real terminal from any caller that
   *  forgot, and the suite is not typechecked, so nothing would have said so
   *  (#69). The one caller that means the real keyboard names it. */
  stdin: CaptureInput;
  /** Where the restore's signal net is hooked. A parameter for the same reason. */
  signals?: SignalTarget;
  /** How the child is started. A parameter so a test supplies a double instead
   *  of reaching into the node-pty module object and replacing its export. */
  spawn?: SpawnPty;
}): Promise<{
  token?: string;
  exitCode: number;
  redacted: boolean;
}> {
  const spawn = opts.spawn ?? (await import("node-pty")).spawn;
  const pty: SpawnedPty = spawn("claude", ["setup-token"], {
    cwd: opts.dir,
    env: { ...opts.env, CLAUDE_CONFIG_DIR: opts.dir } as Record<string, string>,
    name: "xterm-256color",
    // Load-bearing, not cosmetic: `claude` renders the token inside a
    // bordered box sized to the terminal width, and a narrower column count
    // wraps the token itself across a hard line break. A token split by a
    // real newline matches nothing on either side of the break, which
    // defeats this filter entirely. Do not "tidy" this back toward a more
    // realistic terminal width.
    cols: 1000,
    rows: 30,
  });
  // Inside the `try`, so the `finally` below is in charge of the restore from
  // the moment there is one — on every exit path: normal exit, an error from the
  // pty, a rejected await. A throw from inside `attachInput` itself never gets
  // here at all, which is why that function restores whatever it managed to set
  // up before rethrowing, and enters raw mode last of all.
  let detachInput = () => {};
  try {
    detachInput = attachInput(pty, opts.stdin, opts.signals ?? process);
    const filter = createTokenFilter(opts.onData);
    const dataSub = pty.onData((chunk) => filter.push(chunk));
    const exitCode = await new Promise<number>((resolve) => {
      const exitSub = pty.onExit(({ exitCode }) => {
        exitSub.dispose();
        // node-pty can still have an onData chunk queued when onExit fires;
        // resolving synchronously here risks flushing before it arrives and
        // silently dropping a token that lands right at process exit.
        // Deferring to a macrotask lets any already-queued onData run first.
        setImmediate(() => resolve(exitCode));
      });
    });
    dataSub.dispose();
    filter.flush();
    try {
      // Defensive: the process has already exited by the time we get here, so
      // this is normally a no-op. It costs nothing to make sure nothing is
      // left running once this promise settles.
      pty.kill();
    } catch {
      // Already gone.
    }
    return {
      ...(filter.token ? { token: filter.token } : {}),
      exitCode,
      redacted: filter.redacted,
    };
  } finally {
    detachInput();
  }
}
