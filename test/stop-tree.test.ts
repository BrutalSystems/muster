import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { delay, processRef, stopTree } from "../src/identity/processes.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

/**
 * Ignores SIGTERM and forks a child when it arrives — a process that spawns
 * during the window between SIGTERM and SIGKILL, which a tree enumerated once
 * up front cannot contain.
 */
const FORKS_ON_TERM = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  writeFileSync(process.argv[2], String(child.pid));
});
setInterval(() => {}, 1000);
`;

/**
 * The process, once it is actually gone — or still there after two seconds,
 * which fails the assertion that calls this. Two seconds is far beyond the
 * kernel's reaping window and far below the test's own 15s budget.
 */
async function gone(pid: number) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const ref = await processRef(pid);
    if (!ref || Date.now() >= deadline) return ref;
    await delay(25);
  }
}
test("kills a process the tree forked during the SIGTERM wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-stop-"));
  dirs.push(dir);
  const script = join(dir, "forks-on-term.cjs");
  const pidFile = join(dir, "child.pid");
  await writeFile(script, FORKS_ON_TERM);

  const parent = spawn(process.execPath, [script, pidFile], {
    stdio: "ignore",
  });
  const ref = await processRef(parent.pid!);
  expect(ref).toBeDefined();

  const stopped = stopTree(ref!);

  // The child only exists once SIGTERM has been delivered and handled.
  let childPid = 0;
  for (let i = 0; i < 60 && !childPid; i++) {
    childPid = Number(await readFile(pidFile, "utf8").catch(() => 0));
    if (!childPid) await delay(25);
  }
  expect(childPid).toBeGreaterThan(0);

  await stopped;

  // Polled, not asserted outright: `stopTree` resolves once it has SIGNALLED
  // the tree, and SIGKILL is asynchronous — the process stays in the table for
  // a moment after the call returns. Asserting immediately passed on an idle
  // machine and failed about one run in ten under load, which is the worst
  // possible shape for a release gate. Bounded, so a tree that never dies still
  // fails rather than hanging.
  expect(await gone(parent.pid!)).toBeUndefined();
  expect(await gone(childPid)).toBeUndefined();
}, 15000);

test("stops without signalling anything when the root is already gone", async () => {
  const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], {
    stdio: "ignore",
  });
  const ref = await processRef(parent.pid!);
  expect(ref).toBeDefined();
  await new Promise((resolve) => parent.once("exit", resolve));

  await expect(stopTree(ref!)).resolves.toBeUndefined();
});
