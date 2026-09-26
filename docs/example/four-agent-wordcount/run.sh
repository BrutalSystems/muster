#!/usr/bin/env bash
# Launch the four-agent wordcount example.
#
# The integrator must be launched first: peer names are assigned at launch, so
# a worker's prompt can only name an agent that already exists. We capture the
# integrator's name from its launch record and substitute it into the three
# worker prompts.
#
# Usage:
#   ./run.sh <workdir> <opencode-model> [codex-model]
#
# Example:
#   ./run.sh /tmp/wordcount anthropic/claude-sonnet-4-5
#
# Set MUSTER_TERMINAL to choose the terminal app (terminal, iterm2, ghostty).
# Default is muster's own default.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
workdir=${1:?usage: run.sh <workdir> <opencode-model> [codex-model]}
ocmodel=${2:?usage: run.sh <workdir> <opencode-model> [codex-model]}
codexmodel=${3:-}

# muster requires the working directory to exist; it never creates one.
mkdir -p "$workdir/src" "$workdir/test"
cp "$here/sample.txt" "$workdir/sample.txt"

# Codex refuses to start outside a git repository ("Not inside a trusted
# directory and --skip-git-repo-check was not specified"). It never launches,
# so muster reports "no descendant runtime identity found" and the cause is
# nowhere in that message. git init is idempotent; this makes the integrator
# launchable.
git init -q "$workdir" 2>/dev/null || true


term=${MUSTER_TERMINAL:-}

# Everything after `--` goes to the runtime, so muster's own flags — including
# --format — must come before it. The runtime is always the first argument.
launch() { # prints the JSON launch record
  local runtime=$1; shift
  muster run "$runtime" --format json "$@"
}

field() { python3 -c 'import json,sys; print(json.load(sys.stdin)["'"$1"'"])'; }

# Muster's session name and the name Tin Can addresses a peer by are NOT the
# same string. Muster reports something like
# "new-session-2026-09-20t22-07-12-200z"; Tin Can uses the OpenCode slug, like
# "quiet-nebula". Putting muster's name in a worker prompt produces a send that
# fails with "the integrator peer isn't reachable" — and because the integrator
# is told not to hang, the run still ends with a passing test suite, so the
# broken protocol looks like a working one. Map through the peer registry.
peer_name() { # session id -> Tin Can peer slug
  local sid=$1 f="$HOME/.tincan/peers/opencode/$sid.json" i=0
  while [ $i -lt 15 ]; do
    [ -f "$f" ] && python3 -c "import json;print(json.load(open('$f'))['slug'])" && return 0
    sleep 2; i=$((i+1))
  done
  echo "timed out waiting for $sid to register with Tin Can" >&2
  echo "is the OpenCode plugin installed? see README" >&2
  return 1
}

# The integrator is launched first so the workers can be told its name. It needs
# --plugin tincan because it must be *reachable*, not just able to send.
echo "Launching integrator (opencode) first, to learn its peer name..."
record=$(launch opencode \
  --open ${term:+--terminal "$term"} --cwd "$workdir" \
  --permissions auto --sandbox workspace-write \
  --mcp tincan --plugin tincan \
  --prompt "$(cat "$here/prompts/integrator.md")" \
  -- --model "$ocmodel")
integrator=$(printf '%s' "$record" | field session_id | { read sid; peer_name "$sid"; }) || exit 1
echo "  integrator: $integrator  (muster called it $(printf '%s' "$record" | field name))"

for stage in parse format; do
  echo "Launching $stage worker (opencode session)..."
  name=$(launch opencode \
    --open ${term:+--terminal "$term"} --cwd "$workdir" \
    --permissions auto --sandbox workspace-write \
    --mcp tincan --plugin tincan \
    --prompt "$(sed "s/INTEGRATOR_NAME/$integrator/g" "$here/prompts/$stage.md")" \
    -- --model "$ocmodel" | field name)
  echo "  $stage: $name"
done

# rank runs as a CODEX TASK rather than a session. A task is headless and exits
# when done, which is exactly a worker's shape — and codex tasks run `codex
# exec`, which has no directory-trust prompt, so this needs no human. Tasks get
# no MCP defaults, so tincan is selected explicitly.
echo "Launching rank worker (codex task)..."
rankid=$(muster run codex --format json --kind task --cwd "$workdir" \
  --permissions auto --sandbox workspace-write \
  --mcp tincan \
  --prompt "$(sed "s/INTEGRATOR_NAME/$integrator/g" "$here/prompts/rank.md")" \
  ${codexmodel:+-- -m "$codexmodel"} \
  | field id)
echo "  rank: task $rankid  (muster output $rankid)"

cat <<EOF

All four launched in $workdir.

Watch the integrator's terminal. It writes the CLI immediately, then waits for
three DONE messages before running the suite.

  muster list --format human     # see states
  cd $workdir && node --test     # check the result yourself

Every session stays open until you stop it:

  muster list --format json | python3 -c 'import json,sys;[print(e["canonical_id"]) for e in json.load(sys.stdin) if e.get("state") in ("idle","busy")]' | xargs -n1 muster stop
EOF
