import { normalizeHttpUrl } from "../core/url-utils.js";

export const INBOX_ITEM_SOURCE = Object.freeze({
  READING_LIST: "chrome-reading-list",
  FUTURE_REMOTE: "future-remote"
});

/**
 * Source contract used by InboxManager.
 *
 * A source returns normalized InboxItem records from listPending() and owns
 * acknowledgement of its own queue after the core has confirmed transfer.
 */
export class InboxSource {
  constructor(name) {
    this.name = name;
  }

  async listPending() {
    throw new Error(`${this.name} must implement listPending()`);
  }

  async acknowledge() {
    throw new Error(`${this.name} must implement acknowledge()`);
  }
}

export function normalizeInboxItem(record, { source, id, createdAt, title } = {}) {
  const urlResult = normalizeHttpUrl(record?.url);
  if (!urlResult.valid) {
    return { item: null, reason: urlResult.reason };
  }

  const rawCreatedAt = createdAt ?? record?.createdAt ?? record?.creationTime;
  const numericCreatedAt = Number(rawCreatedAt);
  const normalizedCreatedAt = Number.isFinite(numericCreatedAt) ? numericCreatedAt : null;

  return {
    item: {
      id: String(id ?? record?.id ?? urlResult.url),
      url: urlResult.url,
      title: typeof (title ?? record?.title) === "string" ? (title ?? record.title) : "",
      createdAt: normalizedCreatedAt,
      source: String(source ?? record?.source ?? "unknown")
    },
    reason: null
  };
}
