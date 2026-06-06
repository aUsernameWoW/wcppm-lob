/**
 * render.ts — pure view: render(state, size) → an array of exactly `rows` lines.
 * No ANSI styling here (kept testable); terminal.ts adds colors/positioning.
 * Layout: [header] [message area = rows-3] [footer] [input].
 */
import type { Frame } from "../shared/frame.js";
import { type ConsoleState, visibleMessages } from "./state.js";

export interface Size {
  rows: number;
  cols: number;
}

function clip(str: string, cols: number): string {
  const chars = Array.from(str);
  return chars.length <= cols ? str : chars.slice(0, Math.max(0, cols - 1)).join("") + "…";
}

function pad(str: string, cols: number): string {
  const len = Array.from(str).length;
  return len >= cols ? clip(str, cols) : str + " ".repeat(cols - len);
}

function hhmmss(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatFrame(f: Frame, selfWxid: string | undefined, cols: number): string {
  const kind = f.chatType === "group" ? "群" : "DM";
  const sender = f.from.wxid === selfWxid ? "你" : f.from.name ?? f.from.wxid;
  const body = f.media ? `<${f.media.kind}>` : f.text;
  return clip(`${hhmmss(f.ts)} ${kind} ${sender} → ${body}`, cols);
}

export function render(s: ConsoleState, size: Size): string[] {
  const { rows, cols } = size;
  if (rows < 4) return Array.from({ length: Math.max(0, rows) }, () => pad("…terminal too small", cols));

  const header = pad(
    clip(`wcppm  ${s.connected ? "●" : "○"} WS ${s.status.wsUp ? "up" : "down"} · self ${s.status.selfWxid ?? "?"}`, cols),
    cols,
  );

  const areaH = rows - 3;
  let bodyLines: string[];
  if (s.overlay) {
    bodyLines = s.overlay.slice(0, areaH).map((l) => pad(clip(l, cols), cols));
  } else {
    const vis = visibleMessages(s);
    const end = vis.length - s.scrollOffset;
    const start = Math.max(0, end - areaH);
    bodyLines = vis.slice(start, end).map((f) => pad(formatFrame(f, s.status.selfWxid, cols), cols));
  }
  while (bodyLines.length < areaH) bodyLines.push(pad("", cols));

  const filterDesc = describeFilter(s);
  const stats = `recv ${s.recvCount}${filterDesc}${s.follow ? "" : " · [scrolled]"}`;
  const footer = pad(clip(s.statusLine || stats, cols), cols);
  const input = pad(clip(`: ${s.input}`, cols), cols);

  return [header, ...bodyLines, footer, input];
}

function describeFilter(s: ConsoleState): string {
  const parts: string[] = [];
  if (s.filter.chat) parts.push(`chat:${s.filter.chat}`);
  if (s.filter.keyword) parts.push(`grep:${s.filter.keyword}`);
  if (s.filter.dmOnly) parts.push("dm");
  return parts.length ? ` · filter ${parts.join(",")}` : "";
}
