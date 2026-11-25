// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { guidedConnectRuntime, openGuided, type GuidedConnectRuntime } from "./guided-connect";
import { launchWord } from "./guided-window-end";
import { isRow, text } from "./row";
import { nextStep } from "./store-connection";

type Args = Record<string, unknown>;

export const FIRST_LISTING_STATUS = "first-listing-guided";

export const FIRST_LISTING_GUIDE = "first-listing";

export const PARTNER_CENTER_OVERVIEW = "https://partner.microsoft.com/dashboard/microsoftedge/overview";

const PRODUCT_IN_URL = /\/microsoftedge\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export function firstListingStart(dashboardUrl: unknown): { url: string; productId: string } {
  const productId = PRODUCT_IN_URL.exec(text(dashboardUrl))?.[1]?.toLowerCase() ?? "";

  return productId ? { url: `https://partner.microsoft.com/dashboard/microsoftedge/${productId}/packages`, productId } : { url: PARTNER_CENTER_OVERVIEW, productId: "" };
}

export function firstListingSay(args: { label: string; productId: string; slug: string }): string {
  const create = args.productId ? "" : "presses \"Create new extension\" once and saves the new Product ID to the project's Edge store settings (no paste), ";

  return `The ${args.label} window opened on the ${args.slug} Edge page of the console. It needs a full extension.dev sign-in: sign in there if it asks, and if the page says the window was signed in by your MCP, press "Sign in to continue" there, which signs in fully and comes back to the same page, since that quick sign-in only connects store accounts. Once the page loads signed in, it opens ${args.productId ? `the Partner Center product ${args.productId}` : "the Edge overview in Partner Center"} with the extension.dev tools panel; sign in to Partner Center there if it asks. The panel has one button: it ${create}uploads the platform's verified package of the latest build after checking its SHA-256, sets Availability to Hidden (the least public option), fills Properties, Privacy and Store listings from the project's store data with its images, and presses each page's Save only. It stops before Publish with a checklist of what is filled and what Partner Center still wants; the person presses Publish. Once Partner Center shows the product in review, the panel marks the first submission on the project. If no panel shows, ask the person what the console page says.`;
}

/* @invariant A FIRST EDGE LISTING ENDS IN THE GUIDED BROWSER, NEVER IN A
 * DEFAULT BROWSER WITHOUT EXTENSION.DEV TOOLS, AND NEVER ON THE MCP'S QUICK
 * SIGN-IN. That handoff session reaches store-account connects only, so the
 * project page that offers the guided session refuses it. The MCP's own
 * browser opens the project's guided Edge page plainly, the person signs in
 * fully there, and the page opens Partner Center with the panel, whatever
 * listing text is still missing, since the panel fills what it can and lists
 * the rest. When the window cannot open, the answer says so and why (MCP
 * ledger 1151), and no default browser opens in its place.
 */
export async function guideFirstListing(result: string, args: Args, runtime: GuidedConnectRuntime = guidedConnectRuntime): Promise<string | null> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }

  if (!isRow(parsed) || !isRow(parsed.value)) return null;

  const value = parsed.value;
  const status = text(parsed.status);
  const slug = text(value.project);
  const [workspace = "", project = ""] = slug.split("/");
  const pageUrl = text(value.pageUrl);

  if (value.action !== "first-submission" || value.store !== "edge" || !workspace || !project || !pageUrl) return null;
  if (status !== "first-submission-to-do" && status !== "first-submission-waiting") return null;

  const start = firstListingStart(value.dashboardUrl);
  const guideQuery = `?guide=${FIRST_LISTING_GUIDE}`;
  const opened = await openGuided({ workspace, next: null, plainUrl: `${pageUrl.split("?")[0]}${guideQuery}`, storePage: null, api: text(args.api) || undefined, runtime });

  if ("install" in opened || !opened.opened) {
    const note = "install" in opened
      ? `No guided window was opened: ${opened.install.why} It is not installed; install it with extension_browsers_install {action: "install", browser: "${opened.install.install}"}, then call this again.`
      : `No guided window was opened, so nothing on Partner Center was filled: ${opened.note.replace(/^No (?:browser was opened|window is showing): /, "")}`;
    const left = Object.fromEntries(Object.entries(value).filter(([key]) => !["opened", "openedNote", "openPages"].includes(key)));

    return envelope({
      ok: true,
      command: text(parsed.command) || "extension_submit",
      status,
      value: { ...left, opened: false, guidedBrowser: { opened: false, note } },
      hint: [note, text(parsed.hint)].filter(Boolean).join(" "),
    });
  }

  const say = firstListingSay({ label: opened.label, productId: start.productId, slug });
  const consolePage = `${pageUrl.split("?")[0]}${guideQuery}`;
  const kept = Object.fromEntries(Object.entries(value).filter(([key]) => !["opened", "openedNote", "openPages", "nextStep", "sayToPerson"].includes(key)));

  return envelope({
    ok: true,
    command: text(parsed.command) || "extension_submit",
    status: FIRST_LISTING_STATUS,
    value: {
      ...kept,
      opened: true,
      guidedBrowser: { opened: true, browser: opened.choice.browser, why: opened.choice.why, profile: opened.profileDir, reused: opened.launched.reused, ...(opened.launched.replaced ? { replaced: true } : {}) },
      toolsExtension: { source: opened.extension.source, version: opened.extension.version, note: opened.extension.note },
      landedOn: consolePage,
      partnerCenterPage: start.url,
      sayToPerson: say,
      nextStep: nextStep("dashboard", say, consolePage),
    },
    hint: [
      `${launchWord(opened.launched)} ${opened.choice.why} Profile: ${opened.profileDir}.`,
      opened.extension.source === "bundled" ? opened.extension.note : "",
      `Tell the person: "${say}" When they say it is published, call extension_submit {action: "first-submission", store: "edge", project: "${slug}", waitSeconds: 300}.`,
    ].filter(Boolean).join(" "),
  });
}
