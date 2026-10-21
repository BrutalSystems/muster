import { strictJSON } from "./strict-json.js";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const relative = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      p.split("/").every((s) => s && s !== "." && s !== ".."),
  );
const schema = z
  .object({
    version: z.literal(1),
    id: name,
    hooks: z
      .array(
        z
          .object({
            event: z.enum(["PreToolUse", "Stop"]),
            script: relative,
            interpreter: z.enum(["node", "python3", "sh", "bash"]),
            matcher: z
              .string()
              .max(256)
              .optional()
              .refine((s) => {
                try {
                  if (s !== undefined) new RegExp(s);
                  return true;
                } catch {
                  return false;
                }
              }),
            timeout: z.number().int().min(1).max(60).default(10),
            args: z.array(z.string().max(1024)).max(32).default([]),
          })
          .strict()
          .refine((h) => h.event !== "Stop" || h.matcher === undefined)
          .transform((h) =>
            h.event === "PreToolUse"
              ? {
                  event: h.event,
                  script: h.script,
                  interpreter: h.interpreter,
                  matcher: h.matcher ?? ".*",
                  timeout: h.timeout,
                  args: h.args,
                }
              : h,
          ),
      )
      .min(1)
      .max(32),
    files: z.array(relative).max(64).default([]),
    deny: z.array(z.string().min(1).max(1024)).max(128).default([]),
  })
  .strict();
type Manifest = z.infer<typeof schema>;
export type GuardSummary = {
  digest: string;
  bundles: {
    id: string;
    digest: string;
    events: ("PreToolUse" | "Stop")[];
    hooks: number;
    deny_rules: number;
  }[];
};
export type GuardSnapshot = {
  summary: GuardSummary;
  bundles: { manifest: Manifest; files: Map<string, Buffer> }[];
};
const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const guardDirectory = (home: string, launchId: string) =>
  join(home, "guards", launchId);

async function boundedRead(file: string, limit: number): Promise<Buffer> {
  const fd = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.size > limit) throw new Error();
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const r = await fd.read(bytes, size, bytes.length - size, null);
      if (!r.bytesRead) break;
      size += r.bytesRead;
    }
    if (size > limit) throw new Error();
    return bytes.subarray(0, size);
  } finally {
    await fd.close();
  }
}
export async function snapshotGuards(
  options: readonly string[],
  cwd: string,
): Promise<GuardSnapshot | undefined> {
  const paths = options
    .filter((s) => s.startsWith("guard="))
    .map((s) => s.slice(6));
  if (!paths.length) return;
  try {
    if (paths.length > 16 || paths.some((p) => !p || p.length > 4096))
      throw new Error();
    const bundles: GuardSnapshot["bundles"] = [];
    const summaries: GuardSummary["bundles"] = [];
    const ids = new Set<string>();
    let total = 0;
    for (const path of paths) {
      const file = resolve(cwd, path);
      const raw = await boundedRead(file, 65536);
      const manifest = schema.parse(
        strictJSON(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
      );
      if (ids.has(manifest.id)) throw new Error();
      ids.add(manifest.id);
      const files = new Map<string, Buffer>();
      const root = dirname(file);
      const names = [
        ...new Set([...manifest.files, ...manifest.hooks.map((h) => h.script)]),
      ].sort();
      if (names.length > 64) throw new Error();
      for (const name of names) {
        let current = root;
        for (const component of name.split("/")) {
          current = join(current, component);
          if ((await lstat(current)).isSymbolicLink()) throw new Error();
        }
        const bytes = await boundedRead(current, 1024 * 1024);
        total += bytes.length;
        if (total > 4 * 1024 * 1024) throw new Error();
        files.set(name, bytes);
      }
      // Array order remains meaningful for hooks and arguments; object order does not.
      manifest.files = [...new Set(manifest.files)].sort();
      manifest.deny = [...new Set(manifest.deny)].sort();
      const digest = hash(
        JSON.stringify([
          manifest,
          [...files].map(([name, bytes]) => [name, hash(bytes)]),
        ]),
      );
      bundles.push({ manifest, files });
      summaries.push({
        id: manifest.id,
        digest,
        events: [...new Set(manifest.hooks.map((h) => h.event))].sort(),
        hooks: manifest.hooks.length,
        deny_rules: manifest.deny.length,
      });
    }
    if (
      bundles.flatMap((b) => b.manifest.hooks).filter((h) => h.event === "Stop")
        .length > 32
    )
      throw new Error();
    return {
      bundles,
      summary: { digest: hash(JSON.stringify(summaries)), bundles: summaries },
    };
  } catch {
    throw new Error(
      "Guard bundle refused: invalid manifest, duplicate ID/key, missing or unsafe file, or size limit exceeded",
    );
  }
}
export async function assertGuardProfile(
  files: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (
    env.CLAUDE_CODE_SIMPLE &&
    !["0", "false"].includes(env.CLAUDE_CODE_SIMPLE)
  )
    throw new Error("Guard launch refused: Claude simple mode disables hooks");
  for (const file of files) {
    try {
      const settings = JSON.parse(await readFile(file, "utf8"));
      if (
        settings.disableAllHooks === true ||
        settings.allowManagedHooksOnly === true ||
        (settings.env?.CLAUDE_CODE_SIMPLE &&
          !["0", "false"].includes(String(settings.env.CLAUDE_CODE_SIMPLE)))
      )
        throw new Error("disabled");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Guard launch refused: profile hooks are disabled or settings cannot be verified",
        );
    }
  }
}
export async function stageGuards(
  snapshot: GuardSnapshot,
  home: string,
  launchId: string,
  base: Record<string, unknown>,
): Promise<string> {
  try {
    const root = guardDirectory(home, launchId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const hooks: unknown[] = [];
    const stops: { command: string; args: string[]; timeout: number }[] = [];
    const deny: string[] = [];
    for (let i = 0; i < snapshot.bundles.length; i++) {
      const { manifest, files } = snapshot.bundles[i]!;
      const dir = join(root, String(i));
      for (const [name, bytes] of files) {
        const dest = join(dir, name);
        await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
        await writeFile(dest, bytes, { mode: 0o600, flag: "wx" });
      }
      for (let j = 0; j < manifest.hooks.length; j++) {
        const h = manifest.hooks[j]!;
        if (h.event === "Stop") {
          stops.push({
            command: h.interpreter,
            args: [join(dir, h.script), ...h.args],
            timeout: h.timeout,
          });
          continue;
        }
        const descriptor = join(root, `hook-${i}-${j}.json`);
        await writeFile(
          descriptor,
          JSON.stringify({
            command: h.interpreter,
            args: [join(dir, h.script), ...h.args],
            timeout: h.timeout,
          }),
          { mode: 0o600, flag: "wx" },
        );
        hooks.push({
          matcher: h.matcher,
          hooks: [
            {
              type: "command",
              command: process.execPath,
              args: [
                fileURLToPath(
                  new URL("../dist/guard-hook.js", import.meta.url),
                ),
                descriptor,
              ],
              timeout: h.timeout + 2,
              onFailure: "block",
            },
          ],
        });
      }
      deny.push(...manifest.deny);
    }
    const stopHooks: unknown[] = [];
    if (stops.length) {
      const descriptor = join(root, "stop.json");
      await writeFile(
        descriptor,
        JSON.stringify({ home, launchId, hooks: stops }),
        { mode: 0o600, flag: "wx" },
      );
      stopHooks.push({
        hooks: [
          {
            type: "command",
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../dist/stop-guard.js", import.meta.url)),
              descriptor,
            ],
            timeout: Math.max(...stops.map((h) => h.timeout)) + 12,
          },
        ],
      });
    }
    const target = join(root, "settings.json");
    await writeFile(
      target,
      JSON.stringify({
        ...base,
        hooks: {
          ...(hooks.length ? { PreToolUse: hooks } : {}),
          ...(stopHooks.length ? { Stop: stopHooks } : {}),
        },
        permissions: { deny: [...new Set(deny)] },
      }),
      { mode: 0o600, flag: "wx" },
    );
    return target;
  } catch {
    throw new Error("Guard launch refused: private attachment staging failed");
  }
}
