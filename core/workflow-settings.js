import {
  DEFAULT_PRESET_GROUPS,
  MAX_PRESET_GROUPS,
  TMP_GROUP_TITLE
} from "./constants.js";
import {
  MAX_GROUP_TITLE_LENGTH,
  groupTitleKey,
  normalizeGroupTitle
} from "./group-title.js";

export const GROUP_COLORS = Object.freeze([
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

const GROUP_COLOR_SET = new Set(GROUP_COLORS);
const MAX_PRESET_ID_LENGTH = 80;

export function clonePresetGroups(groups = DEFAULT_PRESET_GROUPS) {
  return (groups ?? []).map((group) => ({ ...group }));
}

function normalizedPresetId(value, index, usedIds) {
  const candidate = typeof value === "string" ? value.trim() : "";
  const validCandidate = candidate.length > 0 && candidate.length <= MAX_PRESET_ID_LENGTH
    ? candidate
    : `preset-${index + 1}`;

  let id = validCandidate;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${validCandidate}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

export function sanitizePresetGroups(value, {
  fallback = DEFAULT_PRESET_GROUPS
} = {}) {
  if (!Array.isArray(value)) {
    return clonePresetGroups(fallback);
  }

  const groups = [];
  const usedTitles = new Set();
  const usedIds = new Set();

  for (const candidate of value) {
    if (groups.length >= MAX_PRESET_GROUPS || !candidate || typeof candidate !== "object") {
      continue;
    }
    const title = normalizeGroupTitle(candidate.title);
    const titleKey = groupTitleKey(title);
    if (
      title.length === 0 ||
      title.length > MAX_GROUP_TITLE_LENGTH ||
      titleKey === groupTitleKey(TMP_GROUP_TITLE) ||
      usedTitles.has(titleKey)
    ) {
      continue;
    }
    const color = GROUP_COLOR_SET.has(candidate.color) ? candidate.color : "grey";
    const id = normalizedPresetId(candidate.id, groups.length, usedIds);
    usedTitles.add(titleKey);
    groups.push({ id, title, color });
  }

  return groups;
}

export function presetGroupsEqual(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  return a.length === b.length && a.every((group, index) => (
    group?.id === b[index]?.id &&
    group?.title === b[index]?.title &&
    group?.color === b[index]?.color
  ));
}

export function validatePresetGroups(value) {
  if (!Array.isArray(value)) {
    return { valid: false, message: "プリセットグループの形式が正しくありません" };
  }
  if (value.length > MAX_PRESET_GROUPS) {
    return { valid: false, message: `プリセットグループは${MAX_PRESET_GROUPS}件までです` };
  }

  const titles = new Set();
  for (const candidate of value) {
    const title = normalizeGroupTitle(candidate?.title);
    const titleKey = groupTitleKey(title);
    if (title.length === 0 || title.length > MAX_GROUP_TITLE_LENGTH) {
      return { valid: false, message: "プリセット名は1〜80文字で入力してください" };
    }
    if (titleKey === groupTitleKey(TMP_GROUP_TITLE)) {
      return { valid: false, message: `「${TMP_GROUP_TITLE}」は自動振り分け用の予約名です` };
    }
    if (titles.has(titleKey)) {
      return { valid: false, message: `プリセット名「${title}」が重複しています` };
    }
    if (!GROUP_COLOR_SET.has(candidate?.color)) {
      return { valid: false, message: `「${title}」の色が正しくありません` };
    }
    titles.add(titleKey);
  }

  return { valid: true, groups: sanitizePresetGroups(value, { fallback: [] }) };
}
