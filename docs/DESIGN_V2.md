# atlasent-mcp-server v2 Design

> **Doctrine normalization header (2026-05-18).** This file is
> preserved unchanged below per Doctrine 4 of AtlaSent's versioning
> doctrine.
> The "v2" in this filename and body refers to the mcp-server's
> package-major config-schema migration (Supabase-direct → REST
> proxy), not a platform-version `v2`. Under the current doctrine
> there is no platform `v2`; the design described here ships on the
> stable `AtlaSent v1` contract via the package's own major bump
> (Doctrine 5 — per-package SemVer independent of the platform).
> Filename retained per Doctrine 4.

## Breaking Change

v2 removes all direct Supabase calls from tool implementations.
Every tool now proxies through `atlasent-api` REST endpoints.
This is a **major version bump** (v2 config schema).

## Config Schema Changes

```json
// v1 config (deprecated)
{
  "supabaseUrl": "https://xxx.supabase.co",
  "supabaseAnonKey": "eyJ..."
}

// v2 config
{
  "atlasEntApiUrl": "https://api.atlasent.io",
  "atlasEntApiKey": "ask_live_..."
}
```

## Tool Implementation Changes

| Tool | v1 | v2 |
|------|----|-----------|
| `evaluate_action` | Direct Supabase edge function call | `POST /v1-evaluate` |
| `get_audit_events` | `supabase.from('audit_events').select()` | `GET /v1/audit/events` |
| `create_policy` | `supabase.from('policies').insert()` | `POST /v1/policies` |
| `get_session` | `supabase.auth.getSession()` | `GET /v1/session` |
| `list_approvals` | `supabase.from('approvals').select()` | `GET /v1/approvals` |
| `resolve_approval` | `supabase.from('approvals').update()` | `POST /v1/approvals/:id/resolve` |

## Authentication

All tools use the configured API key (`atlasEntApiKey`) via `X-AtlaSent-Key` header.
No Supabase credentials are stored or transmitted.

## v1 → v2 Migration

Update your MCP server config file:

```json
// ~/.config/atlasent-mcp/config.json
{
  "atlasEntApiUrl": "https://api.atlasent.io",
  "atlasEntApiKey": "ask_live_YOUR_KEY"
}
```

Or via environment variables:
```bash
ATLASENT_API_URL=https://api.atlasent.io
ATLASENT_API_KEY=ask_live_YOUR_KEY
```
