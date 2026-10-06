# atlasent-workload-guard

OpenShell supervisor middleware that stops an agent in one sandbox from
claiming to be another when it asks AtlaSent for authorization.

OpenShell runs it on every request a sandbox sends to the AtlaSent API, before
OpenShell injects the AtlaSent key. The guard reads the calling sandbox from
OpenShell's gateway-signed token, which the agent cannot forge, and:

- **denies** an evaluate or verify whose workload names a different sandbox
  (`workload_mismatch`) or none (`workload_missing`), and any path the
  AtlaSent provider profile does not list;
- **attests** an allowed evaluate or verify. It writes
  `x-atlasent-workload-attestation`, an Ed25519 JWS valid for 60 s that binds
  the sandbox to the exact body. For an API key flagged
  `requires_workload_attestation`, the AtlaSent runtime refuses any request
  without one.

Every failure denies. With `on_error: fail_closed` (OpenShell's default), a
guard that is down blocks the traffic too.

Design: [`docs/OPENSHELL_WORKLOAD_IDENTITY_DESIGN.md`](../../docs/OPENSHELL_WORKLOAD_IDENTITY_DESIGN.md).
Decision record: atlasent-docs CROSS-066. Runtime side: atlasent-api
`docs/runbooks/OPENSHELL_WORKLOAD_ATTESTATION.md`.

Requires Node.js 20 or later and OpenShell 0.1.3-pre.4 or later. Not
published to npm. Run it from this folder (`npm ci`).

## Setup

1. **Gateway verification key.** Copy the gateway's `/.well-known/jwks.json`
   to the guard host. On a local install, build it from
   `<state>/tls/jwt/public.pem` and `kid`. The guard never fetches keys at
   runtime. The issuer is `openshell-gateway:<gateway_id>` (default
   `openshell`).

2. **TLS.** With `gateway_jwt` configured, OpenShell only calls middleware
   over HTTPS. Issue a certificate for the name the gateway and supervisors
   use, such as `host.openshell.internal`.

3. **Attestation key (optional, needed for phase 2).**

   ```
   openssl genpkey -algorithm ed25519 -out attest.pem
   ```

   Register its public key with AtlaSent (see the atlasent-api runbook)
   before flagging any API key.

4. **Config** (`guard.json`):

   ```json
   {
     "listen": "0.0.0.0:50061",
     "audience": "urn:atlasent:openshell:workload-guard",
     "gateway": { "issuer": "openshell-gateway:openshell", "jwks_path": "/etc/atlasent/jwks.json" },
     "tls": { "cert_path": "/etc/atlasent/guard.pem", "key_path": "/etc/atlasent/guard.key" },
     "attestation": { "signing_key_path": "/etc/atlasent/attest.pem", "kid": "guard-1" }
   }
   ```

   ```
   node cli.mjs --config guard.json
   ```

5. **Register it with the gateway** and restart the gateway:

   ```toml
   [[openshell.supervisor.middleware]]
   name = "atlasent-workload-guard"
   grpc_endpoint = "https://host.openshell.internal:50061"
   tls_ca_cert_path = "/etc/openshell/atlasent-guard-ca.pem"
   audience = "urn:atlasent:openshell:workload-guard"
   max_payload_bytes = 262144
   timeout = "2s"
   ```

   `openshell gateway info` should list
   `atlasent/openshell-workload-guard (protocol 1.0)`.

6. **Attach it in the sandbox policy** to the AtlaSent API host. A policy
   given with `--policy` replaces the default one, so keep its
   `filesystem_policy` and `landlock` sections.

   ```yaml
   network_middlewares:
     atlasent-workload-guard:
       middleware: atlasent-workload-guard
       on_error: fail_closed
       endpoints:
         include: ["api.atlasent.io"]
   ```

The guard takes no per-policy configuration. `ValidateConfig` refuses any, so
a policy author cannot loosen it.

## Tests

```
npm test
```

These are unit and gRPC tests. Each check has a negative control, and each
core check was shown to fail when disabled.

The live test was run on OpenShell 0.1.3-pre.4 on 2026-10-06. The results are
in the design doc. They covered:

- a forged sandbox ID: denied before it reached upstream;
- the honest request: let through, with a valid attestation over the bytes
  upstream received;
- a header the agent set itself: overwritten;
- the guard stopped: OpenShell returned `middleware_failed`.

## License

Apache-2.0. `proto/` is vendored from NVIDIA OpenShell (Apache-2.0). See
NOTICE.
