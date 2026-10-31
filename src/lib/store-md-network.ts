// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import fs from "node:fs";
import path from "node:path";

import { STORE_MD_FILENAME } from "./store-md";

const NO_NETWORK_PROMISE = [
  /\bno network (requests?|calls?|access|activity|connections?|traffic)\b/i,
  /\bnetwork (requests?|access|calls?|activity)\s*:\s*(none|no|never)\b/i,
  /\b(makes?|sends?|performs?|issues?|opens?) (no|zero) (network |outbound |external |remote )?(requests?|calls?|connections?)\b/i,
  /\b(does not|doesn't|never|do not|don't|will not|won't) (make|send|perform|issue|open) (any |a |an )?(network |outbound |external |remote )?(requests?|calls?|connections?)\b/i,
  /\b(never|does not|doesn't|will not|won't) (contacts?|connects? to|talks? to|reach(es)?|phones?) (a |any |an |the )?(server|servers|remote|network|internet|home)\b/i,
  /\b(works|runs|operates|functions) (entirely |fully |completely |100% )?offline\b/i,
  /\bno (data|information) (ever )?(leaves|is sent from|is sent off|is transmitted from) (the|your|this|a) (user's )?(device|browser|computer|machine)\b/i,
];

const EXCEPTION = /\b(except|other than|besides|apart from|unless|save for|aside from)\b/i;

export interface NoNetworkPromise {
  line: string;
}

function sentencesOf(content: string): string[] {
  return content
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\n+|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/^#+\s*/, "").trim())
    .filter(Boolean);
}

export function noNetworkPromiseOf(content: string): NoNetworkPromise | null {
  for (const sentence of sentencesOf(content)) {
    if (NO_NETWORK_PROMISE.some((pattern) => pattern.test(sentence)) && !EXCEPTION.test(sentence)) return { line: sentence };
  }

  return null;
}

export function storeMdNoNetworkPromise(projectPath: string): NoNetworkPromise | null {
  if (!projectPath.trim()) return null;

  try {
    return noNetworkPromiseOf(fs.readFileSync(path.join(projectPath, STORE_MD_FILENAME), "utf8"));
  } catch {
    return null;
  }
}
