import {
  READING_LIST_ALARM_NAME,
  TAB_EXPIRY_ALARM_NAME,
  TMP_GROUP_COLOR,
  TMP_GROUP_TITLE
} from "../core/constants.js";
import { BadgeManager } from "../core/badge-manager.js";
import { groupTitleKey } from "../core/group-title.js";
import { InboxManager } from "../core/inbox-manager.js";
import { describeError, logger } from "../core/logging.js";
import { TabGroupManager } from "../core/tab-group-manager.js";
import { TabExpiryManager } from "../core/tab-expiry-manager.js";
import { TemporaryInboxManager } from "../core/temporary-inbox-manager.js";
import { ReadingListInboxSource } from "../sources/reading-list-source.js";

const api = globalThis.chrome;
const readingListSource = new ReadingListInboxSource({
  readingListApi: api?.readingList,
  logger
});
const groupManager = new TabGroupManager({
  tabsApi: api?.tabs,
  tabGroupsApi: api?.tabGroups,
  windowsApi: api?.windows,
  logger
});
const badgeManager = new BadgeManager({
  tabsApi: api?.tabs,
  tabGroupsApi: api?.tabGroups,
  actionApi: api?.action,
  logger
});
const inboxManager = new InboxManager({
  storageArea: api?.storage?.local,
  readingListSource,
  groupManager,
  badgeManager,
  notificationsApi: api?.notifications,
  runtimeApi: api?.runtime,
  logger
});
const temporaryInboxManager = new TemporaryInboxManager({
  tabsApi: api?.tabs,
  settingsProvider: () => inboxManager.getSettings(),
  groupManager,
  logger
});
const tabExpiryManager = new TabExpiryManager({
  tabsApi: api?.tabs,
  tabGroupsApi: api?.tabGroups,
  settingsProvider: () => inboxManager.getSettings(),
  logger
});
const NEW_TAB_SETTLE_DELAY_MS = 350;
const GROUP_UNIQUENESS_SETTLE_DELAY_MS = 200;
const pendingNewTabIds = new Set();
const pendingNewTabTimers = new Map();
const startupSuppressedTabIds = new Set();
let startupCaptureInProgress = false;
let groupUniquenessTimer = null;

// This queue only suppresses duplicate work during one worker lifecycle. The
// durable state remains in Chrome storage, tabs/groups, and Reading List.
let serializedWork = Promise.resolve();

function enqueue(label, work) {
  serializedWork = serializedWork
    .catch((error) => {
      logger.error("previous queued work failed", {
        label,
        error: describeError(error)
      });
    })
    .then(work)
    .catch((error) => {
      logger.error("queued work failed", { label, error: describeError(error) });
      return { ok: false, message: "処理中にエラーが発生しました" };
    });
  return serializedWork;
}

function fire(label, work) {
  void enqueue(label, work);
}

function scheduleGroupUniquenessReconciliation(label) {
  if (groupUniquenessTimer !== null) {
    clearTimeout(groupUniquenessTimer);
  }
  groupUniquenessTimer = setTimeout(() => {
    groupUniquenessTimer = null;
    fire(`group-uniqueness:${label}`, () =>
      inboxManager.reconcileGroupUniqueness()
    );
  }, GROUP_UNIQUENESS_SETTLE_DELAY_MS);
}

function isResourceId(value) {
  return Number.isInteger(value) && value >= 0;
}

async function openGroupPicker(mode) {
  if (!api?.windows || typeof api.windows.create !== "function") {
    return { ok: false, message: "グループ選択ウィンドウを開けません" };
  }

  const currentTab = await groupManager.getCurrentTab();
  const currentUrl = currentTab?.pendingUrl ?? currentTab?.url ?? "";
  const pickerPageUrl = api.runtime.getURL("group-picker/group-picker.html");
  if (
    isResourceId(currentTab?.windowId) &&
    typeof currentUrl === "string" &&
    currentUrl.startsWith(pickerPageUrl)
  ) {
    await api.windows.update(currentTab.windowId, { focused: true });
    return {
      ok: true,
      reused: true,
      windowId: currentTab.windowId,
      message: "開いているグループ選択画面を使用してください"
    };
  }

  let tabId = null;
  let preferredWindowId = await groupManager.getPreferredNormalWindowId();
  if (mode === "assign") {
    const tab = currentTab;
    if (!isResourceId(tab?.id)) {
      return { ok: false, message: "現在のタブを取得できませんでした" };
    }
    tabId = tab.id;
    preferredWindowId = isResourceId(tab.windowId) ? tab.windowId : preferredWindowId;
  }

  const query = new URLSearchParams({ mode });
  if (isResourceId(tabId)) {
    query.set("tabId", String(tabId));
  }
  if (isResourceId(preferredWindowId)) {
    query.set("preferredWindowId", String(preferredWindowId));
  }
  const pickerUrl = api.runtime.getURL(`group-picker/group-picker.html?${query}`);
  if (typeof api.windows.getAll === "function") {
    try {
      const popupWindows = await api.windows.getAll({
        populate: true,
        windowTypes: ["popup"]
      });
      const existingPicker = (popupWindows ?? [])
        .filter((window) => isResourceId(window?.id))
        .flatMap((window) => (window.tabs ?? []).map((tab) => ({ window, tab })))
        .find(({ tab }) => {
          const url = tab?.pendingUrl ?? tab?.url ?? "";
          return isResourceId(tab?.id) && url.startsWith(pickerPageUrl);
        });

      if (existingPicker) {
        if (typeof api.tabs?.update === "function") {
          await api.tabs.update(existingPicker.tab.id, {
            active: true,
            url: pickerUrl
          });
        }
        await api.windows.update(existingPicker.window.id, {
          focused: true,
          width: 560,
          height: 640
        });
        return {
          ok: true,
          reused: true,
          windowId: existingPicker.window.id,
          tabId,
          preferredWindowId,
          message: "開いているグループ選択画面を再利用しました"
        };
      }
    } catch (error) {
      logger.group.warning("existing group picker lookup failed", describeError(error));
    }
  }

  const pickerWindow = await api.windows.create({
    url: pickerUrl,
    type: "popup",
    focused: true,
    width: 560,
    height: 640
  });
  if (!isResourceId(pickerWindow?.id)) {
    return { ok: false, message: "グループ選択ウィンドウを開けませんでした" };
  }
  return {
    ok: true,
    windowId: pickerWindow.id,
    tabId,
    preferredWindowId,
    message: mode === "open"
      ? "開くグループを選んでください"
      : "入れるグループを選んでください"
  };
}

async function ensureReadingListAlarm() {
  if (!api?.alarms || typeof api.alarms.create !== "function") {
    logger.error("alarm API unavailable");
    return false;
  }

  try {
    await api.alarms.create(READING_LIST_ALARM_NAME, { periodInMinutes: 1 });
    return true;
  } catch (error) {
    logger.error("reading list alarm setup failed", describeError(error));
    return false;
  }
}

async function ensureTabExpiryAlarm() {
  try {
    const existing = await api.alarms.get(TAB_EXPIRY_ALARM_NAME);
    if (!existing) {
      await api.alarms.create(TAB_EXPIRY_ALARM_NAME, { periodInMinutes: 1 });
    }
    return true;
  } catch (error) {
    logger.error("tab expiry alarm setup failed", describeError(error));
    return false;
  }
}

function registerListener(event, callback) {
  if (event && typeof event.addListener === "function") {
    event.addListener(callback);
    return true;
  }
  return false;
}

registerListener(api?.runtime?.onInstalled, (details) => {
  fire("runtime.onInstalled", async () => {
    await inboxManager.initialize({
      scan: details?.reason === "install" || details?.reason === "update",
      reason: `onInstalled:${details?.reason ?? "unknown"}`
    });
    await ensureReadingListAlarm();
    await ensureTabExpiryAlarm();
    await tabExpiryManager.scan();
  });
});

function suppressPendingNewTabsForStartup() {
  startupCaptureInProgress = true;
  for (const [tabId, timerId] of pendingNewTabTimers) {
    clearTimeout(timerId);
    startupSuppressedTabIds.add(tabId);
  }
  pendingNewTabTimers.clear();
  for (const tabId of pendingNewTabIds) {
    startupSuppressedTabIds.add(tabId);
  }
  pendingNewTabIds.clear();
}

registerListener(api?.runtime?.onStartup, () => {
  // Chrome can emit tabs.onCreated while it restores a previous session, and
  // onCreated may run before the restored groupId is available. Suppress that
  // path synchronously; captureStartupTabs intentionally handles only one
  // active, still-ungrouped tab per normal window.
  suppressPendingNewTabsForStartup();
  fire("runtime.onStartup", async () => {
    try {
      await inboxManager.initialize({ scan: true, reason: "onStartup" });
      await ensureReadingListAlarm();
      await ensureTabExpiryAlarm();
      await tabExpiryManager.scan();
      return await temporaryInboxManager.captureStartupTabs();
    } finally {
      startupCaptureInProgress = false;
    }
  });
});

function cancelPendingNewTabCapture(tabId) {
  const timerId = pendingNewTabTimers.get(tabId);
  if (timerId !== undefined) {
    clearTimeout(timerId);
    pendingNewTabTimers.delete(tabId);
  }
}

function scheduleNewTabCapture(tabId, label) {
  cancelPendingNewTabCapture(tabId);
  const timerId = setTimeout(() => {
    pendingNewTabTimers.delete(tabId);
    fire(label, () => {
      if (startupSuppressedTabIds.has(tabId)) {
        return { ok: true, skipped: true, startupRestore: true, tabId };
      }
      return temporaryInboxManager.captureTab(tabId, { source: "new-tab" });
    });
  }, NEW_TAB_SETTLE_DELAY_MS);
  pendingNewTabTimers.set(tabId, timerId);
}

function queueNewTabCapture(tab, label) {
  if (!isResourceId(tab?.id)) {
    return;
  }
  if (startupCaptureInProgress) {
    cancelPendingNewTabCapture(tab.id);
    pendingNewTabIds.delete(tab.id);
    startupSuppressedTabIds.add(tab.id);
    return;
  }
  const url = tab.pendingUrl || tab.url || "";
  if (!url) {
    pendingNewTabIds.add(tab.id);
    return;
  }
  pendingNewTabIds.delete(tab.id);
  // Chrome documents that URL and group membership can both be absent during
  // onCreated. A short debounce lets restored/manual grouping settle; capture
  // then re-reads the live tab and leaves any already-grouped tab untouched.
  scheduleNewTabCapture(tab.id, label);
}

registerListener(api?.tabs?.onCreated, (tab) => {
  queueNewTabCapture(tab, "tmp.tabs.onCreated");
});

registerListener(api?.tabs?.onUpdated, (tabId, _changeInfo, tab) => {
  if (pendingNewTabIds.has(tabId)) {
    queueNewTabCapture(tab, "tmp.tabs.onUpdated");
  }
});

registerListener(api?.tabs?.onRemoved, (tabId) => {
  cancelPendingNewTabCapture(tabId);
  pendingNewTabIds.delete(tabId);
  startupSuppressedTabIds.delete(tabId);
});

registerListener(api?.alarms?.onAlarm, (alarm) => {
  if (alarm?.name === TAB_EXPIRY_ALARM_NAME) {
    fire("tab-expiry.alarm", () => tabExpiryManager.scan());
    return;
  }
  if (alarm?.name !== READING_LIST_ALARM_NAME) {
    return;
  }
  fire("reading-list.alarm", () =>
    inboxManager.scanReadingList({ reason: "alarm" })
  );
});

if (readingListSource.registerEntryAddedListener((entry) => {
  fire("reading-list.onEntryAdded", () => inboxManager.importReadingListEntry(entry));
})) {
  logger.readingList.info("onEntryAdded listener registered");
}

registerListener(api?.commands?.onCommand, (command) => {
  if (command === "add-to-unfinished") {
    fire("command.add-to-unfinished", () => inboxManager.addCurrentTab());
  } else if (command === "open-unfinished") {
    fire("command.open-unfinished", () => inboxManager.openUnfinished());
  } else if (command === "choose-group-for-current") {
    fire("command.choose-group-for-current", () => openGroupPicker("assign"));
  } else if (command === "open-group-picker") {
    fire("command.open-group-picker", () => openGroupPicker("open"));
  }
});

registerListener(api?.runtime?.onMessage, (message, _sender, sendResponse) => {
  if (!message || typeof message.action !== "string") {
    return false;
  }

  const action = message.action;
  let task;
  switch (action) {
    case "get-status":
      task = () => inboxManager.getStatus();
      break;
    case "open-unfinished":
      task = () => inboxManager.openUnfinished();
      break;
    case "add-current-tab":
      task = () => inboxManager.addCurrentTab();
      break;
    case "show-assign-group-picker":
      task = () => openGroupPicker("assign");
      break;
    case "show-open-group-picker":
      task = () => openGroupPicker("open");
      break;
    case "get-group-picker-data":
      task = async () => {
        const preferredWindowId = isResourceId(message.preferredWindowId)
          ? message.preferredWindowId
          : null;
        const settings = await inboxManager.getSettings();
        await inboxManager.reconcileGroupUniqueness(settings);
        const groups = await groupManager.listNamedGroupSummaries(preferredWindowId);
        const tmpTitleKey = groupTitleKey(TMP_GROUP_TITLE);
        const tmp = groups.find(
          (group) => groupTitleKey(group.title) === tmpTitleKey
        ) ?? {
          title: TMP_GROUP_TITLE,
          color: TMP_GROUP_COLOR,
          tabCount: 0,
          groupCount: 0,
          windowCount: 0
        };
        let target = null;
        if (isResourceId(message.tabId)) {
          try {
            const tab = await api.tabs.get(message.tabId);
            target = {
              id: tab.id,
              title: tab.title ?? "",
              url: tab.pendingUrl ?? tab.url ?? ""
            };
          } catch (error) {
            logger.tab.warning("group picker target unavailable", describeError(error));
          }
        }
        return {
          ok: true,
          groups,
          target,
          presets: settings.presetGroups,
          tmp
        };
      };
      break;
    case "assign-tab-to-group":
      task = () => inboxManager.assignTabToGroup({
        tabId: message.tabId,
        title: message.title,
        color: message.color
      });
      break;
    case "open-group-by-name":
      task = () => inboxManager.openGroupByName({
        title: message.title,
        color: message.color,
        preferredWindowId: message.preferredWindowId
      });
      break;
    case "scan-existing-reading-list":
      task = () => inboxManager.scanReadingList({
        includeExisting: true,
        force: true,
        reason: "manual-existing"
      });
      break;
    case "set-settings":
      task = async () => {
        try {
          const settings = await inboxManager.updateSettings(message.settings ?? {});
          if (settings.readingListEnabled) {
            await inboxManager.scanReadingList({ reason: "settings-enabled" });
          }
          return { ok: true, settings };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : "設定を保存できませんでした"
          };
        }
      };
      break;
    default:
      return false;
  }

  enqueue(`message:${action}`, task).then((result) => {
    try {
      sendResponse(result);
    } catch (error) {
      logger.error("message response failed", describeError(error));
    }
  });
  return true;
});

const badgeEvents = [
  [api?.tabs?.onCreated, "tabs.onCreated"],
  [api?.tabs?.onRemoved, "tabs.onRemoved"],
  [api?.tabs?.onUpdated, "tabs.onUpdated"],
  [api?.tabs?.onMoved, "tabs.onMoved"],
  [api?.tabs?.onAttached, "tabs.onAttached"],
  [api?.tabs?.onDetached, "tabs.onDetached"],
  [api?.tabs?.onReplaced, "tabs.onReplaced"],
  [api?.tabGroups?.onCreated, "tabGroups.onCreated"],
  [api?.tabGroups?.onRemoved, "tabGroups.onRemoved"],
  [api?.tabGroups?.onUpdated, "tabGroups.onUpdated"]
];
for (const [event, label] of badgeEvents) {
  registerListener(event, () => {
    fire(`badge:${label}`, () => inboxManager.updateBadge());
  });
}

registerListener(api?.tabGroups?.onCreated, () => {
  scheduleGroupUniquenessReconciliation("tabGroups.onCreated");
});
registerListener(api?.tabGroups?.onUpdated, () => {
  scheduleGroupUniquenessReconciliation("tabGroups.onUpdated");
});
registerListener(api?.tabs?.onAttached, () => {
  scheduleGroupUniquenessReconciliation("tabs.onAttached");
});
registerListener(api?.tabs?.onDetached, () => {
  scheduleGroupUniquenessReconciliation("tabs.onDetached");
});

// A worker can start without an onStartup event. Re-establish defaults,
// refresh the badge, and reconcile recent Reading List entries on every boot.
fire("worker-start", async () => {
  await inboxManager.initialize({ scan: true, reason: "worker-start" });
  await ensureReadingListAlarm();
  await ensureTabExpiryAlarm();
  await tabExpiryManager.scan();
});
