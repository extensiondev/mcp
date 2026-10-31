// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { STORE_MD_FILENAME } from "./store-md";
import { LISTING_SECTION, STORE_SECTIONS, classifyStore } from "./store-md-listing";

export interface PasteLines {
  language?: string;
  testInstructions?: string;
}

function sectionsOf(content: string): Array<{ heading: string; body: string }> {
  return content
    .split(/^## +/m)
    .slice(1)
    .map((chunk) => {
      const [heading = "", ...rest] = chunk.split("\n");

      return { heading: heading.trim(), body: rest.join("\n") };
    });
}

function testInstructionsIn(body: string): boolean {
  const match = body.match(/^### +test instructions\b[^\n]*\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/im);

  return Boolean(match?.[1]?.trim());
}

export function chromePasteLines(content: string): PasteLines {
  const lines: PasteLines = {};

  for (const section of sectionsOf(content)) {
    const heading = section.heading.toLowerCase();

    if (heading.startsWith("listing")) {
      const language = section.body.match(/^- +(language) *:[ \t]*\S/im);
      if (language) lines.language = `\`- ${language[1]}:\` under \`${LISTING_SECTION}\` in ${STORE_MD_FILENAME}`;
    } else if (classifyStore(section.heading)[0] === "chrome" && !lines.testInstructions && testInstructionsIn(section.body)) {
      lines.testInstructions = `\`### Test instructions\` under \`${STORE_SECTIONS.chrome}\` in ${STORE_MD_FILENAME}`;
    }
  }

  return lines;
}
