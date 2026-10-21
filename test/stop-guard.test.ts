import { test, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Registry } from "../src/registry.js";

async function fixture(scripts: string[]) {
  const home = await mkdtemp(join(tmpdir(), "stop-guard-"));
  const registry = new Registry(home);
  const { entry } = await registry.reserve(
    { runtime: "claude", kind: "task", cwd: home },
    100,
  );
  const root = join(home, "guards", entry.launchId);
  await mkdir(root, { recursive: true });
  const hooks = await Promise.all(
    scripts.map(async (script, i) => {
      const file = join(root, `${i}.cjs`);
      await writeFile(file, script);
      return { command: process.execPath, args: [file], timeout: 1 };
    }),
  );
  const descriptor = join(root, "stop.json");
  await writeFile(
    descriptor,
    JSON.stringify({ home, launchId: entry.launchId, hooks }),
  );
  async function run(extra = {}) {
    const child = spawn(process.execPath, [
      join(process.cwd(), "dist/stop-guard.js"),
      descriptor,
    ]);
    child.stdin.end(
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: "session",
        prompt_id: "prompt",
        stop_hook_active: false,
        ...extra,
      }),
    );
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise((r) => child.on("close", r));
    return {
      code,
      out,
      err,
      status: (await registry.all())[0]!.stop_guard_status,
    };
  }
  return { run, home, root, registry, descriptor };
}
const block = `console.log(JSON.stringify({decision:'block',reason:'Finish the fixture work.'}))`;
test("Stop blocks once across all policies, then reports unresolved exhaustion", async () => {
  const f = await fixture([block, block]);
  const first = await f.run();
  expect(first.code).toBe(0);
  expect(JSON.parse(first.out)).toMatchObject({
    decision: "block",
    reason: expect.stringContaining("Finish the fixture work."),
  });
  expect(first.status).toMatchObject({
    state: "unresolved",
    continuation: "requested",
  });
  const next = await f.run();
  expect(next.out).toBe("");
  expect(next.err).toContain("budget exhausted");
  expect(next.status).toMatchObject({
    state: "unresolved",
    continuation: "exhausted",
  });
  expect(JSON.stringify(await f.registry.all())).not.toContain(
    "Finish the fixture work.",
  );
});
test("Stop pass after continuation differs from exhaustion and next prompts reset", async () => {
  const f = await fixture([
    `const fs=require('fs');const i=JSON.parse(fs.readFileSync(0,'utf8'));if(!i.stop_hook_active){${block}}`,
  ]);
  await f.run();
  expect((await f.run({ stop_hook_active: true })).status).toMatchObject({
    state: "passed",
    continuation: "none",
  });
  expect(JSON.parse((await f.run({ prompt_id: "next" })).out)).toHaveProperty(
    "decision",
    "block",
  );
  expect(
    JSON.parse((await f.run({ session_id: "cleared" })).out),
  ).toHaveProperty("decision", "block");
});
test("Stop honours native active flag even without a previous budget claim", async () => {
  const f = await fixture([block]);
  const result = await f.run({ stop_hook_active: true });
  expect(result.out).toBe("");
  expect(result.status).toMatchObject({
    state: "unresolved",
    continuation: "exhausted",
  });
  expect((await f.run()).out).toBe("");
});
test("simultaneous Stop invocations share an atomic budget", async () => {
  const f = await fixture([block]);
  const results = await Promise.all([f.run(), f.run(), f.run()]);
  expect(results.filter((r) => r.out.includes('"block"'))).toHaveLength(1);
});
test.each([
  "process.exit(1)",
  "process.stdout.write('not-json-private')",
  `console.log('{"decision":"block","decision":"allow","reason":"private"}')`,
  `console.log(JSON.stringify({decision:'block',reason:'x'.repeat(4097)}))`,
  `process.stdout.write('x'.repeat(65537))`,
  "setTimeout(()=>{},10000)",
  `require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,2]});process.exit(0)`,
])(
  "Stop child failure remains failed after budget exhaustion: %s",
  async (script) => {
    const f = await fixture([script]);
    const first = await f.run();
    expect(JSON.parse(first.out)).toHaveProperty("decision", "block");
    expect(first.out + first.err).not.toContain("private");
    expect(first.status).toMatchObject({
      state: "failed",
      continuation: "requested",
    });
    const next = await f.run({ stop_hook_active: true });
    expect(next.out).toBe("");
    expect(next.status).toMatchObject({
      state: "failed",
      continuation: "exhausted",
    });
  },
);
test("missing child and missing turn identity never silently pass", async () => {
  const f = await fixture([block]);
  const descriptor = JSON.parse(await readFile(f.descriptor, "utf8"));
  descriptor.hooks[0].command = join(f.root, "absent");
  await writeFile(f.descriptor, JSON.stringify(descriptor));
  expect((await f.run()).status).toMatchObject({ state: "failed" });
  const missing = await f.run({ prompt_id: undefined });
  expect(missing.out).toBe("");
  expect(missing.status).toMatchObject({
    state: "failed",
    continuation: "unavailable",
  });
});

test("terminating the dispatcher stops its detached policy process", async () => {
  const f = await fixture([
    `require('fs').writeFileSync(process.argv[1]+'.pid',String(process.pid));setInterval(()=>{},10000)`,
  ]);
  const config = JSON.parse(await readFile(f.descriptor, "utf8"));
  config.hooks[0].timeout = 60;
  await writeFile(f.descriptor, JSON.stringify(config));
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "dist/stop-guard.js"), f.descriptor],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  child.stdin.end(
    JSON.stringify({
      hook_event_name: "Stop",
      session_id: "s",
      prompt_id: "p",
      stop_hook_active: false,
    }),
  );
  let pid: number | undefined;
  const alive = () => {
    try {
      process.kill(pid!, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await expect
      .poll(async () => {
        try {
          pid = Number(await readFile(join(f.root, "0.cjs.pid"), "utf8"));
          return pid > 0;
        } catch {
          return false;
        }
      })
      .toBe(true);
    child.kill("SIGTERM");
    await expect.poll(alive, { timeout: 1500 }).toBe(false);
    expect((await f.registry.all())[0]!.stop_guard_status?.state).not.toBe(
      "passed",
    );
  } finally {
    child.kill("SIGKILL");
    if (pid && alive())
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
  }
});
