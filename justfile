# The patch set's build choreography.
#
# A new CC version flows through here without ever touching a live install:
#
#     just status          1  npm has a version the fleet is not on
#     just fetch           pristine binary into upstream/<v>/claude
#     just port            3  broken patches: the porting-patches skill takes over
#     just check           0  full gate passed, patches/<v>/check.json written
#     (commit + push)      fleet-ready now answers <v>
#     just build           patched binary into release/<v>/claude
#     just smoke           the artifact loads, carries its patches, and runs a turn
#     (fleet rolls out)    via `just artifact`
#
# EXIT CODES ARE THE INTERFACE, following the fleet's convention:
#   0  ok            2  could not ask (network, missing input) — never "fine"
#   1  action needed 3  human or agent needed
#
# upstream/ holds pristine binaries and is never written after `fetch`; release/
# holds patched artifacts. Both are gitignored. The live install is only ever
# read, by `just live`.

# NOT `bash -uc`: nounset during rc sourcing breaks on hosts whose /etc/bashrc
# reads unset variables. Recipes set their own flags once startup is done.
set shell := ["bash", "-c"]

# The bundle-heavy stages OOM on node's default heap.
export NODE_OPTIONS := "--max-old-space-size=8192"

package := "@anthropic-ai/claude-code"
platform_package := "@anthropic-ai/claude-code-linux-x64"

[private]
default:
    @just --list

# --- reading -------------------------------------------------------------

# Newest CC version whose patch set passed a full --check on cached origin/master (fleet probe contract).
fleet-ready tool:
    @scripts/fleet-ready.sh {{quote(tool)}}

# The only network read besides `fetch`. Compares npm's latest against what the
# fleet may roll out, so it answers "is there porting to do".
[doc("Is there a CC version the fleet is not on? 0 current, 1 update available, 2 could not ask")]
status:
    #!/usr/bin/env bash
    set -uo pipefail
    latest=$(npm view {{ package }} version 2>/dev/null) || { echo "could not reach npm" >&2; exit 2; }
    ready=$(just fleet-ready claude 2>/dev/null) || ready=none
    if [ "$latest" = "$ready" ]; then echo "current: $ready (latest)"; exit 0; fi
    echo "update available: $ready -> $latest"
    if [ -x "upstream/$latest/claude" ]; then echo "fetched: upstream/$latest/claude"; fi
    exit 1

# Read-only by construction: --status extracts the live binary's JS to a temp
# file and reports its patch marker. Nothing here writes next to the install.
[doc("Report the live installs' versions and whether they are patched")]
live:
    @node claude-patching.js --status

# --- preparing -------------------------------------------------------------

# The npm platform package is the source because it is versioned, immutable and
# integrity-checked: `npm pack` verifies the tarball against the registry's
# sha512 before it lands. Its `claude` is the same Bun ELF the native installer
# ships. pack.json keeps that integrity for the build manifest.
#
# The binary lands read-only, and every later stage reads it through --binary,
# which refuses to write to its input.
[doc("Download the pristine CC binary for a version (default: npm latest) into upstream/<v>/. 0 ok, 2 could not fetch")]
fetch version="":
    #!/usr/bin/env bash
    set -uo pipefail
    v="{{ version }}"
    if [ -z "$v" ]; then
        v=$(npm view {{ package }} version 2>/dev/null) || { echo "could not reach npm" >&2; exit 2; }
    fi
    [[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a bare version: $v" >&2; exit 2; }
    dest="upstream/$v"
    if [ -x "$dest/claude" ]; then echo "$dest/claude"; exit 0; fi
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    npm pack --json --pack-destination "$work" "{{ platform_package }}@$v" > "$work/pack.json" 2>/dev/null \
        || { echo "could not fetch {{ platform_package }}@$v" >&2; exit 2; }
    tar xzf "$work"/*.tgz -C "$work" package/claude || { echo "tarball holds no claude binary" >&2; exit 2; }
    mkdir -p "$dest"
    install -m 0555 "$work/package/claude" "$dest/claude"
    jq '.[0] | {name, version, integrity, shasum}' "$work/pack.json" > "$dest/pack.json"
    echo "$dest/claude"

# Newest fetched version, the default for port and check.
[private]
fetched:
    #!/usr/bin/env bash
    set -uo pipefail
    v=$(ls -1 upstream 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
    [ -n "$v" ] || { echo "nothing fetched; run \`just fetch\`" >&2; exit 2; }
    echo "$v"

# --port skips the chunk-scope stage, so a green port is not a finished one:
# `just check` is. A red port maps to 3 because fixing patches is agent work
# (the porting-patches skill reads this output).
[doc("Setup + init + scans + pattern check against upstream/<v>. 0 green, 2 could not run, 3 broken patches")]
port version="":
    #!/usr/bin/env bash
    set -uo pipefail
    v="{{ version }}"; [ -n "$v" ] || v=$(just fetched) || exit 2
    [ -x "upstream/$v/claude" ] || { echo "run \`just fetch $v\`" >&2; exit 2; }
    node claude-patching.js --binary "upstream/$v/claude" --port
    case $? in 0) exit 0 ;; 1) exit 3 ;; *) exit 2 ;; esac

# The full gate, chunk scope included. On a clean pass against the version's own
# patch set it writes patches/<v>/check.json, which is what fleet-ready reads
# once pushed.
[doc("Full gate against upstream/<v>, writing patches/<v>/check.json. 0 pass, 1 fail, 2 could not run")]
check version="":
    #!/usr/bin/env bash
    set -uo pipefail
    v="{{ version }}"; [ -n "$v" ] || v=$(just fetched) || exit 2
    [ -x "upstream/$v/claude" ] || { echo "run \`just fetch $v\`" >&2; exit 2; }
    [ -f "patches/$v/index.json" ] || { echo "no patches/$v; run \`just port $v\`" >&2; exit 2; }
    node claude-patching.js --binary "upstream/$v/claude" --check

# --- cooking ---------------------------------------------------------------

# The artifact must be traceable to pushed code, so the build refuses a dirty
# tree and a HEAD that is not cached origin/master, and builds exactly the
# version fleet-ready answers. A version that is not ready cannot be cooked.
#
# release/<v>/ is cleared first so the checks at the end cannot pass on a
# previous build's bytes. Older versions stay as rollback points.
[doc("Patch upstream/<ready>/claude into release/<ready>/. 0 ok, 2 could not build")]
build:
    #!/usr/bin/env bash
    set -uo pipefail
    [ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; refusing to build" >&2; exit 2; }
    head=$(git rev-parse HEAD)
    [ "$head" = "$(git rev-parse refs/remotes/origin/master)" ] \
        || { echo "HEAD is not origin/master; push first" >&2; exit 2; }
    v=$(just fleet-ready claude) || { echo "no ready version on origin/master" >&2; exit 2; }
    src="upstream/$v/claude"
    [ -x "$src" ] || { echo "run \`just fetch $v\`" >&2; exit 2; }
    out="release/$v"
    rm -rf "$out"
    mkdir -p "$out"
    node claude-patching.js --binary "$src" --apply --out "$out/claude" || { rm -rf "$out"; exit 2; }
    [ -x "$out/claude" ] || { echo "built no binary at $out/claude" >&2; exit 2; }
    (cd "$out" && sha256sum claude > claude.sha256)
    jq -n --arg v "$v" --arg commit "$head" --arg sha "$(cut -d' ' -f1 "$out/claude.sha256")" \
        --slurpfile pack "upstream/$v/pack.json" --slurpfile check "patches/$v/check.json" \
        '{version: $v, commit: $commit, sha256: $sha, source: $pack[0], patches: $check[0].passed}' \
        > "$out/manifest.json"
    realpath "$out/claude"

# The only check that runs the ARTIFACT. --version proves it loads; the patch
# marker proves the build applied what the manifest claims; the turn proves a
# real request survives the patched render and request paths.
#
# The turn runs from an empty temp dir with project-only settings, so the user's
# hooks, plugins and MCP servers stay out of it, and persists no session. It
# needs this machine's claude.ai login, which is why it is not `--bare`.
[doc("Run release/<v>/claude: version, embedded patches, one headless turn. 0 pass, 1 fail, 2 could not run")]
smoke version="":
    #!/usr/bin/env bash
    set -uo pipefail
    v="{{ version }}"; [ -n "$v" ] || v=$(just fleet-ready claude) || exit 2
    dir="release/$v"
    [ -x "$dir/claude" ] || { echo "no artifact; run \`just build\`" >&2; exit 2; }
    bin=$(realpath "$dir/claude")
    (cd "$dir" && sha256sum --quiet -c claude.sha256) || { echo "artifact does not match its checksum" >&2; exit 1; }
    reported=$("$bin" --version 2>&1 | head -1)
    [[ $reported == "$v "* ]] || { echo "artifact reports '$reported', not $v" >&2; exit 1; }
    echo "version: $reported"
    embedded=$(CLAUDECODE=1 node claude-patching.js --binary "$bin" --status | jq -c '.installs.native.patches | sort')
    expected=$(jq -c '.patches | sort' "$dir/manifest.json")
    [ "$embedded" = "$expected" ] || { echo "embedded patches $embedded differ from manifest $expected" >&2; exit 1; }
    echo "patches: $(jq length <<< "$embedded") embedded"
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    answer=$(cd "$work" && env -u CLAUDECODE DISABLE_AUTOUPDATER=1 timeout 180 "$bin" -p "Reply with exactly: hello world" \
        --model haiku --max-turns 1 --setting-sources project --strict-mcp-config --no-session-persistence 2>&1) \
        || { echo "turn failed: $answer" >&2; exit 1; }
    [[ ${answer,,} == *"hello world"* ]] || { echo "unexpected answer: $answer" >&2; exit 1; }
    echo "turn: $answer"
    echo "SMOKE PASS"

# What the fleet distributes: the ready version's artifact, checksum-verified,
# built from the same patch inputs origin/master holds now. Inputs that moved
# since the build make it stale rather than absent.
[doc("Print the ready version's artifact path. 0 ok, 1 stale (rebuild), 2 no artifact")]
artifact:
    #!/usr/bin/env bash
    set -uo pipefail
    export GIT_OPTIONAL_LOCKS=0
    v=$(just fleet-ready claude) || exit 2
    dir="release/$v"
    [ -x "$dir/claude" ] || { echo "no artifact for $v" >&2; exit 2; }
    (cd "$dir" && sha256sum --quiet -c claude.sha256) || { echo "artifact does not match its checksum" >&2; exit 2; }
    built=$(jq -er .commit "$dir/manifest.json") || { echo "unreadable manifest" >&2; exit 2; }
    git diff --quiet "$built" refs/remotes/origin/master -- patches lib claude-patching.js \
        || { echo "patch inputs changed since $built; rebuild" >&2; exit 1; }
    realpath "$dir/claude"
