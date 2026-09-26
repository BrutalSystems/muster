#!/usr/bin/env bash
# Launch the five-realm atlas example.
#
# One Claude orchestrator and four OpenCode workers on a local model. The
# orchestrator is launched FIRST, because peer names are assigned at launch and
# a worker's brief can only name an agent that already exists.
#
# Usage:
#   ./run.sh <workdir> [worker-model] [reporter-name]
#
# Example:
#   ./run.sh ~/Sandbox/meridian muster-local/qwen3-30b-a3b my-claude-session
#
# The third argument is the Claude session that should receive the final
# report. It is a session name as ListAgents prints it, not a fixed value:
# take it from the first line of that output ("This session is <name> [ref]"),
# read at dispatch time. A session's own name can change while it runs, so one
# captured earlier may no longer resolve -- and the send fails at the worker,
# where nobody is watching. See README, "Run it".
#
# <workdir> must sit under a directory Claude already trusts, or the
# orchestrator will not start. See README, "The one manual prerequisite".
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
workdir=${1:?usage: run.sh <workdir> [worker-model] [reporter-name]}
model=${2:-muster-local/qwen3-30b-a3b}
reporter=${3:-}

mkdir -p "$workdir/shared" "$workdir/dist"
cp "$here/shared/canon.md" "$workdir/shared/canon.md"
cp "$here/shared/contract.md" "$workdir/shared/contract.md"

field() { python3 -c 'import json,sys; print(json.load(sys.stdin)["'"$1"'"])'; }

# The orchestrator is Claude. For Claude, muster's canonical_id IS the string
# Tin Can addresses the peer by -- verified. That is NOT true for OpenCode,
# whose sessions retitle themselves; see README.
echo "Launching orchestrator (claude) first, to learn its peer name..."
record=$(muster run claude --format json --cwd "$workdir" \
  --permissions auto --sandbox workspace-write \
  --mcp tincan \
  --prompt "You are the orchestrator of a five-agent experiment. Do nothing yet. Your four workers do not exist yet, and your instructions file ORCHESTRATOR.md has not been written. Wait. When a Claude session messages you to begin, read ORCHESTRATOR.md in this directory and follow it exactly.")
orch=$(printf '%s' "$record" | field canonical_id)
orch_sid=$(printf '%s' "$record" | field session_id)
echo "  orchestrator: $orch"

realms=(
  "01-asterfall:asterfall:Asterfall"
  "02-nacre:nacre:Nacre Dominion"
  "03-embersteppe:embersteppe:Embersteppe Compact"
  "04-verdant:verdant:Verdant Choir"
)

# The orchestrator's own brief names the four workers, so it is written after
# they are launched. Placeholders are filled in at the end.
orch_md=$(sed -e "s|REPORTER_NAME|${reporter:-NONE}|g" "$here/prompts/orchestrator.md")

for entry in "${realms[@]}"; do
  dir=${entry%%:*}; rest=${entry#*:}; slug=${rest%%:*}; realm=${rest#*:}
  wdir="$workdir/workers/$dir"
  mkdir -p "$wdir"

  # One file with everything. Workers never read shared/ -- the whole brief is
  # assembled here so nothing has to be discovered at runtime.
  {
    echo "You are the author of one kingdom in a five-agent creative experiment."
    echo "You own only $realm. You are its primary author and designer. Make"
    echo "strong creative decisions inside the fixed canon, and complete the"
    echo "entire deliverable yourself."
    echo
    cat "$here/shared/canon.md"; echo
    cat "$here/prompts/realms/$dir.md"; echo
    sed -e "s|OUTPUT_PATH|$wdir/chapter.html|g" -e "s|SLUG|$slug|g" \
        "$here/shared/contract.md"; echo
    sed -e "s|ORCHESTRATOR_NAME|$orch|g" -e "s|REALM_NAME|$realm|g" \
        -e "s|OUTPUT_PATH|$wdir/chapter.html|g" "$here/prompts/worker-rules.md"
  } > "$wdir/BRIEF.md"

  name=$(muster run opencode --format json --cwd "$wdir" \
    --permissions auto --sandbox workspace-write \
    --mcp tincan --plugin tincan \
    --prompt "Read BRIEF.md in this directory and follow it exactly. Do not write chapter.html until the orchestrator sends THEME_LOCKED. Acknowledge by messaging the orchestrator peer $orch with: STARTED $realm" \
    -- --model "$model" | field session_id)

  # OpenCode's Tin Can name is the plugin slug, NOT muster's session name.
  slugfile="$HOME/.tincan/peers/opencode/$name.json"
  peer=""; i=0
  while [ $i -lt 15 ]; do
    if [ -f "$slugfile" ]; then
      peer=$(python3 -c "import json;print(json.load(open('$slugfile'))['slug'])"); break
    fi
    sleep 2; i=$((i+1))
  done
  [ -n "$peer" ] || { echo "  $realm: never registered with Tin Can" >&2; peer="UNREGISTERED"; }
  echo "  $realm: $peer"
  eval "peer_${slug}=\$peer"
done

orch_md=$(printf '%s' "$orch_md" \
  | sed -e "s|WORKER_ASTERFALL|$peer_asterfall|g" \
        -e "s|WORKER_NACRE|$peer_nacre|g" \
        -e "s|WORKER_EMBERSTEPPE|$peer_embersteppe|g" \
        -e "s|WORKER_VERDANT|$peer_verdant|g")
printf '%s\n' "$orch_md" > "$workdir/ORCHESTRATOR.md"

cat <<EOF

Launched in $workdir.

The orchestrator was told to read ORCHESTRATOR.md, which has just been written
with the four peer names. Send it one nudge so it picks the file up now that
its workers exist:

  (from a Claude session)  SendMessage to $orch: "Your workers are launched and
                           ORCHESTRATOR.md is written. Begin Step 1."

  muster list --format human            # states
  tail -f $workdir/dist/council-log.md  # the council, as it happens
  grep delivered ~/.tincan/opencode-plugin.log | tail   # proof messages landed

Stop everything:

  muster list --format json | python3 -c 'import json,sys;[print(e["canonical_id"]) for e in json.load(sys.stdin) if e.get("state") in ("idle","busy")]' | xargs -n1 muster stop

orchestrator session id: $orch_sid
EOF
