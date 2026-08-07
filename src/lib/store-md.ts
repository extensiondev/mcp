// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

/* @invariant THIS IS A PORT, NOT AN INTERPRETATION.
 *
 * The submission that reaches AMO and Partner Center is parsed by
 * `parseStoreMd` in @extension.dev/deploy, which is a PRIVATE package under
 * C11 and therefore cannot be a dependency of this PUBLIC one. So the rules
 * live here twice on purpose, and the copy is held to the original by
 * src/__tests__/store-md-contract.test.ts: it pins the upstream file's
 * sha256 and replays both implementations over the same corpus whenever the
 * upstream checkout is reachable. Change a rule here and that test reddens.
 * Change a rule there and it reddens too. Neither side may move alone.
 */

export const STORE_MD_FILENAME = "STORE.md";

export interface StoreMdData {
  firefox?: {
    approvalNotes?: string;
    releaseNotes?: string;
  };
  edge?: {
    certificationNotes?: string;
  };
}

type StoreKeyInMd = "chrome" | "firefox" | "edge";

function classifyStoreHeading(heading: string): StoreKeyInMd | undefined {
  const text = heading.toLowerCase();
  if (/\bfirefox\b|\bamo\b|firefox-amo/.test(text)) return "firefox";
  if (/\bedge\b|edge-add-ons/.test(text)) return "edge";
  if (/\bchrome\b|chrome-web-store/.test(text)) return "chrome";
  return undefined;
}

function stripComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "");
}

interface Section {
  heading: string;
  body: string;
}

function splitSections(content: string, level: number): Section[] {
  const marker = "#".repeat(level);
  const pattern = new RegExp(`^${marker} +(.+)$`, "gm");
  const sections: Section[] = [];
  let match = pattern.exec(content);
  while (match) {
    const start = pattern.lastIndex;
    const next = pattern.exec(content);
    sections.push({
      heading: match[1]!.trim(),
      body: content.slice(start, next ? next.index : content.length),
    });
    match = next;
  }
  return sections;
}

function fieldText(storeBody: string, fieldName: string): string | undefined {
  for (const sub of splitSections(storeBody, 3)) {
    if (sub.heading.toLowerCase().startsWith(fieldName)) {
      const text = stripComments(sub.body).trim();
      return text.length > 0 ? text : undefined;
    }
  }
  return undefined;
}

export function parseStoreMd(content: string): StoreMdData {
  const data: StoreMdData = {};

  for (const section of splitSections(content, 2)) {
    const store = classifyStoreHeading(section.heading);
    if (store === "firefox" && !data.firefox) {
      const approvalNotes = fieldText(section.body, "reviewer notes");
      const releaseNotes = fieldText(section.body, "release notes");
      if (approvalNotes || releaseNotes) {
        data.firefox = { approvalNotes, releaseNotes };
      }
    } else if (store === "edge" && !data.edge) {
      const certificationNotes = fieldText(section.body, "certification notes");
      if (certificationNotes) {
        data.edge = { certificationNotes };
      }
    }
  }

  return data;
}
