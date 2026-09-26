// A per-task owner captures output and the exit result; no pools, retries or daemon.
import { readFile, writeFile, rm, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  delay,
  finishOwnedGroup,
  processRef,
  stopTree,
} from "./identity/processes.js";
import { LaunchLog } from "./log.js";
const file = process.argv[2]!;
const spec = JSON.parse(await readFile(file, "utf8"));
await rm(file);
// The parent records ownership before authorizing the runtime to start.
const deadline = Date.now() + 10000;
while (true) {
  try {
    await readFile(spec.startPath);
    await rm(spec.startPath);
    break;
  } catch {
    if (Date.now() > deadline) process.exit(1);
    await delay(25);
  }
}
const output = await open(spec.outputPath, "a", 0o600);
const child = spawn(spec.argv[0], spec.argv.slice(1), {
  cwd: spec.cwd,
  env: spec.env,
  stdio: ["ignore", output.fd, output.fd],
});
let finished = false;
async function finish(
  code: number | null,
  signal: string | null,
  error?: string,
) {
  if (finished) return;
  finished = true;
  try {
    await output.close();
    if (spec.mcpConfigPath) await rm(spec.mcpConfigPath, { force: true });
    await new LaunchLog(spec.logHome).write({
      event: "task_exit",
      launch_id: spec.launchId,
      exit_code: code,
      signal,
      error,
    });
  } finally {
    try {
      await writeFile(spec.exitPath, JSON.stringify({ code, signal, error }), {
        mode: 0o600,
      });
    } finally {
      await finishOwnedGroup(code ?? 1);
    }
  }
}
child.once("error", (e) => void finish(null, null, e.message));
child.once("exit", (code, signal) => void finish(code, signal));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.once(signal, () => {
    void (async () => {
      const ref = child.pid ? await processRef(child.pid) : undefined;
      if (ref) await stopTree(ref);
      await finish(null, signal);
    })();
  });
