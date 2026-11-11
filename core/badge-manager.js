import { GROUP_COLOR, GROUP_TITLE } from "./constants.js";
import { groupTitleKey } from "./group-title.js";
import { describeError, logger as defaultLogger } from "./logging.js";

export class BadgeManager {
  constructor({
    tabsApi = globalThis.chrome?.tabs,
    tabGroupsApi = globalThis.chrome?.tabGroups,
    actionApi = globalThis.chrome?.action,
    logger = defaultLogger
  } = {}) {
    this.tabsApi = tabsApi;
    this.tabGroupsApi = tabGroupsApi;
    this.actionApi = actionApi;
    this.logger = logger;
  }

  async countMembers() {
    if (
      !this.tabsApi ||
      typeof this.tabsApi.query !== "function" ||
      !this.tabGroupsApi ||
      typeof this.tabGroupsApi.query !== "function"
    ) {
      throw new Error("tab and tabGroups APIs are unavailable");
    }

    const groups = await this.tabGroupsApi.query({});
    const expectedTitleKey = groupTitleKey(GROUP_TITLE);
    const groupIds = new Set(
      (groups ?? [])
        .filter((group) => groupTitleKey(group?.title) === expectedTitleKey)
        .map((group) => group?.id)
        .filter((groupId) => Number.isInteger(groupId))
    );
    if (groupIds.size === 0) {
      return 0;
    }

    const tabs = await this.tabsApi.query({});
    return (tabs ?? []).filter(
      (tab) => tab?.incognito !== true && groupIds.has(tab?.groupId)
    ).length;
  }

  async update() {
    try {
      const count = await this.countMembers();
      if (typeof this.actionApi?.setBadgeBackgroundColor === "function") {
        await this.actionApi.setBadgeBackgroundColor({ color: GROUP_COLOR });
      }
      if (typeof this.actionApi?.setBadgeText === "function") {
        await this.actionApi.setBadgeText({ text: count > 0 ? String(count) : "" });
      }
      return count;
    } catch (error) {
      this.logger.error("badge update failed", describeError(error));
      return null;
    }
  }
}
