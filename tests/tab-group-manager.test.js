import assert from "node:assert/strict";
import test from "node:test";

import { GROUP_TITLE, TAB_GROUP_ID_NONE } from "../core/constants.js";
import { TabGroupManager } from "../core/tab-group-manager.js";

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

function makeBrowserState() {
  const state = {
    nextTabId: 5,
    nextGroupId: 20,
    focusedWindowId: 1,
    focusedTabByWindow: new Map([[1, 1], [2, 3]]),
    windows: [
      { id: 1, type: "normal", state: "normal", focused: true },
      { id: 2, type: "normal", state: "minimized", focused: false }
    ],
    groups: [
      { id: 10, windowId: 2, title: GROUP_TITLE, color: "orange", collapsed: true },
      { id: 11, windowId: 1, title: GROUP_TITLE, color: "orange", collapsed: true }
    ],
    ungroupCalls: [],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: TAB_GROUP_ID_NONE, active: true, url: "https://work.example/" },
      { id: 2, windowId: 1, index: 1, groupId: TAB_GROUP_ID_NONE, active: false, url: "https://other.example/" },
      { id: 3, windowId: 2, index: 0, groupId: 10, active: true, url: "https://inbox.example/first" },
      { id: 4, windowId: 2, index: 1, groupId: 10, active: false, url: "https://inbox.example/second" }
    ]
  };

  function reindex(windowId) {
    state.tabs
      .filter((tab) => tab.windowId === windowId)
      .sort((left, right) => left.index - right.index)
      .forEach((tab, index) => { tab.index = index; });
  }

  const tabsApi = {
    async query(query = {}) {
      let result = [...state.tabs];
      if (query.windowId !== undefined) result = result.filter((tab) => tab.windowId === query.windowId);
      if (query.groupId !== undefined) result = result.filter((tab) => tab.groupId === query.groupId);
      if (query.active !== undefined) result = result.filter((tab) => tab.active === query.active);
      if (query.lastFocusedWindow) result = result.filter((tab) => tab.windowId === state.focusedWindowId && tab.active);
      return result;
    },
    async create(properties) {
      const windowId = properties.windowId ?? state.focusedWindowId;
      const tab = {
        id: state.nextTabId++,
        windowId,
        index: state.tabs.filter((candidate) => candidate.windowId === windowId).length,
        groupId: TAB_GROUP_ID_NONE,
        active: Boolean(properties.active),
        url: properties.url
      };
      state.tabs.push(tab);
      return tab;
    },
    async group(properties) {
      let groupId = properties.groupId;
      if (groupId === undefined) {
        groupId = state.nextGroupId++;
        const tab = state.tabs.find((candidate) => candidate.id === properties.tabIds[0]);
        state.groups.push({ id: groupId, windowId: tab.windowId, title: "", color: "grey", collapsed: false });
      }
      for (const tabId of [properties.tabIds].flat()) {
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        tab.groupId = groupId;
      }
      return groupId;
    },
    async update(tabId, properties) {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (properties.active) {
        for (const candidate of state.tabs.filter((item) => item.windowId === tab.windowId)) {
          candidate.active = false;
        }
        tab.active = true;
        state.focusedTabByWindow.set(tab.windowId, tab.id);
      }
      return tab;
    },
    async move(tabId, properties) {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      tab.windowId = properties.windowId;
      tab.index = state.tabs.filter((candidate) => candidate.windowId === properties.windowId && candidate.id !== tabId).length;
      reindex(properties.windowId);
      return tab;
    },
    async ungroup(tabIds) {
      state.ungroupCalls.push(tabIds);
      for (const tabId of [tabIds].flat()) {
        const tab = state.tabs.find((candidate) => candidate.id === tabId);
        tab.groupId = TAB_GROUP_ID_NONE;
      }
    },
    async remove(tabId) {
      const index = state.tabs.findIndex((candidate) => candidate.id === tabId);
      const [removed] = state.tabs.splice(index, 1);
      reindex(removed.windowId);
    }
  };

  const tabGroupsApi = {
    async query(query = {}) {
      return state.groups.filter((group) => query.title === undefined || group.title === query.title);
    },
    async update(groupId, properties) {
      const group = state.groups.find((candidate) => candidate.id === groupId);
      if (!group) return undefined;
      Object.assign(group, properties);
      return group;
    }
  };

  const windowsApi = {
    async getLastFocused() {
      return state.windows.find((window) => window.id === state.focusedWindowId);
    },
    async getAll() {
      return state.windows;
    },
    async get(windowId) {
      return state.windows.find((window) => window.id === windowId);
    },
    async update(windowId, properties) {
      const window = state.windows.find((candidate) => candidate.id === windowId);
      Object.assign(window, properties);
      if (properties.focused) {
        state.focusedWindowId = windowId;
        for (const candidate of state.windows) candidate.focused = candidate.id === windowId;
      }
      return window;
    }
  };

  return { state, tabsApi, tabGroupsApi, windowsApi };
}

test("prefers the last-focused window deterministically without merging same-name groups", async () => {
  const browser = makeBrowserState();
  const manager = new TabGroupManager({ ...browser, logger: makeLogger() });

  const groups = await manager.getCandidateGroups();

  assert.deepEqual(groups.map((group) => group.id), [11, 10]);
});

test("opens a group by restoring its window, expanding it, and activating the lowest-index tab", async () => {
  const browser = makeBrowserState();
  const manager = new TabGroupManager({ ...browser, logger: makeLogger() });

  const result = await manager.openGroup(browser.state.groups[0]);

  assert.equal(result.tab.id, 3);
  assert.equal(browser.state.groups[0].collapsed, false);
  assert.equal(browser.state.windows.find((window) => window.id === 2).focused, true);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 3).active, true);
});

test("moves a multi-tab current window tab to an existing Inbox and restores the original context", async () => {
  const browser = makeBrowserState();
  const manager = new TabGroupManager({ ...browser, logger: makeLogger() });

  const result = await manager.addCurrentTabToNamedGroup({
    tab: browser.state.tabs[0]
  });

  assert.equal(result.moved, true);
  assert.equal(result.cloned, false);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).windowId, 2);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).groupId, 10);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 2).active, true);
  assert.equal(browser.state.groups[0].collapsed, true);
});

test("uses the real ungroup signature and falls back to a copy after a cross-window grouping failure", async () => {
  const browser = makeBrowserState();
  const originalGroup = browser.tabsApi.group;
  let failOnce = true;
  browser.tabsApi.group = async (properties) => {
    if (failOnce && properties.groupId === 10 && properties.tabIds.includes(1)) {
      failOnce = false;
      throw new Error("simulated cross-window group failure");
    }
    return originalGroup(properties);
  };
  const manager = new TabGroupManager({ ...browser, logger: makeLogger() });

  const result = await manager.addCurrentTabToNamedGroup({
    tab: browser.state.tabs[0]
  });

  assert.equal(result.cloned, true);
  assert.deepEqual(browser.state.ungroupCalls, [[1]]);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).windowId, 1);
  assert.equal(browser.state.tabs.find((tab) => tab.id === result.tabId).groupId, 10);
});

test("restoring work context keeps a maximized source window maximized", async () => {
  const browser = makeBrowserState();
  browser.state.windows.find((window) => window.id === 1).state = "maximized";
  const manager = new TabGroupManager({ ...browser, logger: makeLogger() });

  await manager.activateOriginalContext({
    windowId: 1,
    movedTabId: 1,
    originalIndex: 0
  });

  assert.equal(browser.state.windows.find((window) => window.id === 1).state, "maximized");
});

test("opening restores only minimized windows and preserves maximized windows", async () => {
  const browser = makeBrowserState();
  const manager = new TabGroupManager({ ...browser, logger: makeLogger() });

  await manager.openGroup(browser.state.groups[0]);
  assert.equal(browser.state.windows.find((window) => window.id === 2).state, "normal");

  browser.state.windows.find((window) => window.id === 2).state = "maximized";
  browser.state.groups[0].collapsed = true;
  await manager.openGroup(browser.state.groups[0]);
  assert.equal(browser.state.windows.find((window) => window.id === 2).state, "maximized");
});
