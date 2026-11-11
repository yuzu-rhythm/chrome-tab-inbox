export const GROUP_TITLE = "まだやっていない";
export const GROUP_COLOR = "orange";
export const TMP_GROUP_TITLE = "tmp";
export const TMP_GROUP_COLOR = "grey";
export const MAX_PRESET_GROUPS = 9;
export const READING_LIST_SOURCE = "chrome-reading-list";
export const READING_LIST_ALARM_NAME = "unfinished-inbox-reading-list-scan";

export const DEFAULT_PRESET_GROUPS = Object.freeze([
  Object.freeze({
    id: "unfinished",
    title: GROUP_TITLE,
    color: GROUP_COLOR
  })
]);

export const DEFAULT_SETTINGS = Object.freeze({
  bridgeEnabledAt: null,
  readingListEnabled: true,
  removeAfterImport: true,
  lastSyncAt: null,
  tmpEnabled: true,
  tmpCaptureNewTabs: true,
  tmpCaptureStartup: true,
  presetGroups: DEFAULT_PRESET_GROUPS
});

export const TAB_GROUP_ID_NONE = -1;
