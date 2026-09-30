// Signs an identity_assertion.v1 with the STAGING-ONLY D2 test issuer key, using the
// runtime's own canonical.ts so the signed bytes match the verifier exactly.
const API = Deno.env.get("ATLASENT_API_DIR") ?? "../atlasent-api";
const { canonicalize } = await import(new URL(`${API}/supabase/functions/_shared/canonical.ts`, `file://${Deno.cwd()}/`).href);
const S = JSON.parse(await Deno.readTextFile(Deno.env.get("D2_SECRETS") ?? ""));
const unsigned = JSON.parse(await new Response(Deno.stdin.readable).text());
const der = Uint8Array.from(atob(S.issuer_private_pkcs8_b64), (c) => c.charCodeAt(0));
const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(canonicalize(unsigned))));
const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
console.log(JSON.stringify({ ...unsigned, signature: hex }));
