import { strictJSON } from "./strict-json.js";
/** Private per-launch command-hook adapter. Never echo script output or paths. */
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
let child: ChildProcess | undefined;
let finished = false;
function finish(block: boolean): never {
  if (!finished) {
    finished = true;
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    if (block)
      process.stderr.write(
        "Attached guard denied the tool call or failed validation\n",
      );
  }
  process.exit(block ? 2 : 0);
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => finish(true));
try {
  const config = JSON.parse(await readFile(process.argv[2]!, "utf8"));
  if (
    typeof config.command !== "string" ||
    !Array.isArray(config.args) ||
    !config.args.every((s: unknown) => typeof s === "string") ||
    !(config.timeout > 0 && config.timeout <= 60)
  )
    finish(true);
  const timeout = setTimeout(() => finish(true), config.timeout * 1000);
  let input = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    input = Buffer.concat([input, Buffer.from(chunk)]);
    if (input.length > 1024 * 1024) finish(true);
  }
  child = spawn(config.command, config.args, {
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let output = Buffer.alloc(0);
  child.on("error", () => finish(true));
  child.stdin!.on("error", () => {});
  child.stdout!.on("data", (chunk: Buffer) => {
    output = Buffer.concat([output, chunk]);
    if (output.length > 65536) finish(true);
  });
  child.on("close", (code) => {
    clearTimeout(timeout);
    if (code !== 0) finish(true);
    const raw = output.toString("utf8").trim();
    if (!raw) finish(false);
    try {
      const parsed = strictJSON(raw) as Record<string, any>;
      const decision = parsed?.hookSpecificOutput;
      if (
        Object.keys(parsed).length !== 1 ||
        !decision ||
        decision.hookEventName !== "PreToolUse" ||
        !["allow", "deny"].includes(decision.permissionDecision) ||
        (decision.permissionDecisionReason !== undefined &&
          (typeof decision.permissionDecisionReason !== "string" ||
            decision.permissionDecisionReason.length > 4096)) ||
        Object.keys(decision).some(
          (k) =>
            ![
              "hookEventName",
              "permissionDecision",
              "permissionDecisionReason",
            ].includes(k),
        )
      )
        finish(true);
      // Passing is no decision: do not bypass the retained profile's approval flow.
      finish(decision.permissionDecision !== "allow");
    } catch {
      finish(true);
    }
  });
  child.stdin!.end(input);
} catch {
  finish(true);
}
