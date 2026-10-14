# OpenShell live-run kit

Three checks in `docs/OPENSHELL_AUTHORITY_ADAPTER.md` need a real OpenShell,
so no CI can run them. This kit makes each one a single command where OpenShell
is installed. The kit's own logic is tested offline (`live-kit.test.mjs`, part
of `npm test`). That proves the kit works. It proves nothing about OpenShell;
only the live runs do.

Never point any of this at the real AtlaSent API. Use `stub-atlasent.mjs`.

## Pieces

| File | What it is |
|---|---|
| `stub-atlasent.mjs` | A recording stand-in for the AtlaSent API. It records the body bytes and their sha256, whether `Content-Length` matches, whether an `Authorization` header arrived (as a hash prefix, never the key), the guard attestation (signature checked against the guard public key, `body_sha256` checked against the bytes received) and the workload named. It answers like a runtime whose key is flagged `requires_workload_attestation`: no verified, matching attestation means 401, and with one, evaluate returns an allow with `workload_attested: true`. |
| `check-guard-bound.mjs` | Turns the stub log into a pass/fail report. Exit 0 pass, 1 fail, 2 nothing to check. |
| `probe-transport.sh` | One request per case for the #4397 transport probe. It prints only the guard log lines written during that request. |
| `run-guard-bound.sh` | The guard-bound Docker-driver run. An honest case must run and pass the checker. A forged case must exit 77 with nothing reaching the stub. |

## Common setup

1. Start the stub on the host the sandbox can reach. For the TLS case, give it
   a certificate the sandbox trusts.
   ```
   node examples/openshell/live-kit/stub-atlasent.mjs --http-port 18080 \
     --https-port 18443 --cert stub.pem --key stub.key \
     --guard-public-key guard.pub.pem --log stub.jsonl
   ```
2. Register the workload guard (`packages/openshell-workload-guard`) with its
   `destination` set to the stub's host and port. Send its stderr to a file
   (`GUARD_LOG`).
3. Set `OSH_EXEC` to whatever runs a command inside the sandbox in your
   OpenShell version, for example `openshell sandbox exec <name> --`. The kit
   does not guess this. Check `openshell sandbox --help`.

## 1. Transport identity (NVIDIA/OpenShell#4397)

```
OPENSHELL_VERSION=0.1.3-pre.4 \
OPENSHELL_TRANSPORT_PROBE_CMD='sh examples/openshell/live-kit/probe-transport.sh "$@"' \
OSH_EXEC="openshell sandbox exec <name> --" GUARD_LOG=guard.log PROBE_HOST=<stub-host>:18443 \
npm run test:openshell-transport-acceptance
```

Keep the single quotes and the `"$@"`: the harness runs this command with
`sh -c` and passes the case as an argument. Without `"$@"` every case fails
with the script's usage error before anything is sent.

On 0.1.3-pre.4, expect a FAIL with `defect_4397: true`. That failure is the
control.

**OpenShell 0.1.3, Docker driver.** The sandbox has no reachable CONNECT
proxy: the supervisor's proxy listens in its own network, and every sandbox
connection is intercepted transparently. The default plaintext case is then
never observed. Add `PROBE_PLAINTEXT_MODE=transparent`, which sends the plain
HTTP request straight to `PROBE_HOST`. On 0.1.3 the supervisor logs that
request as `http://…` and still tells the guard `https`, so this run is the
control (recorded 2026-10-13, atlasent-api#4281). A transparent-mode *pass*
never qualifies a version for `OPENSHELL_TRANSPORT_IDENTITY_CONFIRMED`: it
says nothing about CONNECT tunnels, and the harness fails it as
non-qualifying. Qualification needs a pass in the default `connect` mode. The same host needed:
`openshell sandbox exec --name <name> --` for `OSH_EXEC`; an explicit
`binaries:` list on the network rule; a stub hostname that public DNS resolves
to a private IP listed in `allowed_ips`, because `host.openshell.internal`
maps to `127.0.0.1` and is refused; and the test CA added, world-readable, to
the supervisor image's `/etc/ssl/certs/ca-certificates.crt`. The supervisor
reads its own trust store, not the sandbox image's, and runs as user 65534. On a release carrying the fix, expect a pass, then record both runs in
`docs/OPENSHELL_AUTHORITY_ADAPTER.md` and the version in
`OPENSHELL_TRANSPORT_IDENTITY_CONFIRMED`.

## 2. Guard-bound mode (Docker driver)

The guard runs with `fill_absent_workload: true`. Inside the sandbox,
`atlasent-openshell` is installed and `ATLASENT_BASE_URL` points at the stub.

```
OSH_EXEC="openshell sandbox exec <name> --" SANDBOX_ID=<real sandbox id> STUB_LOG=stub.jsonl \
sh examples/openshell/live-kit/run-guard-bound.sh
```

A pass means all of the following happened, at the real boundary:
- the guard filled in the right sandbox;
- OpenShell forwarded the new body with a correct `Content-Length`;
- the attestation covered those bytes;
- the key was injected;
- the adapter accepted `workload_attested`;
- a forged workload never reached the stub.

## 3. Startup probe (#3994)

Already a single command. See "Recorded run" in
`docs/OPENSHELL_AUTHORITY_ADAPTER.md` and `npm run test:openshell-acceptance`.
