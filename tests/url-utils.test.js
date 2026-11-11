import assert from "node:assert/strict";
import test from "node:test";

import { findExactUrlInTabs } from "../core/duplicate-detector.js";
import { isSupportedHttpUrl, normalizeHttpUrl, sameExactUrl } from "../core/url-utils.js";

test("accepts http(s) URLs while retaining query strings and fragments", () => {
  const result = normalizeHttpUrl("  https://example.com/read?item=42&mode=full#notes  ");

  assert.deepEqual(result, {
    valid: true,
    url: "https://example.com/read?item=42&mode=full#notes",
    reason: null
  });
  assert.equal(isSupportedHttpUrl("http://localhost:3000/test"), true);
});

test("exact duplicate comparison does not collapse meaningful URL components", () => {
  assert.equal(
    sameExactUrl("https://example.com/article?item=1", "https://example.com/article?item=1"),
    true
  );
  assert.equal(
    sameExactUrl("https://example.com/article?item=1", "https://example.com/article?item=2"),
    false
  );
  assert.equal(
    sameExactUrl("https://example.com/article#one", "https://example.com/article#two"),
    false
  );
});

test("duplicate detection also considers a tab URL that is still pending", () => {
  const pendingUrl = "https://example.com/loading?step=1#target";
  const match = findExactUrlInTabs([{ id: 9, url: "", pendingUrl }], pendingUrl);

  assert.equal(match?.id, 9);
});

test("pending navigation takes precedence over a tab's previous URL", () => {
  const previousUrl = "https://example.com/previous";
  const pendingUrl = "https://example.com/next";
  const tabs = [{ id: 10, url: previousUrl, pendingUrl }];

  assert.equal(findExactUrlInTabs(tabs, pendingUrl)?.id, 10);
  assert.equal(findExactUrlInTabs(tabs, previousUrl), null);
});

test("rejects restricted, malformed, and non-string inputs safely", () => {
  for (const value of [
    "chrome://settings",
    "chrome-extension://abcdef/page.html",
    "file:///tmp/page.html",
    "javascript:alert(1)",
    "data:text/html,hello",
    "not a URL",
    "",
    null,
    undefined
  ]) {
    assert.equal(isSupportedHttpUrl(value), false, `expected rejection: ${String(value)}`);
  }
});
