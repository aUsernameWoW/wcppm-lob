/**
 * Logger — a structured logging interface.
 *
 * Core has no OpenClaw dependency, so Logger is defined standalone here.
 * OpenClaw adapters pass a ctx.log that implements this shape (info/error/warn/debug).
 */
export interface Logger {
  info: (...args: any[]) => void;
  error: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  debug: (...args: any[]) => void;
}
