import { config } from "./config.js";

const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const currentLevel =
  levels[config.logLevel] ?? levels.info;

function serializeError(error) {
  if (!(error instanceof Error)) {
    return error;
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    details: error.details
  };
}

function write(level, context, message) {
  if ((levels[level] ?? 100) < currentLevel) {
    return;
  }

  const safeContext = {
    ...(context ?? {})
  };

  if (safeContext.err) {
    safeContext.err = serializeError(safeContext.err);
  }

  const log = {
    time: new Date().toISOString(),
    level,
    message,
    ...safeContext
  };

  console[level === "debug" ? "log" : level](
    JSON.stringify(log)
  );
}

export const logger = {
  debug: (context, message) =>
    write("debug", context, message),

  info: (context, message) =>
    write("info", context, message),

  warn: (context, message) =>
    write("warn", context, message),

  error: (context, message) =>
    write("error", context, message)
};