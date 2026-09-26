# Claude workspace trust

The one-time folder-trust review Claude Code asks for, how Muster sees it, and
how to get past it deliberately.

[← back to the README](../README.md)

## Why a launch can stop here

Before launching a Claude session, open Claude normally in the target directory
and complete its workspace-trust review yourself, then exit that setup session.
This is a one-time prerequisite for each directory Claude requires you to trust.
An untrusted directory blocks startup; Muster times out and cleans up that
launch. A `--kind task` launch appears not to consult trust at all — only
sessions stop at the dialog.

**There are two trust gates and they do not look equally far.** Measured against
Claude Code 2.1.274:

- The **dialog** gate walks up from the launch directory looking for any trusted
  ancestor, and stops **at the git repo root**. A trusted `/` does not reach
  inside a repository. Outside a repository there is no ceiling, so it walks to
  `/`.
- The **settings** gate — whether the workspace's own `.claude/settings.json` is
  honoured — tests **one exact key, with no walking**, and that key is the repo
  root (the main checkout, for a linked worktree).

So the only key that satisfies both is the repo root. Writing the launch
directory silences the dialog while leaving the workspace untrusted for
settings, which Claude reports itself:

```
Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace
has not been trusted ... set projects["<repo root>"].hasTrustDialogAccepted
```

Muster writes that canonical key wherever it records trust. An earlier version
of this section said trust was not inherited at all; that was wrong.

Muster does not accept trust prompts on its own. It writes a trust record only
when you ask for one: `--options auto-approve-path`, below, and into the
per-launch identity copy for an identity launch.

A session sitting on that dialog has no registry record at all, so the timeout
used to look identical to a hung or crashed launch. Muster now reads
`hasTrustDialogAccepted` for the working directory out of the profile's
`.claude.json` when a Claude launch times out with nothing registered, and
either names the untrusted directory and the one-time fix or rules trust out
and sends you to the terminal for whatever else is holding the session — a
login prompt, or another one-time confirmation. It deliberately does not guess
which: trust is the only one of them Muster can check, and a message that names
the wrong screen costs what the vague one did. That read happens only on the
failure path and only ever reads. A
`--kind task` launch into the same directory is the cheap discriminator by
hand: it runs headless and never sees the dialog.
