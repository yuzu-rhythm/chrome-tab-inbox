import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function readText(path) {
  return readFile(new URL(path, projectRoot), "utf8");
}

test("manifest exposes four hotkey workflows without host permissions", async () => {
  const manifest = JSON.parse(await readText("manifest.json"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.4.0");
  assert.deepEqual(Object.keys(manifest.commands).sort(), [
    "add-to-unfinished",
    "choose-group-for-current",
    "open-group-picker",
    "open-unfinished"
  ]);
  assert.equal(manifest.commands["open-unfinished"].global, true);
  assert.equal(manifest.commands["open-group-picker"].global, true);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
});

test("extension pages keep JavaScript in external files", async () => {
  for (const path of [
    "popup/popup.html",
    "options/options.html",
    "group-picker/group-picker.html"
  ]) {
    const html = await readText(path);
    const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)];
    assert.ok(scriptTags.length > 0, `${path} should load a script`);
    for (const [, attributes] of scriptTags) {
      assert.match(attributes, /\bsrc\s*=\s*["'][^"']+["']/i, `${path} contains an inline script`);
    }
  }
});

test("picker hidden sections stay hidden when component styles set display", async () => {
  const css = await readText("group-picker/group-picker.css");

  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important\s*;/s);
});

test("picker closes its popup through the Chrome windows API", async () => {
  const script = await readText("group-picker/group-picker.js");

  assert.match(script, /chrome\.windows\.getCurrent\(/);
  assert.match(script, /chrome\.windows\.remove\(currentWindow\.id\)/);
  assert.doesNotMatch(script, /setTimeout\(\(\) => window\.close\(\)/);
});

test("group creation and rename events schedule uniqueness reconciliation", async () => {
  const worker = await readText("background/service-worker.js");
  const picker = await readText("group-picker/group-picker.js");

  assert.match(worker, /tabGroups\?\.onCreated/);
  assert.match(worker, /tabGroups\?\.onUpdated/);
  assert.match(worker, /tabs\?\.onAttached/);
  assert.match(worker, /tabs\?\.onDetached/);
  assert.match(worker, /reconcileGroupUniqueness/);
  assert.match(picker, /function titleKey\(/);
  assert.match(picker, /optionsByTitle\.get\(titleKey\(group\.title\)\)/);
  assert.match(picker, /!option\.isPreset && !option\.isTmp/);

  const options = await readText("options/options.js");
  assert.match(options, /function titleKey\(/);
  assert.match(options, /seenTitles\.get\(key\)/);
});
