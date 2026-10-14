#!/bin/sh
# One transport-identity probe request, for
#   OPENSHELL_TRANSPORT_PROBE_CMD='sh examples/openshell/live-kit/probe-transport.sh "$@"'
#   npm run test:openshell-transport-acceptance
# The harness runs the command with `sh -c`, so "$@" is what hands the case
# to this script. Without it the script gets no argument and every case fails
# with the usage error before anything is sent.
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
#   PROBE_PLAINTEXT_MODE  connect (default) | transparent
#                connect:     plain HTTP inside a CONNECT tunnel through the
#                             sandbox proxy, the shape #4397 describes.
#                transparent: plain HTTP sent straight to PROBE_HOST, which
#                             OpenShell intercepts. Use it where the sandbox
#                             has no reachable CONNECT proxy: on OpenShell
#                             0.1.3's Docker driver the proxy listens in the
#                             supervisor's network, not the sandbox's, so
#                             connect mode is never observed. The question is
#                             the same: is the guard told http for a request
#                             that was not TLS? A pass in this mode never
#                             qualifies a version: it says nothing about
#                             CONNECT tunnels. A mislabel is a valid control.
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
mode="${PROBE_PLAINTEXT_MODE:-connect}"
case "$mode" in
  connect|transparent) ;;
  *) echo "PROBE_PLAINTEXT_MODE must be connect or transparent, got: $mode" >&2; exit 64 ;;
esac
before=$(wc -l < "$GUARD_LOG" 2>/dev/null || echo 0)
if [ "$1" = tls ]; then
  # HTTPS: TLS inside whatever path OpenShell gives the sandbox.
  $OSH_EXEC sh -c "curl -sS -o /dev/null -X POST -d '{}' 'https://$PROBE_HOST$path'" || true
elif [ "$mode" = transparent ]; then
  # Plain HTTP straight to the endpoint; OpenShell intercepts it transparently.
  # --noproxy '*' so an ambient http_proxy / ALL_PROXY cannot turn this back
  # into a proxied request.
  $OSH_EXEC sh -c "curl -sS -o /dev/null -m 10 --noproxy '*' -X POST -d '{}' 'http://$PROBE_HOST$path'" || true
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
