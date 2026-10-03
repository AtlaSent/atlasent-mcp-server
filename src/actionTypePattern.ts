/**
 * The one action_type pattern every tool in this server validates against.
 *
 * Mirrors atlasent-api `supabase/functions/v1-evaluate/handler.ts`
 * (`ACTION_TYPE_RE`, the "P0 #3" canonical-format check): lowercase
 * dot-separated segments, at least two, each starting with a letter and
 * otherwise `[a-z0-9_]`. The runtime answers 400 `invalid_action_type` for
 * anything else, so rejecting it here refuses nothing the runtime would
 * accept. The runtime's only pre-check rewrite is the Deploy Gate legacy-alias
 * map (`_shared/canonical-action.ts`), and every alias in it already matches
 * this pattern.
 *
 * Replaces `/^[A-Za-z0-9_.\.-:]+$/`, whose `.-:` was a character RANGE
 * (0x2E-0x3A) and so also admitted `/`, while letting through uppercase,
 * hyphens, colons, undotted and leading-dot values the runtime rejects.
 */
export const ACTION_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export const ACTION_TYPE_PATTERN_MESSAGE =
  "action_type must be canonical lowercase dot-notation <domain>.<verb>[.<sub>...] " +
  "(segments start with a-z and contain only a-z, 0-9, _), e.g. production.deploy";

export function isValidActionType(value: string): boolean {
  return ACTION_TYPE_PATTERN.test(value);
}
