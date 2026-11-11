import {
  DEFAULT_SETTINGS,
  GROUP_COLOR,
  GROUP_TITLE,
  READING_LIST_SOURCE,
  TMP_GROUP_COLOR,
  TMP_GROUP_TITLE
} from "./constants.js";
import { describeError, logger as defaultLogger } from "./logging.js";
import {
  MAX_GROUP_TITLE_LENGTH,
  groupTitleKey,
  normalizeGroupTitle
} from "./group-title.js";
import { normalizeHttpUrl } from "./url-utils.js";
import {
  GROUP_COLORS,
  clonePresetGroups,
  presetGroupsEqual,
  sanitizePresetGroups,
  validatePresetGroups
} from "./workflow-settings.js";

const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));
const GROUP_COLOR_SET = new Set(GROUP_COLORS);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isStoredTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isInteger(value) {
  return Number.isInteger(value);
}

function isResourceId(value) {
  return isInteger(value) && value >= 0;
}

function validateNamedGroup({ title = GROUP_TITLE, color = GROUP_COLOR } = {}) {
  if (typeof title !== "string") {
    return { valid: false, message: "グループ名は文字列で指定してください" };
  }
  const normalizedTitle = normalizeGroupTitle(title);
  if (normalizedTitle.length === 0) {
    return { valid: false, message: "グループ名を入力してください" };
  }
  if (normalizedTitle.length > MAX_GROUP_TITLE_LENGTH) {
    return {
      valid: false,
      message: `グループ名は${MAX_GROUP_TITLE_LENGTH}文字以内で指定してください`
    };
  }
  if (typeof color !== "string" || !GROUP_COLOR_SET.has(color)) {
    return { valid: false, message: "グループ色が正しくありません" };
  }
  return { valid: true, title: normalizedTitle, color };
}

export class InboxManager {
  constructor({
    storageArea = globalThis.chrome?.storage?.local,
    readingListSource = null,
    sourceRegistry = {},
    groupManager,
    badgeManager,
    notificationsApi = globalThis.chrome?.notifications,
    runtimeApi = globalThis.chrome?.runtime,
    logger = defaultLogger
  } = {}) {
    this.storageArea = storageArea;
    this.readingListSource = readingListSource;
    this.sourceRegistry = new Map(Object.entries(sourceRegistry));
    if (readingListSource?.name) {
      this.sourceRegistry.set(readingListSource.name, readingListSource);
    }
    this.groupManager = groupManager;
    this.badgeManager = badgeManager;
    this.notificationsApi = notificationsApi;
    this.runtimeApi = runtimeApi;
    this.logger = logger;
  }

  assertStorage() {
    if (
      !this.storageArea ||
      typeof this.storageArea.get !== "function" ||
      typeof this.storageArea.set !== "function"
    ) {
      throw new Error("chrome.storage.local is unavailable");
    }
  }

  async getSettings() {
    return this.ensureSettings();
  }

  async reconcileGroupUniqueness(settings = null) {
    if (typeof this.groupManager?.reconcileUniqueGroups !== "function") {
      return {
        ok: true,
        unavailable: true,
        checkedGroupCount: 0,
        mergedGroupCount: 0,
        movedTabCount: 0,
        updatedGroupCount: 0
      };
    }
    const resolvedSettings = settings ?? await this.ensureSettings();
    return this.groupManager.reconcileUniqueGroups({
      preferredGroups: resolvedSettings.presetGroups
    });
  }

  async ensureSettings() {
    this.assertStorage();
    const stored = (await this.storageArea.get(SETTINGS_KEYS)) ?? {};
    const current = {
      ...DEFAULT_SETTINGS,
      ...stored,
      presetGroups: sanitizePresetGroups(
        hasOwn(stored, "presetGroups") ? stored.presetGroups : DEFAULT_SETTINGS.presetGroups
      )
    };
    const patch = {};

    if (!hasOwn(stored, "bridgeEnabledAt") || !isStoredTimestamp(current.bridgeEnabledAt)) {
      patch.bridgeEnabledAt = Date.now();
    }
    if (!hasOwn(stored, "readingListEnabled") || typeof current.readingListEnabled !== "boolean") {
      patch.readingListEnabled = DEFAULT_SETTINGS.readingListEnabled;
    }
    if (!hasOwn(stored, "removeAfterImport") || typeof current.removeAfterImport !== "boolean") {
      patch.removeAfterImport = DEFAULT_SETTINGS.removeAfterImport;
    }
    if (!hasOwn(stored, "lastSyncAt") || (current.lastSyncAt !== null && !isStoredTimestamp(current.lastSyncAt))) {
      patch.lastSyncAt = null;
    }
    if (!hasOwn(stored, "tmpEnabled") || typeof current.tmpEnabled !== "boolean") {
      patch.tmpEnabled = DEFAULT_SETTINGS.tmpEnabled;
    }
    if (!hasOwn(stored, "tmpCaptureNewTabs") || typeof current.tmpCaptureNewTabs !== "boolean") {
      patch.tmpCaptureNewTabs = DEFAULT_SETTINGS.tmpCaptureNewTabs;
    }
    if (!hasOwn(stored, "tmpCaptureStartup") || typeof current.tmpCaptureStartup !== "boolean") {
      patch.tmpCaptureStartup = DEFAULT_SETTINGS.tmpCaptureStartup;
    }
    if (
      !hasOwn(stored, "presetGroups") ||
      !presetGroupsEqual(current.presetGroups, stored.presetGroups)
    ) {
      patch.presetGroups = clonePresetGroups(current.presetGroups);
    }

    if (Object.keys(patch).length > 0) {
      await this.storageArea.set(patch);
    }

    const resolved = { ...current, ...patch };
    return {
      ...resolved,
      presetGroups: clonePresetGroups(resolved.presetGroups)
    };
  }

  async updateSettings(settings = {}) {
    this.assertStorage();
    const patch = {};
    if (typeof settings.readingListEnabled === "boolean") {
      patch.readingListEnabled = settings.readingListEnabled;
    }
    if (typeof settings.removeAfterImport === "boolean") {
      patch.removeAfterImport = settings.removeAfterImport;
    }
    if (typeof settings.tmpEnabled === "boolean") {
      patch.tmpEnabled = settings.tmpEnabled;
    }
    if (typeof settings.tmpCaptureNewTabs === "boolean") {
      patch.tmpCaptureNewTabs = settings.tmpCaptureNewTabs;
    }
    if (typeof settings.tmpCaptureStartup === "boolean") {
      patch.tmpCaptureStartup = settings.tmpCaptureStartup;
    }
    if (Object.prototype.hasOwnProperty.call(settings, "presetGroups")) {
      const validation = validatePresetGroups(settings.presetGroups);
      if (!validation.valid) {
        throw new Error(validation.message);
      }
      patch.presetGroups = clonePresetGroups(validation.groups);
    }

    if (Object.keys(patch).length > 0) {
      await this.storageArea.set(patch);
    }
    const resolvedSettings = await this.ensureSettings();
    await this.reconcileGroupUniqueness(resolvedSettings);
    return resolvedSettings;
  }

  async initialize({ scan = false, reason = "worker-start" } = {}) {
    const settings = await this.ensureSettings();
    await this.reconcileGroupUniqueness(settings);
    await this.updateBadge();
    if (scan && settings.readingListEnabled) {
      await this.scanReadingList({ reason });
    }
    return settings;
  }

  async updateBadge() {
    if (!this.badgeManager || typeof this.badgeManager.update !== "function") {
      return null;
    }
    return this.badgeManager.update();
  }

  sourceForItem(item) {
    if (!item?.source) {
      return null;
    }
    return this.sourceRegistry.get(item.source) ?? null;
  }

  async acknowledgeAfterTransfer(item) {
    const source = this.sourceForItem(item);
    if (!source || typeof source.acknowledge !== "function") {
      this.logger.queue.warning("source has no acknowledgement handler", {
        source: item.source,
        url: item.url
      });
      return {
        acknowledged: false,
        acknowledgementFailed: true,
        reason: "source acknowledgement is unavailable"
      };
    }

    try {
      await source.acknowledge(item);
      return { acknowledged: true, acknowledgementFailed: false };
    } catch (error) {
      this.logger.error("source acknowledgement failed; item retained", {
        source: item.source,
        url: item.url,
        error: describeError(error)
      });
      return {
        acknowledged: false,
        acknowledgementFailed: true,
        reason: "Reading Listからの削除に失敗しました"
      };
    }
  }

  async finishTransfer(item, {
    acknowledge = true,
    duplicate = false,
    groupId = null,
    message = null
  } = {}) {
    const result = {
      ok: true,
      transferred: true,
      duplicate,
      groupId,
      acknowledged: false,
      acknowledgementFailed: false,
      retained: !acknowledge,
      message: message ?? (duplicate ? "同じURLは既にInboxにあります" : "Inboxへ追加しました")
    };

    if (!acknowledge) {
      return result;
    }

    const acknowledgement = await this.acknowledgeAfterTransfer(item);
    return { ...result, ...acknowledgement, retained: !acknowledgement.acknowledged };
  }

  async importItem(item, { acknowledge = true, reason = "scan" } = {}) {
    const urlResult = normalizeHttpUrl(item?.url);
    if (!urlResult.valid) {
      this.logger.error("invalid InboxItem skipped", {
        source: item?.source ?? null,
        url: item?.url ?? null,
        reason: urlResult.reason
      });
      return {
        ok: false,
        skipped: true,
        transferred: false,
        message: urlResult.reason
      };
    }

    const normalizedItem = { ...item, url: urlResult.url };
    this.logger.inbox.info("item received", {
      source: normalizedItem.source,
      url: normalizedItem.url,
      reason
    });

    let added;
    try {
      added = await this.groupManager.addUrlToNamedGroup({
        url: normalizedItem.url,
        title: GROUP_TITLE,
        color: GROUP_COLOR
      });
    } catch (error) {
      this.logger.error("Inbox URL import failed; source item retained", {
        source: normalizedItem.source,
        url: normalizedItem.url,
        error: describeError(error)
      });
      return {
        ok: false,
        transferred: false,
        message: "タブをInboxへ追加できませんでした"
      };
    }

    const badgeCount = await this.updateBadge();
    if (badgeCount === null) {
      return {
        ok: false,
        transferred: true,
        duplicate: Boolean(added?.duplicate),
        groupId: added?.groupId ?? null,
        message: added?.duplicate
          ? "重複は確認しましたが、バッジ更新に失敗しました"
          : "タブは追加しましたが、バッジ更新に失敗しました"
      };
    }

    return this.finishTransfer(normalizedItem, {
      acknowledge,
      duplicate: Boolean(added?.duplicate),
      groupId: added?.groupId ?? null
    });
  }

  async scanReadingList({ includeExisting = false, reason = "scan", force = false } = {}) {
    const settings = await this.ensureSettings();
    if (!force && !settings.readingListEnabled) {
      return {
        ok: true,
        disabled: true,
        scanned: 0,
        eligible: 0,
        imported: 0,
        acknowledged: 0,
        message: "Reading List取り込みはOFFです"
      };
    }
    if (!this.readingListSource || typeof this.readingListSource.listPending !== "function") {
      return {
        ok: false,
        scanned: 0,
        eligible: 0,
        imported: 0,
        acknowledged: 0,
        message: "Reading List APIを利用できません"
      };
    }

    this.logger.readingList.info("sync scan started", { includeExisting, reason });
    let pending;
    try {
      pending = await this.readingListSource.listPending({
        includeExisting,
        bridgeEnabledAt: settings.bridgeEnabledAt
      });
    } catch (error) {
      this.logger.error("Reading List query failed; source items retained", describeError(error));
      return {
        ok: false,
        scanned: 0,
        eligible: 0,
        imported: 0,
        acknowledged: 0,
        message: "Reading Listの確認に失敗しました"
      };
    }

    try {
      await this.storageArea.set({ lastSyncAt: Date.now() });
    } catch (error) {
      this.logger.error("last sync timestamp could not be stored", describeError(error));
    }

    const items = Array.isArray(pending?.items) ? pending.items : [];
    const summary = {
      ok: true,
      scanned: Number.isInteger(pending?.scanned) ? pending.scanned : items.length,
      eligible: items.length,
      skipped: Array.isArray(pending?.skipped) ? pending.skipped : [],
      imported: 0,
      duplicates: 0,
      acknowledged: 0,
      acknowledgementFailed: 0,
      retained: 0,
      failed: 0,
      results: []
    };

    for (const item of items) {
      const result = await this.importItem(item, {
        acknowledge: settings.removeAfterImport,
        reason
      });
      if (result.ok && result.transferred && item.source === READING_LIST_SOURCE) {
        this.logger.readingList.info("imported", {
          url: item.url,
          duplicate: Boolean(result.duplicate),
          acknowledged: Boolean(result.acknowledged)
        });
      }
      summary.results.push({ url: item.url, ...result });
      if (result.transferred) {
        summary.imported += 1;
      }
      if (result.duplicate) {
        summary.duplicates += 1;
      }
      if (result.acknowledged) {
        summary.acknowledged += 1;
      }
      if (result.acknowledgementFailed) {
        summary.acknowledgementFailed += 1;
      }
      if (result.retained) {
        summary.retained += 1;
      }
      if (!result.ok) {
        summary.failed += 1;
      }
    }

    summary.partial = summary.failed > 0 || summary.acknowledgementFailed > 0;

    await this.updateBadge();
    this.logger.readingList.info("sync scan finished", {
      scanned: summary.scanned,
      imported: summary.imported,
      acknowledged: summary.acknowledged,
      acknowledgementFailed: summary.acknowledgementFailed,
      failed: summary.failed
    });
    return summary;
  }

  async importReadingListEntry(entry, { reason = "entry-added" } = {}) {
    if (entry?.hasBeenRead !== false) {
      return { ok: true, skipped: true, message: "既読Reading List項目は対象外です" };
    }

    const settings = await this.ensureSettings();
    if (!settings.readingListEnabled) {
      return { ok: true, skipped: true, message: "Reading List取り込みはOFFです" };
    }
    if (!this.readingListSource || typeof this.readingListSource.toInboxItem !== "function") {
      return { ok: false, message: "Reading List APIを利用できません" };
    }

    this.logger.readingList.info("entry detected", { url: entry?.url ?? null });
    const result = this.readingListSource.toInboxItem(entry, {
      includeExisting: false,
      bridgeEnabledAt: settings.bridgeEnabledAt
    });
    if (!result.item) {
      return { ok: true, skipped: true, message: result.reason };
    }

    const imported = await this.importItem(result.item, {
      acknowledge: settings.removeAfterImport,
      reason
    });
    if (imported.ok && imported.transferred) {
      this.logger.readingList.info("imported", {
        url: result.item.url,
        duplicate: Boolean(imported.duplicate),
        acknowledged: Boolean(imported.acknowledged)
      });
    }
    try {
      await this.storageArea.set({ lastSyncAt: Date.now() });
    } catch (error) {
      this.logger.error("last sync timestamp could not be stored", describeError(error));
    }
    return imported;
  }

  validateNamedGroup(options = {}) {
    return validateNamedGroup(options);
  }

  async routeTabToNamedGroup({ tab, title, color }) {
    let added;
    try {
      added = await this.groupManager.addCurrentTabToNamedGroup({
        tab,
        title,
        color
      });
    } catch (error) {
      this.logger.error("named group tab assignment failed", describeError(error));
      return {
        ok: false,
        transferred: false,
        title,
        color,
        message: "現在のタブを指定グループへ追加できませんでした"
      };
    }

    const badgeCount = title === GROUP_TITLE ? await this.updateBadge() : null;
    const badgeFailed = title === GROUP_TITLE && badgeCount === null;
    return {
      ok: !badgeFailed,
      transferred: true,
      title,
      color: added?.color ?? color,
      groupId: added?.groupId ?? null,
      windowId: added?.windowId ?? null,
      tabId: added?.tabId ?? null,
      duplicate: Boolean(added?.duplicate),
      cloned: Boolean(added?.cloned),
      moved: Boolean(added?.moved),
      message: badgeFailed
        ? "指定グループへ追加しましたが、バッジ更新に失敗しました"
        : added?.duplicate
          ? "同じURLは既に指定グループにあります"
          : added?.cloned
            ? "1タブのウィンドウを保護するため、コピーを指定グループへ追加しました"
            : "現在のタブを指定グループへ追加しました"
    };
  }

  /**
   * Assign one explicit tab to a named group. This is the picker-safe path:
   * it never derives a tab from the currently focused extension window.
   */
  async assignTabToGroup({
    tabId,
    title = GROUP_TITLE,
    color = GROUP_COLOR
  } = {}) {
    const groupResult = validateNamedGroup({ title, color });
    if (!groupResult.valid) {
      return { ok: false, skipped: true, message: groupResult.message };
    }
    if (!isResourceId(tabId)) {
      return { ok: false, skipped: true, message: "対象タブを指定してください" };
    }

    let tab;
    try {
      if (typeof this.groupManager?.getTab !== "function") {
        throw new Error("tab lookup is unavailable");
      }
      tab = await this.groupManager.getTab(tabId);
    } catch (error) {
      this.logger.error("selected tab lookup failed", describeError(error));
      return { ok: false, message: "選択したタブを取得できませんでした" };
    }
    if (!tab) {
      return { ok: false, message: "選択したタブを取得できませんでした" };
    }

    const urlResult = normalizeHttpUrl(tab.pendingUrl || tab.url);
    if (!urlResult.valid) {
      return {
        ok: false,
        skipped: true,
        message: "http または https のページだけを指定グループへ追加できます"
      };
    }
    return this.routeTabToNamedGroup({
      tab: { ...tab, url: urlResult.url },
      title: groupResult.title,
      color: groupResult.color
    });
  }

  /**
   * Assign the current tab to a named group. Pass tabId when the picker has
   * taken focus; without it, the direct current-tab lookup is used.
   */
  async assignCurrentTabToGroup({
    tabId = null,
    title = GROUP_TITLE,
    color = GROUP_COLOR
  } = {}) {
    if (tabId !== null && tabId !== undefined) {
      return this.assignTabToGroup({ tabId, title, color });
    }

    const groupResult = validateNamedGroup({ title, color });
    if (!groupResult.valid) {
      return { ok: false, skipped: true, message: groupResult.message };
    }

    let tab;
    try {
      tab = await this.groupManager.getCurrentTab();
    } catch (error) {
      this.logger.error("current tab lookup failed", describeError(error));
      return { ok: false, message: "現在のタブを取得できませんでした" };
    }
    const urlResult = normalizeHttpUrl(tab?.pendingUrl || tab?.url);
    if (!tab || !urlResult.valid) {
      return {
        ok: false,
        skipped: true,
        message: "http または https のページだけを指定グループへ追加できます"
      };
    }

    return this.routeTabToNamedGroup({
      tab: { ...tab, url: urlResult.url },
      title: groupResult.title,
      color: groupResult.color
    });
  }

  async openGroupByName({
    title = GROUP_TITLE,
    color = GROUP_COLOR,
    preferredWindowId = null
  } = {}) {
    const groupResult = validateNamedGroup({ title, color });
    if (!groupResult.valid) {
      return { ok: false, skipped: true, message: groupResult.message };
    }

    try {
      const opened = await this.groupManager.openNamedGroup({
        title: groupResult.title,
        color: groupResult.color,
        preferredWindowId: isResourceId(preferredWindowId) ? preferredWindowId : null
      });
      if (!opened) {
        return {
          ok: false,
          empty: true,
          title: groupResult.title,
          color: groupResult.color,
          message: "指定グループにはタブがありません"
        };
      }
      return {
        ok: true,
        title: groupResult.title,
        color: opened.color ?? groupResult.color,
        groupId: opened.groupId,
        windowId: opened.windowId,
        tabId: opened.tab?.id ?? opened.tabId ?? null,
        message: "指定グループを開きました"
      };
    } catch (error) {
      this.logger.error("named group open failed", describeError(error));
      return {
        ok: false,
        title: groupResult.title,
        color: groupResult.color,
        message: "指定グループを開けませんでした"
      };
    }
  }

  async openUnfinished() {
    const opened = await this.openGroupByName({
      title: GROUP_TITLE,
      color: GROUP_COLOR
    });
    if (opened.ok) {
      const badgeCount = await this.updateBadge();
      return {
        ...opened,
        ok: badgeCount !== null,
        message: badgeCount === null
          ? "未処理タブを開きましたが、バッジ更新に失敗しました"
          : "未処理タブを開きました"
      };
    }
    if (opened.empty) {
      await this.notify("まだやっていない", "まだやっていないタブはありません");
      await this.updateBadge();
      return {
        ...opened,
        message: "まだやっていないタブはありません"
      };
    }
    return {
      ...opened,
      message: opened.message ?? "Inboxを開けませんでした"
    };
  }

  async addCurrentTab() {
    return this.assignCurrentTabToGroup({
      title: GROUP_TITLE,
      color: GROUP_COLOR
    });
  }

  async notify(title, message) {
    if (!this.notificationsApi || typeof this.notificationsApi.create !== "function") {
      this.logger.queue.warning("notification API unavailable", { title, message });
      return false;
    }

    const iconUrl = typeof this.runtimeApi?.getURL === "function"
      ? this.runtimeApi.getURL("icons/icon128.png")
      : "icons/icon128.png";
    try {
      await this.notificationsApi.create("unfinished-inbox-notification", {
        type: "basic",
        iconUrl,
        title,
        message
      });
      return true;
    } catch (error) {
      this.logger.error("notification failed", describeError(error));
      return false;
    }
  }

  async getStatus() {
    const settings = await this.ensureSettings();
    const count = await this.updateBadge();
    let tmpCount = 0;
    if (typeof this.groupManager?.listNamedGroupSummaries === "function") {
      try {
        const summaries = await this.groupManager.listNamedGroupSummaries();
        const tmpTitleKey = groupTitleKey(TMP_GROUP_TITLE);
        tmpCount = summaries.find(
          (group) => groupTitleKey(group.title) === tmpTitleKey
        )?.tabCount ?? 0;
      } catch (error) {
        this.logger.group.warning("tmp summary unavailable", describeError(error));
      }
    }
    return {
      ok: true,
      count,
      groupTitle: GROUP_TITLE,
      tmpTitle: TMP_GROUP_TITLE,
      tmpColor: TMP_GROUP_COLOR,
      tmpCount,
      tmpEnabled: settings.tmpEnabled,
      tmpCaptureNewTabs: settings.tmpCaptureNewTabs,
      tmpCaptureStartup: settings.tmpCaptureStartup,
      presetGroups: clonePresetGroups(settings.presetGroups),
      readingListEnabled: settings.readingListEnabled,
      removeAfterImport: settings.removeAfterImport,
      bridgeEnabledAt: settings.bridgeEnabledAt,
      lastSyncAt: settings.lastSyncAt
    };
  }
}
