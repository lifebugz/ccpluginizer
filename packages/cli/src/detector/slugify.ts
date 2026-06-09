// Deterministic naming and ordering helpers.
//
// Every emitted entry name must match `/^[a-z0-9][a-z0-9-]*$/` (marketplaceEntry
// schema) and be unique across the emitted set (enforced here, not by the schema).

const SLUG_FALLBACK = "group";

/**
 * Locale-independent code-unit comparison. localeCompare's ICU collation differs
 * across machines/locales (it ignores '-' at primary strength), which would make
 * emitted ordering — and thus scan output — vary between environments.
 */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumerics → single hyphen
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return slug === "" ? SLUG_FALLBACK : slug;
}

/**
 * Strip the longest hyphen-delimited token prefix common to ALL keys.
 * Only strips at a token boundary, never partway through a token, and never if
 * doing so would empty a key. Single-key inputs are returned unchanged.
 */
export function stripCommonPrefix(keys: readonly string[]): string[] {
  if (keys.length <= 1) {
    return [...keys];
  }
  let prefix = keys[0] ?? "";
  for (const k of keys.slice(1)) {
    while (prefix !== "" && !k.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
    if (prefix === "") {
      return [...keys];
    }
  }
  const lastHyphen = prefix.lastIndexOf("-");
  if (lastHyphen === -1) {
    return [...keys];
  }
  const cut = lastHyphen + 1;
  const stripped = keys.map((k) => k.slice(cut));
  if (stripped.some((s) => s === "")) {
    return [...keys];
  }
  return stripped;
}

/** First of `desired`, `desired-2`, `desired-3`, … not present in `used`. */
export function uniqueWithin(used: ReadonlySet<string>, desired: string): string {
  if (!used.has(desired)) {
    return desired;
  }
  let n = 2;
  while (used.has(`${desired}-${String(n)}`)) {
    n++;
  }
  return `${desired}-${String(n)}`;
}

/** Deterministically disambiguate duplicate slugs by appending `-2`, `-3`, … */
export function uniqueSlugs(slugs: readonly string[]): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  for (const s of slugs) {
    const candidate = uniqueWithin(used, s);
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}
