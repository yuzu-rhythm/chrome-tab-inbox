import assert from "node:assert/strict";
import test from "node:test";

import { InboxManager } from "../core/inbox-manager.js";

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

class FakeStorage {
  constructor(data = {}) {
    this.data = { ...data };
    this.getCalls = [];
  }

  async get(keys) {
    this.getCalls.push(keys);
    if (keys === null || keys === undefined) {
      return { ...this.data };
    }
    if (Array.isArray(keys)) {
      return Object.fromEntries(
        keys.filter((key) => Object.prototype.hasOwnProperty.call(this.data, key))
          .map((key) => [key, this.data[key]])
      );
    }
    if (typeof keys === "string") {
      return Object.prototype.hasOwnProperty.call(this.data, keys)
        ? { [keys]: this.data[keys] }
        : {};
    }
    return Object.fromEntries(
      Object.entries(keys).map(([key, defaultValue]) => [
        key,
        Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : defaultValue
      ])
    );
  }

  async set(values) {
    Object.assign(this.data, values);
  }
}

function makeGroupManager({ duplicate = null, failGrouping = false } = {}) {
  const calls = [];
  const manager = {
    calls,
    async addUrlToNamedGroup({ url, title, color }) {
      calls.push(["add-url", url, title, color]);
      if (failGrouping) {
        throw new Error("group failed");
      }
      if (duplicate) {
        return {
          duplicate: true,
          groupId: duplicate.group.id,
          windowId: duplicate.group.windowId,
          tabId: duplicate.tab.id
        };
      }
      return {
        duplicate: false,
        groupId: 7,
        windowId: 1,
        tabId: 11
      };
    }
  };
  return manager;
}

function makeSource({ acknowledge = async () => {} } = {}) {
  return {
    name: "chrome-reading-list",
    acknowledged: 0,
    async acknowledge(item) {
      this.acknowledged += 1;
      return acknowledge(item);
    }
  };
}

function makeManager({ groupManager, source, badgeManager = { async update() { return 1; } } }) {
  return new InboxManager({
    storageArea: new FakeStorage({
      bridgeEnabledAt: 1,
      readingListEnabled: true,
      removeAfterImport: true,
      lastSyncAt: null
    }),
    readingListSource: source,
    groupManager,
    badgeManager,
    logger: makeLogger()
  });
}

test("persists first-run bridge timestamp and default settings", async () => {
  const storage = new FakeStorage();
  const manager = new InboxManager({
    storageArea: storage,
    groupManager: makeGroupManager(),
    badgeManager: { async update() { return 0; } },
    logger: makeLogger()
  });

  const settings = await manager.ensureSettings();

  assert.equal(typeof settings.bridgeEnabledAt, "number");
  assert.equal(settings.readingListEnabled, true);
  assert.equal(settings.removeAfterImport, true);
  assert.equal(storage.data.readingListEnabled, true);
  assert.equal(storage.data.removeAfterImport, true);
  assert.equal(storage.data.lastSyncAt, null);
  assert.equal(storage.data.tmpEnabled, true);
  assert.equal(storage.data.tmpCaptureNewTabs, true);
  assert.equal(storage.data.tmpCaptureStartup, true);
  assert.deepEqual(storage.data.presetGroups, [
    { id: "unfinished", title: "まだやっていない", color: "orange" }
  ]);
  assert.deepEqual(storage.getCalls[0], [
    "bridgeEnabledAt",
    "readingListEnabled",
    "removeAfterImport",
    "lastSyncAt",
    "tmpEnabled",
    "tmpCaptureNewTabs",
    "tmpCaptureStartup",
    "presetGroups"
  ]);
});

test("stores ordered preset groups and TMP capture settings", async () => {
  const storage = new FakeStorage({
    bridgeEnabledAt: 1,
    readingListEnabled: true,
    removeAfterImport: true,
    lastSyncAt: null
  });
  const manager = new InboxManager({
    storageArea: storage,
    groupManager: makeGroupManager(),
    badgeManager: { async update() { return 0; } },
    logger: makeLogger()
  });

  const settings = await manager.updateSettings({
    tmpEnabled: true,
    tmpCaptureNewTabs: false,
    tmpCaptureStartup: true,
    presetGroups: [
      { id: "research", title: "研究", color: "blue" },
      { id: "buy", title: "買うもの", color: "green" }
    ]
  });

  assert.equal(settings.tmpCaptureNewTabs, false);
  assert.equal(settings.tmpCaptureStartup, true);
  assert.deepEqual(settings.presetGroups, [
    { id: "research", title: "研究", color: "blue" },
    { id: "buy", title: "買うもの", color: "green" }
  ]);
  assert.deepEqual(storage.data.presetGroups, settings.presetGroups);
});

test("rejects duplicate, reserved, and over-limit preset definitions", async () => {
  const storage = new FakeStorage();
  const manager = new InboxManager({
    storageArea: storage,
    groupManager: makeGroupManager(),
    badgeManager: { async update() { return 0; } },
    logger: makeLogger()
  });

  await assert.rejects(
    manager.updateSettings({
      presetGroups: [
        { id: "a", title: "Work", color: "blue" },
        { id: "b", title: " work ", color: "green" }
      ]
    }),
    /重複/
  );
  await assert.rejects(
    manager.updateSettings({
      presetGroups: [{ id: "tmp", title: " TMP ", color: "grey" }]
    }),
    /予約名/
  );
  await assert.rejects(
    manager.updateSettings({
      presetGroups: Array.from({ length: 10 }, (_, index) => ({
        id: `preset-${index}`,
        title: `Group ${index}`,
        color: "blue"
      }))
    }),
    /9件まで/
  );
});

test("preserves bridgeEnabledAt and user settings across worker restarts", async () => {
  const storage = new FakeStorage({
    bridgeEnabledAt: 123456,
    readingListEnabled: false,
    removeAfterImport: false,
    lastSyncAt: 654321
  });
  const manager = new InboxManager({
    storageArea: storage,
    groupManager: makeGroupManager(),
    badgeManager: { async update() { return 0; } },
    logger: makeLogger()
  });

  const settings = await manager.ensureSettings();

  assert.deepEqual(settings, storage.data);
  assert.equal(settings.bridgeEnabledAt, 123456);
  assert.equal(settings.readingListEnabled, false);
  assert.equal(settings.removeAfterImport, false);
});

const item = {
  id: "https://example.com/work?step=1",
  url: "https://example.com/work?step=1",
  title: "Work",
  createdAt: 2,
  source: "chrome-reading-list"
};

test("acknowledges only after the named-group route and badge succeed", async () => {
  const groupManager = makeGroupManager();
  const source = makeSource();
  const manager = makeManager({ groupManager, source });

  const result = await manager.importItem(item);

  assert.equal(result.ok, true);
  assert.equal(result.transferred, true);
  assert.equal(result.acknowledged, true);
  assert.equal(source.acknowledged, 1);
  assert.deepEqual(groupManager.calls, [
    ["add-url", item.url, "まだやっていない", "orange"]
  ]);
});

test("keeps the source item when grouping fails", async () => {
  const groupManager = makeGroupManager({ failGrouping: true });
  const source = makeSource();
  const manager = makeManager({ groupManager, source });

  const result = await manager.importItem(item);

  assert.equal(result.ok, false);
  assert.equal(result.transferred, false);
  assert.equal(source.acknowledged, 0);
  assert.deepEqual(groupManager.calls, [
    ["add-url", item.url, "まだやっていない", "orange"]
  ]);
});

test("treats an exact duplicate in any Inbox group as a successful transfer without creating a tab", async () => {
  const duplicate = { group: { id: 99, windowId: 4 }, tab: { id: 88, url: item.url } };
  const groupManager = makeGroupManager({ duplicate });
  const source = makeSource();
  const manager = makeManager({ groupManager, source });

  const result = await manager.importItem(item);

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.acknowledged, true);
  assert.equal(source.acknowledged, 1);
  assert.equal(groupManager.calls.length, 1);
});

test("retains a Reading List item when acknowledgement itself fails", async () => {
  const groupManager = makeGroupManager();
  const source = makeSource({ acknowledge: async () => { throw new Error("remove failed"); } });
  const manager = makeManager({ groupManager, source });

  const result = await manager.importItem(item);

  assert.equal(result.ok, true);
  assert.equal(result.transferred, true);
  assert.equal(result.acknowledged, false);
  assert.equal(result.acknowledgementFailed, true);
  assert.equal(result.retained, true);
});

test("reports a partial scan when acknowledgement fails without hiding the retained item", async () => {
  const groupManager = makeGroupManager();
  const source = makeSource({ acknowledge: async () => { throw new Error("remove failed"); } });
  source.listPending = async () => ({ items: [item], skipped: [], scanned: 1 });
  const manager = makeManager({ groupManager, source });

  const summary = await manager.scanReadingList({ reason: "test" });

  assert.equal(summary.ok, true);
  assert.equal(summary.partial, true);
  assert.equal(summary.imported, 1);
  assert.equal(summary.acknowledgementFailed, 1);
  assert.equal(summary.retained, 1);
});

test("does not acknowledge when post-group badge confirmation fails", async () => {
  const groupManager = makeGroupManager();
  const source = makeSource();
  const manager = makeManager({
    groupManager,
    source,
    badgeManager: { async update() { return null; } }
  });

  const result = await manager.importItem(item);

  assert.equal(result.ok, false);
  assert.equal(result.transferred, true);
  assert.equal(result.acknowledged, undefined);
  assert.equal(source.acknowledged, 0);
});

test("invalid InboxItems fail before any tab or acknowledgement operation", async () => {
  const groupManager = makeGroupManager();
  const source = makeSource();
  const manager = makeManager({ groupManager, source });

  const result = await manager.importItem({ ...item, url: "chrome://settings" });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(source.acknowledged, 0);
  assert.deepEqual(groupManager.calls, []);
});
