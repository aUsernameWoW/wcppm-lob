/**
 * state.ts — the console's in-memory view-model and pure reducers.
 * Every reducer returns a new state; no I/O here.
 */
import type { Frame } from "../shared/frame.js";

export interface Filter {
  chat?: string; // matches chat.id exactly or chat.name substring
  keyword?: string; // matches text substring
  dmOnly?: boolean;
}

export interface ConsoleStatus {
  wsUp: boolean;
  selfWxid?: string;
  lastMsgTs?: number;
}

export interface ConsoleState {
  messages: Frame[]; // oldest → newest, capped at `cap`
  cap: number;
  status: ConsoleStatus;
  connected: boolean; // bridge WS connected (console ↔ middleware)
  filter: Filter;
  scrollOffset: number; // 0 = follow latest; N = scrolled N messages up
  follow: boolean;
  input: string;
  statusLine: string; // transient ✓/⚠ line
  recvCount: number;
  overlay?: string[]; // who/history results; shown in place of the live window until dismissed
}

export function initState(cap = 500): ConsoleState {
  return {
    messages: [], cap, status: { wsUp: false }, connected: false,
    filter: {}, scrollOffset: 0, follow: true, input: "", statusLine: "", recvCount: 0,
  };
}

export function applyFrame(s: ConsoleState, f: Frame): ConsoleState {
  const messages = [...s.messages, f];
  if (messages.length > s.cap) messages.splice(0, messages.length - s.cap);
  return { ...s, messages, recvCount: s.recvCount + 1 };
}

export function applyStatus(s: ConsoleState, status: ConsoleStatus): ConsoleState {
  return { ...s, status };
}

export function setConnected(s: ConsoleState, connected: boolean): ConsoleState {
  return { ...s, connected };
}

export function setFilter(s: ConsoleState, filter: Filter): ConsoleState {
  return { ...s, filter, scrollOffset: 0, follow: true };
}

export function clearFilter(s: ConsoleState): ConsoleState {
  return { ...s, filter: {}, scrollOffset: 0, follow: true };
}

export function scroll(s: ConsoleState, delta: number): ConsoleState {
  const max = Math.max(0, visibleMessages(s).length - 1);
  const scrollOffset = Math.min(max, Math.max(0, s.scrollOffset + delta));
  return { ...s, scrollOffset, follow: scrollOffset === 0 };
}

export function setInput(s: ConsoleState, input: string): ConsoleState {
  return { ...s, input };
}

export function setStatusLine(s: ConsoleState, statusLine: string): ConsoleState {
  return { ...s, statusLine };
}

export function setOverlay(s: ConsoleState, overlay: string[]): ConsoleState {
  return { ...s, overlay };
}

export function clearOverlay(s: ConsoleState): ConsoleState {
  return { ...s, overlay: undefined };
}

export function visibleMessages(s: ConsoleState): Frame[] {
  const { chat, keyword, dmOnly } = s.filter;
  return s.messages.filter((m) => {
    if (dmOnly && m.chatType !== "direct") return false;
    if (chat && !(m.chat.id === chat || (m.chat.name ?? "").includes(chat))) return false;
    if (keyword && !m.text.includes(keyword)) return false;
    return true;
  });
}
