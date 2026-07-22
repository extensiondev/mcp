// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

export interface ConsoleMessage {
  level: string;
  text: string;
}

// The console shape source_inspect reports, shared by both transports (CDP
// event buffer on Chromium, RDP watcher resources on Firefox): total, counts
// per level, and the most-repeated messages deduplicated per level.
export function summarizeConsoleMessages(
  messages: ConsoleMessage[],
): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const uniqueByLevel: Record<string, Map<string, number>> = {};

  for (const msg of messages) {
    counts[msg.level] = (counts[msg.level] ?? 0) + 1;
    if (!uniqueByLevel[msg.level]) uniqueByLevel[msg.level] = new Map();
    const key = msg.text.slice(0, 200);
    uniqueByLevel[msg.level].set(
      key,
      (uniqueByLevel[msg.level].get(key) ?? 0) + 1,
    );
  }

  const topMessages: Array<{ level: string; text: string; count: number }> = [];
  for (const [level, msgs] of Object.entries(uniqueByLevel)) {
    const sorted = [...msgs.entries()].sort((a, b) => b[1] - a[1]);
    for (const [text, count] of sorted.slice(0, 5)) {
      topMessages.push({ level, text, count });
    }
  }

  return {
    total: messages.length,
    counts,
    topMessages: topMessages.sort((a, b) => b.count - a.count).slice(0, 10),
  };
}
