// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

const ADDRESS_KEYS = /url|referrer/i;
const KEEP_QUERY = /^(utm_|ref$)/;
const SCRUB_ORIGIN = "https://www.extension.dev";
const REPOSITORY_REF = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@/;
const DEPTH = 4;

/* @invariant
 * THIS IS THE ONE EMITTER IN THE ESTATE THAT CANNOT IMPORT THE SHARED SEAM,
 * AND THE REASON IS THE PACKAGE BOUNDARY, NOT A PREFERENCE.
 *
 * Every other emitter builds its sanitizer from `@extensiondev/analytics-scrub`
 * so that a tenth private copy of the walk cannot drift out of step with the
 * nine it was copied from. That package is `"private": true` and UNLICENSED.
 * This package is PUBLISHED under Apache-2.0 and builds with plain `tsc` and no
 * bundler, so a runtime import of the seam would ship a manifest naming a
 * dependency that does not exist on the registry, and every `npm i
 * @extension.dev/mcp` would fail. Adding the seam as a devDependency does not
 * help either: it would put an unresolvable name in a published manifest.
 *
 * So the walk is reimplemented here, deliberately, with the SAME TWO PASSES IN
 * THE SAME ORDER: the name-keyed query scrub first, because it is the only pass
 * that can read a query string as a query string, then the value mask, because
 * it is the only pass that reaches an address carried under a name no key test
 * matches. Getting that order backwards is silent, the output still looks
 * scrubbed, which is why the seam made it one function and why this copy does
 * too.
 *
 * DRIFT IS CLOSED BY MEASUREMENT RATHER THAN BY THE IMPORT. The monorepo drives
 * this function and the seam's over one corpus and fails if their outputs ever
 * differ, which is a stronger statement than "it imports the right module":
 * an import proves provenance, the corpus proves BEHAVIOUR. If the seam is ever
 * published, delete this file and import it; the corpus test is what makes that
 * swap provably a no-op.
 *
 * WHAT IT CANNOT DO, stated because a net described as a boundary is how a leak
 * ships behind a green test. It sees a property's name and its value. A foreign
 * identifier already welded into a compound string before it arrived is caught
 * here only if it matches the repository shape below. The real close is that
 * the emitter does not build such a string; this catches the day one is built
 * somewhere else.
 */
export function maskRepositoryRef(value: string): string {
  if (!REPOSITORY_REF.test(value)) return value;
  return `[owner]/[repo]@${value.slice(value.indexOf("@") + 1)}`;
}

function scrubUrlProperty(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  let parsed: URL;
  try {
    parsed = new URL(value, SCRUB_ORIGIN);
  } catch {
    return value;
  }
  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (KEEP_QUERY.test(key)) continue;
    parsed.searchParams.delete(key);
    changed = true;
  }
  if (!changed) return value;
  return value.startsWith("/")
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : parsed.toString();
}

function maskDeep(value: unknown, remaining: number): unknown {
  if (typeof value === "string") return maskRepositoryRef(value);
  if (remaining <= 0 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => maskDeep(item, remaining - 1));
  }
  const masked: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    masked[key] = maskDeep(nested, remaining - 1);
  }
  return masked;
}

export type ScrubbableProperties = Record<
  string,
  string | number | boolean | null
>;

export function sanitizeMcpProperties<T extends ScrubbableProperties>(
  properties: T,
): T {
  const sanitized: Record<string, unknown> = { ...properties };
  for (const [key, value] of Object.entries(sanitized)) {
    if (!ADDRESS_KEYS.test(key)) continue;
    sanitized[key] = scrubUrlProperty(value);
  }
  for (const [key, value] of Object.entries(sanitized)) {
    sanitized[key] = maskDeep(value, DEPTH);
  }
  /* @invariant Both passes are value-preserving on this lane's property type:
   * the query scrub and the repository mask each map a string to a string and
   * leave every other scalar untouched, so neither can broaden the shape. */
  return sanitized as T;
}
