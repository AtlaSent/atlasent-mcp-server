/**
 * `atlasent-openshell run`: evaluate → (wait on HOLD) → verify → execute once,
 * in ONE process, around one command inside an NVIDIA OpenShell sandbox.
 *
 * One process on purpose: the adapter's sandbox/generation/digest checks hold
 * the evaluated permit in memory, and the runtime consumes the permit at verify
 * immediately before the command runs. A split evaluate-now / verify-later CLI
 * would need that state on disk, where the agent could edit it.
 *
 * Failure handling:
 *  - DENY, an unresolved HOLD, or a failed verify: the command never runs.
 *  - An OpenShell policy-generation change between evaluate and verify: the
 *    adapter evaluates afresh (bounded), never inherits.
 *  - The command was started but its outcome is unknown (killed by a signal,
 *    timed out): the permit is spent and the effect may or may not have
 *    happened. That is CROSS-064 condition E2. The run trips the local circuit
 *    breaker (if configured) and reports the trip to the runtime's
 *    /v1-agent-circuit-trips, which then refuses this agent's permits until a
 *    person resets it.
 *  - The command exited non-zero: the outcome IS known (it reported failure),
 *    so it is not a trip. Its exit code is passed through.
 */

import { spawn as nodeSpawn } from "node:child_process";

import type { CircuitTripRecord, CircuitTripReport } from "./engine.js";
import type { CircuitBreaker } from "./governedAction.js";
import {
  OpenShellAuthorityAdapter,
  envelopeDigest,
  parseActionEnvelope,
  parseSandboxContext,
  type AdapterResult,
  type CanonicalActionEnvelope,
} from "./openshell.js";

/** Exit codes (sysexits.h where one fits). The command's own code passes through otherwise. */
export const EXIT = {
  DENY: 77, // EX_NOPERM
  HOLD_UNRESOLVED: 75, // EX_TEMPFAIL
  USAGE: 64, // EX_USAGE
  INTERNAL: 70, // EX_SOFTWARE
  NOT_EXECUTED: 126, // command could not be started
  OUTCOME_UNKNOWN: 125,
} as const;

export interface RunResult {
  outcome: "EXECUTED" | "DENY" | "HOLD" | "NOT_EXECUTED" | "OUTCOME_UNKNOWN";
  exit_code: number;
  reasons: string[];
  decision?: AdapterResult;
  command_exit?: { code: number | null; signal: string | null; timed_out: boolean };
  trip?: { local: boolean; runtime: CircuitTripRecord | null };
  display?: { sandbox_id: string; sandbox_name?: string; workspace?: string };
}

export type SpawnOutcome =
  | { started: false; error: string }
  | { started: true; code: number | null; signal: string | null; timed_out: boolean };

export interface RunDeps {
  adapter: OpenShellAuthorityAdapter;
  /** Read the sandbox context NOW. Called before evaluate and again before verify. */
  sandbox: () => unknown;
  spawn?: (argv: string[], timeoutMs: number | undefined) => Promise<SpawnOutcome>;
  reportTrip?: (r: CircuitTripReport) => Promise<CircuitTripRecord>;
  breaker?: CircuitBreaker;
}

export interface RunOptions {
  envelope: unknown;
  argv: string[];
  /** How long to wait on an AtlaSent HOLD. 0 = do not wait. */
  wait_ms?: number;
  poll_interval_ms?: number;
  timeout_ms?: number;
  /** Re-evaluations allowed after a policy-generation change. Default 2. */
  max_reevaluations?: number;
}

export async function runGoverned(deps: RunDeps, opts: RunOptions): Promise<RunResult> {
  if (opts.argv.length === 0) {
    return { outcome: "NOT_EXECUTED", exit_code: EXIT.USAGE, reasons: ["no command given after --"] };
  }
  const env = parseActionEnvelope(opts.envelope);
  if (!env.ok) return { outcome: "DENY", exit_code: EXIT.DENY, reasons: [env.reason] };
  const envelope = env.envelope;

  const scopes = breakerScopes(envelope);
  const stop = deps.breaker?.check(scopes);
  if (stop) {
    return {
      outcome: "DENY",
      exit_code: EXIT.DENY,
      reasons: [`circuit breaker open (${stop.scope}: ${stop.reason}); a person must reset it`],
    };
  }

  const maxRe = opts.max_reevaluations ?? 2;
  let decision: AdapterResult | undefined;
  for (let round = 0; round <= maxRe; round++) {
    decision = await deps.adapter.evaluate(envelope, deps.sandbox());
    if (decision.outcome === "HOLD") {
      if (!decision.approval_request_id || !opts.wait_ms) {
        return { outcome: "HOLD", exit_code: EXIT.HOLD_UNRESOLVED, reasons: decision.reasons, decision, display: decision.display };
      }
      decision = await deps.adapter.resolveHold(decision.approval_request_id, deps.sandbox(), {
        max_wait_ms: opts.wait_ms,
        ...(opts.poll_interval_ms !== undefined && { poll_interval_ms: opts.poll_interval_ms }),
      });
      // resolveHold re-evaluates on a generation change; a fresh HOLD is unresolved.
      if (decision.outcome === "HOLD") {
        return { outcome: "HOLD", exit_code: EXIT.HOLD_UNRESOLVED, reasons: decision.reasons, decision, display: decision.display };
      }
    }
    if (decision.outcome === "DENY") {
      return { outcome: "DENY", exit_code: EXIT.DENY, reasons: decision.reasons, decision };
    }
    const v = await deps.adapter.verifyBeforeExecute(decision.permit_token, envelope, deps.sandbox(), {
      ...(decision.payload_hash !== undefined && { payload_hash: decision.payload_hash }),
    });
    if (!v.execute) {
      if (v.reevaluate && round < maxRe) continue;
      return { outcome: "DENY", exit_code: EXIT.DENY, reasons: v.reasons, decision };
    }
    // Permit consumed. Execute exactly once.
    const spawned = await (deps.spawn ?? defaultSpawn)(opts.argv, opts.timeout_ms);
    if (!spawned.started) {
      return {
        outcome: "NOT_EXECUTED",
        exit_code: EXIT.NOT_EXECUTED,
        reasons: [`command could not be started: ${spawned.error}`],
        decision,
        display: decision.display,
      };
    }
    const command_exit = { code: spawned.code, signal: spawned.signal, timed_out: spawned.timed_out };
    if (spawned.timed_out || spawned.signal !== null || spawned.code === null) {
      const why = spawned.timed_out
        ? `command timed out after ${opts.timeout_ms}ms`
        : `command ended by signal ${spawned.signal ?? "unknown"}`;
      const reason = `execution outcome unknown: ${why}`;
      const local = deps.breaker ? deps.breaker.trip(scopes, "execution_outcome_unknown", reason).length > 0 : false;
      let runtime: CircuitTripRecord | null = null;
      if (deps.reportTrip) {
        try {
          runtime = await deps.reportTrip({
            condition: "E2",
            reason,
            target: envelope.target_id ?? null,
            evidence: {
              action_type: envelope.action_type,
              action_digest: envelopeDigest(envelope),
              sandbox_id: decision.display.sandbox_id,
              ...command_exit,
            },
          });
        } catch (err) {
          runtime = { recorded: false, unsupported: false, reason: err instanceof Error ? err.message : String(err) };
        }
      }
      return {
        outcome: "OUTCOME_UNKNOWN",
        exit_code: EXIT.OUTCOME_UNKNOWN,
        reasons: [reason],
        decision,
        command_exit,
        trip: { local, runtime },
        display: decision.display,
      };
    }
    return {
      outcome: "EXECUTED",
      exit_code: spawned.code,
      reasons: spawned.code === 0 ? [] : [`command exited ${spawned.code}`],
      decision,
      command_exit,
      display: decision.display,
    };
  }
  return {
    outcome: "DENY",
    exit_code: EXIT.DENY,
    reasons: [`OpenShell policy generation kept changing; gave up after ${maxRe} re-evaluations`],
    ...(decision && { decision }),
  };
}

function breakerScopes(envelope: CanonicalActionEnvelope): string[] {
  const scopes = [`agent:${envelope.actor_id}`];
  if (envelope.target_id) scopes.push(`target:${envelope.target_id}`);
  return scopes;
}

function defaultSpawn(argv: string[], timeoutMs: number | undefined): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let timedOut = false;
    let child;
    try {
      child = nodeSpawn(argv[0], argv.slice(1), { stdio: "inherit" });
    } catch (err) {
      resolve({ started: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let spawned = false;
    child.once("spawn", () => {
      spawned = true;
    });
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs)
      : undefined;
    child.once("error", (err) => {
      if (timer) clearTimeout(timer);
      if (!spawned) resolve({ started: false, error: err.message });
    });
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ started: true, code, signal, timed_out: timedOut });
    });
  });
}

/**
 * Where the sandbox context comes from. Precedence: a JSON file (re-read on
 * every call, so a policy-generation change is seen between evaluate and
 * verify), then OPENSHELL_SANDBOX_* environment variables.
 *
 * TRUST: these values bind the permit, so they must come from OpenShell (the
 * supervisor / provider injection), never from the agent. A process inside the
 * sandbox that can rewrite them can claim another sandbox's identity; the
 * binding is only as strong as its source.
 */
export function sandboxContextFrom(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): () => unknown {
  return () => {
    const file = env.ATLASENT_OPENSHELL_SANDBOX_CONTEXT_FILE;
    if (file) {
      try {
        return JSON.parse(readFile(file));
      } catch {
        return undefined; // parseSandboxContext refuses it: no sandbox_id
      }
    }
    const ctx: Record<string, unknown> = {};
    if (env.OPENSHELL_SANDBOX_ID !== undefined) ctx.sandbox_id = env.OPENSHELL_SANDBOX_ID;
    if (env.OPENSHELL_SANDBOX_NAME !== undefined) ctx.sandbox_name = env.OPENSHELL_SANDBOX_NAME;
    if (env.OPENSHELL_WORKSPACE !== undefined) ctx.workspace = env.OPENSHELL_WORKSPACE;
    if (env.OPENSHELL_POLICY_GENERATION !== undefined) ctx.policy_generation = env.OPENSHELL_POLICY_GENERATION;
    return ctx;
  };
}

/** Re-exported for the CLI's preflight. */
export { parseSandboxContext };
