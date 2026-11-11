import assert from "node:assert/strict";
import test from "node:test";

import { ReadingListInboxSource } from "../sources/reading-list-source.js";

function makeLogger() {
  const scope = () => ({ info() {}, warning() {}, error() {} });
  return {
    inbox: scope(),
    readingList: scope(),
    group: scope(),
    tab: scope(),
    queue: scope(),
    error() {}
  };
}

test("queries unread Reading List entries and applies bridgeEnabledAt", async () => {
  const queryCalls = [];
  const api = {
    onEntryAdded: { addListener() {} },
    async query(info) {
      queryCalls.push(info);
      return [
        {
          url: "https://example.com/new?source=phone",
          title: "New",
          creationTime: 200,
          hasBeenRead: false
        },
        {
          url: "https://example.com/old",
          title: "Old",
          creationTime: 99,
          hasBeenRead: false
        },
        {
          url: "chrome://settings",
          title: "Restricted",
          creationTime: 300,
          hasBeenRead: false
        },
        {
          url: "https://example.com/read",
          title: "Read",
          creationTime: 300,
          hasBeenRead: true
        }
      ];
    },
    async removeEntry() {}
  };
  const source = new ReadingListInboxSource({ readingListApi: api, logger: makeLogger() });

  const pending = await source.listPending({ bridgeEnabledAt: 100 });

  assert.deepEqual(queryCalls, [{ hasBeenRead: false }]);
  assert.deepEqual(pending.items.map((item) => item.url), ["https://example.com/new?source=phone"]);
  assert.equal(pending.scanned, 4);
  assert.equal(pending.skipped.length, 3);
});

test("manual existing scan can include old unread entries and acknowledgement uses exact URL", async () => {
  const removals = [];
  const api = {
    async query() { return []; },
    async removeEntry(info) { removals.push(info); }
  };
  const source = new ReadingListInboxSource({ readingListApi: api, logger: makeLogger() });
  const entry = {
    url: "https://example.com/old?keep=query#fragment",
    title: "Old",
    creationTime: 1,
    hasBeenRead: false
  };

  const result = source.toInboxItem(entry, { bridgeEnabledAt: 100, includeExisting: true });
  await source.acknowledge(result.item);

  assert.equal(result.item.url, entry.url);
  assert.deepEqual(removals, [{ url: entry.url }]);
});
