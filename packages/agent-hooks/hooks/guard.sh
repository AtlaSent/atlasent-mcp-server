#!/bin/sh
# AtlaSent guard: the command hooks/hooks.json runs before each checked tool call.
#
# Claude Code treats a hook that exits non-zero (other than 2) as a non-blocking error
# and runs the tool anyway. Without this wrapper, a machine with no Node on PATH got no
# protection at all while the plugin showed as enabled. Exit 2 blocks the tool call.
#
# Kept as a plain script at a literal path, with no computed paths or inline programs,
# so the Claude plugin directory's validator can follow what it runs.

if ! command -v node >/dev/null 2>&1; then
  echo "AtlaSent guard needs Node.js 18 or later on PATH and could not find it, so this action was blocked (fail-closed). Install Node from https://nodejs.org and restart Claude Code, or disable the atlasent-guard plugin." >&2
  exit 2
fi

node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" claude-code --plugin || {
  echo "AtlaSent guard could not run (is Node.js 18 or later installed?), so this action was blocked (fail-closed)." >&2
  exit 2
}
