/**
 * terminal.ts — the thin imperative TUI driver.
 *
 * Owns the alternate screen buffer, raw keypress handling (scroll keys + a
 * single-line input buffer), a throttled repaint, and ALWAYS restores the
 * terminal on exit/crash. Pure rendering is delegated to render.ts; all view
 * state lives in the ConsoleState that the caller mutates via reducers.
 */
import * as readline from "node:readline";
import type { ConsoleState } from "./state.js";
import { render, type Size } from "./render.js";

export interface TerminalHandlers {
  /** Called when the user submits the input line (Enter). */
  onSubmit(line: string): void;
  /** Called on scroll keys; delta>0 = older, <0 = newer. */
  onScroll(delta: number): void;
  /** Called when the user presses a printable/edit key; the driver updates state.input itself. */
  onInputChange(input: string): void;
  /** Called on Esc — used to dismiss an overlay/filter. */
  onEscape(): void;
  /** Called on quit (Ctrl-C / Ctrl-D). */
  onQuit(): void;
}

export interface Terminal {
  /** Repaint now (throttled to once per animation frame). */
  schedulePaint(): void;
  /** Tear down: restore the terminal. Safe to call multiple times. */
  close(): void;
}

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CLEAR = "\x1b[2J\x1b[H";

export function startTerminal(getState: () => ConsoleState, handlers: TerminalHandlers): Terminal {
  const out = process.stdout;
  const input = process.stdin;

  let inputBuffer = "";
  let painting = false;
  let closed = false;

  function size(): Size {
    return { rows: out.rows ?? 24, cols: out.columns ?? 80 };
  }

  function paint(): void {
    if (closed) return;
    const lines = render(getState(), size());
    out.write(CLEAR + lines.join("\r\n"));
  }

  function schedulePaint(): void {
    if (painting || closed) return;
    painting = true;
    setImmediate(() => {
      painting = false;
      paint();
    });
  }

  out.write(ALT_ON + CURSOR_HIDE);
  readline.emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);

  function onKeypress(str: string | undefined, key: readline.Key): void {
    if (!key) return;
    if ((key.ctrl && (key.name === "c" || key.name === "d"))) {
      handlers.onQuit();
      return;
    }
    switch (key.name) {
      case "up":
        handlers.onScroll(1);
        return;
      case "down":
        handlers.onScroll(-1);
        return;
      case "pageup":
        handlers.onScroll(10);
        return;
      case "pagedown":
        handlers.onScroll(-10);
        return;
      case "escape":
        inputBuffer = "";
        handlers.onInputChange(inputBuffer);
        handlers.onEscape();
        return;
      case "return":
      case "enter": {
        const line = inputBuffer;
        inputBuffer = "";
        handlers.onInputChange(inputBuffer);
        handlers.onSubmit(line);
        return;
      }
      case "backspace":
        inputBuffer = Array.from(inputBuffer).slice(0, -1).join("");
        handlers.onInputChange(inputBuffer);
        return;
      default:
        if (str && !key.ctrl && !key.meta && str >= " ") {
          inputBuffer += str;
          handlers.onInputChange(inputBuffer);
        }
    }
  }

  input.on("keypress", onKeypress);
  out.on("resize", schedulePaint);

  function close(): void {
    if (closed) return;
    closed = true;
    input.off("keypress", onKeypress);
    out.off("resize", schedulePaint);
    if (input.isTTY) input.setRawMode(false);
    out.write(CURSOR_SHOW + ALT_OFF);
  }

  // Safety nets: restore the terminal no matter how we exit.
  process.on("exit", close);

  paint();
  return { schedulePaint, close };
}
