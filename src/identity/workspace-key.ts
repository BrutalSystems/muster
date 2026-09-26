import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { command } from "./processes.js";

/**
 * The key a workspace's trust is recorded under.
 *
 * NOT the launch directory. Claude Code 2.1.274 has two gates and they disagree
 * about how far they will look, so only one key satisfies both:
 *
 * - The **dialog** gate walks up from the launch directory looking for any
 *   trusted ancestor, but stops AT the git repo root — a trusted `/` does not
 *   reach inside a repo.
 * - The **settings** gate, which decides whether `.claude/settings.json` is
 *   honoured, tests one exact key with no walking at all, and that key is the
 *   repo root.
 *
 * So writing the launch directory silences the dialog and still leaves the
 * workspace untrusted for settings. Claude says so itself, from a subdirectory
 * of an untrusted repo:
 *
 *   Ignoring 1 permissions.allow entry from .claude/settings.json: this
 *   workspace has not been trusted ... set projects["<repo root>"]
 *
 * Writing the repo root satisfies both: the settings gate matches it exactly,
 * and the dialog gate's walk reaches it before hitting its ceiling.
 *
 * A linked worktree keys on its MAIN checkout, which is why this asks git for
 * the common directory rather than the top level — verified against a real
 * linked worktree, whose `.git` is a file rather than a directory.
 *
 * Outside a repository, or with no usable git, the answer is the directory
 * itself: the dialog gate then walks freely and the settings gate wants exactly
 * this path.
 */
export async function workspaceTrustKey(cwd: string): Promise<string> {
  const resolved = await realpath(cwd).catch(() => cwd);
  try {
    // `--git-common-dir`, not `--show-toplevel`: a linked worktree's top level
    // is the worktree, while Claude keys on the checkout that owns the repo.
    const common = (
      await command(
        "git",
        [
          "-C",
          resolved,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        2000,
      )
    ).trim();
    if (!common) return resolved;
    // <main checkout>/.git for a normal repo and for a linked worktree alike.
    // A bare repo has no checkout to trust, so it falls through to the cwd.
    const base = common.replace(/\/\.git\/?$/, "");
    if (base === common) return resolved;
    return await realpath(base).catch(() => base);
  } catch {
    // Not a repository, or git unavailable: the directory is its own key.
    return resolved;
  }
}
