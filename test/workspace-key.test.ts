import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../src/identity/processes.js";
import { workspaceTrustKey } from "../src/identity/workspace-key.js";

/**
 * Measured against Claude Code 2.1.274 rather than assumed. Launching `claude
 * -p` in a subdirectory of an untrusted repo prints which key it wanted, and it
 * names the REPO ROOT — not the launch directory, and not a trusted ancestor
 * above the repo, because the repo root is a ceiling for the dialog gate and
 * the only key the settings gate will accept.
 */
test("inside a repository, the key is the repo root", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "muster-wk-")));
  await command("git", ["-C", root, "init", "-q"], 5000);
  const sub = join(root, "a", "b");
  await mkdir(sub, { recursive: true });
  expect(await workspaceTrustKey(sub)).toBe(root);
  expect(await workspaceTrustKey(root)).toBe(root);
});

test("outside a repository, the directory is its own key", async () => {
  const plain = await realpath(await mkdtemp(join(tmpdir(), "muster-wk-")));
  expect(await workspaceTrustKey(plain)).toBe(plain);
});

test("a linked worktree keys on its main checkout", async () => {
  // Its `.git` is a file, not a directory, and Claude asks for the checkout
  // that owns the repository rather than the worktree it is standing in.
  const root = await realpath(await mkdtemp(join(tmpdir(), "muster-wk-")));
  await command("git", ["-C", root, "init", "-q"], 5000);
  await writeFile(join(root, "f.txt"), "x");
  await command("git", ["-C", root, "add", "-A"], 5000);
  await command(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "c",
    ],
    8000,
  );
  const tree = join(root, "..", "wk-" + Date.now());
  await command("git", ["-C", root, "worktree", "add", "-q", tree], 8000);
  expect(await workspaceTrustKey(await realpath(tree))).toBe(root);
});
