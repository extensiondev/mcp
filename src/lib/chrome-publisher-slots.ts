// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isRow, text } from "./ship-act";

type Row = Record<string, unknown>;

export const CHROME_PUBLISHER_SLOTS_CHECK = "chrome.publisher_slots";
export const CHROME_SLOTS_DEFAULT = 2;
export const CHROME_SLOTS_POST_URL = "https://developer.chrome.com/blog/cws-review-updates-2026";
export const CHROME_DEVELOPER_DASHBOARD_URL = "https://chrome.google.com/webstore/devconsole";

export const CHROME_SLOTS_SENTENCE = `Since August 20, 2026 each Chrome Web Store publisher account has ${CHROME_SLOTS_DEFAULT} extension slots by default, and a new item is refused once they are used; the Chrome Web Store API has no call that lists or counts a publisher's items, so this cannot be checked here. If the account already publishes ${CHROME_SLOTS_DEFAULT} extensions, request a limit increase in the Chrome Web Store developer dashboard at ${CHROME_DEVELOPER_DASHBOARD_URL} before creating the item; Google answers at once in most cases.`;

export function chromeItemMissing(json: unknown): boolean {
  const connection = isRow(json) && isRow(json.connection) ? json.connection : null;
  if (!connection) return false;

  return connection.itemLinked !== true && !text(connection.itemId);
}

export function chromePublisherSlotsCheck(json: unknown): Row | null {
  if (!chromeItemMissing(json)) return null;

  return {
    id: CHROME_PUBLISHER_SLOTS_CHECK,
    label: "The publisher account has a free extension slot for this item",
    status: "warn",
    severity: "advisory",
    stage: "integration",
    owner: "you",
    expected: `a free slot among the account's ${CHROME_SLOTS_DEFAULT} default extension slots`,
    actual: "no Chrome item is linked to this project yet, and the API cannot count the account's items",
    message: `This project's Chrome item is still to be created in the dashboard, the step the publisher limit counts. ${CHROME_SLOTS_SENTENCE}`,
    docsUrl: CHROME_SLOTS_POST_URL,
  };
}
