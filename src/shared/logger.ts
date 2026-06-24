/**
 * Logger — a small structured console logger.
 *
 * Core has no OpenClaw dependency, so Logger is defined standalone here.
 * OpenClaw adapters pass a ctx.log that implements this shape (info/error/warn/debug).
 *
 * Line format: `LEVEL [tag…] message`. The level token is column-padded to 5
 * chars so lines align at a glance; contextual tags (e.g. the account) are
 * prepended ONCE via child loggers, so every line from an instance is
 * attributable without each call site repeating the account.
 *
 * Timestamps are intentionally omitted: the middleware runs under
 * systemd/journald, which stamps every line. For raw stdout (`npm run debug`)
 * line ordering is still preserved.
 */
export interface Logger {
  info: (...args: any[]) => void;
  error: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  debug: (...args: any[]) => void;
}

/** A Logger that can derive tagged child loggers. Returned by createLogger. */
export interface TaggableLogger extends Logger {
  /** Derive a logger that prepends an extra bracketed tag (e.g. an account). */
  child: (tag: string) => TaggableLogger;
}

export interface LoggerOptions {
  /** Emit debug lines. Off by default (gate on WCPPM_DEBUG in the entrypoint). */
  debug?: boolean;
  /** Bracketed context tags prepended to every line, in order. */
  tags?: string[];
  /** Colorize the LEVEL token. Defaults to whether stdout is a TTY. */
  color?: boolean;
}

type Level = "info" | "warn" | "error" | "debug";

/** Fixed-width (5-char) labels so the message column lines up. */
const LABEL: Record<Level, string> = {
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
  debug: "DEBUG",
};

/** ANSI color for the LEVEL token only (kept off when not a TTY). */
const COLOR: Record<Level, string> = {
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  debug: "\x1b[90m", // bright black / gray
};
const RESET = "\x1b[0m";

/** Which console method each level writes to (looked up at call time). */
const STREAM: Record<Level, "log" | "warn" | "error" | "debug"> = {
  info: "log",
  warn: "warn",
  error: "error",
  debug: "debug",
};

export function createLogger(opts: LoggerOptions = {}): TaggableLogger {
  const tags = opts.tags ?? [];
  const debugOn = opts.debug ?? false;
  const color = opts.color ?? Boolean(process.stdout?.isTTY);
  const prefix = tags.map((t) => `[${t}]`).join(" ");

  const emit =
    (level: Level) =>
    (...args: any[]): void => {
      const label = color ? `${COLOR[level]}${LABEL[level]}${RESET}` : LABEL[level];
      // Resolve the console method at call time (not construction) so the stream
      // is never stale. Keep the prefix as discrete args so util.inspect still
      // pretty-prints any objects/Errors passed through (e.g. log.error("…", err)).
      const stream = console[STREAM[level]];
      if (prefix) stream(label, prefix, ...args);
      else stream(label, ...args);
    };

  return {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    debug: (...args: any[]): void => {
      if (debugOn) emit("debug")(...args);
    },
    child(tag: string): TaggableLogger {
      return createLogger({ ...opts, tags: [...tags, tag] });
    },
  };
}
