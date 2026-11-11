import assert from "node:assert/strict";
import test from "node:test";

import {
  groupTitleKey,
  groupTitlesEqual,
  normalizeGroupTitle
} from "../core/group-title.js";

test("group titles trim display text and compare case-insensitively", () => {
  assert.equal(normalizeGroupTitle("  Research  "), "Research");
  assert.equal(groupTitleKey("Research"), "research");
  assert.equal(groupTitleKey(" research "), "research");
  assert.equal(groupTitleKey("RESEARCH"), "research");
  assert.equal(groupTitleKey("  TMP  "), "tmp");
  assert.equal(groupTitleKey("   "), "");
  assert.equal(groupTitlesEqual("Work", " work "), true);
  assert.equal(groupTitlesEqual("", "   "), false);
});
