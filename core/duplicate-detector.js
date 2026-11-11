import { sameExactUrl } from "./url-utils.js";

export function findExactUrlInTabs(tabs, url) {
  if (!Array.isArray(tabs)) {
    return null;
  }

  return tabs.find((tab) => sameExactUrl(tab?.pendingUrl || tab?.url, url)) ?? null;
}

export async function findExactUrlInGroup({ tabsApi, groupId, url }) {
  if (!tabsApi || typeof tabsApi.query !== "function") {
    throw new Error("tabs API is unavailable");
  }

  const tabs = await tabsApi.query({ groupId });
  return findExactUrlInTabs(tabs, url);
}

export async function findExactUrlInGroups({ tabsApi, groups, url }) {
  for (const group of groups ?? []) {
    const tab = await findExactUrlInGroup({ tabsApi, groupId: group.id, url });
    if (tab) {
      return { group, tab };
    }
  }

  return null;
}
