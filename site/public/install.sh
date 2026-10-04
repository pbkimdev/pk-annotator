#!/bin/sh
# Installs pk-annotator as a dev dependency at the workspace root in the current
# directory and registers pka-mcp with Claude Code when it is installed.
# Usage: curl -fsSL https://pk-annotator.paulbkim.dev/install.sh | sh
set -eu

fail() {
  printf 'pk-annotator: %s\n' "$1" >&2
  exit 1
}

# The lockfile or workspace file nearest above $1, as "<manager> <directory>".
find_root() {
  dir=$1
  while :; do
    if [ -f "$dir/pnpm-lock.yaml" ] || [ -f "$dir/pnpm-workspace.yaml" ]; then echo "pnpm $dir"; return; fi
    if [ -f "$dir/bun.lock" ] || [ -f "$dir/bun.lockb" ]; then echo "bun $dir"; return; fi
    if [ -f "$dir/yarn.lock" ]; then echo "yarn $dir"; return; fi
    if [ -f "$dir/package-lock.json" ]; then echo "npm $dir"; return; fi
    [ "$dir" = / ] && return
    dir=$(dirname "$dir")
  done
}

main() {
  [ -f package.json ] || fail "no package.json here; run this from your workspace root"
  command -v node >/dev/null 2>&1 || fail "Node.js 24 or newer is required"
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$node_major" -ge 24 ] || fail "Node.js 24 or newer is required (found $(node -v))"

  here=$(pwd -P)
  found=$(find_root "$here")
  manager=${found%% *}
  root=${found#* }
  if [ -z "$found" ]; then
    manager=npm
  elif [ "$root" != "$here" ]; then
    # Installing in a member would put the dependency and pka-mcp in the wrong place.
    fail "this is inside the $manager workspace at $root; run the installer there"
  fi
  command -v "$manager" >/dev/null 2>&1 || fail "$manager is not on PATH"

  printf 'pk-annotator: installing with %s\n' "$manager"
  case $manager in
    pnpm)
      # pnpm refuses to add to a workspace root without -w.
      if [ -f pnpm-workspace.yaml ]; then pnpm add -D -w pk-annotator; else pnpm add -D pk-annotator; fi
      ;;
    yarn)
      yarn_version=$(yarn --version)
      case $yarn_version in
        1.*)
          # Yarn 1 refuses to add to a workspace root without -W.
          if grep -q '"workspaces"' package.json; then yarn add -D -W pk-annotator; else yarn add -D pk-annotator; fi
          ;;
        *)
          yarn_linker=$(yarn config get nodeLinker)
          [ "$yarn_linker" = node-modules ] || fail "Yarn requires nodeLinker: node-modules in .yarnrc.yml for the MCP binary; no dependencies were changed"
          yarn add -D pk-annotator
          ;;
      esac
      ;;
    bun) bun add -d pk-annotator ;;
    npm) npm install -D pk-annotator ;;
  esac

  [ -x node_modules/.bin/pka-mcp ] || fail "node_modules/.bin/pka-mcp is missing after install"

  if command -v claude >/dev/null 2>&1; then
    if claude mcp get pka >/dev/null 2>&1; then
      printf 'pk-annotator: Claude Code already has an MCP server named pka; left it unchanged\n'
    else
      claude mcp add pka --scope project -- node_modules/.bin/pka-mcp
    fi
  fi

  cat <<'EOF'

pk-annotator is installed. Next:
  1. vite.config.ts:  plugins: [...annotator()]  from "pk-annotator/vite"
  2. client entry:    mount({ hot: import.meta.hot }) from "pk-annotator/overlay", in dev only
  3. Start the dev server and press Alt+Shift+A.

Or let your agent finish the setup:
  Set up pk-annotator in this project by following https://pk-annotator.paulbkim.dev/agents.md

Codex, Pi, and manual setup: https://pk-annotator.paulbkim.dev/#install
EOF
}

# Called last, so a truncated download runs nothing.
main
