// Redaction for the action preview sent to the approver. Two passes: structured keys
// whose names say "secret" lose their values, then known secret shapes are replaced in
// every string. A final check re-scans the output and THROWS if any shape survived, so
// a redaction bug turns into "send nothing and deny", never into a leaked secret.

const SECRET_KEY = /(pass(word|wd|phrase)?|secret|token|api[_-]?key|authorization|credential|private[_-]?key|session[_-]?key|cookie)/i;
export const MASK = '[REDACTED]';

// Each pattern's first group, when present, is kept (a label such as "Bearer " or
// "PGPASSWORD="); the rest of the match is masked.
const PATTERNS = [
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /(\bBasic\s+)[A-Za-z0-9+/=]{8,}/g,
  /()\bask_(?:live|test)_[A-Za-z0-9_-]{6,}/g,
  /()\bsk-[A-Za-z0-9_-]{16,}/g,
  /()\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /()\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /()\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /()\bAKIA[0-9A-Z]{16}\b/g,
  /()\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/g,
  /(\b[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|[^\s;&|]+)/g,
  /(--(?:password|passwd|token|secret|api-key|apikey)(?:=|\s+))("[^"]*"|'[^']*'|[^\s]+)/gi,
  /((?:^|\s)-p)(?!\s)([^\s]+)/g,
];

function redactString(s) {
  let out = s;
  for (const re of PATTERNS) out = out.replace(re, (m, keep = '') => keep + MASK);
  return out;
}

function redactValue(v, depth = 0) {
  if (depth > 64) throw Error('input nested too deeply to redact');
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(x => redactValue(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) && x !== null && typeof x !== 'object' ? MASK : redactValue(x, depth + 1);
    return out;
  }
  return v;
}

// Returns a redacted, size-capped JSON string. Throws on any failure, including a
// secret shape that survived redaction.
// Throws if any known secret shape appears in `text` unmasked.
export function assertNoSecrets(text) {
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const keep = m[1] ?? '';
      if (m[0] !== keep + MASK && !m[0].slice(keep.length).startsWith(MASK)) throw Error('redaction left a secret-shaped value in the preview');
    }
  }
}

export function redactedPreview(action, maxBytes = 2048) {
  const text = JSON.stringify(redactValue(action));
  assertNoSecrets(text);
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  // Cut on a character boundary, then mark the truncation.
  return buf.subarray(0, maxBytes).toString('utf8').replace(/�$/, '') + '…[truncated]';
}
