import { READING_LIST_SOURCE } from "../core/constants.js";
import { describeError, logger as defaultLogger } from "../core/logging.js";
import { InboxSource, normalizeInboxItem } from "./inbox-source.js";

export class ReadingListInboxSource extends InboxSource {
  constructor({ readingListApi = globalThis.chrome?.readingList, logger = defaultLogger } = {}) {
    super(READING_LIST_SOURCE);
    this.readingListApi = readingListApi;
    this.logger = logger;
  }

  get available() {
    return Boolean(
      this.readingListApi &&
        typeof this.readingListApi.query === "function" &&
        typeof this.readingListApi.removeEntry === "function"
    );
  }

  registerEntryAddedListener(callback) {
    const event = this.readingListApi?.onEntryAdded;
    if (!event || typeof event.addListener !== "function") {
      return false;
    }

    try {
      event.addListener(callback);
      return true;
    } catch (error) {
      this.logger.readingList.warning("onEntryAdded listener unavailable", describeError(error));
      return false;
    }
  }

  toInboxItem(entry, { includeExisting = false, bridgeEnabledAt = 0 } = {}) {
    if (entry?.hasBeenRead !== false) {
      return { item: null, reason: "既読Reading List項目は対象外です" };
    }

    const normalized = normalizeInboxItem(entry, {
      source: READING_LIST_SOURCE,
      id: entry?.url,
      createdAt: entry?.creationTime,
      title: entry?.title
    });

    if (!normalized.item) {
      this.logger.readingList.info("invalid URL skipped", {
        url: typeof entry?.url === "string" ? entry.url : null,
        reason: normalized.reason
      });
      return normalized;
    }

    if (!includeExisting) {
      const bridgeTimestamp = Number(bridgeEnabledAt);
      if (
        !Number.isFinite(normalized.item.createdAt) ||
        !Number.isFinite(bridgeTimestamp) ||
        normalized.item.createdAt < bridgeTimestamp
      ) {
        return {
          item: null,
          reason: "bridgeEnabledAtより前に作成された項目です"
        };
      }
    }

    return normalized;
  }

  async listPending({ includeExisting = false, bridgeEnabledAt = 0 } = {}) {
    if (!this.available) {
      throw new Error("chrome.readingList API is unavailable");
    }

    const entries = await this.readingListApi.query({ hasBeenRead: false });
    const items = [];
    const skipped = [];

    for (const entry of entries ?? []) {
      const result = this.toInboxItem(entry, { includeExisting, bridgeEnabledAt });
      if (result.item) {
        items.push(result.item);
      } else {
        skipped.push({ url: entry?.url ?? null, reason: result.reason });
      }
    }

    return { items, skipped, scanned: Array.isArray(entries) ? entries.length : 0 };
  }

  async acknowledge(item) {
    if (!this.available) {
      throw new Error("chrome.readingList API is unavailable");
    }

    await this.readingListApi.removeEntry({ url: item.url });
    this.logger.queue.info("source item acknowledged", {
      source: READING_LIST_SOURCE,
      url: item.url
    });
  }
}
