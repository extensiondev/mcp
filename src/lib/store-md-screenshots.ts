// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { STORE_MD_FILENAME } from "./store-md";

export const SCREENSHOTS_DOOR =
  'pass screenshots to sync-listing as PNG paths inside projectPath, written by extension_screenshot with forStore: "<store>"';

const screenshotsArgument = (named: number): string =>
  `sync-listing takes ${named === 1 ? "it" : "them"} as its screenshots argument, as PNG paths inside projectPath written by extension_screenshot with forStore: "<store>"`;

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
