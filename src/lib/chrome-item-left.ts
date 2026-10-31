// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";

type Row = Record<string, unknown>;

export const PUBLISHER_ID_CHECK = "store.chrome_publisher_id";
export const STORE_ENABLED_CHECK = "store.enabled";

const SAID_BY_THE_ITEM = new Set([PUBLISHER_ID_CHECK, STORE_ENABLED_CHECK, "store.credentials_present", "credentials"]);

export const ITEM_ON_FILE_POINTER =
  "Say value.sayToPerson to the owner as it is: the Chrome Web Store item id is on file, so the item is not created again; what is left is named with the call that clears it where one exists.";

export interface ChromeItemLeft {
  itemId: string;
  checks: unknown[];
}

const configureCall = (settings: string): string => `extension_submit action: "configure-store" store: "chrome" storeSettings: { ${settings} }`;

function failing(checks: unknown[]): Row[] {
  return checks.filter(isRow).filter((check) => text(check.status) === "fail");
}

/* @invariant AN ITEM ID ON FILE IS NEVER ASKED FOR AGAIN. The platform reads
 * the Chrome item as linked only with both ids from the dashboard address,
 * and on 2026-10-31 a preflight with the item id saved still told the owner
 * to create the item (ledger 317). With the item id on file the sentence
 * names only what is left: the publisher id, with the configure-store write
 * that saves it (publisherId, or the dashboard address as storeUrl, which
 * carries both ids); store publishing when its check fails, with the
 * enabled write; and every other failing check by the platform's own label
 * and message. Enabling publishing and choosing the channel stay the owner's
 * decisions, so the sentence offers the call and decides nothing.
 */
export function itemOnFileSentences(left: ChromeItemLeft): string {
  const address = `https://chrome.google.com/webstore/devconsole/<publisherId>/${left.itemId}/edit`;
  const checks = failing(left.checks);
  const enabledOff = checks.some((check) => text(check.id) === STORE_ENABLED_CHECK);
  const others = checks.filter((check) => !SAID_BY_THE_ITEM.has(text(check.id)));
  const steps = [
    `the publisher id, the token after /devconsole/ in the item's dashboard address (${address}): ${configureCall('publisherId: "<publisherId>"')}, or ${configureCall('storeUrl: "<that address>"')}, which saves both ids at once`,
    ...(enabledOff ? [`store publishing, off for chrome: ${configureCall("enabled: true")}, a plain call under your own token, once you want builds uploaded there`] : []),
    ...others.map((check) => `${text(check.label) || text(check.id)}: ${(text(check.message) || text(check.actual) || "the preflight names it").replace(/[.\s]+$/, "")}`),
  ];

  return `The Chrome Web Store item ${left.itemId} is on file, so there is nothing to create in the dashboard. Left before a submit: ${steps.join("; ")}.`;
}

export function chromeItemLeftOf(connection: unknown, report: unknown): ChromeItemLeft | null {
  if (!isRow(connection) || connection.itemLinked !== false) return null;

  const itemId = text(connection.itemId);
  if (!itemId) return null;

  const checks = isRow(report) && Array.isArray(report.checks) ? report.checks : [];

  return { itemId, checks };
}
