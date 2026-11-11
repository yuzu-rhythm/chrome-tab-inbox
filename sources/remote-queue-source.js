import { INBOX_ITEM_SOURCE, InboxSource } from "./inbox-source.js";

/**
 * Deliberately unimplemented v1 extension point.
 *
 * A future OS-neutral remote queue can implement listPending() and
 * acknowledge() without changing InboxManager, tab grouping, badge, popup, or
 * keyboard command code. Keep remote records normalized to InboxItem first.
 */
export class RemoteQueueInboxSource extends InboxSource {
  constructor(options = {}) {
    super(INBOX_ITEM_SOURCE.FUTURE_REMOTE);
    this.options = options;
  }

  async listPending() {
    throw new Error("RemoteQueueInboxSource is reserved for a future version");
  }

  async acknowledge() {
    throw new Error("RemoteQueueInboxSource is reserved for a future version");
  }
}
