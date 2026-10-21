/** Private bounded Stop dispatcher. Policy reasons are model-visible; never recorded. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { Registry, type StopGuardStatus } from "./registry.js";
import { strictJSON } from "./strict-json.js";

const descriptorSchema = z
  .object({
    home: z.string().min(1),
    launchId: z.string().min(1),
    hooks: z
      .array(
        z
          .object({
            command: z.string().min(1),
            args: z.array(z.string()),
            timeout: z.number().int().min(1).max(60),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
type Hook = z.infer<typeof descriptorSchema>["hooks"][number];
type Result = { state: "passed" | "unresolved" | "failed"; reason?: string };
const children = new Set<ChildProcess>();
function kill(child: ChildProcess) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => {
    for (const child of children) kill(child);
    // The pre-evaluation unknown observation remains honest on interruption.
    process.exit(0);
  });
function evaluate(hook: Hook, input: Buffer): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(hook.command, hook.args, {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.add(child);
    let done = false,
      output = Buffer.alloc(0);
    const finish = (result: Result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      kill(child);
      children.delete(child);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ state: "failed" }),
      hook.timeout * 1000,
    );
    child.on("error", () => finish({ state: "failed" }));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > 65536) finish({ state: "failed" });
    });
    child.on("close", (code) => {
      if (code !== 0) return finish({ state: "failed" });
      try {
        const raw = new TextDecoder("utf-8", { fatal: true })
          .decode(output)
          .trim();
        if (!raw) return finish({ state: "passed" });
        const value = z
          .object({
            decision: z.literal("block"),
            reason: z
              .string()
              .min(1)
              .max(4096)
              .refine((s) => !!s.trim()),
          })
          .strict()
          .parse(strictJSON(raw));
        finish({ state: "unresolved", reason: value.reason });
      } catch {
        finish({ state: "failed" });
      }
    });
    child.stdin.end(input);
  });
}
let registry: Registry | undefined, launchId: string | undefined;
async function record(status: Omit<StopGuardStatus, "observed_at">) {
  if (!registry || !launchId) throw new Error();
  await registry.update(launchId, {
    stop_guard_status: { ...status, observed_at: new Date().toISOString() },
  });
}
try {
  const config = descriptorSchema.parse(
    strictJSON(await readFile(process.argv[2]!, "utf8")),
  );
  registry = new Registry(config.home, 1000);
  launchId = config.launchId;
  // Clear the previous observation before evaluating: a killed runner must not look passed.
  await record({ state: "unknown", continuation: "none" });
  const inputTimer = setTimeout(() => process.stdin.destroy(new Error()), 2000);
  let input = Buffer.alloc(0);
  try {
    for await (const chunk of process.stdin) {
      input = Buffer.concat([input, Buffer.from(chunk)]);
      if (input.length > 1024 * 1024) throw new Error();
    }
  } finally {
    clearTimeout(inputTimer);
  }
  const event = z
    .object({
      hook_event_name: z.literal("Stop"),
      session_id: z.string().min(1).max(256),
      prompt_id: z.string().min(1).max(256),
      stop_hook_active: z.boolean(),
    })
    .passthrough()
    .parse(strictJSON(new TextDecoder("utf-8", { fatal: true }).decode(input)));
  const key = createHash("sha256")
    .update(JSON.stringify([event.session_id, event.prompt_id]))
    .digest("hex");
  const budget = join(config.home, "guards", config.launchId, "stop-budgets");
  await mkdir(budget, { recursive: true, mode: 0o700 });
  async function claim() {
    try {
      await writeFile(join(budget, key), "", { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  }
  // Native continuation also consumes the allowance, even if a profile hook requested it.
  if (event.stop_hook_active) await claim();
  const results = await Promise.all(
    config.hooks.map((h) => evaluate(h, input)),
  );
  const state = results.some((r) => r.state === "failed")
    ? "failed"
    : results.some((r) => r.state === "unresolved")
      ? "unresolved"
      : "passed";
  if (state === "passed") {
    await record({ state, continuation: "none", turn: key });
  } else {
    const requested = !event.stop_hook_active && (await claim());
    await record({
      state,
      continuation: requested ? "requested" : "exhausted",
      turn: key,
    });
    if (requested) {
      const reason =
        state === "failed"
          ? "An attached Stop guard failed. One continuation is available; report unresolved work if it cannot be completed."
          : results
              .filter((r) => r.reason)
              .map((r) => r.reason)
              .join("\n")
              .slice(0, 4096);
      process.stdout.write(JSON.stringify({ decision: "block", reason }));
    } else {
      process.stderr.write(
        "Attached Stop guard unresolved: continuation budget exhausted.\n",
      );
    }
  }
} catch {
  await record({ state: "failed", continuation: "unavailable" }).catch(
    () => {},
  );
  process.stderr.write(
    "Attached Stop guard failed; bounded continuation unavailable.\n",
  );
}
