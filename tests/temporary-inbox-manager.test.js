import assert from "node:assert/strict";
import test from "node:test";

import {
  TemporaryInboxManager,
  isTemporaryInboxCandidate
} from "../core/temporary-inbox-manager.js";

function makeLogger() {
  const scope = () => ({ info() {}, warning() {}, error() {} });
  return {
    inbox: scope(),
    readingList: scope(),
    group: scope(),
    tab: scope(),
    queue: scope(),
    error() {}
  };
}

function settings(overrides = {}) {
  return {
    tmpEnabled: true,
    tmpCaptureNewTabs: true,
    tmpCaptureStartup: true,
    ...overrides
  };
}

test("temporary Inbox eligibility accepts web and New Tab pages only", () => {
  const base = { id: 1, windowId: 2, pinned: false, incognito: false };
  assert.equal(isTemporaryInboxCandidate({ ...base, url: "https://example.com/" }), true);
  assert.equal(isTemporaryInboxCandidate({ ...base, pendingUrl: "http://example.com/" }), true);
  assert.equal(isTemporaryInboxCandidate({ ...base, url: "chrome://newtab/" }), true);
  assert.equal(isTemporaryInboxCandidate({ ...base, url: "about:blank" }), true);
  assert.equal(isTemporaryInboxCandidate({ ...base, url: "" }), false);
  assert.equal(isTemporaryInboxCandidate({ ...base, url: "chrome://extensions/" }), false);
  assert.equal(isTemporaryInboxCandidate({ ...base, url: "chrome-extension://abc/options.html" }), false);
  assert.equal(isTemporaryInboxCandidate({ ...base, url: "file:///tmp/private.txt" }), false);
  assert.equal(isTemporaryInboxCandidate({ ...base, url: "https://example.com/", pinned: true }), false);
  assert.equal(isTemporaryInboxCandidate({ ...base, url: "https://example.com/", incognito: true }), false);
});

test("captures an eligible new tab with the fixed tmp title and grey color", async () => {
  const calls = [];
  const tab = { id: 7, windowId: 3, url: "https://example.com/" };
  const manager = new TemporaryInboxManager({
    tabsApi: { async query() { return []; } },
    settingsProvider: async () => settings(),
    groupManager: {
      async getTab(tabId) {
        assert.equal(tabId, tab.id);
        return tab;
      },
      async ensureTemporaryGroupForTab(input) {
        calls.push(input);
        return { ok: true, skipped: false, ...input };
      }
    },
    logger: makeLogger()
  });

  const result = await manager.captureTab(tab, { source: "new-tab" });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    tabId: 7,
    title: "tmp",
    color: "grey",
    source: "new-tab"
  }]);
});

test("does not capture when disabled or when the tab is ineligible", async () => {
  let grouped = 0;
  const groupManager = {
    async getTab(tabId) {
      return { id: tabId, windowId: 1, url: "chrome://settings/" };
    },
    async ensureTemporaryGroupForTab() {
      grouped += 1;
      return { ok: true };
    }
  };
  const disabled = new TemporaryInboxManager({
    settingsProvider: async () => settings({ tmpCaptureNewTabs: false }),
    groupManager,
    logger: makeLogger()
  });
  const enabled = new TemporaryInboxManager({
    settingsProvider: async () => settings(),
    groupManager,
    logger: makeLogger()
  });

  assert.equal((await disabled.captureTab(1, { source: "new-tab" })).disabled, true);
  assert.equal((await enabled.captureTab(1, { source: "new-tab" })).ineligible, true);
  assert.equal(grouped, 0);
});

test("startup captures only eligible active tabs and reports the summary", async () => {
  const tabs = [
    { id: 1, windowId: 10, active: true, url: "https://one.example/" },
    { id: 2, windowId: 20, active: true, url: "chrome://settings/" },
    { id: 3, windowId: 30, active: true, url: "https://pinned.example/", pinned: true }
  ];
  const grouped = [];
  const manager = new TemporaryInboxManager({
    tabsApi: {
      async query(query) {
        assert.deepEqual(query, { active: true });
        return tabs;
      }
    },
    settingsProvider: async () => settings(),
    groupManager: {
      async getTab(tabId) {
        return tabs.find((tab) => tab.id === tabId);
      },
      async ensureTemporaryGroupForTab(input) {
        grouped.push(input.tabId);
        return { ok: true, skipped: false };
      }
    },
    logger: makeLogger()
  });

  const result = await manager.captureStartupTabs();

  assert.deepEqual(grouped, [1]);
  assert.deepEqual(result, { ok: true, captured: 1, skipped: 2, failed: 0 });
});
