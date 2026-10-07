import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ERROR_WITHHELD } from "../src/log.js";
import { delay } from "../src/identity/processes.js";
import { lines } from "./helpers.js";

const TOKEN = "zqxjplover";
const worker = fileURLToPath(
  new URL("../dist/task-worker.js", import.meta.url),
);

/**
 * Runs the built worker against a runtime that cannot be spawned, so the child
 * `error` event fires and `task_exit` carries an error string. The missing
 * binary's path holds the token, and Node quotes that path in the message, so
 * the token stands in for any prompt-derived text an error might carry.
 *
 * Detached: the worker SIGKILLs its own process group on the way out, which
 * must not be the test runner's.
 */
async function runWorker(logMode?: "full" | "metadata") {
  const dir = await mkdtemp(join(tmpdir(), "mu-worker-"));
  const spec = join(dir, "launch.json");
  const exitPath = join(dir, "exit.json");
  const startPath = join(dir, "start");
  await writeFile(
    spec,
    JSON.stringify({
      argv: [join(dir, TOKEN)],
      cwd: dir,
      env: {},
      outputPath: join(dir, "output.txt"),
      exitPath,
      startPath,
      logHome: dir,
      launchId: "l1",
      ...(logMode ? { logMode } : {}),
    }),
  );
  await writeFile(startPath, "start");
  spawn(process.execPath, [worker, spec], {
    detached: true,
    stdio: "ignore",
  }).unref();
  for (let i = 0; i < 100; i++) {
    const exit = await readFile(exitPath, "utf8").catch(() => "");
    if (exit) break;
    await delay(50);
  }
  return lines(join(dir, "launches.jsonl"));
}

test("the task worker honours metadata mode for task_exit", async () => {
  const written = await runWorker("metadata");
  const exit = written.find((l) => l.event === "task_exit");
  expect(exit).toBeDefined();
  expect(exit.error).toBe(ERROR_WITHHELD);
  for (const line of written) expect(JSON.stringify(line)).not.toContain(TOKEN);
}, 15000);

test("the task worker keeps the error in full mode", async () => {
  // The counterpart: proof the error really did carry the token, so the
  // metadata assertion above is not passing on an empty line.
  const written = await runWorker("full");
  const exit = written.find((l) => l.event === "task_exit");
  expect(exit.error).toContain(TOKEN);
}, 15000);
