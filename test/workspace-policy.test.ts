import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { assertAllowedWorkspace } from "../src/guard.js";
import { loadConfig } from "../src/config.js";
import { Muster } from "../src/run.js";
import { fixture } from "./helpers.js";

const policy = (allowed_roots: string[] = [], projects = {}) => ({
  allowed_roots,
  projects,
});

test("nothing configured permits anything, as it always has", async () => {
  await expect(
    assertAllowedWorkspace(process.cwd(), policy()),
  ).resolves.toBeUndefined();
});

test("a configured root permits itself and what is under it", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-root-"));
  const nested = join(root, "a", "b");
  await mkdir(nested, { recursive: true });

  await expect(
    assertAllowedWorkspace(root, policy([root])),
  ).resolves.toBeUndefined();
  await expect(
    assertAllowedWorkspace(nested, policy([root])),
  ).resolves.toBeUndefined();
});

test("a sibling sharing the root's name prefix is refused", async () => {
  const base = await mkdtemp(join(tmpdir(), "muster-prefix-"));
  const root = join(base, "project");
  const sibling = join(base, "project-other");
  await mkdir(root);
  await mkdir(sibling);

  await expect(assertAllowedWorkspace(sibling, policy([root]))).rejects.toThrow(
    /outside every configured allowed root/,
  );
});

test("a symlink inside a root cannot reach outside it", async () => {
  const base = await mkdtemp(join(tmpdir(), "muster-symlink-"));
  const root = join(base, "allowed");
  const secret = join(base, "elsewhere");
  await mkdir(root);
  await mkdir(secret);
  await writeFile(join(secret, "key.txt"), "secret");
  const escape = join(root, "escape");
  await symlink(secret, escape);

  // The path as written sits inside the root; where it lands does not.
  await expect(assertAllowedWorkspace(escape, policy([root]))).rejects.toThrow(
    /outside every configured allowed root/,
  );
});

test("a root reached through a symlink still matches", async () => {
  const base = await mkdtemp(join(tmpdir(), "muster-linkroot-"));
  const real = join(base, "real");
  await mkdir(real);
  const link = join(base, "link");
  await symlink(real, link);

  await expect(
    assertAllowedWorkspace(link, policy([real])),
  ).resolves.toBeUndefined();
  await expect(
    assertAllowedWorkspace(real, policy([link])),
  ).resolves.toBeUndefined();
});

test("a configured project is a grant in its own right", async () => {
  const base = await mkdtemp(join(tmpdir(), "muster-project-"));
  const project = join(base, "work");
  const other = join(base, "other");
  await mkdir(project);
  await mkdir(other);

  await expect(
    assertAllowedWorkspace(project, policy([], { work: project })),
  ).resolves.toBeUndefined();
  await expect(
    assertAllowedWorkspace(other, policy([], { work: project })),
  ).rejects.toThrow(/outside every configured allowed root/);
});

test("a root that does not exist does not permit everything", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-missing-"));
  await expect(
    assertAllowedWorkspace(dir, policy([join(dir, "nope")])),
  ).rejects.toThrow(/outside every configured allowed root/);
});

test("config carries roots and projects", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-conf-"));
  await writeFile(
    join(home, "config.toml"),
    ['allowed_roots = ["/tmp/a"]', "", "[projects]", 'work = "/tmp/b"'].join(
      "\n",
    ),
  );
  const config = await loadConfig(home);
  expect(config.allowed_roots).toEqual(["/tmp/a"]);
  expect(config.projects).toEqual({ work: "/tmp/b" });
});

test("a launch names a project or a directory, never both", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    await expect(
      m.run({
        runtime: "codex",
        prompt: "both",
        cwd: f.root,
        project: "work",
      }),
    ).rejects.toThrow(/not both/);
    await expect(
      m.run({ runtime: "codex", prompt: "unknown project", project: "nope" }),
    ).rejects.toThrow(/Unknown project nope/);
  } finally {
    await m.close();
  }
});
