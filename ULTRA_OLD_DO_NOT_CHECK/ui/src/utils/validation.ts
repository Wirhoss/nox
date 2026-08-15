/*
 * Field validation and label helpers shared by the resource editors.
 *
 * Blueprints and providers are both saved under a caller-chosen id and both
 * reject the same characters, because that id becomes a path segment in the
 * REST routes. Keeping the rule in one place stops the two editors from
 * drifting apart on what they accept.
 */

/** Ids are path segments, so only characters that survive a URL unescaped. */
const RESOURCE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function isValidResourceId(value: string): boolean {
  return RESOURCE_ID_PATTERN.test(value);
}

/** True only for an absolute URL; the relative forms `URL` rejects are invalid. */
function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Turns a wire enum (`openai_completions`) into a label (`Openai Completions`). */
function prettyType(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** The host of a base URL, falling back to the raw value while it is half-typed. */
function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export {
  hostLabel,
  isValidResourceId,
  isValidUrl,
  prettyType,
  RESOURCE_ID_PATTERN,
};
