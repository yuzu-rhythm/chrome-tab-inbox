import assert from "node:assert/strict";
import test from "node:test";
import { isExpiredTab, TabExpiryManager } from "../core/tab-expiry-manager.js";

const day = 24 * 60 * 60 * 1000;
const now = 30 * day;
const presets = [{ title: "研究", color: "blue" }, { title: "Later", color: "green" }];
const group = (title) => ({ id: 10, windowId: 1, title });
const tab = (lastAccessed, overrides = {}) => ({
  id: 1, groupId: 10, windowId: 1, lastAccessed,
  active: false, pinned: false, incognito: false, ...overrides
});

test("tmp expires at 24 hours and named groups at seven days per tab", () => {
  assert.equal(isExpiredTab(tab(now - day + 1), group("tmp"), presets, now), false);
  assert.equal(isExpiredTab(tab(now - day), group(" TMP "), presets, now), true);
  assert.equal(isExpiredTab(tab(now - 7 * day + 1), group("Work"), presets, now), false);
  assert.equal(isExpiredTab(tab(now - 7 * day), group("Work"), presets, now), true);
  assert.equal(isExpiredTab(tab(now - 14 * day), group(" later "), presets, now), false);
  assert.equal(isExpiredTab(tab(now - 14 * day), group("研究"), presets, now), false);
});

test("active, pinned, incognito, ungrouped and unknown timestamp tabs are excluded", () => {
  for (const overrides of [
    { active: true }, { pinned: true }, { incognito: true },
    { groupId: -1 }, { lastAccessed: undefined }, { lastAccessed: 0 },
    { lastAccessed: NaN }, { lastAccessed: now + 1 }
  ]) {
    assert.equal(isExpiredTab(tab(now - 14 * day, overrides), group("tmp"), presets, now), false);
  }
  assert.equal(isExpiredTab(tab(now - 14 * day), group(""), presets, now), false);
  assert.equal(isExpiredTab(tab(now - 14 * day), group("  "), presets, now), false);
});

test("a restored tab uses its last active wall-clock time across browser downtime", () => {
  const lastActive = now - day + 1;
  const restored = tab(lastActive);
  assert.equal(isExpiredTab(restored, group("tmp"), presets, now), false);
  assert.equal(isExpiredTab(restored, group("tmp"), presets, now + 1), true);
  assert.equal(isExpiredTab(tab(now - 8 * day, { active: true }), group("tmp"), presets, now), false);
});

test("scan rechecks current tab, group and preset state before closing", async () => {
  const groups = [group("tmp"), { id: 20, windowId: 1, title: "Old" }];
  const tabs = [
    tab(now - day, { id: 1 }),
    tab(now - day, { id: 2 }),
    tab(now - day, { id: 3 }),
    tab(now - 8 * day, { id: 4, groupId: 20 }),
    tab(now - 8 * day, { id: 5, groupId: 20 })
  ];
  const removed = [];
  const manager = new TabExpiryManager({
    tabsApi: {
      async query() { return tabs.map((item) => ({ ...item })); },
      async get(id) {
        const current = { ...tabs.find((item) => item.id === id) };
        if (id === 2) current.active = true;
        if (id === 3) current.groupId = 20;
        return current;
      },
      async remove(id) { removed.push(id); }
    },
    tabGroupsApi: {
      async query() { return groups.map((item) => ({ ...item })); },
      async get(id) {
        const current = { ...groups.find((item) => item.id === id) };
        if (id === 20) current.title = "Later";
        return current;
      }
    },
    settingsProvider: async () => ({ presetGroups: presets }),
    now: () => now,
    logger: { tab: { warning() {} } }
  });

  assert.deepEqual(await manager.scan(), { ok: true, closed: 1, failed: 0 });
  assert.deepEqual(removed, [1]);
});

test("a failed tab removal leaves other expired tabs eligible for cleanup", async () => {
  const removed = [];
  const manager = new TabExpiryManager({
    tabsApi: {
      async query() { return [tab(now - day, { id: 1 }), tab(now - day, { id: 2 })]; },
      async get(id) { return tab(now - day, { id }); },
      async remove(id) { if (id === 1) throw new Error("blocked"); removed.push(id); }
    },
    tabGroupsApi: {
      async query() { return [group("tmp")]; },
      async get() { return group("tmp"); }
    },
    settingsProvider: async () => ({ presetGroups: presets }),
    now: () => now,
    logger: { tab: { warning() {} } }
  });
  assert.deepEqual(await manager.scan(), { ok: false, closed: 1, failed: 1 });
  assert.deepEqual(removed, [2]);
});
