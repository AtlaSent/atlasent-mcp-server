// RFC 8785 (JCS) canonical JSON for values that came out of JSON.parse: objects,
// arrays, strings, finite numbers, booleans and null. Keys are sorted by UTF-16 code
// units at every depth, which is what Array.prototype.sort does by default, and
// numbers and strings are serialized by JSON.stringify, which matches JCS for finite
// values. Anything JSON cannot represent throws: the caller fails closed.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  throw Error(`not representable as JSON: ${typeof value}`);
}
