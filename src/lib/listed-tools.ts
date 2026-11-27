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

type Listed = (name: string) => boolean;

const EXTRAS_TOOLS = (): string[] =>
  Object.keys(TOOL_POLICY)
    .filter((name) => TOOL_POLICY[name]!.group === "extras")
    .sort((a, b) => b.length - a.length);

const unlistedExtras = (listed: Listed): string[] => EXTRAS_TOOLS().filter((name) => !listed(name));

const toolPattern = (names: string[]): RegExp => new RegExp(`\\b(?:${names.join("|")})\\b`, "g");

const names = (text: string, unlisted: string[]): boolean => unlisted.length > 0 && toolPattern(unlisted).test(text);

const shortName = (name: string): string => name.replace(/^extension_/, "").replaceAll("_", " ");

export function withoutUnlistedWait(text: string, command: string): string {
  if (!text.includes(WAIT_TOOL)) return text;

  return RULES.reduce((said, [pattern, replace]) => said.replace(pattern, (match: string, ...groups: unknown[]) => replace(command, match, ...(groups.filter((group) => typeof group === "string" || group === undefined) as string[]))), text);
}

export function withoutUnlistedTools(text: string, command: string, listed: Listed): string {
  const waited = listed(WAIT_TOOL) ? text : withoutUnlistedWait(text, command);
  const unlisted = unlistedExtras(listed);
  if (!names(waited, unlisted)) return waited;

  let told = false;

  return waited.replace(toolPattern(unlisted), (name: string, offset: number) => {
    const said = `the extras ${shortName(name)} tool${told ? "" : " (add extras to --features in this server's MCP config to list it)"}`;
    told = true;

    return /(?:^|[.!?:]\s|"|\n)$/.test(waited.slice(Math.max(0, offset - 2), offset)) ? `T${said.slice(1)}` : said;
  });
}

function proseWithoutUnlisted(value: unknown, command: string, listed: Listed): unknown {
  if (typeof value === "string") return value.includes(" ") ? withoutUnlistedTools(value, command, listed) : value;
  if (Array.isArray(value)) return value.map((item) => proseWithoutUnlisted(item, command, listed));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, proseWithoutUnlisted(item, command, listed)]));
}

function answerWithoutUnlisted(text: string, command: string, listed: Listed): string {
  try {
    const parsed: unknown = JSON.parse(text);

    return parsed && typeof parsed === "object" ? JSON.stringify(proseWithoutUnlisted(parsed, command, listed)) : text;
  } catch {
    return text;
  }
}

export function frameWithoutUnlistedTools(frame: ToolFrame, command: string, listed: Listed): ToolFrame {
  const unlisted = [...unlistedExtras(listed), ...(listed(WAIT_TOOL) ? [] : [WAIT_TOOL])];
  if (!listed(command) || !frame.content.some((part) => typeof part.text === "string" && names(part.text, unlisted))) return frame;

  return { ...frame, content: frame.content.map((part) => (typeof part.text === "string" ? { ...part, text: answerWithoutUnlisted(part.text, command, listed) } : part)) };
}

function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i += separator.length - 1;
    }
  }

  return [...parts, text.slice(start)];
}

function listedClause(clause: string, unlisted: string[]): string | null {
  if (!names(clause, unlisted)) return clause;

  const items = splitTop(clause, ", ");
  const last = items.pop()!;
  const tail = splitTop(last, " and ");
  const all = [...items, ...(tail.length > 1 ? [tail.slice(0, -1).join(" and "), tail[tail.length - 1]!] : tail)].map((item) => item.replace(/^and /, ""));
  const kept = all.filter((item) => !names(item, unlisted));

  if (kept.length === 0) return null;

  return kept.length === 1 ? kept[0]! : `${kept.slice(0, -1).join(", ")} and ${kept[kept.length - 1]}`;
}

function listedSentence(sentence: string, unlisted: string[]): string | null {
  if (!names(sentence, unlisted)) return sentence;

  const end = /[.!?]$/.test(sentence) ? sentence.slice(-1) : "";
  const body = end ? sentence.slice(0, -1) : sentence;
  const clauses = splitTop(body, "; ").map((clause) => listedClause(clause, unlisted)).filter((clause): clause is string => clause !== null);

  return clauses.length ? `${clauses.join("; ")}${end}` : null;
}

export function describedForListed(description: string, listed: Listed): string {
  const unlisted = unlistedExtras(listed);
  if (!names(description, unlisted)) return description;

  return description
    .split(/(?<=[.!?]) (?=[A-Z]|extension_)/)
    .map((sentence) => listedSentence(sentence, unlisted))
    .filter((sentence): sentence is string => sentence !== null)
    .join(" ");
}

export function schemaForListed<T>(schema: T, listed: Listed): T {
  if (Array.isArray(schema)) return schema.map((item) => (item && typeof item === "object" ? schemaForListed(item, listed) : item)) as T;
  if (!schema || typeof schema !== "object") return schema;

  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, key === "description" && typeof value === "string" ? describedForListed(value, listed) : value && typeof value === "object" ? schemaForListed(value, listed) : value]),
  ) as T;
}
