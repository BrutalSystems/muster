# muster#68 leftovers

**Status:** closed. PR #69 merged (eccfa6d), released as 3.1.1 (a69f647, publish.yml green), installed on this Mac (`muster --version` → 3.1.1). #68 closed with a comment; follow-ups in #70.

## Question
Mike, 2026-10-16: "Take over the leftover issues … Get them done." This worktree's part is
BrutalSystems/muster#68: items 3, 4, 6, 7 and the three "New, from this round" notes.

## Context
- Worktree `.claude/worktrees/leftovers-muster`, branch `leftovers-muster` from origin/main `2f91934` (3.1.0).
- `fix/codex-trust` f8f73b9 (built on 3.0.1) cherry-picked: one conflict in `src/run.ts`
  (new `defaultConfigHome` next to main's `failedLaunchId`), both sides kept.
- Ship ceiling: commit only.

## What was checked
- `test/codex-launch.test.ts` fails with "Cannot find module dist/muster.js" until `npm run build`.
  Not a bug: `pretest` builds, and running vitest directly skips it. After the build, 3/3 pass.
- Trust misfire: `claudeWorkspaceTrusted` (`src/identity/claude.ts`) reads
  `projects[cwd].hasTrustDialogAccepted` for the exact cwd only.
- Cli-entry flake: 6/6 passes under 3× `yes` CPU load. The failing assertion from the one bad run
  was not recorded, so there is nothing to go on. Deferred.
- Live, with a throwaway HOME holding a copy of `~/.codex` (the real config was never touched):
  branch `dist`, `run codex --host tmux --options auto-approve-path` in an untrusted dir → `idle`,
  CLI exit 0 in 2s, trust table appended. `--host pty` → `idle` too. Installed 3.1.0, same launch →
  exit 1 after 31s, "no descendant runtime identity found after 30s", nothing written.
- Codex review (`muster output f5110093-f1b5-4fd0-83c3-0fa2d21fe307`): 4 findings. Fixed #2 (quoted
  inline `projects` key) and #3 (missing `~/.codex`) in 4292fb0. Deferred #1 (concurrent appends
  race, needs a cross-process lock) and #4 (NFC path normalisation, low).

## Findings
- *confirmed (code)*: the trust check ignores Claude's dialog-gate walk-up. Claude accepts any
  trusted ancestor up to the git repo root, so a worktree or subdirectory of a trusted repo is
  reported "not accepted". Live run 3 ran from this worktree.
- *confirmed (code)*: with no CLAUDE_CONFIG_DIR the check reads `~/.claude/.claude.json`.
  Claude's file is `~/.claude.json` (`src/mcp-install.ts:79` already gets this right).
- *confirmed (code)*: `prepareOnExit` stats the cwd but never checks it can be entered (X_OK),
  and never checks the HOME fallback at all.

## Options
Each fix is small and local. No alternatives worth weighing.

## Decision
The master's brief (2026-10-16) is to fix the cheap items and defer the rest.

## Decision (2)
Mike, 2026-10-17 05:15 (relayed), plus his own approve line in this pane: land and roll out 3.1.1. Done.

## Next steps
None for #68. Work continues in #70.
