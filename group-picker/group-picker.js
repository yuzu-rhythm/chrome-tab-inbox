const GROUP_COLORS = Object.freeze([
  ["grey", "グレー", "#8b8b8b"],
  ["blue", "ブルー", "#3b82f6"],
  ["red", "レッド", "#ef4444"],
  ["yellow", "イエロー", "#eab308"],
  ["green", "グリーン", "#22c55e"],
  ["pink", "ピンク", "#ec4899"],
  ["purple", "パープル", "#a855f7"],
  ["cyan", "シアン", "#06b6d4"],
  ["orange", "オレンジ", "#f97316"]
]);

const COLOR_MAP = new Map(GROUP_COLORS.map(([id, label, value]) => [id, { label, value }]));
const TMP_GROUP_TITLE = "tmp";
const MAX_GROUP_TITLE_LENGTH = 80;

const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "open" ? "open" : "assign";

function resourceIdParam(name) {
  const raw = params.get(name);
  if (raw === null || raw === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

const targetTabId = resourceIdParam("tabId");
const preferredWindowId = resourceIdParam("preferredWindowId");

const modeLabel = document.getElementById("mode-label");
const pickerTitle = document.getElementById("picker-title");
const closeButton = document.getElementById("close-picker");
const targetCard = document.getElementById("target-card");
const targetTitle = document.getElementById("target-title");
const targetHost = document.getElementById("target-host");
const searchInput = document.getElementById("group-search");
const colorSection = document.getElementById("color-section");
const colorPicker = document.getElementById("color-picker");
const colorName = document.getElementById("color-name");
const groupList = document.getElementById("group-list");
const resultCount = document.getElementById("result-count");
const emptyState = document.getElementById("empty-state");
const statusElement = document.getElementById("picker-status");

let actualGroups = [];
let presetGroups = [];
let tmpGroup = null;
let allOptions = [];
let visibleOptions = [];
let selectedIndex = 0;
let selectedColor = "orange";
let busy = false;

function setStatus(message, kind = "") {
  statusElement.textContent = message ?? "";
  statusElement.classList.toggle("error", kind === "error");
  statusElement.classList.toggle("success", kind === "success");
}

async function closePickerWindow() {
  try {
    const currentWindow = await chrome.windows.getCurrent({ populate: false });
    if (Number.isInteger(currentWindow?.id) && currentWindow.type === "popup") {
      await chrome.windows.remove(currentWindow.id);
      return;
    }
  } catch {
    // Fall back to the page-level close below when the window disappeared or
    // the windows API is temporarily unavailable.
  }
  window.close();
}

async function send(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, ...payload });
}

function safeColor(color) {
  return COLOR_MAP.has(color) ? color : "grey";
}

function colorValue(color) {
  return COLOR_MAP.get(safeColor(color)).value;
}

function normalizedTitle(value) {
  return typeof value === "string" ? value.trim() : "";
}

function titleKey(value) {
  return normalizedTitle(value).toLocaleLowerCase("ja");
}

function countValue(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeGroup(group) {
  const title = normalizedTitle(group?.title);
  if (!title) {
    return null;
  }
  return {
    title,
    color: safeColor(group?.color),
    tabCount: countValue(Number.isInteger(group?.tabCount) ? group.tabCount : group?.totalTabCount),
    groupCount: countValue(group?.groupCount),
    windowCount: countValue(group?.windowCount)
  };
}

function normalizeActualGroups(items) {
  const groupsByTitle = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const group = normalizeGroup(item);
    if (!group) {
      continue;
    }
    const key = titleKey(group.title);
    const previous = groupsByTitle.get(key);
    if (!previous) {
      groupsByTitle.set(key, group);
      continue;
    }
    previous.tabCount += group.tabCount;
    previous.groupCount += group.groupCount;
    previous.windowCount += group.windowCount;
  }
  return [...groupsByTitle.values()];
}

function normalizePresetGroups(items) {
  return (Array.isArray(items) ? items : [])
    .map(normalizeGroup)
    .filter(Boolean)
    .map((group) => ({
      ...group,
      id: ""
    }));
}

function normalizeTmpGroup(item, actualTmp) {
  if (!item && !actualTmp) {
    return null;
  }
  const source = actualTmp ?? normalizeGroup(item);
  const fallback = normalizeGroup(item);
  return {
    title: TMP_GROUP_TITLE,
    color: "grey",
    tabCount: source?.tabCount ?? fallback?.tabCount ?? 0,
    groupCount: source?.groupCount ?? fallback?.groupCount ?? 0,
    windowCount: source?.windowCount ?? fallback?.windowCount ?? 0
  };
}

function selectColor(color) {
  selectedColor = safeColor(color);
  colorName.textContent = COLOR_MAP.get(selectedColor).label;
  for (const chip of colorPicker.querySelectorAll(".color-chip")) {
    chip.setAttribute("aria-checked", String(chip.dataset.color === selectedColor));
  }
  renderOptions();
}

function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function buildColorPicker() {
  colorPicker.replaceChildren();
  GROUP_COLORS.forEach(([id, label, value], index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-chip";
    button.dataset.color = id;
    button.title = `${label}（Option+${index + 1}）`;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-label", `${label}（Option+${index + 1}）`);
    button.setAttribute("aria-checked", String(id === selectedColor));
    button.style.setProperty("--chip-color", value);
    button.addEventListener("click", () => {
      selectColor(id);
      searchInput.focus();
    });
    colorPicker.append(button);
  });
}

function mergeOptionCounts(option, group) {
  if (!option.isPreset && !option.isTmp) {
    option.color = group.color;
  }
  option.tabCount = group.tabCount;
  option.groupCount = group.groupCount;
  option.windowCount = group.windowCount;
  option.hasLiveGroup = true;
}

function buildPaletteOptions() {
  const options = [];
  const optionsByTitle = new Map();
  const add = (option) => {
    const key = titleKey(option.title);
    const existing = optionsByTitle.get(key);
    if (existing) {
      return existing;
    }
    optionsByTitle.set(key, option);
    options.push(option);
    return option;
  };

  if (tmpGroup) {
    add({
      ...tmpGroup,
      kind: "TMP",
      isTmp: true,
      isPreset: false,
      isNew: false,
      presetSlots: [],
      hasLiveGroup: Boolean(actualGroups.find((group) =>
        titleKey(group.title) === titleKey(TMP_GROUP_TITLE)
      ))
    });
  }

  presetGroups.forEach((preset, index) => {
    const option = add({
      ...preset,
      color: safeColor(preset.color),
      kind: "PRESET",
      isTmp: false,
      isPreset: true,
      isNew: false,
      presetSlots: [],
      hasLiveGroup: false
    });
    option.presetSlots.push(index + 1);
  });

  for (const group of actualGroups) {
    const existing = optionsByTitle.get(titleKey(group.title));
    if (existing) {
      if (titleKey(group.title) !== titleKey(TMP_GROUP_TITLE)) {
        mergeOptionCounts(existing, group);
      }
      continue;
    }
    add({
      ...group,
      kind: "OPEN",
      isTmp: false,
      isPreset: false,
      isNew: false,
      presetSlots: [],
      hasLiveGroup: true
    });
  }

  return options;
}

function buildOptions() {
  allOptions = buildPaletteOptions();
  const query = normalizedTitle(searchInput.value);
  const foldedQuery = titleKey(query);
  const matches = allOptions.filter((option) =>
    !foldedQuery || titleKey(option.title).includes(foldedQuery)
  );
  const queryKey = titleKey(query);
  const exactMatch = allOptions.find((option) => titleKey(option.title) === queryKey);
  if (exactMatch && query) {
    matches.sort((left, right) => {
      const leftExact = titleKey(left.title) === queryKey ? 0 : 1;
      const rightExact = titleKey(right.title) === queryKey ? 0 : 1;
      return leftExact - rightExact;
    });
  }

  const options = matches.map((option) => ({
    ...option,
    presetSlots: [...option.presetSlots]
  }));
  if (mode === "assign" && query && !exactMatch) {
    options.push({
      title: query,
      color: selectedColor,
      tabCount: 0,
      groupCount: 0,
      windowCount: 0,
      kind: "NEW",
      isTmp: false,
      isPreset: false,
      isNew: true,
      presetSlots: [],
      hasLiveGroup: false
    });
  }
  return options;
}

function optionSubtitle(option) {
  if (option.isNew) {
    return "入力名で新規作成";
  }
  const groupCount = countValue(option.groupCount);
  const windowCount = countValue(option.windowCount);
  const groupLabel = groupCount > 1 ? `同名${groupCount}グループ` : `${groupCount}グループ`;
  const windowLabel = windowCount > 1 ? `同名${windowCount}ウィンドウ` : `${windowCount}ウィンドウ`;
  return `${countValue(option.tabCount)}タブ・${groupLabel}・${windowLabel}`;
}

function optionKeyLabels(option) {
  const labels = [];
  if (option.isTmp) {
    labels.push("Ctrl+0");
  }
  for (const slot of option.presetSlots ?? []) {
    labels.push(`Ctrl+${slot}`);
  }
  if (labels.length === 0) {
    labels.push("Enter");
  }
  return labels;
}

function syncSelectedRows() {
  for (const row of groupList.querySelectorAll(".group-row")) {
    const index = Number(row.dataset.index);
    const selected = index === selectedIndex;
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-selected", String(selected));
  }
}

function renderOptions() {
  visibleOptions = buildOptions();
  const query = normalizedTitle(searchInput.value);
  const queryKey = titleKey(query);
  const exactIndex = query
    ? visibleOptions.findIndex((option) => titleKey(option.title) === queryKey)
    : -1;
  if (exactIndex >= 0) {
    selectedIndex = exactIndex;
  } else if (visibleOptions.length === 0) {
    selectedIndex = 0;
  } else {
    selectedIndex = Math.min(Math.max(selectedIndex, 0), visibleOptions.length - 1);
  }

  groupList.replaceChildren();
  visibleOptions.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `group-row row-kind-${option.kind.toLowerCase()}${index === selectedIndex ? " selected" : ""}${option.isNew ? " new-row" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === selectedIndex));
    button.setAttribute("aria-label", `${option.kind} ${option.title}、${optionSubtitle(option)}`);
    button.dataset.index = String(index);

    const kind = document.createElement("span");
    kind.className = "group-kind";
    kind.textContent = option.kind;

    const dot = document.createElement("span");
    dot.className = "group-dot";
    dot.style.setProperty("--group-color", colorValue(option.color));
    dot.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    copy.className = "group-copy";
    const title = document.createElement("strong");
    title.textContent = option.title;
    const subtitle = document.createElement("small");
    subtitle.textContent = optionSubtitle(option);
    copy.append(title, subtitle);

    const trailing = document.createElement("span");
    trailing.className = "row-trailing";
    const keys = document.createElement("span");
    keys.className = "row-keys";
    for (const label of optionKeyLabels(option)) {
      const key = document.createElement("kbd");
      key.textContent = label;
      keys.append(key);
    }
    const action = document.createElement("span");
    action.className = "group-action";
    action.textContent = mode === "open" ? "開く" : "送る";
    trailing.append(keys, action);

    button.append(kind, dot, copy, trailing);
    button.addEventListener("mouseenter", () => {
      selectedIndex = index;
      syncSelectedRows();
    });
    button.addEventListener("click", () => void executeOption(option));
    groupList.append(button);
  });

  resultCount.textContent = `${visibleOptions.length}件`;
  emptyState.hidden = visibleOptions.length > 0;
  if (visibleOptions.length === 0) {
    emptyState.textContent = mode === "open"
      ? "開いているグループがありません。"
      : "名前を入力すると、新しいグループを作成できます。";
  }
}

function moveSelection(delta) {
  if (visibleOptions.length === 0) {
    return;
  }
  selectedIndex = (selectedIndex + delta + visibleOptions.length) % visibleOptions.length;
  syncSelectedRows();
  groupList.querySelector(`[data-index="${selectedIndex}"]`)?.scrollIntoView({ block: "nearest" });
}

function digitFromCode(code) {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(code ?? "");
  return match ? Number(match[1]) : null;
}

function optionForShortcut(digit) {
  if (digit === 0) {
    return allOptions.find((option) => option.isTmp) ?? null;
  }
  return allOptions.find((option) => option.presetSlots?.includes(digit)) ?? null;
}

async function executeOption(option) {
  if (busy || !option) {
    return;
  }
  const title = normalizedTitle(option.title);
  if (!title || title.length > MAX_GROUP_TITLE_LENGTH) {
    setStatus(`グループ名は1〜${MAX_GROUP_TITLE_LENGTH}文字で入力してください`, "error");
    return;
  }
  if (mode === "assign" && targetTabId === null) {
    setStatus("振り分けるタブを確認できません", "error");
    return;
  }

  busy = true;
  document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  setStatus(mode === "open" ? "グループを開いています…" : "タブを移動しています…");
  try {
    const action = mode === "open" ? "open-group-by-name" : "assign-tab-to-group";
    const result = await send(action, {
      tabId: targetTabId,
      title,
      color: safeColor(option.color),
      preferredWindowId
    });
    if (!result?.ok) {
      throw new Error(result?.message ?? "操作を完了できませんでした");
    }
    setStatus(result.message ?? "完了しました", "success");
    await closePickerWindow();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "操作を完了できませんでした", "error");
    busy = false;
    document.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    searchInput.focus();
  }
}

async function load() {
  modeLabel.textContent = mode === "open" ? "グループ一覧" : "タブを振り分け";
  pickerTitle.textContent = mode === "open" ? "グループOverview" : "グループに振り分け";
  targetCard.hidden = mode !== "assign";
  colorSection.hidden = mode !== "assign";
  searchInput.placeholder = mode === "open" ? "グループを検索…" : "グループを検索 / 新規入力…";

  buildColorPicker();
  setStatus("グループを確認中…");
  try {
    const result = await send("get-group-picker-data", {
      tabId: targetTabId,
      preferredWindowId
    });
    if (!result?.ok) {
      throw new Error(result?.message ?? "グループを取得できませんでした");
    }
    actualGroups = normalizeActualGroups(result.groups);
    const actualTmp = actualGroups.find((group) => group.title === TMP_GROUP_TITLE) ?? null;
    tmpGroup = normalizeTmpGroup(result.tmp, actualTmp);
    actualGroups = actualGroups.filter((group) => group.title !== TMP_GROUP_TITLE);
    presetGroups = normalizePresetGroups(result.presets ?? result.presetGroups);

    if (mode === "assign") {
      targetTitle.textContent = result.target?.title || "タイトルなし";
      targetHost.textContent = hostFromUrl(result.target?.url);
    }
    setStatus("");
    renderOptions();
    searchInput.focus();
  } catch (error) {
    actualGroups = [];
    presetGroups = [];
    tmpGroup = null;
    renderOptions();
    setStatus(error instanceof Error ? error.message : "グループを取得できませんでした", "error");
  }
}

closeButton.addEventListener("click", () => void closePickerWindow());
searchInput.addEventListener("input", () => {
  selectedIndex = 0;
  renderOptions();
});
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveSelection(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    void executeOption(visibleOptions[selectedIndex]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    void closePickerWindow();
  }
});
document.addEventListener("keydown", (event) => {
  const digit = digitFromCode(event.code);
  if (
    mode === "assign" &&
    event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    digit !== null &&
    digit >= 1 &&
    digit <= 9
  ) {
    event.preventDefault();
    selectColor(GROUP_COLORS[digit - 1][0]);
    searchInput.focus();
    return;
  }
  if (
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    digit !== null &&
    digit >= 0 &&
    digit <= 9
  ) {
    const option = optionForShortcut(digit);
    if (option) {
      event.preventDefault();
      void executeOption(option);
      return;
    }
  }
  if (event.key === "Escape") {
    void closePickerWindow();
  }
});

void load();
