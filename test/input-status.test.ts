import { expect, test } from "vitest";
import {
  classifyScreen,
  codexInputStatus,
  unknownInputStatus,
} from "../src/input-status.js";
import { TmuxHost } from "../src/hosts/tmux.js";
import { testServer } from "./global-setup.js";
import { fixture } from "./helpers.js";

for (const [runtime, screen, reason] of [
  [
    "claude",
    "Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\nEnter to confirm",
    "trust",
  ],
  [
    "claude",
    "Bypass Permissions mode\n❯ 1. Yes, I accept\n  2. No, exit",
    "bypass-warning",
  ],
  ["claude", "Do you want to proceed?\n❯ 1. Yes\n  2. No", "permission"],
  ["codex", "Trust this folder?\n› Trust and continue\nCancel", "trust"],
  [
    "codex",
    "Would you like to run the following command?\n› 1. Yes, proceed\n2. No",
    "permission",
  ],
  ["opencode", "[sudo] password for operator:", "password"],
  ["claude", "Password:", "password"],
  [
    "claude",
    "Are you sure you want to continue connecting (yes/no/[fingerprint])?",
    "host-key",
  ],
] as const)
  test(`recognizes ${runtime} ${reason} from visible screen evidence`, () => {
    expect(classifyScreen(runtime, screen)).toMatchObject({
      state: "waiting",
      reason,
      source: "tmux-screen",
    });
  });

test("quiet, busy and ordinary prose do not establish waiting", () => {
  for (const text of [
    "",
    "❯",
    "Working (esc to interrupt)",
    "The documentation mentions Password: as an example.",
    "Do you want to proceed?\nThis is a quoted example in a tutorial.",
  ])
    expect(classifyScreen("claude", text)).toMatchObject({
      state: "unknown",
      reason: "unknown",
    });
  expect(
    classifyScreen(
      "claude",
      "Password:\n" + Array(50).fill("ordinary output").join("\n"),
    ),
  ).toMatchObject({ state: "unknown" });
});

test("native Codex approval flags are positive evidence, idle and absent flags are not", () => {
  expect(
    codexInputStatus({ type: "active", activeFlags: ["waitingOnApproval"] }),
  ).toMatchObject({
    state: "waiting",
    reason: "permission",
    source: "codex-status",
  });
  expect(
    codexInputStatus({ type: "active", activeFlags: ["waitingOnUserInput"] }),
  ).toMatchObject({ state: "waiting", reason: "question" });
  for (const status of [
    "idle",
    { type: "idle" },
    { type: "active", activeFlags: [] },
    { type: "idle", activeFlags: ["waitingOnApproval"] },
  ])
    expect(codexInputStatus(status)).toBeUndefined();
  expect(unknownInputStatus().observed_at).toMatch(/^\d{4}-/);
});

test("tmux inspects only its owned pane's visible screen and returns no captured text", async () => {
  const f = await fixture();
  const host = new TmuxHost(testServer("input-screen"));
  const launch = await host.launch({
    argv: [
      process.execPath,
      "-e",
      "process.stdout.write('Password:');setInterval(()=>{},1000)",
    ],
    cwd: f.root,
    env: f.env,
    label: "input-probe",
  });
  try {
    await expect
      .poll(
        async () =>
          (await host.inputStatus(launch.hostRef, "claude", Date.now() + 1000))
            .reason,
      )
      .toBe("password");
    const observed = await host.inputStatus(
      launch.hostRef,
      "claude",
      Date.now() + 1000,
    );
    expect(Object.keys(observed).sort()).toEqual([
      "observed_at",
      "reason",
      "source",
      "state",
    ]);
    await expect(
      host.inputStatus("@9999999", "claude", Date.now() + 500),
    ).resolves.toMatchObject({ state: "unknown" });
  } finally {
    await host.stop(launch.hostRef);
  }
});

test("a returned input prompt supersedes old dialog text still visible above it", () => {
  expect(
    classifyScreen(
      "claude",
      "Do you want to proceed?\n1. Yes\n2. No\nFinished\n❯ ",
    ),
  ).toMatchObject({ state: "unknown" });
});

const heldMessage =
  "Held message from another session\n\nTest sender: harmless test message\n\n❯ 1. Deny — drop it and tell the sender it was declined\n  2. Deliver this message to Claude\nEnter to confirm · Esc to cancel";
for (const screen of [
  heldMessage,
  heldMessage.replace(
    "Test sender: harmless test message",
    Array(20).fill("│ harmless body").join("\n"),
  ),
  heldMessage
    .replace(
      "Held message from another session",
      "Held message from another\nsession",
    )
    .replace(
      "Deliver this message to Claude",
      "Deliver this message to\nClaude",
    ),
  `\x1b[33m${heldMessage}\x1b[0m`,
])
  test("Claude held-message menu is positive waiting evidence", () => {
    expect(classifyScreen("claude", screen)).toMatchObject({
      state: "waiting",
      reason: "held-message",
      source: "tmux-screen",
    });
  });

test("held-message words without an active menu, old output and other runtimes stay unknown", () => {
  for (const screen of [
    "Held message from another session",
    "The dialog says Held message from another session, with Deny / Deliver.",
    heldMessage.replace("❯ 1.", "1."),
    heldMessage + "\n❯ ",
    heldMessage + "\n" + Array(20).fill("ordinary output").join("\n"),
  ])
    expect(classifyScreen("claude", screen).state).toBe("unknown");
  expect(classifyScreen("codex", heldMessage).state).toBe("unknown");
});

test("post-menu output and a nonempty input prompt supersede held-message choices", () => {
  for (const suffix of [
    "\nDelivered\n❯ next input",
    "\nMessage denied",
    "\nWorking (esc to interrupt)",
  ])
    expect(classifyScreen("claude", heldMessage + suffix).state).toBe(
      "unknown",
    );
});
