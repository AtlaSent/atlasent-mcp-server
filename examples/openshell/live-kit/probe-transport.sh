#!/bin/sh
# One transport-identity probe request, for
#   OPENSHELL_TRANSPORT_PROBE_CMD="sh examples/openshell/live-kit/probe-transport.sh"
#   npm run test:openshell-transport-acceptance
# The harness passes the case as $1: tls | plaintext_tunnel.
#
# Required environment:
#   OSH_EXEC     command prefix that runs a command inside the sandbox, e.g.
#                "openshell sandbox exec <name> --" (check your OpenShell CLI)
#   GUARD_LOG    file the AtlaSent workload guard writes its stderr to
#   PROBE_HOST   host:port of an endpoint the guard is attached to. Point it
#                at the stub (stub-atlasent.mjs), never the real AtlaSent API.
# Optional:
#   PROBE_PATH   default /functions/v1/v1-evaluate
#   PROBE_PROXY  proxy URL inside the sandbox; default: the sandbox's own
#                $HTTPS_PROXY (expanded inside the sandbox, not here)
#
# Prints the guard log lines written during this request. The harness reads
# the scheme the guard was told from the last of them.
set -eu
case "${1:-}" in
  tls) ;;
  plaintext_tunnel) ;;
  *) echo "usage: $0 tls|plaintext_tunnel" >&2; exit 64 ;;
esac
: "${OSH_EXEC:?set OSH_EXEC}" "${GUARD_LOG:?set GUARD_LOG}" "${PROBE_HOST:?set PROBE_HOST}"
path="${PROBE_PATH:-/functions/v1/v1-evaluate}"
before=$(wc -l < "$GUARD_LOG" 2>/dev/null || echo 0)
if [ "$1" = tls ]; then
  # HTTPS: TLS inside whatever path OpenShell gives the sandbox.
  $OSH_EXEC sh -c "curl -sS -o /dev/null -X POST -d '{}' 'https://$PROBE_HOST$path'" || true
else
  # Plain HTTP forced through a CONNECT tunnel (-p): the case #4397 mislabels.
  proxy="${PROBE_PROXY:-}"
  if [ -n "$proxy" ]; then
    $OSH_EXEC sh -c "curl -sS -o /dev/null -p -x '$proxy' -X POST -d '{}' 'http://$PROBE_HOST$path'" || true
  else
    $OSH_EXEC sh -c 'curl -sS -o /dev/null -p -x "$HTTPS_PROXY" -X POST -d "{}" "http://'"$PROBE_HOST$path"'"' || true
  fi
fi
# Give the guard a moment to flush its line.
sleep 1
tail -n +"$((before + 1))" "$GUARD_LOG"
