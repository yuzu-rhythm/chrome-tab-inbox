import assert from "node:assert/strict";
import test from "node:test";

import {
  GROUP_COLOR,
  GROUP_TITLE,
  TAB_GROUP_ID_NONE,
  TMP_GROUP_COLOR,
  TMP_GROUP_TITLE
} from "../core/constants.js";
import { InboxManager } from "../core/inbox-manager.js";
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

function makeBrowser({
  windows = [],
  groups = [],
  tabs = [],
  focusedWindowId = windows.find((window) => window.focused)?.id ?? windows[0]?.id ?? null
} = {}) {
  const state = {
    windows: windows.map((window) => ({ type: "normal", state: "normal", focused: false, ...window })),
    groups: groups.map((group) => ({ collapsed: true, ...group })),
    tabs: tabs.map((tab) => ({ active: false, groupId: TAB_GROUP_ID_NONE, ...tab })),
    focusedWindowId,
    nextWindowId: Math.max(0, ...windows.map((window) => window.id ?? 0)) + 1,
    nextTabId: Math.max(0, ...tabs.map((tab) => tab.id ?? 0)) + 1,
    nextGroupId: Math.max(0, ...groups.map((group) => group.id ?? 0)) + 1,
    calls: [],
    failMove: null,
    failGroup: null
  };

  for (const window of state.windows) {
    window.focused = window.id === state.focusedWindowId;
  }

  function reindex(windowId) {
    state.tabs
      .filter((tab) => tab.windowId === windowId)
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .forEach((tab, index) => { tab.index = index; });
  }

  function findTab(tabId) {
    return state.tabs.find((tab) => tab.id === tabId);
  }

  function findGroup(groupId) {
    return state.groups.find((group) => group.id === groupId);
  }

  function pruneEmptyGroups() {
    state.groups = state.groups.filter((group) =>
      state.tabs.some((tab) => tab.groupId === group.id)
    );
  }

  const tabsApi = {
    async query(query = {}) {
      state.calls.push(["query", { ...query }]);
      let result = [...state.tabs];
      if (query.windowId !== undefined) {
        result = result.filter((tab) => tab.windowId === query.windowId);
      }
      if (query.groupId !== undefined) {
        result = result.filter((tab) => tab.groupId === query.groupId);
      }
      if (query.active !== undefined) {
        result = result.filter((tab) => tab.active === query.active);
      }
      if (query.lastFocusedWindow) {
        result = result.filter((tab) => tab.windowId === state.focusedWindowId && tab.active);
      }
      return result;
    },
    async get(tabId) {
      state.calls.push(["get", tabId]);
      return findTab(tabId);
    },
    async create(properties) {
      state.calls.push(["create", { ...properties }]);
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
    async move(tabIds, properties) {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      state.calls.push(["move", [...ids], { ...properties }]);
      for (const tabId of ids) {
        if (typeof state.failMove === "function" && state.failMove(tabId, properties)) {
          throw new Error("simulated tab move failure");
        }
        const tab = findTab(tabId);
        if (!tab) throw new Error("tab missing");
        tab.windowId = properties.windowId;
        tab.groupId = TAB_GROUP_ID_NONE;
        tab.index = properties.index === -1
          ? state.tabs.filter((candidate) => candidate.windowId === properties.windowId).length
          : properties.index;
        reindex(properties.windowId);
      }
      pruneEmptyGroups();
      return ids.map((tabId) => findTab(tabId));
    },
    async group(properties) {
      state.calls.push(["group", JSON.parse(JSON.stringify(properties))]);
      if (typeof state.failGroup === "function" && state.failGroup(properties)) {
        throw new Error("simulated tab group failure");
      }
      const ids = [...properties.tabIds];
      const members = ids.map(findTab);
      if (members.some((tab) => !tab)) throw new Error("tab missing");
      const windowId = members[0].windowId;
      if (members.some((tab) => tab.windowId !== windowId)) {
        throw new Error("tabs from different windows");
      }
      let groupId = properties.groupId;
      if (groupId === undefined) {
        groupId = state.nextGroupId++;
        state.groups.push({
          id: groupId,
          windowId,
          title: "",
          color: "grey",
          collapsed: false
        });
      }
      const group = findGroup(groupId);
      if (!group) throw new Error("group missing");
      for (const tab of members) tab.groupId = groupId;
      pruneEmptyGroups();
      return groupId;
    },
    async ungroup(tabIds) {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      state.calls.push(["ungroup", [...ids]]);
      for (const tabId of ids) {
        const tab = findTab(tabId);
        if (tab) tab.groupId = TAB_GROUP_ID_NONE;
      }
      pruneEmptyGroups();
    },
    async update(tabId, properties) {
      state.calls.push(["update-tab", tabId, { ...properties }]);
      const tab = findTab(tabId);
      if (!tab) return undefined;
      if (properties.active) {
        for (const candidate of state.tabs) {
          if (candidate.windowId === tab.windowId) candidate.active = false;
        }
        tab.active = true;
      }
      return tab;
    },
    async remove(tabId) {
      state.calls.push(["remove", tabId]);
      const index = state.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) throw new Error("tab missing");
      const [removed] = state.tabs.splice(index, 1);
      reindex(removed.windowId);
      pruneEmptyGroups();
    }
  };

  const tabGroupsApi = {
    async query(query = {}) {
      state.calls.push(["group-query", { ...query }]);
      return state.groups.filter((group) =>
        query.title === undefined || group.title === query.title
      );
    },
    async update(groupId, properties) {
      state.calls.push(["group-update", groupId, { ...properties }]);
      const group = findGroup(groupId);
      if (!group) return undefined;
      Object.assign(group, properties);
      return group;
    }
  };

  const windowsApi = {
    async getLastFocused() {
      state.calls.push(["last-focused"]);
      return state.windows.find((window) => window.id === state.focusedWindowId);
    },
    async getAll() {
      state.calls.push(["windows-all"]);
      return state.windows;
    },
    async get(windowId) {
      state.calls.push(["window-get", windowId]);
      return state.windows.find((window) => window.id === windowId);
    },
    async update(windowId, properties) {
      state.calls.push(["window-update", windowId, { ...properties }]);
      const window = state.windows.find((candidate) => candidate.id === windowId);
      if (!window) return undefined;
      Object.assign(window, properties);
      if (properties.focused) {
        state.focusedWindowId = windowId;
        for (const candidate of state.windows) candidate.focused = candidate.id === windowId;
      }
      return window;
    },
    async create(properties) {
      state.calls.push(["window-create", { ...properties }]);
      const window = {
        id: state.nextWindowId++,
        type: properties.type ?? "normal",
        state: "normal",
        focused: Boolean(properties.focused)
      };
      state.windows.push(window);
      let tab;
      if (properties.tabId !== undefined) {
        tab = findTab(properties.tabId);
        if (!tab) throw new Error("seed tab missing");
        tab.windowId = window.id;
        tab.groupId = TAB_GROUP_ID_NONE;
        tab.index = 0;
        reindex(window.id);
        pruneEmptyGroups();
      } else {
        tab = {
          id: state.nextTabId++,
          windowId: window.id,
          index: 0,
          groupId: TAB_GROUP_ID_NONE,
          active: true,
          url: properties.url ?? "chrome://newtab/"
        };
        state.tabs.push(tab);
      }
      if (window.focused) {
        state.focusedWindowId = window.id;
        for (const candidate of state.windows) candidate.focused = candidate.id === window.id;
      }
      return { ...window, tabs: [{ ...tab }] };
    },
    async remove(windowId) {
      state.calls.push(["window-remove", windowId]);
      const windowIndex = state.windows.findIndex((window) => window.id === windowId);
      if (windowIndex < 0) throw new Error("window missing");
      state.windows.splice(windowIndex, 1);
      state.tabs = state.tabs.filter((tab) => tab.windowId !== windowId);
      pruneEmptyGroups();
    }
  };

  return { state, tabsApi, tabGroupsApi, windowsApi };
}

function makeManager(browser) {
  return new TabGroupManager({ ...browser, logger: makeLogger() });
}

function makeInboxManager(groupManager, {
  badgeManager = { async update() { return 1; } },
  readingListSource = null
} = {}) {
  return new InboxManager({
    storageArea: {
      async get() {
        return {
          bridgeEnabledAt: 1,
          readingListEnabled: true,
          removeAfterImport: true,
          lastSyncAt: null
        };
      },
      async set() {}
    },
    readingListSource,
    groupManager,
    badgeManager,
    logger: makeLogger()
  });
}

test("reuses a clean dedicated window for a named URL", async () => {
  const browser = makeBrowser({
    windows: [
      { id: 1, focused: true },
      { id: 2 }
    ],
    groups: [
      { id: 10, windowId: 2, title: "Later", color: "blue" }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, url: "https://work.example/" },
      { id: 2, windowId: 2, index: 0, groupId: 10, url: "https://later.example/" }
    ]
  });
  const manager = makeManager(browser);

  const result = await manager.addUrlToNamedGroup({
    url: "https://later.example/new",
    title: "Later",
    color: "blue"
  });

  assert.equal(result.created, true);
  assert.equal(result.windowId, 2);
  assert.equal(browser.state.windows.length, 2);
  assert.equal(browser.state.tabs.find((tab) => tab.id === result.tabId).windowId, 2);
  assert.equal(browser.state.tabs.filter((tab) => tab.windowId === 2).every((tab) => tab.groupId === 10), true);
  assert.equal(browser.state.groups.find((group) => group.id === 10).collapsed, true);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).windowId, 1);
});

test("creates a clean window from a mixed group window and leaves unrelated tabs in place", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }],
    groups: [{ id: 10, windowId: 1, title: "Later", color: "blue" }],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, active: true, url: "https://later.example/one" },
      { id: 2, windowId: 1, index: 1, url: "https://work.example/" }
    ]
  });
  const manager = makeManager(browser);

  const result = await manager.addUrlToNamedGroup({
    url: "https://later.example/two",
    title: "Later",
    color: "blue"
  });

  assert.equal(result.created, true);
  assert.equal(result.windowId, 2);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 2).windowId, 1);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 2).groupId, TAB_GROUP_ID_NONE);
  assert.equal(browser.state.tabs.filter((tab) => tab.windowId === 2).every((tab) => tab.groupId === result.groupId), true);
  assert.equal(browser.state.groups.filter((group) => group.title === "Later").length, 1);
});

test("isolates only the preferred same-title group and leaves every other group untouched", async () => {
  const browser = makeBrowser({
    windows: [
      { id: 1, focused: true },
      { id: 2 }
    ],
    groups: [
      { id: 10, windowId: 1, title: "Later", color: "blue" },
      { id: 11, windowId: 2, title: "Later", color: "blue" },
      { id: 20, windowId: 1, title: "Other", color: "red" }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, url: "https://later.example/one" },
      { id: 2, windowId: 1, index: 1, groupId: 20, url: "https://other.example/one" },
      { id: 3, windowId: 2, index: 0, groupId: 11, url: "https://later.example/two" }
    ]
  });
  const manager = makeManager(browser);

  const result = await manager.prepareNamedGroup({ title: "Later", color: "blue" });

  assert.equal(result.windowId, 3);
  assert.equal(result.matchingGroupCount, 2);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).windowId, 3);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 2).windowId, 1);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 2).groupId, 20);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 3).windowId, 2);
  assert.equal(browser.state.tabs.filter((tab) => tab.windowId === 3).every((tab) => tab.groupId === result.groupId), true);
  assert.equal(browser.state.groups.filter((group) => group.title === "Later").length, 2);
});

test("one-tab source is cloned and multi-tab source is moved with work context restored", async () => {
  const oneTabBrowser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: [{ id: 10, windowId: 2, title: "Later", color: "blue" }],
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, url: "https://one.example/" },
      { id: 2, windowId: 2, index: 0, groupId: 10, url: "https://later.example/" }
    ]
  });
  const oneTabResult = await makeManager(oneTabBrowser).addCurrentTabToNamedGroup({
    tab: oneTabBrowser.state.tabs.find((tab) => tab.id === 1),
    title: "Later",
    color: "blue"
  });
  assert.equal(oneTabResult.cloned, true);
  assert.equal(oneTabBrowser.state.tabs.find((tab) => tab.id === 1).windowId, 1);
  assert.equal(oneTabBrowser.state.tabs.filter((tab) => tab.windowId === 2).length, 2);

  const multiTabBrowser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: [{ id: 10, windowId: 2, title: "Later", color: "blue" }],
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, url: "https://multi.example/" },
      { id: 3, windowId: 1, index: 1, url: "https://work.example/" },
      { id: 2, windowId: 2, index: 0, groupId: 10, url: "https://later.example/" }
    ]
  });
  const multiTabResult = await makeManager(multiTabBrowser).addCurrentTabToNamedGroup({
    tab: multiTabBrowser.state.tabs.find((tab) => tab.id === 1),
    title: "Later",
    color: "blue"
  });
  assert.equal(multiTabResult.moved, true);
  assert.equal(multiTabBrowser.state.tabs.find((tab) => tab.id === 1).windowId, 2);
  assert.equal(multiTabBrowser.state.tabs.find((tab) => tab.id === 3).active, true);
  assert.equal(multiTabBrowser.state.focusedWindowId, 1);
});

test("selected-title duplicates are not duplicated, while the same URL in another title is allowed", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: [
      { id: 10, windowId: 2, title: "Later", color: "blue" },
      { id: 20, windowId: 2, title: "Other", color: "red" }
    ],
    tabs: [
      { id: 1, windowId: 2, index: 0, groupId: 10, url: "https://same.example/?a=1#x" },
      { id: 2, windowId: 2, index: 1, groupId: 20, url: "https://same.example/?a=1#x" }
    ]
  });
  const manager = makeManager(browser);

  const duplicate = await manager.addUrlToNamedGroup({
    url: "https://same.example/?a=1#x",
    title: "Later",
    color: "blue"
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(browser.state.tabs.length, 2);

  const newTitle = await manager.addUrlToNamedGroup({
    url: "https://same.example/?a=1#x",
    title: "New title",
    color: "green"
  });
  assert.equal(newTitle.duplicate, false);
  assert.equal(browser.state.tabs.length, 3);
  assert.equal(browser.state.groups.find((group) => group.id === newTitle.groupId).title, "New title");
});

test("URL import failure removes only its own created tab", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: [{ id: 10, windowId: 2, title: "Later", color: "blue" }],
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, url: "https://work.example/" },
      { id: 2, windowId: 2, index: 0, groupId: 10, url: "https://later.example/" },
      { id: 3, windowId: 1, index: 1, url: "https://unrelated.example/" }
    ]
  });
  browser.state.failGroup = (properties) => properties.groupId === 10 && properties.tabIds.includes(4);
  const manager = makeManager(browser);

  await assert.rejects(
    manager.addUrlToNamedGroup({
      url: "https://later.example/fails",
      title: "Later",
      color: "blue"
    }),
    /simulated tab group failure/
  );
  assert.equal(browser.state.tabs.some((tab) => tab.id === 4), false);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 2).windowId, 2);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 3).windowId, 1);
});

test("an unconfirmed new dedicated window is cleaned without touching existing tabs", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }],
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, url: "https://work.example/" },
      { id: 2, windowId: 1, index: 1, url: "https://unrelated.example/" }
    ]
  });
  const createWindow = browser.windowsApi.create;
  browser.windowsApi.create = async (properties) => {
    const created = await createWindow(properties);
    browser.state.tabs = browser.state.tabs.filter((tab) => tab.windowId !== created.id);
    return { ...created, tabs: [] };
  };

  await assert.rejects(
    makeManager(browser).addUrlToNamedGroup({
      url: "https://later.example/unconfirmed",
      title: "Later",
      color: "blue"
    }),
    /could not be confirmed/
  );

  assert.deepEqual(browser.state.windows.map((window) => window.id), [1]);
  assert.deepEqual(browser.state.tabs.map((tab) => tab.id).sort(), [1, 2]);
  assert.equal(browser.state.calls.some(([kind, windowId]) =>
    kind === "window-remove" && windowId === 2
  ), true);
});

test("failed dedicated-window preparation restores the preferred group and leaves all others untouched", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: [
      { id: 10, windowId: 1, title: "Later", color: "blue" },
      { id: 11, windowId: 2, title: "Later", color: "blue" },
      { id: 20, windowId: 2, title: "Other", color: "red" }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, url: "https://later.example/one" },
      { id: 2, windowId: 1, index: 1, url: "https://unrelated.example/" },
      { id: 3, windowId: 2, index: 0, groupId: 11, url: "https://later.example/two" },
      { id: 4, windowId: 2, index: 1, groupId: 20, url: "https://other.example/" }
    ]
  });
  let failOnce = true;
  browser.state.failGroup = (properties) => {
    if (failOnce && properties.groupId === undefined && properties.tabIds.includes(1)) {
      failOnce = false;
      return true;
    }
    return false;
  };

  await assert.rejects(
    makeManager(browser).prepareNamedGroup({ title: "Later", color: "blue" }),
    (error) => {
      assert.match(error.message, /original tabs were restored/);
      assert.equal(error.rollbackSucceeded, true);
      return true;
    }
  );

  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).windowId, 1);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 3).windowId, 2);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 2).windowId, 1);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 2).groupId, TAB_GROUP_ID_NONE);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 4).windowId, 2);
  assert.equal(browser.state.groups.find(
    (group) => group.id === browser.state.tabs.find((tab) => tab.id === 4).groupId
  ).title, "Other");
  for (const tabId of [1, 3]) {
    const tab = browser.state.tabs.find((candidate) => candidate.id === tabId);
    const group = browser.state.groups.find((candidate) => candidate.id === tab.groupId);
    assert.equal(group?.title, "Later");
  }
});

test("cross-window fallback recreates a vanished original group with its exact metadata", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: [
      { id: 10, windowId: 2, title: "Later", color: "blue", collapsed: true },
      { id: 30, windowId: 1, title: "Work", color: "purple", collapsed: false }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 30, active: true, url: "https://selected.example/" },
      { id: 2, windowId: 1, index: 1, url: "https://work.example/" },
      { id: 3, windowId: 2, index: 0, groupId: 10, url: "https://later.example/" }
    ]
  });
  let failOnce = true;
  browser.state.failGroup = (properties) => {
    if (failOnce && properties.groupId === 10 && properties.tabIds.includes(1)) {
      failOnce = false;
      return true;
    }
    return false;
  };

  const result = await makeManager(browser).addCurrentTabToNamedGroup({
    tab: browser.state.tabs.find((tab) => tab.id === 1),
    title: "Later",
    color: "blue"
  });

  const originalTab = browser.state.tabs.find((tab) => tab.id === 1);
  const restoredGroup = browser.state.groups.find((group) => group.id === originalTab.groupId);
  assert.equal(result.cloned, true);
  assert.equal(originalTab.windowId, 1);
  assert.equal(originalTab.active, true);
  assert.equal(browser.state.focusedWindowId, 1);
  assert.deepEqual(
    {
      title: restoredGroup?.title,
      color: restoredGroup?.color,
      collapsed: restoredGroup?.collapsed
    },
    { title: "Work", color: "purple", collapsed: false }
  );
  assert.equal(browser.state.tabs.find((tab) => tab.id === result.tabId).groupId, 10);
});

test("openNamedGroup restores minimized state, focuses, expands, and selects the lowest index", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2, state: "minimized" }],
    groups: [{ id: 10, windowId: 2, title: "Later", color: "blue", collapsed: true }],
    tabs: [
      { id: 1, windowId: 2, index: 1, groupId: 10, url: "https://later.example/second" },
      { id: 2, windowId: 2, index: 0, groupId: 10, url: "https://later.example/first" }
    ]
  });
  const result = await makeManager(browser).openNamedGroup({ title: "Later", color: "blue" });

  assert.equal(result.tab.id, 2);
  assert.equal(browser.state.windows.find((window) => window.id === 2).state, "normal");
  assert.equal(browser.state.windows.find((window) => window.id === 2).focused, true);
  assert.equal(browser.state.groups.find((group) => group.id === 10).collapsed, false);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 2).active, true);
});

test("named group summaries aggregate normalized titles without page data", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1 }, { id: 2 }],
    groups: [
      { id: 10, windowId: 1, title: "Later", color: "blue" },
      { id: 11, windowId: 2, title: "Later", color: "red" },
      { id: 20, windowId: 2, title: "Other", color: "red" },
      { id: 30, windowId: 2, title: "Empty", color: "green" }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, title: "secret", url: "https://one.example/" },
      { id: 2, windowId: 2, index: 0, groupId: 11, title: "secret2", url: "https://two.example/" },
      { id: 3, windowId: 2, index: 1, groupId: 20, title: "secret3", url: "https://three.example/" }
    ]
  });
  const summaries = await makeManager(browser).listNamedGroupSummaries();

  assert.deepEqual(summaries, [
    {
      title: "Later",
      color: "blue",
      tabCount: 2,
      groupCount: 2,
      windowCount: 2
    },
    {
      title: "Other",
      color: "red",
      tabCount: 1,
      groupCount: 1,
      windowCount: 1
    }
  ]);
  assert.equal(JSON.stringify(summaries).includes("https://"), false);
  assert.equal(JSON.stringify(summaries).includes("secret"), false);

  const preferredSummaries = await makeManager(browser).listNamedGroupSummaries(2);
  assert.equal(
    preferredSummaries.find((summary) => summary.title === "Later").color,
    "red"
  );
});

test("picker-safe tabId assignment does not query or assign the picker tab", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }, { id: 3 }],
    groups: [{ id: 10, windowId: 2, title: "Later", color: "blue" }],
    tabs: [
      { id: 1, windowId: 1, index: 0, url: "https://selected.example/" },
      { id: 2, windowId: 1, index: 1, url: "https://work.example/" },
      { id: 10, windowId: 2, index: 0, groupId: 10, url: "https://later.example/" },
      { id: 99, windowId: 3, index: 0, active: true, url: "chrome-extension://picker/" }
    ]
  });
  const tabManager = makeManager(browser);
  const inboxManager = makeInboxManager(tabManager);

  const result = await inboxManager.assignTabToGroup({
    tabId: 1,
    title: "Later",
    color: "blue"
  });

  assert.equal(result.ok, true);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).windowId, 2);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 99).windowId, 3);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 99).groupId, TAB_GROUP_ID_NONE);
  assert.equal(browser.state.calls.some(([kind, query]) =>
    kind === "query" && (query.active !== undefined || query.lastFocusedWindow)
  ), false);
  assert.equal(browser.state.calls.some(([kind, tabId]) =>
    kind === "get" && tabId === 99
  ), false);
});

test("the generalized Reading List path acknowledges only after routing and badge confirmation", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }],
    tabs: [{ id: 1, windowId: 1, index: 0, active: true, url: "https://work.example/" }]
  });
  const events = [];
  const tabManager = makeManager(browser);
  const addUrlToNamedGroup = tabManager.addUrlToNamedGroup.bind(tabManager);
  tabManager.addUrlToNamedGroup = async (options) => {
    events.push("route-start");
    const result = await addUrlToNamedGroup(options);
    events.push("route-confirmed");
    return result;
  };
  const readingListSource = {
    name: "chrome-reading-list",
    async acknowledge() {
      events.push("acknowledge");
    }
  };
  const inboxManager = makeInboxManager(tabManager, {
    readingListSource,
    badgeManager: {
      async update() {
        events.push("badge-confirmed");
        return 1;
      }
    }
  });

  const result = await inboxManager.importItem({
    id: "https://reading.example/item",
    url: "https://reading.example/item",
    title: "Reading item",
    source: "chrome-reading-list",
    createdAt: 2
  });

  assert.equal(result.ok, true);
  assert.equal(result.transferred, true);
  assert.equal(result.acknowledged, true);
  assert.deepEqual(events, [
    "route-start",
    "route-confirmed",
    "badge-confirmed",
    "acknowledge"
  ]);
});

test("opening from a focused picker still uses the captured normal-window preference", async () => {
  const browser = makeBrowser({
    windows: [
      { id: 1 },
      { id: 2 },
      { id: 99, type: "popup", focused: true }
    ],
    focusedWindowId: 99,
    groups: [
      { id: 10, windowId: 1, title: "Later", color: "blue", collapsed: true },
      { id: 11, windowId: 2, title: "Later", color: "red", collapsed: true }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, url: "https://later.example/one" },
      { id: 2, windowId: 2, index: 0, groupId: 11, url: "https://later.example/two" },
      { id: 99, windowId: 99, index: 0, active: true, url: "chrome-extension://picker/" }
    ]
  });
  const result = await makeInboxManager(makeManager(browser)).openGroupByName({
    title: "Later",
    color: "blue",
    preferredWindowId: 2
  });

  assert.equal(result.ok, true);
  assert.equal(result.windowId, 2);
  assert.equal(result.groupId, 11);
  assert.equal(result.color, "red");
  assert.equal(browser.state.groups.find((group) => group.id === 11).collapsed, false);
  assert.equal(browser.state.groups.find((group) => group.id === 10).collapsed, true);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).windowId, 1);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 99).windowId, 99);
});

test("generic title and color validation fails before routing", async () => {
  const calls = [];
  const manager = new InboxManager({
    groupManager: {
      async getTab() {
        calls.push("get-tab");
        return { id: 1, windowId: 1, url: "https://example.com/" };
      },
      async addCurrentTabToNamedGroup() {
        calls.push("route");
        return { groupId: 1 };
      }
    },
    badgeManager: { async update() { return 0; } },
    logger: makeLogger()
  });

  const empty = await manager.assignTabToGroup({ tabId: 1, title: "   ", color: "blue" });
  const tooLong = await manager.assignTabToGroup({ tabId: 1, title: "x".repeat(81), color: "blue" });
  const badColor = await manager.assignTabToGroup({ tabId: 1, title: "Later", color: "black" });

  assert.equal(empty.ok, false);
  assert.equal(tooLong.ok, false);
  assert.equal(badColor.ok, false);
  assert.deepEqual(calls, []);
});

test("maximized windows remain maximized during named-group open", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2, state: "maximized" }],
    groups: [{ id: 10, windowId: 2, title: GROUP_TITLE, color: GROUP_COLOR }],
    tabs: [{ id: 1, windowId: 2, index: 0, groupId: 10, url: "https://inbox.example/" }]
  });
  await makeManager(browser).openNamedGroup({ title: GROUP_TITLE, color: GROUP_COLOR });
  assert.equal(browser.state.windows.find((window) => window.id === 2).state, "maximized");
});

test("the fixed Inbox title is always restored to Chrome orange", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }],
    groups: [{ id: 10, windowId: 1, title: GROUP_TITLE, color: "blue" }],
    tabs: [{ id: 1, windowId: 1, index: 0, groupId: 10, url: "https://inbox.example/" }]
  });

  const result = await makeManager(browser).prepareNamedGroup({
    title: GROUP_TITLE,
    color: "blue"
  });

  assert.equal(result.color, GROUP_COLOR);
  assert.equal(browser.state.groups.find((group) => group.id === 10).color, GROUP_COLOR);
});

test("captures an ungrouped tab in the existing per-window tmp group", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: [
      { id: 10, windowId: 1, title: TMP_GROUP_TITLE, color: "blue", collapsed: true },
      { id: 20, windowId: 2, title: TMP_GROUP_TITLE, color: TMP_GROUP_COLOR, collapsed: false }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, url: "https://tmp.example/one" },
      { id: 2, windowId: 1, index: 1, active: true, url: "https://tmp.example/two" },
      { id: 3, windowId: 2, index: 0, groupId: 20, url: "https://tmp.example/other" }
    ]
  });

  const result = await makeManager(browser).ensureTemporaryGroupForTab({ tabId: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.groupId, 10);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 2).groupId, 10);
  assert.equal(browser.state.groups.find((group) => group.id === 10).color, TMP_GROUP_COLOR);
  assert.equal(browser.state.groups.find((group) => group.id === 10).collapsed, false);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 3).groupId, 20);
});

test("reconciles normalized duplicate groups per window without closing tabs", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: [
      { id: 10, windowId: 1, title: "tmp", color: "blue", collapsed: true },
      { id: 11, windowId: 1, title: " TMP ", color: "red", collapsed: false },
      { id: 20, windowId: 2, title: "Tmp", color: "green", collapsed: true }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, url: "https://tmp.example/one" },
      { id: 2, windowId: 1, index: 1, groupId: 11, active: true, url: "https://tmp.example/two" },
      { id: 3, windowId: 2, index: 0, groupId: 20, url: "https://tmp.example/other" }
    ]
  });

  const result = await makeManager(browser).reconcileUniqueGroups();

  assert.equal(result.ok, true);
  assert.equal(result.mergedGroupCount, 1);
  assert.equal(result.movedTabCount, 1);
  assert.equal(browser.state.tabs.length, 3);
  assert.deepEqual(
    browser.state.groups
      .filter((group) => group.windowId === 1)
      .map((group) => ({ id: group.id, title: group.title, color: group.color })),
    [{ id: 11, title: TMP_GROUP_TITLE, color: TMP_GROUP_COLOR }]
  );
  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).groupId, 11);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 2).groupId, 11);
  assert.equal(browser.state.groups.find((group) => group.id === 20).title, TMP_GROUP_TITLE);
  assert.equal(browser.state.groups.find((group) => group.id === 20).color, TMP_GROUP_COLOR);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 3).groupId, 20);
});

test("preset metadata wins while arbitrary unique groups preserve canonical color", async () => {
  const presetBrowser = makeBrowser({
    windows: [{ id: 1, focused: true }],
    groups: [
      { id: 10, windowId: 1, title: "Research", color: "blue" },
      { id: 11, windowId: 1, title: " research ", color: "red" }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, url: "https://research.example/one" },
      { id: 2, windowId: 1, index: 1, groupId: 11, url: "https://research.example/two" }
    ]
  });

  await makeManager(presetBrowser).reconcileUniqueGroups({
    preferredGroups: [{ title: "RESEARCH", color: "green" }]
  });
  assert.equal(presetBrowser.state.groups.length, 1);
  assert.equal(presetBrowser.state.groups[0].title, "RESEARCH");
  assert.equal(presetBrowser.state.groups[0].color, "green");

  const arbitraryBrowser = makeBrowser({
    windows: [{ id: 1, focused: true }],
    groups: [
      { id: 10, windowId: 1, title: "Work", color: "blue" },
      { id: 11, windowId: 1, title: " work ", color: "red" }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, url: "https://work.example/one" },
      { id: 2, windowId: 1, index: 1, groupId: 11, url: "https://work.example/two" }
    ]
  });

  await makeManager(arbitraryBrowser).reconcileUniqueGroups();
  assert.equal(arbitraryBrowser.state.groups.length, 1);
  assert.equal(arbitraryBrowser.state.groups[0].title, "Work");
  assert.equal(arbitraryBrowser.state.groups[0].color, "blue");
});

test("tmp capture first consolidates stale duplicate tmp groups", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }],
    groups: [
      { id: 10, windowId: 1, title: "tmp", color: "grey" },
      { id: 11, windowId: 1, title: "TMP", color: "red" }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, url: "https://tmp.example/one" },
      { id: 2, windowId: 1, index: 1, groupId: 11, url: "https://tmp.example/two" },
      { id: 3, windowId: 1, index: 2, active: true, url: "https://tmp.example/three" }
    ]
  });

  const result = await makeManager(browser).ensureTemporaryGroupForTab({ tabId: 3 });

  assert.equal(result.ok, true);
  assert.equal(browser.state.groups.length, 1);
  assert.equal(browser.state.groups[0].title, TMP_GROUP_TITLE);
  assert.equal(browser.state.groups[0].color, TMP_GROUP_COLOR);
  assert.equal(browser.state.tabs.every((tab) => tab.groupId === browser.state.groups[0].id), true);
});

test("concurrent tmp captures serialize creation and reuse one group", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }],
    tabs: [
      { id: 1, windowId: 1, index: 0, active: true, url: "https://tmp.example/one" },
      { id: 2, windowId: 1, index: 1, url: "https://tmp.example/two" }
    ]
  });
  const manager = makeManager(browser);

  const results = await Promise.all([
    manager.ensureTemporaryGroupForTab({ tabId: 1 }),
    manager.ensureTemporaryGroupForTab({ tabId: 2 })
  ]);

  assert.equal(results.every((result) => result.ok && !result.skipped), true);
  assert.equal(browser.state.groups.length, 1);
  assert.equal(browser.state.groups[0].title, TMP_GROUP_TITLE);
  assert.equal(browser.state.tabs.every((tab) => tab.groupId === browser.state.groups[0].id), true);
  assert.equal(browser.state.calls.filter(([kind, properties]) =>
    kind === "group" && properties.groupId === undefined
  ).length, 1);
});

test("creates a grey tmp group without changing an existing user group", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }],
    groups: [{ id: 10, windowId: 1, title: "Research", color: "blue", collapsed: true }],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, url: "https://research.example/" },
      { id: 2, windowId: 1, index: 1, active: true, url: "https://new.example/" }
    ]
  });

  const result = await makeManager(browser).ensureTemporaryGroupForTab({ tabId: 2 });

  assert.equal(result.ok, true);
  assert.notEqual(result.groupId, 10);
  assert.equal(browser.state.groups.find((group) => group.id === result.groupId).title, TMP_GROUP_TITLE);
  assert.equal(browser.state.groups.find((group) => group.id === result.groupId).color, TMP_GROUP_COLOR);
  assert.equal(browser.state.groups.find((group) => group.id === 10).title, "Research");
  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).groupId, 10);
});

test("leaves a tab already assigned to any user group untouched by tmp capture", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }],
    groups: [{ id: 10, windowId: 1, title: "Research", color: "blue" }],
    tabs: [{ id: 1, windowId: 1, index: 0, groupId: 10, active: true, url: "https://research.example/" }]
  });

  const result = await makeManager(browser).ensureTemporaryGroupForTab({ tabId: 1 });

  assert.equal(result.skipped, true);
  assert.equal(result.alreadyGrouped, true);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).groupId, 10);
  assert.equal(browser.state.groups.length, 1);
});

test("a one-tab tmp source is moved through an operation-owned placeholder instead of cloned", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: [
      { id: 10, windowId: 1, title: TMP_GROUP_TITLE, color: TMP_GROUP_COLOR },
      { id: 20, windowId: 2, title: "Research", color: "blue" }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, active: true, url: "https://paper.example/" },
      { id: 2, windowId: 2, index: 0, groupId: 20, url: "https://research.example/" }
    ]
  });

  const result = await makeManager(browser).addCurrentTabToNamedGroup({
    tab: { ...browser.state.tabs.find((tab) => tab.id === 1) },
    title: "Research",
    color: "blue"
  });

  assert.equal(result.moved, true);
  assert.equal(result.cloned, false);
  assert.equal(result.tabId, 1);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).windowId, 2);
  assert.equal(browser.state.tabs.find((tab) => tab.id === 1).groupId, 20);
  assert.equal(browser.state.tabs.some((tab) => tab.url === "about:blank"), false);
  assert.equal(browser.state.tabs.filter((tab) => tab.url === "https://paper.example/").length, 1);
});

test("a failed one-tab tmp move restores the original before safe copy fallback", async () => {
  const browser = makeBrowser({
    windows: [{ id: 1, focused: true }, { id: 2 }],
    groups: [
      { id: 10, windowId: 1, title: TMP_GROUP_TITLE, color: TMP_GROUP_COLOR, collapsed: false },
      { id: 20, windowId: 2, title: "Research", color: "blue", collapsed: true }
    ],
    tabs: [
      { id: 1, windowId: 1, index: 0, groupId: 10, active: true, url: "https://paper.example/" },
      { id: 2, windowId: 2, index: 0, groupId: 20, url: "https://research.example/" }
    ]
  });
  let failedOnce = false;
  browser.state.failGroup = (properties) => {
    if (!failedOnce && properties.groupId === 20 && properties.tabIds.includes(1)) {
      failedOnce = true;
      return true;
    }
    return false;
  };

  const result = await makeManager(browser).addCurrentTabToNamedGroup({
    tab: { ...browser.state.tabs.find((tab) => tab.id === 1) },
    title: "Research",
    color: "blue"
  });

  assert.equal(result.cloned, true);
  assert.equal(result.moved, false);
  const original = browser.state.tabs.find((tab) => tab.id === 1);
  const restoredTmp = browser.state.groups.find((group) => group.title === TMP_GROUP_TITLE);
  assert.equal(original.windowId, 1);
  assert.equal(original.groupId, restoredTmp.id);
  assert.equal(restoredTmp.color, TMP_GROUP_COLOR);
  assert.equal(browser.state.tabs.some((tab) => tab.url === "about:blank"), false);
  assert.equal(browser.state.tabs.filter((tab) => tab.url === "https://paper.example/").length, 2);
});
