import { expect, test } from "vitest";
import {
  paramsFingerprint,
  resolveLifecycle,
  runSchema,
} from "../src/guard.js";
import { configSchema } from "../src/config.js";

const empty = configSchema.parse({});
const req = (over: Record<string, unknown>) =>
  runSchema.parse({ runtime: "claude", prompt: "ping", ...over });

test("a session with nothing named gets the 30 minute default", () => {
  expect(resolveLifecycle(req({}), empty, true)).toEqual({
    idleTimeout: 1800,
    ttl: null,
  });
});

test("a flag beats config", () => {
  const config = configSchema.parse({ session: { idle_timeout: "45m" } });
  expect(
    resolveLifecycle(req({ idleTimeout: "10m" }), config, true).idleTimeout,
  ).toBe(600);
});

test("config beats the built-in default", () => {
  const config = configSchema.parse({ session: { idle_timeout: "45m" } });
  expect(resolveLifecycle(req({}), config, true).idleTimeout).toBe(2700);
});

test("off on the flag escapes a configured default", () => {
  // Otherwise a config default is inescapable per launch.
  const config = configSchema.parse({ session: { idle_timeout: "45m" } });
  expect(
    resolveLifecycle(req({ idleTimeout: "off" }), config, true).idleTimeout,
  ).toBeNull();
});

test("off in config disables the built-in default", () => {
  const config = configSchema.parse({ session: { idle_timeout: "off" } });
  expect(resolveLifecycle(req({}), config, true).idleTimeout).toBeNull();
});

test("ttl is off unless asked for", () => {
  expect(resolveLifecycle(req({ ttl: "4h" }), empty, true).ttl).toBe(14400);
  expect(resolveLifecycle(req({}), empty, true).ttl).toBeNull();
});

test("a task gets no lifecycle at all", () => {
  // A task is not a tmux session; it already ends when its prompt does.
  expect(resolveLifecycle(req({ kind: "task" }), empty, false)).toEqual({
    idleTimeout: null,
    ttl: null,
  });
});

test("a configured default does not reach a host that cannot reap", () => {
  // Refusing here would break every pty launch the moment someone sets a
  // default, so the default is skipped silently where an explicit flag errors.
  const config = configSchema.parse({ session: { idle_timeout: "45m" } });
  expect(resolveLifecycle(req({}), config, false).idleTimeout).toBeNull();
});

test("naming a lifecycle explicitly on a host that cannot honour it is refused", () => {
  // Covers pty, macos-terminal and task alike: all three arrive as reapable
  // false, and the caller decides which of them it was.
  expect(() =>
    resolveLifecycle(req({ host: "pty", idleTimeout: "10m" }), empty, false),
  ).toThrow(/--idle-timeout applies to tmux sessions/);
  expect(() =>
    resolveLifecycle(req({ host: "macos-terminal", ttl: "1h" }), empty, false),
  ).toThrow(/--ttl applies to tmux sessions/);
  expect(() =>
    resolveLifecycle(req({ kind: "task", ttl: "1h" }), empty, false),
  ).toThrow(/--ttl applies to tmux sessions/);
});

test("a malformed duration is refused with the flag named", () => {
  expect(() =>
    resolveLifecycle(req({ idleTimeout: "30" }), empty, true),
  ).toThrow(/--idle-timeout/);
});

test("off is accepted everywhere, because it asks for nothing", () => {
  // A wrapper that always passes `--idle-timeout off` to be safe must still be
  // able to launch a pty session.
  expect(
    resolveLifecycle(req({ host: "pty", idleTimeout: "off" }), empty, false),
  ).toEqual({ idleTimeout: null, ttl: null });
  expect(
    resolveLifecycle(req({ kind: "task", ttl: "off" }), empty, false),
  ).toEqual({ idleTimeout: null, ttl: null });
});

test("the lifecycle is part of a request key's identity", () => {
  // Otherwise --request-key K --idle-timeout off dedupes into an earlier
  // 30m session and hands the caller a session that dies under it.
  const base = { runtime: "claude" as const, prompt: "p", cwd: "/tmp" };
  const perms = { permissions: "deny" as const, sandbox: "read-only" as const };
  const a = paramsFingerprint(
    runSchema.parse({ ...base, idleTimeout: "30m" }),
    perms,
    [],
    [],
  );
  const b = paramsFingerprint(
    runSchema.parse({ ...base, idleTimeout: "off" }),
    perms,
    [],
    [],
  );
  expect(a).not.toBe(b);
});

test("a bad config value names the config key, not a flag nobody typed", () => {
  const config = configSchema.parse({
    session: { idle_timeout: "halfanhour" },
  });
  expect(() => resolveLifecycle(req({}), config, true)).toThrow(
    /\[session\] idle_timeout/,
  );
  const withTtl = configSchema.parse({ session: { ttl: "soon" } });
  expect(() => resolveLifecycle(req({}), withTtl, true)).toThrow(
    /\[session\] ttl/,
  );
});
