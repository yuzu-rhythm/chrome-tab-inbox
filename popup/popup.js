const countElement = document.getElementById("unfinished-count");
const tmpCountElement = document.getElementById("tmp-count");
const tmpEnabledStateElement = document.getElementById("tmp-enabled-state");
const presetFlowTargetElement = document.getElementById("preset-flow-target");
const readingListStatusElement = document.getElementById("reading-list-status");
const lastSyncElement = document.getElementById("last-sync");
const statusElement = document.getElementById("popup-status");
const openButton = document.getElementById("open-unfinished");
const addButton = document.getElementById("add-current-tab");
const chooseGroupButton = document.getElementById("choose-group");
const openGroupButton = document.getElementById("open-group");

const shortcutElements = new Map([
  ["open-unfinished", document.getElementById("popup-shortcut-open-unfinished")],
  ["add-to-unfinished", document.getElementById("popup-shortcut-add-unfinished")],
  ["open-group-picker", document.getElementById("popup-shortcut-open-group")],
  ["choose-group-for-current", document.getElementById("popup-shortcut-choose-group")]
]);

function formatTime(timestamp) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "まだ同期していません";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function setStatus(message, { error = false } = {}) {
  statusElement.textContent = message ?? "";
  statusElement.classList.toggle("error", error);
}

function presetFlowLabel(presets) {
  const titles = (Array.isArray(presets) ? presets : [])
    .map((preset) => typeof preset?.title === "string" ? preset.title.trim() : "")
    .filter(Boolean);
  if (titles.length === 0) {
    return "設定から追加";
  }
  if (titles.length === 1) {
    return titles[0];
  }
  return titles[0] + " ほか" + (titles.length - 1) + "件";
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

async function refresh() {
  try {
    const result = await send("get-status");
    if (!result?.ok) {
      throw new Error(result?.message ?? "状態を取得できませんでした");
    }
    countElement.textContent = result.count === null ? "?" : String(result.count);
    tmpCountElement.textContent = Number.isInteger(result.tmpCount) && result.tmpCount >= 0
      ? String(result.tmpCount)
      : "?";
    tmpEnabledStateElement.textContent = typeof result.tmpEnabled === "boolean"
      ? result.tmpEnabled ? "ON" : "OFF"
      : "確認不可";
    presetFlowTargetElement.textContent = presetFlowLabel(result.presetGroups);
    readingListStatusElement.textContent = result.readingListEnabled ? "ON" : "OFF";
    lastSyncElement.textContent = formatTime(result.lastSyncAt);
  } catch (error) {
    countElement.textContent = "?";
    tmpCountElement.textContent = "?";
    tmpEnabledStateElement.textContent = "確認不可";
    presetFlowTargetElement.textContent = "確認不可";
    setStatus(error instanceof Error ? error.message : "状態を取得できませんでした", { error: true });
  }
}

async function runAction(button, action) {
  button.disabled = true;
  setStatus("処理中…");
  try {
    const result = await send(action);
    if (!result?.ok) {
      setStatus(result?.message ?? "処理できませんでした", { error: true });
    } else {
      setStatus(result.message ?? "完了しました");
    }
    await refresh();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "処理できませんでした", { error: true });
  } finally {
    button.disabled = false;
  }
}

openButton.addEventListener("click", () => runAction(openButton, "open-unfinished"));
addButton.addEventListener("click", () => runAction(addButton, "add-current-tab"));
chooseGroupButton.addEventListener("click", () => runAction(chooseGroupButton, "show-assign-group-picker"));
openGroupButton.addEventListener("click", () => runAction(openGroupButton, "show-open-group-picker"));
void refresh();
void loadShortcuts();
