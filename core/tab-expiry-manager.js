import { TMP_GROUP_TITLE } from "./constants.js";
import { groupTitleKey } from "./group-title.js";
import { describeError, logger as defaultLogger } from "./logging.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function tabExpiryDuration(groupTitle, presetGroups) {
  const key = groupTitleKey(groupTitle);
  if (!key) return null;
  if (key === groupTitleKey(TMP_GROUP_TITLE)) return DAY_MS;
  if (presetGroups.some((preset) => groupTitleKey(preset.title) === key)) return null;
  return 7 * DAY_MS;
}

export function isExpiredTab(tab, group, presetGroups, now) {
  if (
    !tab || !Number.isInteger(tab.id) || tab.id < 0 ||
    tab.active || tab.pinned || tab.incognito ||
    !group || group.id !== tab.groupId || group.windowId !== tab.windowId ||
    typeof tab.lastAccessed !== "number" || !Number.isFinite(tab.lastAccessed) ||
    tab.lastAccessed <= 0 || tab.lastAccessed > now
  ) return false;

  const duration = tabExpiryDuration(group.title, presetGroups);
  return duration !== null && now - tab.lastAccessed >= duration;
}

export class TabExpiryManager {
  constructor({ tabsApi, tabGroupsApi, settingsProvider, now = () => Date.now(), logger = defaultLogger }) {
    this.tabsApi = tabsApi;
    this.tabGroupsApi = tabGroupsApi;
    this.settingsProvider = settingsProvider;
    this.now = now;
    this.logger = logger;
  }

  async scan() {
    const tabs = await this.tabsApi.query({});
    const groups = await this.tabGroupsApi.query({});
    const settings = await this.settingsProvider();
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    const candidates = tabs.filter((tab) =>
      isExpiredTab(tab, groupsById.get(tab.groupId), settings.presetGroups, this.now())
    );
    let closed = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        // Re-read immediately before removal: the user may have activated,
        // pinned, moved, or reclassified the tab since the initial query.
        const tab = await this.tabsApi.get(candidate.id);
        if (!tab || tab.groupId !== candidate.groupId) continue;
        const currentSettings = await this.settingsProvider();
        const latestTab = await this.tabsApi.get(candidate.id);
        if (!latestTab || latestTab.groupId !== candidate.groupId) continue;
        const group = await this.tabGroupsApi.get(latestTab.groupId);
        if (!isExpiredTab(latestTab, group, currentSettings.presetGroups, this.now())) continue;
        await this.tabsApi.remove(candidate.id);
        closed += 1;
      } catch (error) {
        failed += 1;
        this.logger.tab.warning("expired tab check or close failed", {
          tabId: candidate.id,
          error: describeError(error)
        });
      }
    }
    return { ok: failed === 0, closed, failed };
  }
}
