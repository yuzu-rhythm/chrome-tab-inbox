const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validate a web URL without removing meaningful URL components.
 * Trimming surrounding whitespace is the only string normalization performed;
 * query strings, fragments, paths, and casing are otherwise retained.
 */
export function normalizeHttpUrl(value) {
  if (typeof value !== "string") {
    return { valid: false, url: null, reason: "URLが文字列ではありません" };
  }

  const candidate = value.trim();
  if (candidate.length === 0) {
    return { valid: false, url: null, reason: "URLが空です" };
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, url: null, reason: "URLの形式が正しくありません" };
  }

  if (!HTTP_PROTOCOLS.has(parsed.protocol) || parsed.hostname.length === 0) {
    return {
      valid: false,
      url: null,
      reason: "http または https のページだけを扱えます"
    };
  }

  return { valid: true, url: candidate, reason: null };
}

export function isSupportedHttpUrl(value) {
  return normalizeHttpUrl(value).valid;
}

export function sameExactUrl(left, right) {
  const leftResult = normalizeHttpUrl(left);
  const rightResult = normalizeHttpUrl(right);
  return leftResult.valid && rightResult.valid && leftResult.url === rightResult.url;
}
