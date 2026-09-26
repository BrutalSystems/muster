// Own the terminal child without putting prompt text or secrets in tmux's shell command.
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  processRef,
  stopTree,
  finishOwnedGroup,
} from "../identity/processes.js";
const file = process.argv[2]!;
const spec = JSON.parse(await readFile(file, "utf8"));
await rm(dirname(file), { recursive: true });
const child = spawn(spec.argv[0], spec.argv.slice(1), {
  cwd: spec.cwd,
  env: { ...spec.env, TERM: process.env.TERM ?? "xterm-256color" },
  stdio: "inherit",
});
child.once("error", (e) => {
  process.stderr.write(e.message + "\n");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  void finishOwnedGroup(code ?? 1);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.once(signal, () => {
    void (async () => {
      const ref = child.pid ? await processRef(child.pid) : undefined;
      if (ref) await stopTree(ref);
      process.exit(0);
    })();
  });
