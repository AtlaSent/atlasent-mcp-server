#!/bin/sh
# Guard-bound mode, live, on OpenShell's Docker driver (no sandbox ID in the
# workload). Runs two cases inside the sandbox and checks what the stub saw.
#
# Required environment:
#   OSH_EXEC        command prefix that runs a command inside the sandbox, e.g.
#                   "openshell sandbox exec <name> --" (check your OpenShell CLI)
#   SANDBOX_ID      the sandbox's real ID, from OpenShell (what the guard must fill in)
#   STUB_LOG        the stub-atlasent.mjs --log file
# Inside the sandbox, atlasent-openshell must be installed and pointed at the
# stub through the provider profile (ATLASENT_BASE_URL); the guard must be
# registered with fill_absent_workload: true and the stub's host pinned as its
# destination.
#
# Case 1 (honest): no sandbox ID, guard-bound mode. Expect the command to run
#   (exit 0) and every evaluate/verify the stub saw to carry the filled-in
#   workload, a matching attestation, a correct Content-Length and a key.
# Case 2 (forged): the workload names another sandbox. Expect a refusal
#   (exit 77) and nothing new at the stub: the guard must deny it.
set -eu
: "${OSH_EXEC:?set OSH_EXEC}" "${SANDBOX_ID:?set SANDBOX_ID}" "${STUB_LOG:?set STUB_LOG}"
here=$(cd "$(dirname "$0")" && pwd)
envelope='{"action_type":"data.export","actor_id":"agent:live-kit","environment":"staging","target_id":"live-kit"}'
fail=0

since=$(date -u +%Y-%m-%dT%H:%M:%S)
echo "== case 1: honest, guard-bound"
set +e
$OSH_EXEC sh -c "printf '%s' '$envelope' > /tmp/env.json && ATLASENT_OPENSHELL_WORKLOAD_BINDING=guard atlasent-openshell run --envelope /tmp/env.json -- true"
code=$?
set -e
echo "exit $code (expected 0)"
[ "$code" -eq 0 ] || fail=1
node "$here/check-guard-bound.mjs" --log "$STUB_LOG" --sandbox-id "$SANDBOX_ID" --since "$since" || fail=1

before=$(wc -l < "$STUB_LOG")
echo "== case 2: forged workload"
set +e
$OSH_EXEC sh -c "printf '%s' '$envelope' > /tmp/env.json && OPENSHELL_SANDBOX_ID=sbx-forged-live-kit ATLASENT_OPENSHELL_WORKLOAD_BINDING=guard atlasent-openshell run --envelope /tmp/env.json -- true"
code=$?
set -e
after=$(wc -l < "$STUB_LOG")
echo "exit $code (expected 77); stub received $((after - before)) request(s) (expected 0)"
[ "$code" -eq 77 ] || fail=1
[ "$after" -eq "$before" ] || fail=1

if [ "$fail" -eq 0 ]; then echo "GUARD-BOUND LIVE RUN: PASS"; else echo "GUARD-BOUND LIVE RUN: FAIL"; fi
exit "$fail"
