# atlasent-mcp-server — V1 Plan

**Role:** MCP (Model Context Protocol) server exposing AtlaSent's
authorization as agent tools. Drops into Claude Desktop, Cursor,
Windsurf, Zed, or any MCP-compatible client so an agent wrapper can
authorize its own tool calls.

**ICP this round:** biotech data scientist running a Claude Code /
Cursor agent against clinical data who needs every tool call to be
pre-authorized.

---

## V1 gates

- [ ] Published to npm as `@atlasent/mcp-server`, invokable via
      `npx @atlasent/mcp-server`.
- [ ] Exposes tools: `atlasent_evaluate`, `atlasent_verify_permit`,
      `atlasent_list_permits`, `atlasent_list_pending_approvals`,
      `atlasent_record_override` (internal break-glass).
- [ ] `ATLASENT_API_KEY` + `ATLASENT_ENV` configured via MCP
      environment block.
- [ ] Streams progress tokens for long-running evaluations.
- [ ] Uses `@atlasent/sdk` for all network calls. Zero raw `fetch`.
- [ ] Error messages expose `request_id` so customers can escalate.
- [ ] README has ready-to-paste JSON for Claude Desktop +
      `~/.cursor/mcp.json` + `~/.config/mcp/atlasent.json`.
- [ ] E2E test: run against a staging AtlaSent API via `@modelcontextprotocol/inspector`.
- [ ] Semver tag → npm publish via GitHub Actions + provenance.

## Out of scope

- Stateful conversation history (MCP server should be stateless;
  audit is server-side).
- Self-hosted HTTP transport (stdio only for V1).

## Risks

- **Secret handling.** API key in `env` is standard for MCP, but
  agents sometimes log their env — document the risk prominently
  and add a test that asserts the key isn't returned in any tool
  description or error.
- **Tool-use injection.** A malicious prompt could ask the agent to
  call `atlasent_evaluate` with benign inputs to launder a separate
  action. Document that evaluate is only a pre-authorization hint; the
  actual action still has to go through the real endpoint with a
  server-issued permit.
