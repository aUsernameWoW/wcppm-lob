/**
 * commands.ts — pure parser: a command-line string → a typed Command.
 * Execution (calling the bridge client) lives in main.ts; this is parse-only.
 */

export type Command =
  | { kind: "filter"; chat: string }
  | { kind: "grep"; keyword: string }
  | { kind: "dm" }
  | { kind: "clear" }
  | { kind: "send"; to: string; text: string }
  | { kind: "reply"; text: string }
  | { kind: "forcesync" }
  | { kind: "who"; query: string }
  | { kind: "history"; chat: string; limit: number }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "error"; message: string };

export function parseCommand(line: string): Command {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "error", message: "empty command" };

  if (trimmed.startsWith("/")) {
    const [head, ...rest] = trimmed.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (head) {
      case "filter":
        return arg ? { kind: "filter", chat: arg } : { kind: "error", message: "/filter needs a chat" };
      case "grep":
        return arg ? { kind: "grep", keyword: arg } : { kind: "error", message: "/grep needs a keyword" };
      case "dm":
        return { kind: "dm" };
      case "clear":
        return { kind: "clear" };
      default:
        return { kind: "error", message: `unknown command: /${head}` };
    }
  }

  const [head, ...rest] = trimmed.split(/\s+/);
  switch (head) {
    case "send": {
      const to = rest[0];
      const text = rest.slice(1).join(" ").trim();
      return to && text ? { kind: "send", to, text } : { kind: "error", message: "usage: send <to> <text>" };
    }
    case "r": {
      const text = rest.join(" ").trim();
      return text ? { kind: "reply", text } : { kind: "error", message: "usage: r <text>" };
    }
    case "forcesync":
      return { kind: "forcesync" };
    case "who": {
      const query = rest.join(" ").trim();
      return query ? { kind: "who", query } : { kind: "error", message: "usage: who <id|keyword>" };
    }
    case "history": {
      const chat = rest[0];
      if (!chat) return { kind: "error", message: "usage: history <chat> [n]" };
      const n = Number(rest[1]);
      const limit = rest[1] !== undefined && Number.isFinite(n) && n > 0 ? n : 20;
      return { kind: "history", chat, limit };
    }
    case "status":
      return { kind: "status" };
    case "help":
    case "?":
      return { kind: "help" };
    case "quit":
    case "exit":
    case "q":
      return { kind: "quit" };
    default:
      return { kind: "error", message: `unknown command: ${head}` };
  }
}
