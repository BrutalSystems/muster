import { test, expect } from "vitest";
import { formatHuman, humanColorEnabled } from "../src/format.js";

test("human sessions retain full IDs and show tmux attach instructions", () => {
  const result = formatHuman({
    kind: "session",
    runtime: "codex",
    state: "idle",
    thread_id: "12345678-1234-1234-1234-123456789abc",
    canonical_id: "codex:review.abc",
    cwd: "/src/project with spaces",
    host: "tmux",
    attach_hint: "tmux -L muster attach -t muster",
  });
  expect(result).toContain("codex · session · idle");
  expect(result).toContain("ID: 12345678-1234-1234-1234-123456789abc");
  expect(result).toContain("Address: codex:review.abc");
  expect(result).toContain("Directory: /src/project with spaces");
  expect(result).toContain("Attach: tmux -L muster attach -t muster");
  expect(result).toContain(
    "Stop: muster stop 12345678-1234-1234-1234-123456789abc",
  );
});
test("human OpenCode sessions retain their ID and control URL", () => {
  const result = formatHuman({
    kind: "session",
    runtime: "opencode",
    state: "idle",
    session_id: "ses_0123456789abcdef",
    server_url: "http://127.0.0.1:4096",
    cwd: "/src/project",
  });
  expect(result).toContain("opencode · session · idle");
  expect(result).toContain("ID: ses_0123456789abcdef");
  expect(result).toContain("Control URL: http://127.0.0.1:4096");
});
test("human listing distinguishes pty sessions and completed tasks", () => {
  const result = formatHuman([
    {
      kind: "session",
      runtime: "claude-code",
      state: "busy",
      session_id: "peer-id",
      host: "pty",
      cwd: "/src",
    },
    {
      kind: "task",
      runtime: "codex",
      state: "exited",
      id: "task-id",
      cwd: "/src",
      exit_code: 7,
    },
  ]);
  expect(result).toContain("pty (not watchable or attachable)");
  expect(result).toContain("codex · task · exited");
  expect(result).toContain("Exit code: 7");
  expect(result).toContain("Output: muster output task-id");
  expect(result).not.toContain("muster stop task-id");
});
test("empty and failed human listings are readable and escape terminal controls", () => {
  expect(formatHuman([])).toBe("No Muster runs.\n");
  const result = formatHuman([
    {
      kind: "session",
      runtime: "claude",
      state: "failed",
      id: "failed-id",
      error: "startup\nfailed\u001b[31m",
    },
  ]);
  expect(result).toContain("Error: startup\\nfailed\\u001b[31m");
  expect(result).not.toContain("Attach:");
});

test("color styles status and commands while preserving IDs, paths and plain content", () => {
  const record = {
    kind: "task",
    runtime: "codex",
    state: "running",
    id: "full-task-id",
    cwd: "/src/project",
  };
  const colored = formatHuman(record, true);
  expect(colored).toContain("\u001b[32mrunning\u001b[0m");
  expect(colored).toContain("\u001b[90mID:\u001b[0m full-task-id");
  expect(colored).toContain("\u001b[90mDirectory:\u001b[0m /src/project");
  expect(colored).toContain("\u001b[36mmuster output full-task-id\u001b[0m");
  expect(colored.replace(/\u001b\[[0-9;]*m/g, "")).toBe(formatHuman(record));
});
test.each([
  ["idle", undefined, 32],
  ["busy", undefined, 33],
  ["exited", 0, 90],
  ["stopped", undefined, 90],
  ["failed", undefined, 31],
  ["exited", 1, 31],
])("colors %s with exit code %s appropriately", (state, exit_code, code) => {
  const result = formatHuman(
    {
      kind: "task",
      runtime: "codex",
      state: state as string,
      exit_code: exit_code as number | undefined,
    },
    true,
  );
  expect(result).toContain(`\u001b[${code}m${state}\u001b[0m`);
  if (exit_code === 1) expect(result).toContain("\u001b[31m1\u001b[0m");
});

test("color requires a terminal and respects NO_COLOR and TERM=dumb", () => {
  expect(humanColorEnabled(true, {})).toBe(true);
  expect(humanColorEnabled(false, {})).toBe(false);
  expect(humanColorEnabled(undefined, {})).toBe(false);
  expect(humanColorEnabled(true, { NO_COLOR: "1" })).toBe(false);
  expect(humanColorEnabled(true, { NO_COLOR: "" })).toBe(false);
  expect(humanColorEnabled(true, { TERM: "dumb" })).toBe(false);
  expect(humanColorEnabled(false, { FORCE_COLOR: "1" })).toBe(false);
});

test("human output names the selected viewer and handles older records", () => {
  for (const [terminal, label] of [
    ["ghostty", "Ghostty"],
    ["iterm2", "iTerm2"],
    [undefined, "Terminal.app"],
  ])
    expect(formatHuman({ terminal, terminal_opened: true })).toContain(
      `Terminal: ${label} (opened at launch)`,
    );
});

test("a known model is shown in the human view", () => {
  const out = formatHuman({
    kind: "task",
    runtime: "claude",
    state: "exited",
    id: "x",
    cwd: "/tmp",
    model: "opus",
  });
  expect(out).toContain("Model: opus");
});

test("an unknown model is omitted rather than shown as a dash", () => {
  const out = formatHuman({
    kind: "task",
    runtime: "claude",
    state: "exited",
    id: "x",
    cwd: "/tmp",
    model: null,
  });
  expect(out).not.toContain("Model");
});

test("the human view names the identity a launch ran under", () => {
  const out = formatHuman({
    kind: "session",
    runtime: "codex",
    state: "idle",
    id: "01a0d002",
    cwd: "/tmp",
    identity: "codex-personal",
  });
  expect(out).toContain("Identity: codex-personal");
});

test("a launch with no identity shows no Identity line", () => {
  const out = formatHuman({
    kind: "session",
    runtime: "codex",
    state: "idle",
    id: "01a0d002",
    cwd: "/tmp",
  });
  expect(out).not.toContain("Identity");
});

test("the human view says whether a model was pinned or came from config", () => {
  const pinned = formatHuman({
    kind: "task",
    runtime: "claude",
    state: "exited",
    id: "x",
    cwd: "/tmp",
    model: "opus",
    model_source: "request",
  });
  expect(pinned).toContain("Model: opus (requested)");
  const defaulted = formatHuman({
    kind: "session",
    runtime: "opencode",
    state: "idle",
    id: "y",
    cwd: "/tmp",
    model: "local/qwen",
    model_source: "config",
  });
  expect(defaulted).toContain("Model: local/qwen (configured default)");
});
