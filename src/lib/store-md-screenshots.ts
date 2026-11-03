// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { STORE_MD_FILENAME } from "./store-md";

export const SCREENSHOTS_DOOR =
  'capture them with extension_screenshot store:"<store>", one call per view, and sync-listing picks them up from store/screenshots/<store>/';

const screenshotsArgument = (named: number): string =>
  `sync-listing takes ${named === 1 ? "it" : "them"} as its screenshots argument, as PNG paths inside projectPath; extension_screenshot store:"<store>" writes them under store/screenshots/<store>/, which sync-listing reads on its own`;

const IMAGE_PATH = /[^\s`'"()[\]<>,:]+\.(?:png|jpe?g|webp)\b/gi;

export function screenshotFilesNamed(value: string): number {
  return new Set(value.match(IMAGE_PATH) ?? []).size;
}

export function screenshotsAdvice(named: number | undefined): string {
  if (named === undefined) return `${STORE_MD_FILENAME} carries no screenshot; ${SCREENSHOTS_DOOR}`;
  if (named === 0) return `${STORE_MD_FILENAME} names no screenshot file; ${SCREENSHOTS_DOOR}`;

  return `${STORE_MD_FILENAME} names ${named} screenshot${named === 1 ? "" : "s"}; ${screenshotsArgument(named)}`;
}

export const screenshotsLineSentence = (line: string, named: number): string =>
  `the \`- ${line}:\` line in ${screenshotsAdvice(named)}`;
