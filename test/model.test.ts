import { expect, test } from "vitest";
import {
  launchArgs,
  resolveModel,
  runSchema,
  runtimeArgs,
} from "../src/guard.js";
import { configSchema } from "../src/config.js";

const empty = configSchema.parse({});
const req = (over: Record<string, unknown>) =>
  runSchema.parse({ runtime: "claude", prompt: "ping", ...over });

test("a model named as --model is resolved with source request", () => {
  expect(resolveModel(req({ model: "opus" }), empty)).toEqual({
    model: "opus",
    source: "request",
    origin: "flag",
  });
});

test("a model named inside args is resolved the same way", () => {
  expect(resolveModel(req({ args: ["--model", "opus"] }), empty)).toEqual({
    model: "opus",
    source: "request",
    origin: "args",
  });
});

test("the equals form is recognised", () => {
  expect(resolveModel(req({ args: ["--model=opus"] }), empty)).toEqual({
    model: "opus",
    source: "request",
    origin: "args",
  });
});

test("flag spelling is normalised the way runtimeArgs normalises it", () => {
  expect(resolveModel(req({ args: ["--MODEL", "opus"] }), empty)?.model).toBe(
    "opus",
  );
  expect(resolveModel(req({ args: ["-m", "opus"] }), empty)?.model).toBe(
    "opus",
  );
});

test("naming a model twice is refused rather than silently preferring one", () => {
  expect(() =>
    resolveModel(req({ model: "opus", args: ["--model", "sonnet"] }), empty),
  ).toThrow(/twice/i);
});

test("PROVIDER/MODEL is refused for claude, which takes a bare id", () => {
  expect(() => resolveModel(req({ model: "anthropic/opus" }), empty)).toThrow(
    /bare model id/,
  );
});

test("PROVIDER/MODEL is refused for codex too", () => {
  expect(() =>
    resolveModel(req({ runtime: "codex", model: "openai/gpt-5" }), empty),
  ).toThrow(/bare model id/);
});

test("opencode keeps accepting a slashed model, which is its native form", () => {
  expect(
    resolveModel(req({ runtime: "opencode", model: "anthropic/x" }), empty),
  ).toEqual({ model: "anthropic/x", source: "request", origin: "flag" });
});

test("opencode falls back to the configured default, tagged config", () => {
  const config = configSchema.parse({ opencode: { model: "local/qwen" } });
  expect(resolveModel(req({ runtime: "opencode" }), config)).toEqual({
    model: "local/qwen",
    source: "config",
    origin: "config",
  });
});

test("a request beats the configured default and says so", () => {
  const config = configSchema.parse({ opencode: { model: "local/qwen" } });
  expect(
    resolveModel(req({ runtime: "opencode", model: "local/other" }), config),
  ).toEqual({ model: "local/other", source: "request", origin: "flag" });
});

test("nothing named and no default resolves to null, not a guess", () => {
  expect(resolveModel(req({}), empty)).toBeNull();
  expect(resolveModel(req({ runtime: "codex" }), empty)).toBeNull();
});

test("claude and codex have no configured default to fall back to", () => {
  const config = configSchema.parse({ opencode: { model: "local/qwen" } });
  expect(resolveModel(req({ runtime: "claude" }), config)).toBeNull();
});

test("a model flag with no value is left for runtimeArgs to complain about", () => {
  expect(resolveModel(req({ args: ["--model"] }), empty)).toBeNull();
});

test("claude gets the model on its argv exactly once", () => {
  const argv = launchArgs(req({ model: "opus" }), empty);
  expect(argv.filter((a) => a === "--model")).toHaveLength(1);
  expect(
    argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2),
  ).toEqual(["--model", "opus"]);
});

test("a model in args reaches claude's argv once, not twice", () => {
  const argv = launchArgs(req({ args: ["--model", "opus"] }), empty);
  expect(argv.filter((a) => a === "--model")).toHaveLength(1);
});

test("the equals form in args also produces one flag and its value", () => {
  const argv = launchArgs(req({ args: ["--model=opus"] }), empty);
  expect(argv.filter((a) => a === "--model")).toHaveLength(1);
  expect(argv).toContain("opus");
  expect(argv).not.toContain("--model=opus");
});

test("codex gets the model on its argv", () => {
  const argv = launchArgs(
    req({ runtime: "codex", model: "gpt-5-codex" }),
    empty,
  );
  expect(
    argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2),
  ).toEqual(["--model", "gpt-5-codex"]);
});

test("naming no model leaves the argv without one", () => {
  expect(launchArgs(req({}), empty)).not.toContain("--model");
});

test("a consumed model flag is not forwarded as a runtime option", () => {
  expect(runtimeArgs(req({ args: ["--model", "opus"] }))).toEqual([]);
});

test("--effort is still forwarded for claude alongside a model", () => {
  expect(runtimeArgs(req({ args: ["--effort", "high"] }))).toEqual([
    "--effort",
    "high",
  ]);
});

test("a model flag with no value still raises the existing error", () => {
  expect(() => runtimeArgs(req({ args: ["--model"] }))).toThrow(
    "Missing value for --model",
  );
});

test("an unknown runtime option is still refused", () => {
  expect(() => runtimeArgs(req({ args: ["--wat", "x"] }))).toThrow(
    "Runtime option refused: --wat",
  );
});

test("opencode still forwards a model from args to the child's argv", () => {
  expect(
    runtimeArgs(req({ runtime: "opencode", args: ["--model", "local/qwen"] })),
  ).toEqual(["--model", "local/qwen"]);
});

test("an empty model value is refused rather than silently ignored", () => {
  // The accepted-and-dropped failure #70 exists to remove. Naming a model and
  // getting silence plus a recorded null is the same defect in miniature.
  expect(() => resolveModel(req({ args: ["--model="] }), empty)).toThrow(
    /Missing value for --model/,
  );
});

test("a model named twice inside args is refused, not resolved to the first", () => {
  // Otherwise opencode forwards both to the child, whose last flag wins, while
  // the record keeps the first — an audit record that disagrees with the run.
  expect(() =>
    resolveModel(req({ args: ["--model", "a", "--model", "b"] }), empty),
  ).toThrow(/twice/i);
});

test("an args-named model is tagged so opencode can tell it from a flag", () => {
  expect(resolveModel(req({ args: ["--model", "opus"] }), empty)?.origin).toBe(
    "args",
  );
  expect(resolveModel(req({ model: "opus" }), empty)?.origin).toBe("flag");
});

test("launchArgs raises the model error before the runtime-option error", () => {
  // The spec's order is load-bearing: resolveModel owns every model error.
  // `Muster.launch` resolves first, so this only shows through the exported
  // launchArgs — which is exactly why the invariant belongs in the function
  // rather than in its caller's discipline.
  // Needs an input where BOTH errors are live: a model conflict and a refused
  // option. Whichever function runs first decides which one the caller sees.
  expect(() =>
    launchArgs(
      req({ model: "opus", args: ["--model", "sonnet", "--wat", "x"] }),
      empty,
    ),
  ).toThrow(/twice/i);
});
