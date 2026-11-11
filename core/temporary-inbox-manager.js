import { TMP_GROUP_COLOR, TMP_GROUP_TITLE } from "./constants.js";
import { describeError, logger as defaultLogger } from "./logging.js";

function isResourceId(value) {
  return Number.isInteger(value) && value >= 0;
}

function candidateUrl(tab) {
  return tab?.pendingUrl || tab?.url || "";
}

export function isTemporaryInboxCandidate(tab) {
  if (
    !tab ||
    !isResourceId(tab.id) ||
    !isResourceId(tab.windowId) ||
    tab.pinned === true ||
    tab.incognito === true
  ) {
    return false;
  }

  const url = candidateUrl(tab);
  if (url === "") {
    return false;
  }
  if (url === "about:blank" || url.startsWith("chrome://newtab")) {
    return true;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export class TemporaryInboxManager {
  constructor({
    tabsApi = globalThis.chrome?.tabs,
    settingsProvider,
    groupManager,
    logger = defaultLogger
  } = {}) {
    this.tabsApi = tabsApi;
    this.settingsProvider = settingsProvider;
    this.groupManager = groupManager;
    this.logger = logger;
  }

  async getSettings() {
    if (typeof this.settingsProvider !== "function") {
      throw new Error("temporary Inbox settings are unavailable");
    }
    return this.settingsProvider();
  }

  async captureTab(tabOrId, { source = "new-tab", settings = null } = {}) {
    const resolvedSettings = settings ?? await this.getSettings();
    if (!resolvedSettings.tmpEnabled) {
      return { ok: true, skipped: true, disabled: true, source };
    }
    if (source === "new-tab" && !resolvedSettings.tmpCaptureNewTabs) {
      return { ok: true, skipped: true, disabled: true, source };
    }
    if (source === "startup" && !resolvedSettings.tmpCaptureStartup) {
      return { ok: true, skipped: true, disabled: true, source };
    }

    let tab = tabOrId;
    if (isResourceId(tabOrId)) {
      tab = await this.groupManager.getTab(tabOrId);
    } else if (isResourceId(tabOrId?.id)) {
      tab = await this.groupManager.getTab(tabOrId.id) ?? tabOrId;
    }

    if (!isTemporaryInboxCandidate(tab)) {
      return { ok: true, skipped: true, ineligible: true, source };
    }

    try {
      return await this.groupManager.ensureTemporaryGroupForTab({
        tabId: tab.id,
        title: TMP_GROUP_TITLE,
        color: TMP_GROUP_COLOR,
        source
      });
    } catch (error) {
      this.logger.group.warning("temporary Inbox capture failed", {
        tabId: tab.id,
        source,
        error: describeError(error)
      });
      return {
        ok: false,
        skipped: false,
        tabId: tab.id,
        source,
        message: "タブをtmpへ追加できませんでした"
      };
    }
  }

  async captureStartupTabs() {
    if (!this.tabsApi || typeof this.tabsApi.query !== "function") {
      return { ok: false, captured: 0, skipped: 0, message: "タブを確認できませんでした" };
    }

    const settings = await this.getSettings();
    if (!settings.tmpEnabled || !settings.tmpCaptureStartup) {
      return { ok: true, disabled: true, captured: 0, skipped: 0 };
    }

    const activeTabs = (await this.tabsApi.query({ active: true })) ?? [];
    let captured = 0;
    let skipped = 0;
    let failed = 0;
    for (const tab of activeTabs) {
      const result = await this.captureTab(tab, { source: "startup", settings });
      if (!result.ok) {
        failed += 1;
      } else if (result.skipped) {
        skipped += 1;
      } else {
        captured += 1;
      }
    }

    return { ok: failed === 0, captured, skipped, failed };
  }
}
