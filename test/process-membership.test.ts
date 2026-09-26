import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  delay,
  descendants,
  groupAlive,
  ownedGroup,
  processRef,
  stopTree,
} from "../src/identity/processes.js";
import { Registry } from "../src/registry.js";
import { ampleDeadline } from "./deadline.js";

const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

/**
 * root -> intermediate -> grandchild, then the intermediate is killed. The
 * grandchild keeps running and reparents to launchd, leaving the parent chain
 * entirely. This is the shape of an agent that spawns a helper and then exits.
 */
async function orphaned() {
  const root = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const mid = spawn(process.execPath, ["-e", \`
         const { spawn } = require("node:child_process");
         const g = spawn("sleep", ["30"], { stdio: "ignore" });
         console.log("G " + g.pid);
         setInterval(() => {}, 1000);
       \`], { stdio: "inherit" });
       console.log("M " + mid.pid);
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"], detached: true },
  );
  started.push(root.pid!);
  let mid = 0,
    grandchild = 0;
  root.stdout.on("data", (b: Buffer) => {
    for (const line of String(b).trim().split("\n")) {
      if (line.startsWith("M ")) mid = Number(line.slice(2));
      if (line.startsWith("G ")) grandchild = Number(line.slice(2));
    }
  });
  for (let i = 0; i < 80 && !(mid && grandchild); i++) await delay(50);
  expect(mid && grandchild).toBeTruthy();
  started.push(mid, grandchild);

  const group = await ownedGroup(root.pid!);
  expect(group).toBe(root.pid);

  process.kill(mid, "SIGKILL");
  await delay(400);
  expect(await processRef(grandchild)).toBeDefined();
  return { root: root.pid!, grandchild, group: group! };
}

test("the parent chain loses a reparented process and the group keeps it", async () => {
  const { root, grandchild, group } = await orphaned();

  expect(await descendants(root)).not.toContain(grandchild);
  expect(await descendants(root, ampleDeadline(), group)).toContain(grandchild);
});

test("a stop reaches a reparented process when the group is known", async () => {
  const { root, grandchild, group } = await orphaned();
  const ref = await processRef(root);

  await stopTree(ref!, group);

  expect(await processRef(root)).toBeUndefined();
  expect(await processRef(grandchild)).toBeUndefined();
});

test("a session whose root died but whose group still runs is not called exited", async () => {
  const { root, grandchild, group } = await orphaned();
  const home = await mkdtemp(join(tmpdir(), "muster-group-"));
  const registry = new Registry(home);
  const { entry } = await registry.reserve(
    { runtime: "codex", kind: "session", cwd: home },
    4,
  );
  await registry.update(entry.launchId, {
    root: (await processRef(root))!,
    group,
    status: "running",
  });

  // The root dies; the reparented worker does not.
  process.kill(root, "SIGKILL");
  await delay(300);
  expect(await processRef(grandchild)).toBeDefined();
  expect(await groupAlive(group)).toBe(true);

  expect((await registry.all())[0]!.status).toBe("running");

  // Once the group is genuinely empty, the entry ends.
  process.kill(grandchild, "SIGKILL");
  await delay(300);
  expect((await registry.all())[0]!.status).toBe("exited");
});

test("a process group led by someone else is never claimed", async () => {
  // This process does not lead its own group in the test runner.
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},2000)"], {
    stdio: "ignore",
  });
  started.push(child.pid!);
  expect(await ownedGroup(child.pid!)).toBeUndefined();
});
