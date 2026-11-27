// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { TOOL_POLICY } from "./tool-policy";

import type { ToolFrame } from "./server-reload";

export const WAIT_TOOL = "extension_wait";

const Q = '\\\\?"';
const REBUILD = `for: ${Q}rebuild${Q}`;

type Rule = [RegExp, (command: string, match: string, ...groups: string[]) => string];

const capitalized = (match: string, said: string): string => (/^[A-Z]/.test(match) ? `${said[0]!.toUpperCase()}${said.slice(1)}` : said);

const waitsItself = (command: string): boolean => TOOL_POLICY[command]?.liveSession === true;

const callAgain = (command: string): string =>
  waitsItself(command) ? `call ${command} again, which waits for a starting session on its own` : "call extension_doctor, which reads the session's ready.json";

const RULES: Rule[] = [
  [new RegExp(`Call ${WAIT_TOOL}(?: with ([^,.;]*?))?, then call (\\S+?) again`, "g"), (_command, _match, withPart, next) =>
    new RegExp(REBUILD).test(withPart ?? "") ? `Call ${next} again once the compile lands (extension_logs shows it)` : `Call ${next} again, which waits for a starting session on its own`],
  [new RegExp(`[Cc]all ${WAIT_TOOL} until (?:the session|it) (?:is|answers) ready, then (?:call )?(extension_\\w+) again`, "g"), (_command, match, next) =>
    capitalized(match, `call ${next} again, which waits for a starting session on its own`)],
  [new RegExp(`, then ${WAIT_TOOL} until it is ready, then`, "g"), () => ", then"],
  [new RegExp(`\\(${WAIT_TOOL}\\)`, "g"), () => "(extension_doctor reads its ready.json)"],
  [new RegExp(`(?:,|;)? then use ${WAIT_TOOL} to confirm it is ready`, "g"), () => " and let it answer ready.status: ready"],
  [new RegExp(`(?:, then|; then| and) ${WAIT_TOOL} for ready`, "g"), () => " and let it answer ready.status: ready"],
  [new RegExp(`wait for ${WAIT_TOOL} to answer ready`, "g"), () => "let it answer ready.status: ready"],
  [new RegExp(`[Cc]all ${WAIT_TOOL} with ${REBUILD}(?: again)?(?: to wait for that compile)?`, "g"), (_command, match) => capitalized(match, "read extension_logs until the compile lands")],
  [new RegExp(`\\(${WAIT_TOOL} with ${REBUILD}\\)`, "g"), () => "(extension_logs shows the compile)"],
  [new RegExp(`${WAIT_TOOL} with ${REBUILD}`, "g"), () => "extension_logs"],
  [new RegExp(`[Cc]all ${WAIT_TOOL}(?: with [^,.;]*?)? again`, "g"), (command, match) => capitalized(match, callAgain(command))],
  [new RegExp(`[Cc]all ${WAIT_TOOL} until (?:the session|it) (?:is|answers) ready`, "g"), (command, match) => capitalized(match, callAgain(command))],
  [new RegExp(`\\b${WAIT_TOOL}\\b`, "g"), () => "extension_doctor"],
];

export function withoutUnlistedWait(text: string, command: string): string {
  if (!text.includes(WAIT_TOOL)) return text;

  return RULES.reduce((said, [pattern, replace]) => said.replace(pattern, (match: string, ...groups: unknown[]) => replace(command, match, ...(groups.filter((group) => typeof group === "string" || group === undefined) as string[]))), text);
}

export function frameWithoutUnlistedWait(frame: ToolFrame, command: string): ToolFrame {
  if (!frame.content.some((part) => typeof part.text === "string" && part.text.includes(WAIT_TOOL))) return frame;

  return { ...frame, content: frame.content.map((part) => (typeof part.text === "string" ? { ...part, text: withoutUnlistedWait(part.text, command) } : part)) };
}
