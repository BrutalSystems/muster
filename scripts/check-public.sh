#!/usr/bin/env bash
# Blocks text that should not reach a public repository: personal paths,
# email addresses, credentials, and any terms a maintainer lists privately.
#
#   scripts/check-public.sh --push <remote>   pre-push hook mode; reads the
#                                             hook's ref lines on stdin
#   scripts/check-public.sh --range <revs>    added lines and messages of the
#                                             commits <revs> selects, e.g.
#                                             origin/main..HEAD
#   scripts/check-public.sh --tree            every tracked file in the tree
#   scripts/check-public.sh --files <path>…   the named files or directories
#
# Patterns come from two places. scripts/public-patterns.txt holds generic
# shapes and ships with the repo. A private terms file adds names that must
# never be written into the repo itself; it is read from $PUBLIC_TERMS_FILE,
# else `git config public.termsFile`, else ~/.config/public-terms.txt when it
# exists. Both are extended regexes, one per line, matched case-insensitively
# unless the line starts with (?c); lines starting with # and blank lines are
# ignored. A hit line that also
# matches scripts/public-allow.txt is not reported.
#
# Uses the system grep -E, which honours \b; `git grep -E` on macOS does not.
# Exits 1 when anything matches. A reviewed false positive can be pushed with
# `git push --no-verify`.
set -euo pipefail

# The system grep, not a shell alias or function that may wrap another tool.
if [ -x /usr/bin/grep ]; then grep() { /usr/bin/grep "$@"; }; fi

root=$(git rev-parse --show-toplevel)
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# grep exits 0 on a match and 1 on none; anything above 1 is a bad pattern or
# an unreadable file, which must fail the check rather than read as clean.
search() {
  local status=0
  grep "$@" || status=$?
  if [ "$status" -gt 1 ]; then
    echo "check-public: grep failed (exit $status); refusing to report clean" >&2
    exit 2
  fi
}

# Every line of the named files, labelled "<file>:<n>:"; binary files skipped.
lines() {
  xargs -0 sh -c 's=0; grep -IHn "" "$@" || s=$?; [ "$s" -le 1 ]' sh || {
    echo "check-public: could not read every file" >&2
    exit 2
  }
}

strip() { search -vE '^[[:space:]]*(#|$)' "$1"; }

strip "$here/public-patterns.txt" >"$work/patterns"
terms=${PUBLIC_TERMS_FILE:-$(git config --get public.termsFile || true)}
terms=${terms/#\~/$HOME}
if [ -z "$terms" ] && [ -f "$HOME/.config/public-terms.txt" ]; then
  terms="$HOME/.config/public-terms.txt"
fi
if [ -n "$terms" ]; then
  if [ ! -r "$terms" ]; then
    echo "check-public: terms file $terms is not readable" >&2
    exit 2
  fi
  strip "$terms" >>"$work/patterns"
else
  echo "check-public: no private terms file; checking generic patterns only" >&2
fi
if [ -f "$here/public-allow.txt" ]; then
  strip "$here/public-allow.txt" >"$work/allow"
fi
: >"$work/text"

# Each line of $work/text is "<where>: <text>", so a hit says where it is.

add_commits() {
  git -C "$root" log --no-color --format='commit %h%n%B' "$@" |
    awk '/^commit [0-9a-f]+$/ { c = $2; next } { print "message " c ": " $0 }' \
      >>"$work/text"
  git -C "$root" log --no-color --format='commit %h' -p --unified=0 "$@" |
    awk '
      /^commit [0-9a-f]+$/ { c = $2; next }
      /^\+\+\+ / { f = substr($0, 5); sub(/^b\//, "", f); next }
      /^\+/ { print c " " f ": " substr($0, 2) }
    ' >>"$work/text"
}

add_files() {
  find "$@" -type f -print0 | lines >>"$work/text"
}

mode=${1:-}
[ $# -gt 0 ] && shift
case "$mode" in
  --push)
    remote=${1:-origin}
    zero=0000000000000000000000000000000000000000
    while read -r local_ref local_sha _remote_ref _remote_sha; do
      [ "$local_sha" = "$zero" ] && continue
      echo "ref: $local_ref" >>"$work/text"
      if [ "$(git -C "$root" cat-file -t "$local_sha")" = tag ]; then
        git -C "$root" cat-file tag "$local_sha" |
          sed "s|^|tag $local_ref: |" >>"$work/text"
      fi
      add_commits "$local_sha" --not --remotes="$remote"
    done
    ;;
  --range)
    [ $# -gt 0 ] || { echo "usage: $0 --range <revs>" >&2; exit 2; }
    add_commits "$@"
    ;;
  --tree)
    (cd "$root" && git ls-files -z | lines) >>"$work/text"
    ;;
  --files)
    [ $# -gt 0 ] || { echo "usage: $0 --files <path>..." >&2; exit 2; }
    add_files "$@"
    ;;
  *)
    sed -n '2,24s/^# \{0,1\}//p' "$0" >&2
    exit 2
    ;;
esac

search -v '^(?c)' "$work/patterns" >"$work/fold"
sed -n 's/^(?c)//p' "$work/patterns" >"$work/exact"
: >"$work/hits"
if [ -s "$work/fold" ]; then
  search -E -i -f "$work/fold" "$work/text" >>"$work/hits"
fi
if [ -s "$work/exact" ]; then
  search -E -f "$work/exact" "$work/text" >>"$work/hits"
fi
sort -u -o "$work/hits" "$work/hits"
if [ -s "$work/hits" ] && [ -s "${work}/allow" ]; then
  search -E -i -v -f "$work/allow" "$work/hits" >"$work/kept"
  mv "$work/kept" "$work/hits"
fi

if [ -s "$work/hits" ]; then
  echo "check-public: $(wc -l <"$work/hits" | tr -d ' ') line(s) match a blocked pattern:" >&2
  cut -c1-200 "$work/hits" >&2
  exit 1
fi
echo "check-public: clean" >&2
