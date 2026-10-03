#!/bin/sh
# Installs pk-annotator as a dev dependency of the project in the current
# directory and registers pka-mcp with Claude Code when it is installed.
# Usage: curl -fsSL https://pk-annotator.paulbkim.dev/install.sh | sh
set -eu

fail() {
  printf 'pk-annotator: %s\n' "$1" >&2
  exit 1
}

[ -f package.json ] || fail "no package.json here; run this from your project root"
command -v node >/dev/null 2>&1 || fail "Node.js 24 or newer is required"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || fail "Node.js 24 or newer is required (found $(node -v))"

if [ -f pnpm-lock.yaml ] || [ -f pnpm-workspace.yaml ]; then
  manager=pnpm
elif [ -f bun.lock ] || [ -f bun.lockb ]; then
  manager=bun
elif [ -f yarn.lock ]; then
  manager=yarn
else
  manager=npm
fi
command -v "$manager" >/dev/null 2>&1 || fail "$manager is not on PATH"

printf 'pk-annotator: installing with %s\n' "$manager"
case $manager in
  pnpm)
    # pnpm refuses to add to a workspace root without -w.
    if [ -f pnpm-workspace.yaml ]; then pnpm add -D -w pk-annotator; else pnpm add -D pk-annotator; fi
    ;;
  bun) bun add -d pk-annotator ;;
  yarn) yarn add -D pk-annotator ;;
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
