// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { navigateToUrl } from "../tools/open";

export type PageOpenOutcome =
  | { opened: true; targetId: string | null; url: string }
  | { opened: false; reason: string };

interface OpenFrame {
  ok?: boolean;
  status?: string;
  error?: { message?: string };
  value?: { target?: { targetId?: string; url?: string } };
}

export function literalPageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && !url.includes("*");
}

export async function openPageForCheck(
  session: { projectPath: string; browser: string; timeout?: number },
  url: string,
): Promise<PageOpenOutcome> {
  let frame: OpenFrame;

  try {
    frame = JSON.parse(await navigateToUrl(session.projectPath, session.browser, url, session.timeout)) as OpenFrame;
  } catch (error) {
    return { opened: false, reason: error instanceof Error ? error.message : String(error) };
  }

  if (frame.ok === true && frame.status === "navigated") {
    return { opened: true, targetId: frame.value?.target?.targetId ?? null, url: frame.value?.target?.url ?? url };
  }

  return {
    opened: false,
    reason: `extension_open answered ${frame.status ?? "nothing"}: ${frame.error?.message ?? "no page target landed"}`,
  };
}
