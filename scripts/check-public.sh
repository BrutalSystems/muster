#!/usr/bin/env bash
# Blocks text that should not reach a public repository: personal paths,
# email addresses, credentials, and any terms a maintainer lists privately.
#
#   scripts/check-public.sh --push <remote> [<url>]
#                                             pre-push hook mode; reads the
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
# ignored. Text matching scripts/public-allow.txt is cut out of a hit line,
# and the rest of the line is checked again, so an allowed value excuses only
# itself.
#
# Uses the system grep -E, which honours \b; `git grep -E` on macOS does not.
# Exits 1 when anything matches and 2 when the check itself cannot run. A
# reviewed false positive can be pushed with `git push --no-verify`.
set -euo pipefail

# The system grep, not a shell alias or function that may wrap another tool.
if [ -x /usr/bin/grep ]; then grep() { /usr/bin/grep "$@"; }; fi

root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
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
else
  : >"$work/allow"
fi
search -v '^(?c)' "$work/patterns" >"$work/fold"
sed -n 's/^(?c)//p' "$work/patterns" >"$work/exact"
# A malformed pattern in any file fails here, before anything is scanned.
for f in fold exact allow; do
  if [ -s "$work/$f" ]; then search -E -f "$work/$f" /dev/null; fi
done
: >"$work/text"

# Each line of $work/text is "<where>: <text>", so a hit says where it is.

add_commits() {
  git -C "$root" log --no-color --format='@@commit %h%n%B' "$@" |
    awk '/^@@commit [0-9a-f]+$/ { c = $2; next } { print "message " c ": " $0 }' \
      >>"$work/text"
  # Merges are diffed against their first parent, so text a conflict
  # resolution adds is seen too. Headers are read only between "diff --git"
  # and the first hunk, so an added line that starts with "++" stays content.
  git -C "$root" log --no-color --no-ext-diff --no-textconv \
    --diff-merges=first-parent --format='@@commit %h' -p --unified=0 "$@" |
    awk '
      /^@@commit [0-9a-f]+$/ { c = $2; hunk = 0; next }
      /^diff --git / { hunk = 0; next }
      !hunk && /^\+\+\+ / { f = substr($0, 5); sub(/^b\//, "", f); next }
      /^@@ / { hunk = 1; next }
      hunk && /^\+/ { print c " " f ": " substr($0, 2) }
    ' >>"$work/text"
}

# The message of an annotated tag and of any tag it points at, down to the
# object it names. Its headers (object, type, tagger) are git's own record,
# like a commit's author, and are not scanned.
add_tag() {
  local ref=$1 sha=$2
  while [ "$(git -C "$root" cat-file -t "$sha")" = tag ]; do
    git -C "$root" cat-file tag "$sha" | sed '1,/^$/d' |
      sed "s|^|tag $ref: |" >>"$work/text"
    sha=$(git -C "$root" cat-file tag "$sha" | sed -n 's/^object //p;q')
  done
}

add_files() {
  find "$@" -type f -print0 | lines >>"$work/text"
}

mode=${1:-}
[ $# -gt 0 ] && shift
case "$mode" in
  --push)
    remote=${1:-origin}
    # The hook's second argument is the URL being pushed to, which can differ
    # from the remote's fetch URL; that is the repository to compare against.
    dest=${2:-$remote}
    zero=0000000000000000000000000000000000000000
    # What the remote holds now, not what the remote-tracking refs last saw:
    # a stale ref could otherwise hide commits this push would publish.
    git -C "$root" ls-remote "$dest" >"$work/remote" || {
      echo "check-public: could not list $dest; refusing to report clean" >&2
      exit 2
    }
    : >"$work/known"
    while read -r sha _ref; do
      if git -C "$root" cat-file -e "$sha^{commit}" 2>/dev/null; then
        echo "$sha" >>"$work/known"
      fi
    done <"$work/remote"
    while read -r local_ref local_sha remote_ref _remote_sha; do
      [ "$local_sha" = "$zero" ] && continue
      echo "ref: $local_ref" >>"$work/text"
      echo "ref: $remote_ref" >>"$work/text"
      add_tag "$local_ref" "$local_sha"
      # shellcheck disable=SC2046
      add_commits "$local_sha" --not $(sort -u "$work/known")
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
    sed -n '2,27s/^# \{0,1\}//p' "$0" >&2
    exit 2
    ;;
esac

: >"$work/hits"
scan() {
  if [ -s "$work/fold" ]; then search -E -i -f "$work/fold" "$1"; fi
  if [ -s "$work/exact" ]; then search -E -f "$work/exact" "$1"; fi
}
scan "$work/text" | sort -u >"$work/hits"
# An allowed match is cut out of its line, and the rest of the line is
# scanned again, so an allowed value cannot shield anything beside it.
if [ -s "$work/hits" ] && [ -s "$work/allow" ]; then
  ALLOW="$work/allow" perl -ne '
    BEGIN { open my $a, "<", $ENV{ALLOW} or die; chomp(@re = <$a>) }
    my $line = $_;
    $line =~ s/$_//gi for @re;
    print $line;
  ' "$work/hits" >"$work/rest"
  scan "$work/rest" | sort -u >"$work/hits"
fi

if [ -s "$work/hits" ]; then
  echo "check-public: $(wc -l <"$work/hits" | tr -d ' ') line(s) match a blocked pattern:" >&2
  cut -c1-200 "$work/hits" >&2
  exit 1
fi
echo "check-public: clean" >&2
