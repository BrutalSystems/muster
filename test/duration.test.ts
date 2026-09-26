import { expect, test } from "vitest";
import { parseDuration } from "../src/duration.js";
import { configSchema } from "../src/config.js";

test("accepts seconds, minutes and hours", () => {
  expect(parseDuration("90s", "--ttl")).toBe(90);
  expect(parseDuration("30m", "--ttl")).toBe(1800);
  expect(parseDuration("4h", "--ttl")).toBe(14400);
});

test("off disables", () => {
  expect(parseDuration("off", "--idle-timeout")).toBe("off");
  expect(parseDuration("OFF", "--idle-timeout")).toBe("off");
});

test("a bare number is refused rather than guessed at", () => {
  // Guessing a unit is how "30" becomes 30 seconds and reaps a session
  // someone meant to keep for thirty minutes.
  expect(() => parseDuration("30", "--ttl")).toThrow(/--ttl/);
  expect(() => parseDuration("30", "--ttl")).toThrow(/90s, 30m, 4h/);
});

test("zero and negative are refused, not treated as instant", () => {
  expect(() => parseDuration("0m", "--ttl")).toThrow(/--ttl/);
  expect(() => parseDuration("-5m", "--ttl")).toThrow(/--ttl/);
});

test("an unknown unit is refused", () => {
  expect(() => parseDuration("30x", "--ttl")).toThrow(/--ttl/);
  expect(() => parseDuration("", "--ttl")).toThrow(/--ttl/);
});

test("config accepts a session lifecycle section", () => {
  const config = configSchema.parse({
    session: { idle_timeout: "45m", ttl: "4h" },
  });
  expect(config.session.idle_timeout).toBe("45m");
  expect(config.session.ttl).toBe("4h");
});

test("an absent session section parses to empty, not to a default value", () => {
  // The built-in default lives in one place (Task 5), not in two.
  const config = configSchema.parse({});
  expect(config.session.idle_timeout).toBeUndefined();
  expect(config.session.ttl).toBeUndefined();
});

test("a unit is case-insensitive, as off already was", () => {
  expect(parseDuration("30M", "--ttl")).toBe(1800);
  expect(parseDuration("4H", "--ttl")).toBe(14400);
  expect(parseDuration("90S", "--ttl")).toBe(90);
});
