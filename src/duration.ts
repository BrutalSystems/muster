/** Seconds, or `"off"` for a lifecycle limit that does not apply. */
export type Duration = number | "off";

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600 };

/**
 * `90s`, `30m`, `4h`, or `off`.
 *
 * A bare number is refused rather than assigned a unit: guessing seconds turns
 * `--ttl 30` into half a minute and reaps a session the caller meant to keep
 * for half an hour. Zero and negative are refused for the same reason — they
 * would read as "reap immediately", which no caller types on purpose.
 */
export function parseDuration(value: string, label: string): Duration {
  const raw = value.trim();
  if (raw.toLowerCase() === "off") return "off";
  const match = /^(\d+)([smh])$/i.exec(raw);
  const seconds = match
    ? Number(match[1]) * UNITS[match[2]!.toLowerCase()]!
    : 0;
  if (!match || seconds <= 0)
    throw new Error(
      `${label} must be a duration like 90s, 30m, 4h, or off (got ${JSON.stringify(value)})`,
    );
  return seconds;
}

/**
 * `wait --timeout`: seconds as a bare number, which is what `timeout(1)` and
 * shell callers write, or a duration. A lifecycle limit refuses the bare
 * number because a wrong unit reaps a session; here the unit is the obvious
 * one. `off` is refused: no timeout is spelled by leaving the flag out.
 */
export function waitSeconds(value: string): number {
  const raw = value.trim();
  const seconds = /^\d+$/.test(raw)
    ? Number(raw)
    : /^\d+[smh]$/i.test(raw)
      ? (parseDuration(raw, "--timeout") as number)
      : 0;
  if (seconds <= 0)
    throw new Error(
      `--timeout must be seconds or a duration like 90s, 30m, 4h (got ${JSON.stringify(value)})`,
    );
  return seconds;
}
