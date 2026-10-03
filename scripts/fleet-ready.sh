#!/usr/bin/env bash
# Offline probe: the newest CC version whose patch set fully passed --check on cached origin/master.
set -Eeuo pipefail
trap 'exit 2' ERR
export GIT_OPTIONAL_LOCKS=0

refuse() {
  printf '%s\n' "$1" >&2
  exit 2
}

[[ $# == 1 && $1 == claude ]] || refuse 'fleet-ready supports only claude'

origin_ref=refs/remotes/origin/master
git rev-parse --quiet --verify "$origin_ref^{commit}" >/dev/null || refuse 'missing cached origin/master'

# A record counts only if it names its own directory, every patch passed, and nothing was skipped.
record_filter='
  select(.version == $v and .success == true and .total > 0
    and (.passed | length) == .total and (.failed | length) == 0 and (.skipped | length) == 0)
  | .version
  | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))
'
while read -r version; do
  record=$(git show "$origin_ref:patches/$version/check.json" 2>/dev/null) || continue
  if ready=$(printf '%s' "$record" | jq -er --arg v "$version" "$record_filter" 2>/dev/null); then
    printf '%s\n' "$ready"
    exit 0
  fi
done < <(git ls-tree -d --name-only "$origin_ref" patches/ | sed 's|^patches/||' | sort -rV)

refuse 'no fully-checked patch set on cached origin/master'
