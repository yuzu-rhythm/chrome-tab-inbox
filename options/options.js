const GROUP_COLORS = Object.freeze([
  ["grey", "グレー"],
  ["blue", "ブルー"],
  ["red", "レッド"],
  ["yellow", "イエロー"],
  ["green", "グリーン"],
  ["pink", "ピンク"],
  ["purple", "パープル"],
  ["cyan", "シアン"],
  ["orange", "オレンジ"]
]);
const COLOR_IDS = new Set(GROUP_COLORS.map(([id]) => id));
const MAX_PRESET_GROUPS = 9;
const MAX_GROUP_TITLE_LENGTH = 80;
const RESERVED_PRESET_TITLE = "tmp";

const readingListEnabledInput = document.getElementById("reading-list-enabled");
const removeAfterImportInput = document.getElementById("remove-after-import");
const tmpEnabledInput = document.getElementById("tmp-enabled");
const tmpCaptureNewTabsInput = document.getElementById("tmp-capture-new-tabs");
const tmpCaptureStartupInput = document.getElementById("tmp-capture-startup");
const presetCountElement = document.getElementById("preset-count");
const presetList = document.getElementById("preset-list");
const addPresetButton = document.getElementById("add-preset");
const presetErrorElement = document.getElementById("preset-error");
const saveButton = document.getElementById("save-settings");
const importExistingButton = document.getElementById("import-existing");
const statusElement = document.getElementById("options-status");

const shortcutElements = new Map([
  ["open-unfinished", document.getElementById("shortcut-open-unfinished")],
  ["add-to-unfinished", document.getElementById("shortcut-add-unfinished")],
  ["open-group-picker", document.getElementById("shortcut-open-group")],
  ["choose-group-for-current", document.getElementById("shortcut-choose-group")]
]);

let presetGroups = [];
let presetIdSequence = 0;
let settingsLoaded = false;

saveButton.disabled = true;
addPresetButton.disabled = true;

function setStatus(message, { error = false } = {}) {
  statusElement.textContent = message ?? "";
  statusElement.classList.toggle("error", error);
}

function setPresetError(message = "") {
  presetErrorElement.textContent = message;
  presetErrorElement.hidden = !message;
}

async function send(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, ...payload });
}

function formatShortcut(shortcut) {
  if (!shortcut) {
    return "未設定";
  }
  return shortcut
    .replaceAll("Command", "⌘")
    .replaceAll("MacCtrl", "⌃")
    .replaceAll("Ctrl", "⌃")
    .replaceAll("Alt", "⌥")
    .replaceAll("Shift", "⇧")
    .replaceAll("+", " ");
}

async function loadShortcuts() {
  try {
    const commands = await chrome.commands.getAll();
    const commandMap = new Map(commands.map((command) => [command.name, command.shortcut]));
    for (const [name, element] of shortcutElements) {
      const shortcut = commandMap.get(name);
      element.textContent = formatShortcut(shortcut);
      element.classList.toggle("unassigned", !shortcut);
    }
  } catch {
    for (const element of shortcutElements.values()) {
      element.textContent = "確認不可";
    }
  }
}

function summaryMessage(result) {
  if (!result) {
    return "応答がありませんでした";
  }
  if (result.disabled) {
    return result.message;
  }
  if ((result.scanned ?? 0) === 0) {
    return "未読Reading Listはありません。";
  }
  const parts = [(result.imported ?? 0) + "件を確認"];
  if ((result.imported ?? 0) === 0 && (result.skipped?.length ?? 0) > 0) {
    parts.push("自動対象外の項目は保持");
  }
  if (result.acknowledged) {
    parts.push(result.acknowledged + "件をReading Listから削除");
  }
  if (result.retained && !result.acknowledgementFailed) {
    parts.push(result.retained + "件を保持");
  }
  if (result.acknowledgementFailed) {
    parts.push(result.acknowledgementFailed + "件は削除失敗のためReading Listに保持");
  }
  if (result.failed) {
    parts.push(result.failed + "件は再試行待ち");
  }
  return parts.join("、") + "。";
}

function safeColor(color) {
  return COLOR_IDS.has(color) ? color : "orange";
}

function normalizedTitle(value) {
  return typeof value === "string" ? value.trim() : "";
}

function titleKey(value) {
  return normalizedTitle(value).toLocaleLowerCase("ja");
}

function createPresetId() {
  presetIdSequence += 1;
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "preset-" + Date.now() + "-" + presetIdSequence;
}

function normalizePreset(preset) {
  const storedId = typeof preset?.id === "string" ? preset.id.trim() : "";
  return {
    id: storedId || createPresetId(),
    title: typeof preset?.title === "string" ? preset.title : "",
    color: safeColor(preset?.color)
  };
}

function updatePresetCount() {
  presetCountElement.textContent = presetGroups.length + " / " + MAX_PRESET_GROUPS;
  addPresetButton.disabled = !settingsLoaded || presetGroups.length >= MAX_PRESET_GROUPS;
  addPresetButton.title = addPresetButton.disabled
    ? "プリセットは" + MAX_PRESET_GROUPS + "件までです"
    : "プリセットを追加";
}

function makeFieldLabel(labelText, control) {
  const label = document.createElement("label");
  label.className = "field-label";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  label.append(caption, control);
  return label;
}

function movePreset(index, delta) {
  const targetIndex = index + delta;
  if (targetIndex < 0 || targetIndex >= presetGroups.length) {
    return;
  }
  [presetGroups[index], presetGroups[targetIndex]] = [presetGroups[targetIndex], presetGroups[index]];
  setPresetError();
  renderPresets();
}

function deletePreset(index) {
  if (index < 0 || index >= presetGroups.length) {
    return;
  }
  presetGroups.splice(index, 1);
  setPresetError();
  renderPresets();
}

function makePresetRow(preset, index) {
  const row = document.createElement("div");
  row.className = "preset-row";
  row.dataset.index = String(index);
  row.setAttribute("aria-label", "プリセット" + (index + 1));

  const number = document.createElement("span");
  number.className = "preset-number";
  number.textContent = String(index + 1);
  number.setAttribute("aria-hidden", "true");

  const fields = document.createElement("div");
  fields.className = "preset-fields";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.maxLength = MAX_GROUP_TITLE_LENGTH;
  titleInput.autocomplete = "off";
  titleInput.value = preset.title;
  titleInput.placeholder = "グループ名";
  titleInput.setAttribute("aria-label", "プリセット" + (index + 1) + "のグループ名");
  titleInput.addEventListener("input", () => {
    preset.title = titleInput.value;
    setPresetError();
  });

  const colorSelect = document.createElement("select");
  colorSelect.setAttribute("aria-label", "プリセット" + (index + 1) + "の色");
  for (const [id, label] of GROUP_COLORS) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    colorSelect.append(option);
  }
  colorSelect.value = safeColor(preset.color);
  colorSelect.addEventListener("change", () => {
    preset.color = safeColor(colorSelect.value);
    setPresetError();
  });

  fields.append(
    makeFieldLabel("グループ名", titleInput),
    makeFieldLabel("Chrome色", colorSelect)
  );

  const controls = document.createElement("div");
  controls.className = "preset-controls";

  const upButton = document.createElement("button");
  upButton.type = "button";
  upButton.className = "icon-button";
  upButton.textContent = "↑";
  upButton.title = "上へ移動";
  upButton.setAttribute("aria-label", "プリセット" + (index + 1) + "を上へ移動");
  upButton.disabled = index === 0;
  upButton.addEventListener("click", () => movePreset(index, -1));

  const downButton = document.createElement("button");
  downButton.type = "button";
  downButton.className = "icon-button";
  downButton.textContent = "↓";
  downButton.title = "下へ移動";
  downButton.setAttribute("aria-label", "プリセット" + (index + 1) + "を下へ移動");
  downButton.disabled = index === presetGroups.length - 1;
  downButton.addEventListener("click", () => movePreset(index, 1));

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "delete-button";
  deleteButton.textContent = "削除";
  deleteButton.setAttribute("aria-label", "プリセット" + (index + 1) + "を削除");
  deleteButton.addEventListener("click", () => deletePreset(index));

  controls.append(upButton, downButton, deleteButton);
  row.append(number, fields, controls);
  return row;
}

function renderPresets() {
  presetList.replaceChildren();
  presetGroups.forEach((preset, index) => {
    presetList.append(makePresetRow(preset, index));
  });
  updatePresetCount();
}

function addPreset() {
  if (presetGroups.length >= MAX_PRESET_GROUPS) {
    setPresetError("プリセットは" + MAX_PRESET_GROUPS + "件までです。");
    return;
  }
  presetGroups.push({ id: createPresetId(), title: "", color: "orange" });
  setPresetError();
  renderPresets();
  const lastRow = presetList.lastElementChild;
  lastRow?.querySelector("input")?.focus();
}

function validatePresets() {
  if (presetGroups.length > MAX_PRESET_GROUPS) {
    return {
      valid: false,
      message: "プリセットは" + MAX_PRESET_GROUPS + "件までです。"
    };
  }

  const seenTitles = new Map();
  const normalized = [];
  for (const [index, preset] of presetGroups.entries()) {
    const title = normalizedTitle(preset.title);
    const key = titleKey(title);
    if (!title) {
      return {
        valid: false,
        index,
        message: "プリセット" + (index + 1) + "のグループ名を入力してください。"
      };
    }
    if (title.length > MAX_GROUP_TITLE_LENGTH) {
      return {
        valid: false,
        index,
        message: "プリセット" + (index + 1) + "のグループ名は" + MAX_GROUP_TITLE_LENGTH + "文字以内で入力してください。"
      };
    }
    if (key === titleKey(RESERVED_PRESET_TITLE)) {
      return {
        valid: false,
        index,
        message: "「tmp」はTMP専用の予約名です。別の名前を入力してください。"
      };
    }
    const previousIndex = seenTitles.get(key);
    if (previousIndex !== undefined) {
      return {
        valid: false,
        index,
        message: "プリセット" + (previousIndex + 1) + "と" + (index + 1) + "のグループ名が重複しています。"
      };
    }
    seenTitles.set(key, index);
    normalized.push({
      id: typeof preset.id === "string" && preset.id.trim() ? preset.id.trim() : createPresetId(),
      title,
      color: safeColor(preset.color)
    });
  }
  return { valid: true, presets: normalized };
}

function focusPreset(index) {
  if (!Number.isInteger(index)) {
    return;
  }
  presetList.querySelector("[data-index=\"" + index + "\"] input")?.focus();
}

async function loadSettings() {
  try {
    const result = await send("get-status");
    if (!result?.ok) {
      throw new Error(result?.message ?? "設定を読み込めませんでした");
    }
    readingListEnabledInput.checked = Boolean(result.readingListEnabled);
    removeAfterImportInput.checked = Boolean(result.removeAfterImport);
    tmpEnabledInput.checked = Boolean(result.tmpEnabled);
    tmpCaptureNewTabsInput.checked = Boolean(result.tmpCaptureNewTabs);
    tmpCaptureStartupInput.checked = Boolean(result.tmpCaptureStartup);
    presetGroups = (Array.isArray(result.presetGroups) ? result.presetGroups : []).map(normalizePreset);
    settingsLoaded = true;
    saveButton.disabled = false;
    setPresetError();
    renderPresets();
  } catch (error) {
    renderPresets();
    setStatus(error instanceof Error ? error.message : "設定を読み込めませんでした", { error: true });
  }
}

async function saveSettings() {
  if (!settingsLoaded) {
    setStatus("設定を読み込み中です", { error: true });
    return;
  }
  const validation = validatePresets();
  if (!validation.valid) {
    setPresetError(validation.message);
    setStatus("入力を確認してください", { error: true });
    focusPreset(validation.index);
    return;
  }

  saveButton.disabled = true;
  setStatus("保存中…");
  setPresetError();
  try {
    const result = await send("set-settings", {
      settings: {
        readingListEnabled: readingListEnabledInput.checked,
        removeAfterImport: removeAfterImportInput.checked,
        tmpEnabled: tmpEnabledInput.checked,
        tmpCaptureNewTabs: tmpCaptureNewTabsInput.checked,
        tmpCaptureStartup: tmpCaptureStartupInput.checked,
        presetGroups: validation.presets
      }
    });
    if (!result?.ok) {
      throw new Error(result?.message ?? "設定を保存できませんでした");
    }
    presetGroups = validation.presets;
    renderPresets();
    setStatus("設定を保存しました");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "設定を保存できませんでした", { error: true });
  } finally {
    saveButton.disabled = false;
  }
}

async function importExisting() {
  importExistingButton.disabled = true;
  setStatus("既存の未読項目を確認中…");
  try {
    const result = await send("scan-existing-reading-list");
    if (!result?.ok && !result?.disabled) {
      throw new Error(result?.message ?? "Reading Listを確認できませんでした");
    }
    setStatus(summaryMessage(result), {
      error: Boolean(result?.failed || result?.acknowledgementFailed)
    });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Reading Listを確認できませんでした", { error: true });
  } finally {
    importExistingButton.disabled = false;
  }
}

addPresetButton.addEventListener("click", () => addPreset());
saveButton.addEventListener("click", () => void saveSettings());
importExistingButton.addEventListener("click", () => void importExisting());
void loadSettings();
void loadShortcuts();
