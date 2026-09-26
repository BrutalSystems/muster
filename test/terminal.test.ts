import { test, expect, vi } from "vitest";
import { openTerminal, terminalAvailable } from "../src/hosts/terminal.js";
import { command } from "../src/identity/processes.js";
import { ampleDeadline } from "./deadline.js";
vi.mock("../src/identity/processes.js", () => ({
  command: vi.fn(async () => ""),
}));
test("Terminal.app receives a literal attach command as an argument, not AppleScript source", async () => {
  await openTerminal("/tmp/a'b/tmux", "muster-test", "@12", Date.now() + 5000);
  const [bin, args] = vi.mocked(command).mock.calls.at(-1)!;
  expect(bin).toBe("/usr/bin/osascript");
  expect(args[0]).toBe("-e");
  expect(args[1]).toContain("do script (item 1 of argv)");
  // The Apple event order is significant: activate on a cold app opens
  // a default shell before do script creates the requested window.
  expect(args[1]).toMatch(/launch\s+do script \(item 1 of argv\)\s+activate/);
  expect(args[1]).not.toContain("/tmp/a'b/tmux");
  expect(args[2]).toContain("'/tmp/a'\\''b/tmux'");
  expect(args[2]).toContain("attach-session -t @12");
});
test("invalid server and window references cannot become shell commands", async () => {
  for (const [server, ref] of [
    ["muster;touch BAD", "@1"],
    ["muster", "@1;touch BAD"],
  ])
    await expect(
      openTerminal("/bin/tmux", server!, ref!, ampleDeadline()),
    ).rejects.toThrow(/Invalid/);
});
test("Terminal opening is unavailable off macOS", async () => {
  expect(await terminalAvailable("linux")).toBe(false);
});

test("Ghostty receives executable arguments without a shell or AppleScript", async () => {
  await openTerminal(
    "/tmp/a'b/tmux",
    "muster-test",
    "@12",
    Date.now() + 5000,
    "ghostty",
  );
  const [bin, args] = vi.mocked(command).mock.calls.at(-1)!;
  expect(bin).toBe("/usr/bin/open");
  expect(args).toEqual([
    "-na",
    "Ghostty",
    "--args",
    "--quit-after-last-window-closed=true",
    "--window-save-state=never",
    "-e",
    "/tmp/a'b/tmux",
    "-L",
    "muster-test",
    "attach-session",
    "-t",
    "@12",
  ]);
});
test("iTerm2 receives its own window creation command", async () => {
  await openTerminal(
    "/opt/bin/tmux",
    "muster-test",
    "@2",
    Date.now() + 5000,
    "iterm2",
  );
  const [bin, args] = vi.mocked(command).mock.calls.at(-1)!;
  expect(bin).toBe("/usr/bin/osascript");
  expect(args[1]).toContain('tell application "iTerm"');
  expect(args[1]).toContain(
    "create window with default profile command (item 1 of argv)",
  );
  expect(args[2]).toContain("attach-session -t @2");
});
