/**
 * V2 Wave A endpoint clients.
 *
 * Wraps three new atlasent-api endpoints landed in Wave A:
 *   - POST /v1/evaluate/batch    (atlasent-api #742, flag v2_batch)
 *   - POST /v1/evaluate/stream   (atlasent-api #745, flag v2_streaming)
 *   - POST /v1/graphql           (atlasent-api #746, flag v2_graphql)
 *
 * Auth is read from the same env vars as the existing remote engine
 * (`ATLASENT_API_KEY`, `ATLASENT_BASE_URL`, optional `ATLASENT_ANON_KEY`)
 * — no new auth surface is introduced.
 *
 * Closed-by-default discipline: every endpoint is gated by a tenant
 * flag at the API. A 404 means "feature not enabled for this tenant" —
 * we surface that as a typed `FeatureNotEnabledError` so the caller
 * can produce an MCP error result rather than a silent fallback.
 */

import { VERSION } from "./version.js";
import { functionRegionHeaders } from "./functionRegion.js";

const REQUEST_TIMEOUT_MS = 10_000;
const STREAM_TIMEOUT_MS = 60_000;

export type TenantFlag = "v2_batch" | "v2_streaming" | "v2_graphql";

export class FeatureNotEnabledError extends Error {
  readonly kind = "feature_not_enabled" as const;
  readonly flag: TenantFlag;
  constructor(flag: TenantFlag, message?: string) {
    super(message ?? `Feature not enabled for this tenant: ${flag}`);
    this.name = "FeatureNotEnabledError";
    this.flag = flag;
  }
}

export class V2HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `AtlaSent V2 API ${status}`);
    this.name = "V2HttpError";
    this.status = status;
    this.body = body;
  }
}

function makeAbortSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(handle) };
}

function baseUrl(): string {
  return (process.env.ATLASENT_BASE_URL ?? "https://api.atlasent.io").replace(
    /\/+$/,
    "",
  );
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `@atlasent/mcp-server/${VERSION}`,
  };
  const key = process.env.ATLASENT_API_KEY;
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const anon = process.env.ATLASENT_ANON_KEY;
  if (anon) headers["x-anon-key"] = anon;
  Object.assign(headers, functionRegionHeaders(baseUrl()));
  if (extra) Object.assign(headers, extra);
  return headers;
}

function handleStatus(flag: TenantFlag, status: number, body: string): never {
  if (status === 404) throw new FeatureNotEnabledError(flag);
  if (status === 401) {
    throw new V2HttpError(
      status,
      body,
      "Authentication failed — check your ATLASENT_API_KEY",
    );
  }
  if (status === 403) {
    throw new V2HttpError(
      status,
      body,
      "Permission denied — your key lacks the required scope",
    );
  }
  if (status === 429) {
    throw new V2HttpError(status, body, "Rate limited — back off and retry");
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const msg = (parsed.message ?? parsed.error ?? body) as string;
    throw new V2HttpError(status, body, `AtlaSent V2 API ${status}: ${msg}`);
  } catch (e) {
    if (e instanceof V2HttpError) throw e;
    throw new V2HttpError(status, body, `AtlaSent V2 API ${status}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// POST /v1/evaluate/batch — atlasent-api #742 (V2-D3)
// ---------------------------------------------------------------------------

export interface BatchEvaluateItem {
  action: string;
  agent: string;
  context?: Record<string, unknown>;
}

export interface BatchEvaluateRequest {
  items: BatchEvaluateItem[];
  batch_id?: string;
}

export interface BatchEvaluateResponse {
  batch_id: string;
  items: unknown[];
  partial: boolean;
}

const MAX_BATCH_ITEMS = 100;
const MAX_BATCH_BYTES = 1_000_000;

export async function evaluateBatch(
  req: BatchEvaluateRequest,
): Promise<BatchEvaluateResponse> {
  if (!Array.isArray(req.items) || req.items.length === 0) {
    throw new Error("items must be a non-empty array");
  }
  if (req.items.length > MAX_BATCH_ITEMS) {
    throw new Error(`items length ${req.items.length} exceeds max ${MAX_BATCH_ITEMS}`);
  }
  const body: Record<string, unknown> = { items: req.items };
  if (req.batch_id !== undefined) body.batch_id = req.batch_id;
  const serialized = JSON.stringify(body);
  if (serialized.length > MAX_BATCH_BYTES) {
    throw new Error(`request body ${serialized.length} bytes exceeds max ${MAX_BATCH_BYTES}`);
  }

  const { signal, cancel } = makeAbortSignal(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}/v1/evaluate/batch`, {
      method: "POST",
      headers: buildHeaders(),
      body: serialized,
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      handleStatus("v2_batch", res.status, text);
    }
    return (await res.json()) as BatchEvaluateResponse;
  } finally {
    cancel();
  }
}

// ---------------------------------------------------------------------------
// POST /v1/evaluate/stream — atlasent-api #745 (V2-D4)
// Buffers the SSE stream and returns the same shape as batch once `complete`
// arrives. Per-item RPC errors are surfaced as `error` frames in the items
// array; the stream itself does not abort on per-item failure.
// ---------------------------------------------------------------------------

export interface StreamEvaluateRequest {
  items: BatchEvaluateItem[];
  batch_id?: string;
}

export interface StreamEvaluateResponse {
  batch_id: string;
  items: unknown[];
  partial: boolean;
}

export async function evaluateStream(
  req: StreamEvaluateRequest,
): Promise<StreamEvaluateResponse> {
  if (!Array.isArray(req.items) || req.items.length === 0) {
    throw new Error("items must be a non-empty array");
  }
  if (req.items.length > MAX_BATCH_ITEMS) {
    throw new Error(`items length ${req.items.length} exceeds max ${MAX_BATCH_ITEMS}`);
  }
  const body: Record<string, unknown> = { items: req.items };
  if (req.batch_id !== undefined) body.batch_id = req.batch_id;

  const { signal, cancel } = makeAbortSignal(STREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}/v1/evaluate/stream`, {
      method: "POST",
      headers: buildHeaders({ Accept: "text/event-stream" }),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      handleStatus("v2_streaming", res.status, text);
    }
    if (!res.body) {
      throw new V2HttpError(res.status, "", "Stream response had no body");
    }
    return await consumeSseStream(res, req.batch_id);
  } finally {
    cancel();
  }
}

interface SseEvent {
  event: string;
  data: string;
}

/**
 * Minimal SSE parser. Reads the response body line-by-line, accumulates
 * `event:` + `data:` fields, and yields one event per blank-line boundary.
 *
 * Frames the stream into:
 *   - event: decision   → push parsed JSON onto the items array (in order)
 *   - event: error      → push the error frame as-is (per-item RPC failure)
 *   - event: complete   → terminal frame, return the accumulated batch
 */
async function consumeSseStream(
  res: Response,
  requestedBatchId?: string,
): Promise<StreamEvaluateResponse> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const items: unknown[] = [];
  let batchId: string | undefined = requestedBatchId;
  let partial = false;
  let completed = false;

  const handleEvent = (ev: SseEvent): boolean => {
    if (!ev.event && !ev.data) return false;
    let parsed: unknown;
    if (ev.data) {
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        parsed = { raw: ev.data };
      }
    }
    if (ev.event === "decision") {
      items.push(parsed ?? null);
      return false;
    }
    if (ev.event === "error") {
      // Per-item RPC failure — stream continues.
      items.push({ error: parsed ?? "stream item error" });
      partial = true;
      return false;
    }
    if (ev.event === "complete") {
      const data = (parsed as Record<string, unknown> | undefined) ?? {};
      if (typeof data.batch_id === "string") batchId = data.batch_id;
      if (typeof data.partial === "boolean") partial = partial || data.partial;
      return true;
    }
    return false;
  };

  const flushFrame = (frame: string): boolean => {
    const lines = frame.split(/\r?\n/);
    const ev: SseEvent = { event: "", data: "" };
    const dataLines: string[] = [];
    for (const raw of lines) {
      if (raw.length === 0) continue;
      if (raw.startsWith(":")) continue;
      const idx = raw.indexOf(":");
      const field = idx === -1 ? raw : raw.slice(0, idx);
      let value = idx === -1 ? "" : raw.slice(idx + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") ev.event = value;
      else if (field === "data") dataLines.push(value);
    }
    ev.data = dataLines.join("\n");
    return handleEvent(ev);
  };

  while (!completed) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = findFrameBoundary(buffer)) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^(\r?\n){1,2}/, "");
      if (flushFrame(frame)) {
        completed = true;
        break;
      }
    }
  }
  if (!completed && buffer.trim().length > 0) {
    flushFrame(buffer);
  }

  return {
    batch_id: batchId ?? "",
    items,
    partial,
  };
}

function findFrameBoundary(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

// ---------------------------------------------------------------------------
// POST /v1/graphql — atlasent-api #746 (V2-D2 + V2-D8)
// ---------------------------------------------------------------------------

export interface GraphqlRequest {
  query: string;
  variables?: Record<string, unknown>;
}

export interface GraphqlResponse {
  data?: unknown;
  errors?: unknown[];
}

const MAX_GRAPHQL_BYTES = 1_000_000;

export async function graphqlQuery(req: GraphqlRequest): Promise<GraphqlResponse> {
  if (typeof req.query !== "string" || req.query.length === 0) {
    throw new Error("query must be a non-empty string");
  }
  const body: Record<string, unknown> = { query: req.query };
  if (req.variables !== undefined) body.variables = req.variables;
  const serialized = JSON.stringify(body);
  if (serialized.length > MAX_GRAPHQL_BYTES) {
    throw new Error(
      `request body ${serialized.length} bytes exceeds max ${MAX_GRAPHQL_BYTES}`,
    );
  }

  const { signal, cancel } = makeAbortSignal(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}/v1/graphql`, {
      method: "POST",
      headers: buildHeaders(),
      body: serialized,
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      handleStatus("v2_graphql", res.status, text);
    }
    return (await res.json()) as GraphqlResponse;
  } finally {
    cancel();
  }
}
