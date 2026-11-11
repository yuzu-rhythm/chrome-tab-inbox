export const MAX_GROUP_TITLE_LENGTH = 80;

export function normalizeGroupTitle(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function groupTitleKey(value) {
  return normalizeGroupTitle(value).toLocaleLowerCase();
}

export function groupTitlesEqual(left, right) {
  const leftKey = groupTitleKey(left);
  return leftKey.length > 0 && leftKey === groupTitleKey(right);
}
