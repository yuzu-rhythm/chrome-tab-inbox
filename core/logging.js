function write(level, prefix, event, details) {
  const method = typeof console?.[level] === "function" ? console[level] : console.log;
  const message = `${prefix} ${event}`;

  if (details === undefined) {
    method.call(console, message);
  } else {
    method.call(console, message, details);
  }
}

function scoped(prefix) {
  return {
    info(event, details) {
      write("info", prefix, event, details);
    },
    warning(event, details) {
      write("warn", prefix, event, details);
    },
    error(event, details) {
      write("error", prefix, event, details);
    }
  };
}

export const logger = {
  inbox: scoped("[inbox]"),
  readingList: scoped("[reading-list]"),
  group: scoped("[group]"),
  tab: scoped("[tab]"),
  queue: scoped("[queue]"),
  error(event, details) {
    write("error", "[error]", event, details);
  }
};

export function describeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  if (typeof error === "string") {
    return { message: error };
  }

  try {
    return { message: String(error) };
  } catch {
    return { message: "Unknown error" };
  }
}
