import {
  GROUP_COLOR,
  GROUP_TITLE,
  TAB_GROUP_ID_NONE,
  TMP_GROUP_COLOR,
  TMP_GROUP_TITLE
} from "./constants.js";
import { findExactUrlInGroups } from "./duplicate-detector.js";
import {
  groupTitleKey,
  normalizeGroupTitle
} from "./group-title.js";
import { describeError, logger as defaultLogger } from "./logging.js";
import { normalizeHttpUrl } from "./url-utils.js";

const GROUP_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
]);

function isInteger(value) {
  return Number.isInteger(value);
}

function isResourceId(value) {
  return isInteger(value) && value >= 0;
}

function compareNumbers(left, right) {
  return (Number.isInteger(left) ? left : Number.MAX_SAFE_INTEGER) -
    (Number.isInteger(right) ? right : Number.MAX_SAFE_INTEGER);
}

function compareTabs(left, right) {
  return (
    compareNumbers(left?.windowId, right?.windowId) ||
    compareNumbers(left?.index, right?.index) ||
    compareNumbers(left?.id, right?.id)
  );
}

function compareGroups(left, right) {
  return (
    compareNumbers(left?.windowId, right?.windowId) ||
    compareNumbers(left?.id, right?.id)
  );
}

function comparePreferredGroups(left, right, preferredWindowId = null) {
  const leftPreferred = left?.windowId === preferredWindowId ? 0 : 1;
  const rightPreferred = right?.windowId === preferredWindowId ? 0 : 1;
  return leftPreferred - rightPreferred || compareGroups(left, right);
}

function resolveGroupColor(title, requestedColor, existingColor = null) {
  const titleKey = groupTitleKey(title);
  if (titleKey === groupTitleKey(GROUP_TITLE)) {
    return GROUP_COLOR;
  }
  if (titleKey === groupTitleKey(TMP_GROUP_TITLE)) {
    return TMP_GROUP_COLOR;
  }
  if (GROUP_COLORS.has(existingColor)) {
    return existingColor;
  }
  return GROUP_COLORS.has(requestedColor) ? requestedColor : GROUP_COLOR;
}

function isNormalWindow(window) {
  return Boolean(
    window &&
      isResourceId(window.id) &&
      window.incognito !== true &&
      (!window.type || window.type === "normal")
  );
}

function buildPreferredGroupDefinitions(preferredGroups = []) {
  const definitions = new Map();
  for (const candidate of preferredGroups ?? []) {
    const title = normalizeGroupTitle(candidate?.title);
    const key = groupTitleKey(title);
    if (key.length === 0 || !GROUP_COLORS.has(candidate?.color)) {
      continue;
    }
    definitions.set(key, { title, color: candidate.color });
  }

  // System groups always win over user-editable preset metadata.
  definitions.set(groupTitleKey(GROUP_TITLE), {
    title: GROUP_TITLE,
    color: GROUP_COLOR
  });
  definitions.set(groupTitleKey(TMP_GROUP_TITLE), {
    title: TMP_GROUP_TITLE,
    color: TMP_GROUP_COLOR
  });
  return definitions;
}

function tabUrl(tab) {
  return tab?.pendingUrl || tab?.url;
}

function makeOperationError(message, cause, details = {}) {
  const error = new Error(message, { cause });
  Object.assign(error, details);
  return error;
}

export class TabGroupManager {
  constructor({
    tabsApi = globalThis.chrome?.tabs,
    tabGroupsApi = globalThis.chrome?.tabGroups,
    windowsApi = globalThis.chrome?.windows,
    logger = defaultLogger
  } = {}) {
    this.tabsApi = tabsApi;
    this.tabGroupsApi = tabGroupsApi;
    this.windowsApi = windowsApi;
    this.logger = logger;
    this.groupMutationQueue = Promise.resolve();
  }

  runGroupMutation(work) {
    const task = this.groupMutationQueue
      .catch(() => undefined)
      .then(work);
    this.groupMutationQueue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  assertTabsApi() {
    if (!this.tabsApi || typeof this.tabsApi.query !== "function") {
      throw new Error("chrome.tabs API is unavailable");
    }
  }

  assertGroupsApi() {
    if (
      !this.tabGroupsApi ||
      typeof this.tabGroupsApi.query !== "function" ||
      typeof this.tabGroupsApi.update !== "function"
    ) {
      throw new Error("chrome.tabGroups API is unavailable");
    }
  }

  assertWindowsApi({ create = false } = {}) {
    if (
      !this.windowsApi ||
      typeof this.windowsApi.getAll !== "function" ||
      (create && typeof this.windowsApi.create !== "function")
    ) {
      throw new Error("chrome.windows API is unavailable");
    }
  }

  async getLastFocusedWindowId() {
    if (!this.windowsApi || typeof this.windowsApi.getLastFocused !== "function") {
      return null;
    }

    try {
      const window = await this.windowsApi.getLastFocused({ populate: false });
      return isNormalWindow(window) ? window.id : null;
    } catch (error) {
      this.logger.group.warning("last focused window unavailable", describeError(error));
      return null;
    }
  }

  async getNormalWindows() {
    this.assertWindowsApi();
    const windows = await this.windowsApi.getAll({
      populate: false,
      windowTypes: ["normal"]
    });
    return (windows ?? []).filter(isNormalWindow);
  }

  async getWindow(windowId) {
    if (!isResourceId(windowId)) {
      return null;
    }

    if (typeof this.windowsApi?.get === "function") {
      try {
        const window = await this.windowsApi.get(windowId, { populate: false });
        return isNormalWindow(window) ? window : null;
      } catch (error) {
        this.logger.group.warning("window lookup failed", {
          windowId,
          error: describeError(error)
        });
        return null;
      }
    }

    const windows = await this.getNormalWindows();
    return windows.find((window) => window.id === windowId) ?? null;
  }

  async getNamedGroups(title = GROUP_TITLE) {
    this.assertGroupsApi();
    const titleKey = groupTitleKey(title);
    if (titleKey.length === 0) {
      return [];
    }
    const groups = await this.tabGroupsApi.query({});
    return (groups ?? [])
      .filter(
        (group) =>
          groupTitleKey(group?.title) === titleKey &&
          typeof group.title === "string" &&
          normalizeGroupTitle(group.title).length > 0 &&
          isResourceId(group.id) &&
          isResourceId(group.windowId)
      )
      .sort(compareGroups);
  }

  async getCandidateGroups({
    title = GROUP_TITLE,
    preferredWindowId = null
  } = {}) {
    this.assertGroupsApi();
    const validGroups = await this.getNamedGroups(title);
    const focusedWindowId =
      preferredWindowId ?? (await this.getLastFocusedWindowId());

    validGroups.sort((left, right) =>
      comparePreferredGroups(left, right, focusedWindowId)
    );

    if (validGroups.length > 1) {
      this.logger.group.warning("multiple matching groups; using the preferred group only", {
        title,
        count: validGroups.length,
        groups: validGroups.map((group) => ({ id: group.id, windowId: group.windowId }))
      });
    }

    return validGroups;
  }

  async getGroupTabs(groupId) {
    this.assertTabsApi();
    if (!isResourceId(groupId)) {
      throw new Error("invalid tab group id");
    }
    return (await this.tabsApi.query({ groupId })) ?? [];
  }

  async getGroup(groupId) {
    if (!isResourceId(groupId)) {
      return null;
    }
    this.assertGroupsApi();

    if (typeof this.tabGroupsApi.get === "function") {
      try {
        return (await this.tabGroupsApi.get(groupId)) ?? null;
      } catch (error) {
        this.logger.group.warning("group lookup failed", {
          groupId,
          error: describeError(error)
        });
        return null;
      }
    }

    const groups = await this.tabGroupsApi.query({});
    return (groups ?? []).find((group) => group?.id === groupId) ?? null;
  }

  async getTab(tabId) {
    this.assertTabsApi();
    if (!isResourceId(tabId)) {
      return null;
    }

    if (typeof this.tabsApi.get === "function") {
      try {
        return (await this.tabsApi.get(tabId)) ?? null;
      } catch (error) {
        this.logger.tab.warning("tab lookup failed", {
          tabId,
          error: describeError(error)
        });
        return null;
      }
    }

    const tabs = await this.tabsApi.query({});
    return (tabs ?? []).find((tab) => tab?.id === tabId) ?? null;
  }

  async findGroupWithUrl(url, {
    title = GROUP_TITLE,
    preferredWindowId = null
  } = {}) {
    const groups = await this.getCandidateGroups({ title, preferredWindowId });
    return findExactUrlInGroups({ tabsApi: this.tabsApi, groups, url });
  }

  async getWindowTabs(windowId) {
    this.assertTabsApi();
    if (!isResourceId(windowId)) {
      return [];
    }
    return (await this.tabsApi.query({ windowId })) ?? [];
  }

  async getCurrentTab() {
    this.assertTabsApi();
    try {
      const activeTabs = await this.tabsApi.query({
        active: true,
        lastFocusedWindow: true
      });
      if (activeTabs?.[0]) {
        return activeTabs[0];
      }
    } catch (error) {
      this.logger.tab.warning("last focused tab query failed", describeError(error));
    }

    const windowId = await this.getLastFocusedWindowId();
    if (!isResourceId(windowId)) {
      return null;
    }

    const activeTabs = await this.tabsApi.query({ active: true, windowId });
    return activeTabs?.[0] ?? null;
  }

  async getPreferredNormalWindowId() {
    if (this.windowsApi && typeof this.windowsApi.getLastFocused === "function") {
      try {
        const lastFocusedWindow = await this.windowsApi.getLastFocused({ populate: false });
        if (
          isResourceId(lastFocusedWindow?.id) &&
          (!lastFocusedWindow.type || lastFocusedWindow.type === "normal")
        ) {
          return lastFocusedWindow.id;
        }
      } catch (error) {
        this.logger.group.warning("last focused normal window unavailable", describeError(error));
      }
    }

    if (!this.windowsApi || typeof this.windowsApi.getAll !== "function") {
      return null;
    }

    try {
      const windows = await this.windowsApi.getAll({
        populate: false,
        windowTypes: ["normal"]
      });
      const normalWindow = (windows ?? [])
        .filter((window) => isResourceId(window?.id))
        .sort((left, right) => compareNumbers(left.id, right.id))[0];
      return normalWindow?.id ?? null;
    } catch (error) {
      this.logger.group.warning("normal window lookup failed", describeError(error));
      return null;
    }
  }

  async createBackgroundTab(url, { windowId = null } = {}) {
    this.assertTabsApi();
    if (typeof this.tabsApi.create !== "function") {
      throw new Error("chrome.tabs.create is unavailable");
    }

    const createProperties = { url, active: false };
    if (isResourceId(windowId)) {
      createProperties.windowId = windowId;
    }

    const tab = await this.tabsApi.create(createProperties);
    if (!isResourceId(tab?.id)) {
      throw new Error("background tab was not created");
    }
    return tab;
  }

  async removeTab(tabId) {
    if (!isResourceId(tabId) || typeof this.tabsApi?.remove !== "function") {
      return false;
    }

    try {
      await this.tabsApi.remove(tabId);
      return true;
    } catch (error) {
      this.logger.tab.warning("cleanup tab failed", {
        tabId,
        error: describeError(error)
      });
      return false;
    }
  }

  async configureGroup(groupId, {
    title = GROUP_TITLE,
    color = GROUP_COLOR,
    collapsed = true
  } = {}) {
    this.assertGroupsApi();
    if (!isResourceId(groupId)) {
      throw new Error("invalid tab group id");
    }

    const group = await this.tabGroupsApi.update(groupId, {
      title,
      color,
      collapsed
    });
    if (!group) {
      throw new Error("tab group disappeared while configuring");
    }

    this.logger.group.info(collapsed ? "collapsed" : "expanded", {
      groupId,
      title,
      color
    });
    return group;
  }

  async groupTabs(tabIds, { groupId = null, windowId = null } = {}) {
    this.assertTabsApi();
    if (
      !Array.isArray(tabIds) ||
      tabIds.length === 0 ||
      tabIds.some((tabId) => !isResourceId(tabId)) ||
      typeof this.tabsApi.group !== "function"
    ) {
      throw new Error("chrome.tabs.group is unavailable");
    }

    const groupProperties = { tabIds: [...tabIds] };
    if (isResourceId(groupId)) {
      groupProperties.groupId = groupId;
    } else if (isResourceId(windowId)) {
      groupProperties.createProperties = { windowId };
    }

    const resultingGroupId = await this.tabsApi.group(groupProperties);
    const actualGroupId = isInteger(resultingGroupId) ? resultingGroupId : groupId;
    if (!isResourceId(actualGroupId) || actualGroupId === TAB_GROUP_ID_NONE) {
      throw new Error("tabs were not assigned to a group");
    }

    const members = await this.getGroupTabs(actualGroupId);
    const memberIds = new Set(members.map((tab) => tab?.id));
    if (tabIds.some((tabId) => !memberIds.has(tabId))) {
      throw new Error("tab group membership could not be confirmed");
    }
    if (isResourceId(windowId) && members.some((tab) => tab?.windowId !== windowId)) {
      throw new Error("tab group window could not be confirmed");
    }

    this.logger.tab.info("added", { tabIds: [...tabIds], groupId: actualGroupId });
    return actualGroupId;
  }

  async groupTab(tabId, groupId = null, { windowId = null } = {}) {
    return this.groupTabs([tabId], { groupId, windowId });
  }

  async createGroupForTab(tabId, { title = GROUP_TITLE, color = GROUP_COLOR } = {}) {
    const tab = await this.getTab(tabId);
    const groupId = await this.groupTabs([tabId], { windowId: tab?.windowId });
    this.logger.group.info("created", { groupId, title });
    await this.configureGroup(groupId, { title, color, collapsed: true });
    return groupId;
  }

  async cleanupCreatedTab(tabId) {
    return this.removeTab(tabId);
  }

  async moveTabToWindow(tabId, windowId, index = -1) {
    if (typeof this.tabsApi?.move !== "function") {
      throw new Error("chrome.tabs.move is unavailable");
    }

    await this.tabsApi.move(tabId, { windowId, index });
    const movedTab = await this.getTab(tabId);
    if (!movedTab || movedTab.windowId !== windowId) {
      throw new Error("tab move could not be confirmed");
    }
    return movedTab;
  }

  async createWindowFromTab(tabId) {
    this.assertWindowsApi({ create: true });
    let createdWindow;
    try {
      createdWindow = await this.windowsApi.create({ tabId, focused: false });
    } catch (error) {
      throw makeOperationError("dedicated window could not be created", error);
    }

    const windowId = createdWindow?.id;
    if (!isResourceId(windowId) || (createdWindow.type && createdWindow.type !== "normal")) {
      throw makeOperationError(
        "dedicated window was not a normal window",
        null,
        { createdWindowId: windowId }
      );
    }

    const movedTab = await this.getTab(tabId);
    if (!movedTab || movedTab.windowId !== windowId) {
      throw makeOperationError(
        "seed tab move could not be confirmed",
        null,
        { createdWindowId: windowId }
      );
    }
    return { windowId, tab: movedTab };
  }

  async createBackgroundTabInNewWindow(url) {
    this.assertWindowsApi({ create: true });
    let createdWindow;
    try {
      createdWindow = await this.windowsApi.create({
        url,
        type: "normal",
        focused: false
      });
    } catch (error) {
      throw makeOperationError("dedicated window could not be created", error);
    }

    const windowId = createdWindow?.id;
    if (!isResourceId(windowId) || (createdWindow.type && createdWindow.type !== "normal")) {
      const cleanupSucceeded = isResourceId(windowId)
        ? await this.cleanupCreatedWindow(windowId)
        : true;
      throw makeOperationError(
        cleanupSucceeded
          ? "dedicated window was not a normal window"
          : "dedicated window was not normal and cleanup could not be confirmed",
        null,
        { createdWindowId: windowId, cleanupSucceeded }
      );
    }

    const returnedTabs = Array.isArray(createdWindow.tabs) ? createdWindow.tabs : [];
    const tabs = returnedTabs.length > 0 ? returnedTabs : await this.getWindowTabs(windowId);
    const createdTab = tabs.find(
      (tab) => tabUrl(tab) === url && tab.windowId === windowId
    ) ?? tabs.find((tab) => tab?.windowId === windowId);
    if (!createdTab || !isResourceId(createdTab.id)) {
      const cleanupSucceeded = await this.cleanupCreatedWindow(windowId);
      throw makeOperationError(
        cleanupSucceeded
          ? "dedicated background tab could not be confirmed"
          : "dedicated background tab could not be confirmed and cleanup failed",
        null,
        { createdWindowId: windowId, cleanupSucceeded }
      );
    }
    return { windowId, tab: createdTab };
  }

  async cleanupCreatedWindow(windowId) {
    if (!isResourceId(windowId) || typeof this.windowsApi?.remove !== "function") {
      return false;
    }

    try {
      await this.windowsApi.remove(windowId);
      return true;
    } catch (error) {
      this.logger.group.warning("cleanup created window failed", {
        windowId,
        error: describeError(error)
      });
      return false;
    }
  }

  async focusWindow(windowId, { restoreIfMinimized = false } = {}) {
    if (!isResourceId(windowId) || typeof this.windowsApi?.update !== "function") {
      return null;
    }

    const updateInfo = { focused: true };
    if (restoreIfMinimized && typeof this.windowsApi.get === "function") {
      try {
        const window = await this.windowsApi.get(windowId, { populate: false });
        if (window?.state === "minimized") {
          updateInfo.state = "normal";
        }
      } catch (error) {
        this.logger.group.warning("window state lookup failed", {
          windowId,
          error: describeError(error)
        });
      }
    }

    return this.windowsApi.update(windowId, updateInfo);
  }

  async restoreTabContext({ windowId, tabId }) {
    try {
      await this.focusWindow(windowId);
      if (typeof this.tabsApi?.update === "function") {
        await this.tabsApi.update(tabId, { active: true });
      }
      return await this.getTab(tabId);
    } catch (error) {
      this.logger.tab.warning("original tab context restore failed", describeError(error));
      return null;
    }
  }

  async activateOriginalContext({
    windowId,
    movedTabId,
    originalIndex,
    excludedGroupId = null
  }) {
    const candidates = (await this.getWindowTabs(windowId)).filter(
      (tab) =>
        tab?.id !== movedTabId &&
        (excludedGroupId === null || tab?.groupId !== excludedGroupId)
    );
    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((left, right) => {
      const leftUngrouped = left?.groupId === TAB_GROUP_ID_NONE ? 0 : 1;
      const rightUngrouped = right?.groupId === TAB_GROUP_ID_NONE ? 0 : 1;
      return (
        leftUngrouped - rightUngrouped ||
        Math.abs((left?.index ?? 0) - (originalIndex ?? 0)) -
          Math.abs((right?.index ?? 0) - (originalIndex ?? 0)) ||
        compareNumbers(left?.index, right?.index)
      );
    });

    const contextTab = candidates[0];
    try {
      await this.focusWindow(windowId);
      await this.tabsApi.update(contextTab.id, { active: true });
      return contextTab;
    } catch (error) {
      this.logger.tab.warning("original context restore failed", describeError(error));
      return null;
    }
  }

  async rollbackMovedTab({
    tabId,
    sourceWindowId,
    sourceIndex,
    sourceGroupId = null,
    sourceGroup = null
  }) {
    let rollbackSucceeded = true;
    try {
      if (typeof this.tabsApi?.ungroup === "function") {
        await this.tabsApi.ungroup([tabId]);
      }
    } catch (error) {
      rollbackSucceeded = false;
      this.logger.tab.warning("rollback ungroup failed", describeError(error));
    }

    try {
      await this.moveTabToWindow(
        tabId,
        sourceWindowId,
        Math.max(0, Number.isInteger(sourceIndex) ? sourceIndex : 0)
      );
    } catch (error) {
      rollbackSucceeded = false;
      this.logger.tab.warning("rollback move failed", describeError(error));
    }

    if (rollbackSucceeded && isResourceId(sourceGroupId)) {
      try {
        let restoredGroupId;
        try {
          restoredGroupId = await this.groupTab(tabId, sourceGroupId);
        } catch {
          if (!sourceGroup) {
            throw new Error("original group metadata is unavailable");
          }
          restoredGroupId = await this.groupTabs([tabId], { windowId: sourceWindowId });
        }
        if (sourceGroup) {
          await this.tabGroupsApi.update(restoredGroupId, {
            title: sourceGroup.title,
            color: sourceGroup.color,
            collapsed: sourceGroup.collapsed
          });
        }
      } catch (error) {
        rollbackSucceeded = false;
        this.logger.tab.warning("rollback group failed", describeError(error));
      }
    }

    return rollbackSucceeded;
  }

  async restorePreparedGroup(snapshot) {
    let succeeded = true;
    const tabIds = snapshot.tabs.map((tab) => tab.id);

    try {
      if (typeof this.tabsApi?.ungroup === "function" && tabIds.length > 0) {
        await this.tabsApi.ungroup(tabIds);
      }
    } catch (error) {
      succeeded = false;
      this.logger.group.warning("dedicated-window rollback ungroup failed", describeError(error));
    }

    const tabsBySource = new Map();
    for (const tab of snapshot.tabs) {
      const current = await this.getTab(tab.id);
      if (!current) {
        succeeded = false;
        continue;
      }
      if (current.windowId !== tab.windowId) {
        const list = tabsBySource.get(tab.windowId) ?? [];
        list.push(tab);
        tabsBySource.set(tab.windowId, list);
      }
    }

    for (const [sourceWindowId, tabs] of tabsBySource) {
      tabs.sort((left, right) => compareNumbers(left.index, right.index));
      for (const tab of tabs) {
        try {
          await this.moveTabToWindow(
            tab.id,
            sourceWindowId,
            Math.max(0, Number.isInteger(tab.index) ? tab.index : 0)
          );
        } catch (error) {
          succeeded = false;
          this.logger.group.warning("dedicated-window rollback move failed", {
            tabId: tab.id,
            sourceWindowId,
            error: describeError(error)
          });
        }
      }
    }

    for (const group of snapshot.groups) {
      const memberIds = group.tabs.map((tab) => tab.id).filter((tabId) =>
        snapshot.tabs.some((tab) => tab.id === tabId)
      );
      if (memberIds.length === 0) {
        continue;
      }

      try {
        let groupId = group.id;
        try {
          groupId = await this.groupTabs(memberIds, { groupId: group.id });
        } catch {
          groupId = await this.groupTabs(memberIds, { windowId: group.windowId });
        }
        await this.tabGroupsApi.update(groupId, {
          title: group.title,
          color: group.color,
          collapsed: group.collapsed
        });
      } catch (error) {
        succeeded = false;
        this.logger.group.warning("dedicated-window rollback group failed", {
          groupId: group.id,
          error: describeError(error)
        });
      }
    }

    for (const tab of snapshot.tabs) {
      const current = await this.getTab(tab.id);
      if (!current || current.windowId !== tab.windowId) {
        succeeded = false;
      }
    }
    return succeeded;
  }

  async inspectPreferredNamedGroup(title, preferredWindowId = null) {
    const groups = await this.getCandidateGroups({ title, preferredWindowId });
    for (const group of groups) {
      const members = (await this.getGroupTabs(group.id)).filter(
        (tab) => isResourceId(tab?.id) && tab?.windowId === group.windowId
      );
      if (members.length > 0) {
        this.logger.group.info("found", {
          title,
          groupId: group.id,
          windowId: group.windowId
        });
        return {
          groups,
          group: { ...group },
          tabs: members.map((tab) => ({ ...tab })).sort(compareTabs)
        };
      }
    }
    return { groups, group: null, tabs: [] };
  }

  /**
   * Keep each normalized title unique inside each normal Chrome window.
   * Chrome tab groups cannot span windows, so groups in different windows are
   * intentionally left separate. Duplicate groups are emptied into one
   * canonical group; no tab is closed or deleted by this reconciliation.
   */
  async reconcileUniqueGroups({
    windowId = null,
    title = null,
    preferredGroups = []
  } = {}) {
    return this.runGroupMutation(() => this.reconcileUniqueGroupsUnlocked({
      windowId,
      title,
      preferredGroups
    }));
  }

  async reconcileUniqueGroupsUnlocked({
    windowId = null,
    title = null,
    preferredGroups = []
  } = {}) {
    this.assertTabsApi();
    this.assertGroupsApi();

    const requestedTitleKey = title === null ? null : groupTitleKey(title);
    if (requestedTitleKey === "") {
      return {
        ok: true,
        checkedGroupCount: 0,
        mergedGroupCount: 0,
        movedTabCount: 0,
        updatedGroupCount: 0
      };
    }

    const normalWindowIds = new Set(
      (await this.getNormalWindows()).map((window) => window.id)
    );
    if (isResourceId(windowId) && !normalWindowIds.has(windowId)) {
      return {
        ok: true,
        checkedGroupCount: 0,
        mergedGroupCount: 0,
        movedTabCount: 0,
        updatedGroupCount: 0
      };
    }

    const definitions = buildPreferredGroupDefinitions(preferredGroups);
    const groups = (await this.tabGroupsApi.query({})) ?? [];
    const buckets = new Map();

    for (const group of groups) {
      const normalizedTitle = normalizeGroupTitle(group?.title);
      const titleKey = groupTitleKey(normalizedTitle);
      if (
        normalizedTitle.length === 0 ||
        titleKey.length === 0 ||
        !isResourceId(group?.id) ||
        !normalWindowIds.has(group?.windowId) ||
        (isResourceId(windowId) && group.windowId !== windowId) ||
        (requestedTitleKey !== null && titleKey !== requestedTitleKey)
      ) {
        continue;
      }

      const bucketKey = `${group.windowId}\u0000${titleKey}`;
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, {
          windowId: group.windowId,
          titleKey,
          groups: []
        });
      }
      buckets.get(bucketKey).groups.push({ ...group });
    }

    let checkedGroupCount = 0;
    let mergedGroupCount = 0;
    let movedTabCount = 0;
    let updatedGroupCount = 0;

    for (const bucket of buckets.values()) {
      const records = [];
      for (const group of bucket.groups) {
        const members = (await this.getGroupTabs(group.id))
          .filter((tab) => isResourceId(tab?.id) && tab?.windowId === bucket.windowId)
          .sort(compareTabs);
        if (members.length > 0) {
          records.push({ group, members });
        }
      }
      checkedGroupCount += records.length;
      if (records.length === 0) {
        continue;
      }

      records.sort((left, right) => {
        const leftActive = left.members.some((tab) => tab?.active) ? 0 : 1;
        const rightActive = right.members.some((tab) => tab?.active) ? 0 : 1;
        return (
          leftActive - rightActive ||
          compareNumbers(left.members[0]?.index, right.members[0]?.index) ||
          compareGroups(left.group, right.group)
        );
      });

      const canonical = records[0];
      const definition = definitions.get(bucket.titleKey) ?? null;
      const desiredTitle = definition?.title ?? normalizeGroupTitle(canonical.group.title);
      const desiredColor = definition?.color ?? (
        GROUP_COLORS.has(canonical.group.color) ? canonical.group.color : GROUP_COLOR
      );
      const desiredCollapsed = canonical.group.collapsed === true;

      for (const duplicate of records.slice(1)) {
        const duplicateTabIds = duplicate.members.map((tab) => tab.id);
        await this.groupTabs(duplicateTabIds, {
          groupId: canonical.group.id,
          windowId: bucket.windowId
        });
        mergedGroupCount += 1;
        movedTabCount += duplicateTabIds.length;
      }

      if (
        canonical.group.title !== desiredTitle ||
        canonical.group.color !== desiredColor ||
        canonical.group.collapsed !== desiredCollapsed
      ) {
        await this.configureGroup(canonical.group.id, {
          title: desiredTitle,
          color: desiredColor,
          collapsed: desiredCollapsed
        });
        updatedGroupCount += 1;
      }

      const remaining = (await this.getNamedGroups(desiredTitle))
        .filter((group) => group.windowId === bucket.windowId);
      if (remaining.length !== 1 || remaining[0].id !== canonical.group.id) {
        throw new Error("duplicate tab groups could not be reconciled");
      }
    }

    if (mergedGroupCount > 0 || updatedGroupCount > 0) {
      this.logger.group.info("group titles reconciled", {
        checkedGroupCount,
        mergedGroupCount,
        movedTabCount,
        updatedGroupCount
      });
    }
    return {
      ok: true,
      checkedGroupCount,
      mergedGroupCount,
      movedTabCount,
      updatedGroupCount
    };
  }

  /**
   * List non-empty named groups without exposing page URLs or page titles.
   * Each result has { title, color, tabCount, groupCount, windowCount }.
   */
  async listNamedGroupSummaries(preferredWindowId = null) {
    this.assertGroupsApi();
    const groups = await this.tabGroupsApi.query({});
    const summaries = new Map();

    for (const group of groups ?? []) {
      if (
        typeof group?.title !== "string" ||
        group.title.trim().length === 0 ||
        !isResourceId(group.id) ||
        !isResourceId(group.windowId)
      ) {
        continue;
      }

      const members = await this.getGroupTabs(group.id);
      if (members.length === 0) {
        continue;
      }

      const normalizedTitle = normalizeGroupTitle(group.title);
      const titleKey = groupTitleKey(normalizedTitle);
      let summary = summaries.get(titleKey);
      if (!summary) {
        summary = {
          title: normalizedTitle,
          color: GROUP_COLOR,
          tabCount: 0,
          groupIds: new Set(),
          windowIds: new Set(),
          firstGroup: null
        };
        summaries.set(titleKey, summary);
      }

      summary.tabCount += members.length;
      summary.groupIds.add(group.id);
      summary.windowIds.add(group.windowId);
      if (
        !summary.firstGroup ||
        comparePreferredGroups(group, summary.firstGroup, preferredWindowId) < 0
      ) {
        summary.firstGroup = group;
        summary.title = normalizedTitle;
        summary.color = GROUP_COLORS.has(group.color) ? group.color : GROUP_COLOR;
      }
    }

    return [...summaries.values()]
      .sort((left, right) => (
        left.title < right.title ? -1 : left.title > right.title ? 1 : 0
      ))
      .map((summary) => ({
        title: summary.title,
        color: summary.color,
        tabCount: summary.tabCount,
        groupCount: summary.groupIds.size,
        windowCount: summary.windowIds.size
      }));
  }

  /**
   * Put one still-ungrouped tab in the per-window temporary Inbox. Existing
   * user groups are never renamed or repurposed.
   */
  async ensureTemporaryGroupForTab({
    tabId,
    title = TMP_GROUP_TITLE,
    color = TMP_GROUP_COLOR,
    source = "new-tab"
  } = {}) {
    return this.runGroupMutation(() => this.ensureTemporaryGroupForTabUnlocked({
      tabId,
      title,
      color,
      source
    }));
  }

  async ensureTemporaryGroupForTabUnlocked({
    tabId,
    title = TMP_GROUP_TITLE,
    color = TMP_GROUP_COLOR,
    source = "new-tab"
  } = {}) {
    if (!isResourceId(tabId)) {
      return { ok: false, skipped: true, message: "tmp対象タブを確認できません" };
    }

    const tab = await this.getTab(tabId);
    if (!tab || !isResourceId(tab.windowId)) {
      return { ok: true, skipped: true, missing: true, tabId, source };
    }
    if (isResourceId(tab.groupId)) {
      return {
        ok: true,
        skipped: true,
        alreadyGrouped: true,
        tabId,
        groupId: tab.groupId,
        windowId: tab.windowId,
        source
      };
    }
    if (!await this.getWindow(tab.windowId)) {
      return { ok: true, skipped: true, unsupportedWindow: true, tabId, source };
    }

    await this.reconcileUniqueGroupsUnlocked({ windowId: tab.windowId, title });
    const groups = await this.getNamedGroups(title);
    const existing = groups
      .filter((group) => group.windowId === tab.windowId)
      .sort(compareGroups)[0] ?? null;
    const groupId = existing
      ? await this.groupTab(tab.id, existing.id, { windowId: tab.windowId })
      : await this.groupTabs([tab.id], { windowId: tab.windowId });
    const group = await this.configureGroup(groupId, {
      title,
      color: resolveGroupColor(title, color, existing?.color),
      collapsed: false
    });
    const confirmed = await this.getTab(tab.id);
    if (!confirmed || confirmed.groupId !== groupId || confirmed.windowId !== tab.windowId) {
      throw new Error("tmp group membership could not be confirmed");
    }

    this.logger.group.info("temporary Inbox captured tab", {
      tabId: tab.id,
      groupId,
      windowId: tab.windowId,
      source
    });
    return {
      ok: true,
      skipped: false,
      title,
      color: group?.color ?? TMP_GROUP_COLOR,
      tabId: tab.id,
      groupId,
      windowId: tab.windowId,
      source
    };
  }

  /**
   * Put only the safely preferred exact-title group in a normal group-only
   * window. Other same-title groups are deliberately left untouched. Window
   * and group IDs are discovered from live Chrome state and never persisted.
   */
  async prepareNamedGroup({
    title = GROUP_TITLE,
    color = GROUP_COLOR,
    preferredWindowId = null
  } = {}) {
    return this.runGroupMutation(() => this.prepareNamedGroupUnlocked({
      title,
      color,
      preferredWindowId
    }));
  }

  async prepareNamedGroupUnlocked({
    title = GROUP_TITLE,
    color = GROUP_COLOR,
    preferredWindowId = null
  } = {}) {
    await this.reconcileUniqueGroupsUnlocked({ title });
    const inspected = await this.inspectPreferredNamedGroup(title, preferredWindowId);
    if (!inspected.group || inspected.tabs.length === 0) {
      return null;
    }

    const sourceWindow = await this.getWindow(inspected.group.windowId);
    if (!sourceWindow) {
      throw new Error("named group contains a tab in an unsupported window");
    }

    const sourceWindowTabs = await this.getWindowTabs(inspected.group.windowId);
    const resolvedColor = resolveGroupColor(title, color, inspected.group.color);
    const isAlreadyDedicated =
      sourceWindowTabs.length === inspected.tabs.length &&
      sourceWindowTabs.every((tab) => tab?.groupId === inspected.group.id);
    if (isAlreadyDedicated) {
      const group = await this.configureGroup(inspected.group.id, {
        title,
        color: resolvedColor,
        collapsed: true
      });
      const tabs = await this.getGroupTabs(inspected.group.id);
      if (
        tabs.length === 0 ||
        tabs.length !== sourceWindowTabs.length ||
        tabs.some((tab) => tab?.windowId !== inspected.group.windowId)
      ) {
        throw new Error("dedicated named group could not be confirmed");
      }
      return {
        title,
        color: resolvedColor,
        windowId: inspected.group.windowId,
        groupId: inspected.group.id,
        group,
        tabs: tabs.sort(compareTabs),
        createdWindow: false,
        matchingGroupCount: inspected.groups.length
      };
    }

    const snapshot = {
      tabs: inspected.tabs.map((tab) => ({ ...tab })),
      groups: [{
        ...inspected.group,
        tabs: inspected.tabs.map((tab) => ({ ...tab }))
      }]
    };

    let destinationWindowId = null;
    let createdWindowId = null;
    let groupId = null;

    try {
      const seed = inspected.tabs[0];
      try {
        const created = await this.createWindowFromTab(seed.id);
        destinationWindowId = created.windowId;
        createdWindowId = created.windowId;
      } catch (error) {
        createdWindowId = error?.createdWindowId ?? null;
        throw error;
      }

      for (const tab of inspected.tabs) {
        const current = await this.getTab(tab.id);
        if (!current) {
          throw new Error("named group tab disappeared while creating its dedicated window");
        }
        if (current.windowId !== destinationWindowId) {
          await this.moveTabToWindow(tab.id, destinationWindowId, -1);
        }
      }

      const destinationTabs = await this.getWindowTabs(destinationWindowId);
      const selectedTabIds = new Set(inspected.tabs.map((tab) => tab.id));
      if (
        destinationTabs.length !== selectedTabIds.size ||
        destinationTabs.some((tab) => !selectedTabIds.has(tab?.id))
      ) {
        throw new Error("dedicated window contains an unrelated tab");
      }

      groupId = await this.groupTabs(
        destinationTabs.map((tab) => tab.id),
        { windowId: destinationWindowId }
      );
      await this.configureGroup(groupId, { title, color: resolvedColor, collapsed: true });

      const finalGroups = await this.getNamedGroups(title);
      const finalGroup = finalGroups.find((group) => group.id === groupId) ?? null;
      const finalTabs = await this.getGroupTabs(groupId);
      const finalWindowTabs = await this.getWindowTabs(destinationWindowId);
      if (
        !finalGroup ||
        finalTabs.length === 0 ||
        finalTabs.some((tab) => tab?.windowId !== destinationWindowId) ||
        finalWindowTabs.length !== finalTabs.length ||
        finalWindowTabs.some((tab) => tab?.groupId !== groupId)
      ) {
        throw new Error("dedicated named group could not be confirmed");
      }

      return {
        title,
        color: resolvedColor,
        windowId: destinationWindowId,
        groupId,
        group: finalGroup,
        tabs: finalTabs.sort(compareTabs),
        createdWindow: createdWindowId !== null,
        matchingGroupCount: inspected.groups.length
      };
    } catch (error) {
      const rollbackSucceeded = await this.restorePreparedGroup(snapshot);
      throw makeOperationError(
        rollbackSucceeded
          ? "dedicated window preparation failed; original tabs were restored"
          : "dedicated window preparation failed and rollback could not be confirmed",
        error,
        { rollbackSucceeded, createdWindowId }
      );
    }
  }

  async cloneTabIntoNamedGroup({ url, title, color, target }) {
    const created = target
      ? {
          windowId: target.windowId,
          tab: await this.createBackgroundTab(url, { windowId: target.windowId })
        }
      : await this.createBackgroundTabInNewWindow(url);

    try {
      if (created.tab.windowId !== created.windowId) {
        throw new Error("created tab is not in the dedicated window");
      }
      const groupId = target
        ? await this.groupTab(created.tab.id, target.groupId, {
            windowId: target.windowId
          })
        : await this.createGroupForTab(created.tab.id, { title, color });
      await this.configureGroup(groupId, { title, color, collapsed: true });
      const members = await this.getGroupTabs(groupId);
      if (!members.some((tab) => tab?.id === created.tab.id)) {
        throw new Error("created tab is not a confirmed named-group member");
      }
      return {
        title,
        color,
        windowId: created.windowId,
        groupId,
        tabId: created.tab.id,
        created: true,
        cloned: true,
        moved: false,
        duplicate: false
      };
    } catch (error) {
      const cleaned = await this.cleanupCreatedTab(created.tab.id);
      if (!cleaned) {
        throw makeOperationError(
          "named-group clone failed and cleanup could not be confirmed",
          error,
          { createdTabId: created.tab.id }
        );
      }
      throw error;
    }
  }

  /**
   * Add a current tab to an exact-title named group. A multi-tab source is
   * moved; a one-tab source is cloned so its original window survives.
   */
  async addCurrentTabToNamedGroup({
    tab,
    title = GROUP_TITLE,
    color = GROUP_COLOR
  } = {}) {
    return this.runGroupMutation(() => this.addCurrentTabToNamedGroupUnlocked({
      tab,
      title,
      color
    }));
  }

  async addCurrentTabToNamedGroupUnlocked({
    tab,
    title = GROUP_TITLE,
    color = GROUP_COLOR
  } = {}) {
    if (!tab || !isResourceId(tab.id) || !isResourceId(tab.windowId)) {
      throw new Error("current tab is unavailable");
    }
    const urlResult = normalizeHttpUrl(tabUrl(tab));
    if (!urlResult.valid) {
      throw new Error("current tab URL is not a supported http(s) page");
    }

    const sourceWindowId = tab.windowId;
    const sourceIndex = tab.index;
    const sourceGroupId = tab.groupId;
    if (!await this.getWindow(sourceWindowId)) {
      throw new Error("current tab is not in a normal window");
    }
    const sourceGroup = isResourceId(sourceGroupId)
      ? await this.getGroup(sourceGroupId)
      : null;

    // A one-tab TMP window should be consumed by triage, not cloned forever.
    // Keep the source window alive with one operation-owned placeholder until
    // the real tab has been moved and confirmed. On failure, the ordinary
    // rollback can still restore the original tab before the placeholder is
    // removed.
    const initialSourceTabs = await this.getWindowTabs(sourceWindowId);
    if (
      groupTitleKey(sourceGroup?.title) === groupTitleKey(TMP_GROUP_TITLE) &&
      initialSourceTabs.length <= 1
    ) {
      let placeholder = null;
      try {
        if (typeof this.tabsApi?.create === "function") {
          placeholder = await this.tabsApi.create({
            windowId: sourceWindowId,
            active: false,
            url: "about:blank"
          });
        }
        if (!isResourceId(placeholder?.id) || placeholder.windowId !== sourceWindowId) {
          throw new Error("temporary source placeholder could not be created");
        }
        return await this.addCurrentTabToNamedGroupUnlocked({ tab, title, color });
      } finally {
        if (isResourceId(placeholder?.id)) {
          const cleaned = await this.cleanupCreatedTab(placeholder.id);
          if (!cleaned) {
            this.logger.tab.warning("temporary source placeholder cleanup failed", {
              tabId: placeholder.id,
              windowId: sourceWindowId
            });
          }
        }
      }
    }

    const normalizedTab = { ...tab, url: urlResult.url };
    const prepared = await this.prepareNamedGroupUnlocked({
      title,
      color,
      preferredWindowId: sourceWindowId
    });
    const duplicate = await this.findGroupWithUrl(normalizedTab.url, {
      title,
      preferredWindowId: sourceWindowId
    });
    if (duplicate) {
      const duplicateColor = resolveGroupColor(title, color, duplicate.group.color);
      this.logger.tab.info("duplicate", {
        title,
        url: normalizedTab.url,
        groupId: duplicate.group.id,
        tabId: duplicate.tab.id
      });
      await this.configureGroup(duplicate.group.id, {
        title,
        color: duplicateColor,
        collapsed: true
      });
      return {
        title,
        color: duplicateColor,
        windowId: duplicate.group.windowId,
        groupId: duplicate.group.id,
        tabId: duplicate.tab.id,
        created: false,
        cloned: false,
        moved: false,
        duplicate: true
      };
    }

    const sourceTabs = await this.getWindowTabs(sourceWindowId);
    const routeColor = prepared?.color ?? resolveGroupColor(title, color);
    const target = prepared
      ? { windowId: prepared.windowId, groupId: prepared.groupId }
      : null;

    if (sourceTabs.length <= 1) {
      const result = await this.cloneTabIntoNamedGroup({
        url: normalizedTab.url,
        title,
        color: routeColor,
        target
      });
      await this.restoreTabContext({ windowId: sourceWindowId, tabId: normalizedTab.id });
      return result;
    }

    if (!target) {
      let moved = false;
      try {
        const created = await this.createWindowFromTab(normalizedTab.id);
        moved = true;
        const groupId = await this.createGroupForTab(normalizedTab.id, {
          title,
          color: routeColor
        });
        const members = await this.getGroupTabs(groupId);
        if (!members.some((member) => member?.id === normalizedTab.id)) {
          throw new Error("moved tab is not a confirmed named-group member");
        }
        await this.activateOriginalContext({
          windowId: sourceWindowId,
          movedTabId: normalizedTab.id,
          originalIndex: sourceIndex
        });
        return {
          title,
          color: routeColor,
          windowId: created.windowId,
          groupId,
          tabId: normalizedTab.id,
          created: false,
          cloned: false,
          moved: true,
          duplicate: false
        };
      } catch (error) {
        const current = await this.getTab(normalizedTab.id);
        if (!moved && current?.windowId !== sourceWindowId) {
          moved = true;
        }
        if (!moved) {
          throw error;
        }
        const rollbackSucceeded = await this.rollbackMovedTab({
          tabId: normalizedTab.id,
          sourceWindowId,
          sourceIndex,
          sourceGroupId,
          sourceGroup
        });
        if (!rollbackSucceeded) {
          throw makeOperationError(
            "current tab routing failed and rollback could not be confirmed",
            error,
            { rollbackSucceeded: false }
          );
        }
        await this.restoreTabContext({
          windowId: sourceWindowId,
          tabId: normalizedTab.id
        });
        throw error;
      }
    }

    if (target.windowId === sourceWindowId) {
      const groupId = await this.groupTab(normalizedTab.id, target.groupId, {
        windowId: target.windowId
      });
      await this.configureGroup(groupId, { title, color: routeColor, collapsed: true });
      await this.activateOriginalContext({
        windowId: sourceWindowId,
        movedTabId: normalizedTab.id,
        originalIndex: sourceIndex,
        excludedGroupId: groupId
      });
      return {
        title,
        color: routeColor,
        windowId: target.windowId,
        groupId,
        tabId: normalizedTab.id,
        created: false,
        cloned: false,
        moved: false,
        duplicate: false
      };
    }

    let moved = false;
    try {
      await this.moveTabToWindow(normalizedTab.id, target.windowId, -1);
      moved = true;
      const groupId = await this.groupTab(normalizedTab.id, target.groupId, {
        windowId: target.windowId
      });
      await this.configureGroup(groupId, { title, color: routeColor, collapsed: true });
      await this.activateOriginalContext({
        windowId: sourceWindowId,
        movedTabId: normalizedTab.id,
        originalIndex: sourceIndex
      });
      return {
        title,
        color: routeColor,
        windowId: target.windowId,
        groupId,
        tabId: normalizedTab.id,
        created: false,
        cloned: false,
        moved: true,
        duplicate: false
      };
    } catch (error) {
      const current = await this.getTab(normalizedTab.id);
      if (!moved && current?.windowId !== sourceWindowId) {
        moved = true;
      }
      if (moved) {
        const rollbackSucceeded = await this.rollbackMovedTab({
          tabId: normalizedTab.id,
          sourceWindowId,
          sourceIndex,
          sourceGroupId,
          sourceGroup
        });
        if (!rollbackSucceeded) {
          throw makeOperationError(
            "current tab routing failed and rollback could not be confirmed",
            error,
            { rollbackSucceeded: false }
          );
        }
      }

      await this.restoreTabContext({
        windowId: sourceWindowId,
        tabId: normalizedTab.id
      });

      this.logger.tab.warning("cross-window named-group route failed; using copy fallback", {
        tabId: normalizedTab.id,
        sourceWindowId,
        targetWindowId: target.windowId,
        error: describeError(error)
      });
      return this.cloneTabIntoNamedGroup({
        url: normalizedTab.url,
        title,
        color: routeColor,
        target
      });
    }
  }

  /**
   * Add a URL with a background tab and confirm its final group membership.
   * Only this operation's newly-created tab is eligible for cleanup.
   */
  async addUrlToNamedGroup({
    url,
    title = GROUP_TITLE,
    color = GROUP_COLOR
  } = {}) {
    return this.runGroupMutation(() => this.addUrlToNamedGroupUnlocked({
      url,
      title,
      color
    }));
  }

  async addUrlToNamedGroupUnlocked({
    url,
    title = GROUP_TITLE,
    color = GROUP_COLOR
  } = {}) {
    const urlResult = normalizeHttpUrl(url);
    if (!urlResult.valid) {
      throw new Error(urlResult.reason);
    }

    const prepared = await this.prepareNamedGroupUnlocked({ title, color });
    const duplicate = await this.findGroupWithUrl(urlResult.url, { title });
    if (duplicate) {
      const duplicateColor = resolveGroupColor(title, color, duplicate.group.color);
      this.logger.tab.info("duplicate", {
        title,
        url: urlResult.url,
        groupId: duplicate.group.id,
        tabId: duplicate.tab.id
      });
      await this.configureGroup(duplicate.group.id, {
        title,
        color: duplicateColor,
        collapsed: true
      });
      return {
        title,
        color: duplicateColor,
        windowId: duplicate.group.windowId,
        groupId: duplicate.group.id,
        tabId: duplicate.tab.id,
        created: false,
        cloned: false,
        moved: false,
        duplicate: true
      };
    }

    const routeColor = prepared?.color ?? resolveGroupColor(title, color);
    let createdTab = null;
    try {
      const created = prepared
        ? {
            windowId: prepared.windowId,
            tab: await this.createBackgroundTab(urlResult.url, {
              windowId: prepared.windowId
            })
          }
        : await this.createBackgroundTabInNewWindow(urlResult.url);
      createdTab = created.tab;
      if (createdTab.windowId !== created.windowId) {
        throw new Error("created tab is not in the dedicated window");
      }

      const groupId = prepared
        ? await this.groupTab(createdTab.id, prepared.groupId, {
            windowId: prepared.windowId
          })
        : await this.createGroupForTab(createdTab.id, { title, color: routeColor });
      await this.configureGroup(groupId, { title, color: routeColor, collapsed: true });
      const members = await this.getGroupTabs(groupId);
      if (!members.some((tab) => tab?.id === createdTab.id)) {
        throw new Error("created tab is not a confirmed named-group member");
      }

      return {
        title,
        color: routeColor,
        windowId: created.windowId,
        groupId,
        tabId: createdTab.id,
        created: true,
        cloned: false,
        moved: false,
        duplicate: false
      };
    } catch (error) {
      if (createdTab) {
        const cleaned = await this.cleanupCreatedTab(createdTab.id);
        if (!cleaned) {
          throw makeOperationError(
            "named-group URL import failed and cleanup could not be confirmed",
            error,
            { createdTabId: createdTab.id }
          );
        }
      }
      throw error;
    }
  }

  /**
   * Prepare, focus/restore, expand, and open the preferred exact-title group.
   */
  async openNamedGroup({
    title = GROUP_TITLE,
    color = GROUP_COLOR,
    preferredWindowId = null
  } = {}) {
    return this.runGroupMutation(() => this.openNamedGroupUnlocked({
      title,
      color,
      preferredWindowId
    }));
  }

  async openNamedGroupUnlocked({
    title = GROUP_TITLE,
    color = GROUP_COLOR,
    preferredWindowId = null
  } = {}) {
    const prepared = await this.prepareNamedGroupUnlocked({
      title,
      color,
      preferredWindowId
    });
    if (!prepared) {
      return null;
    }

    const opened = await this.openGroup({
      id: prepared.groupId,
      windowId: prepared.windowId,
      title,
      color
    });
    if (!opened) {
      return null;
    }
    return {
      ...prepared,
      group: opened.group,
      tab: opened.tab
    };
  }

  async openGroup(group) {
    if (!group || !isResourceId(group.id) || !isResourceId(group.windowId)) {
      throw new Error("tab group is unavailable");
    }

    const members = await this.getGroupTabs(group.id);
    if (members.length === 0) {
      return null;
    }

    await this.focusWindow(group.windowId, { restoreIfMinimized: true });

    this.assertGroupsApi();
    if (typeof this.tabsApi.update !== "function") {
      throw new Error("chrome.tabs.update is unavailable");
    }
    const expanded = await this.tabGroupsApi.update(group.id, { collapsed: false });
    if (!expanded) {
      throw new Error("tab group disappeared while opening");
    }
    this.logger.group.info("opened", { groupId: group.id, windowId: group.windowId });

    members.sort((left, right) => compareNumbers(left?.index, right?.index));
    const firstTab = members[0];
    await this.tabsApi.update(firstTab.id, { active: true });
    return { group, tab: firstTab };
  }
}
