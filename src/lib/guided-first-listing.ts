// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { guidedEngine } from "./guided-browser";
import { guidedConnectRuntime, openGuided, type GuidedConnectRuntime } from "./guided-connect";
import { launchFacts, launchWord } from "./guided-window-end";
import { isRow, text } from "./row";
import { nextStep } from "./store-connection";

type Args = Record<string, unknown>;

export const FIRST_LISTING_STATUS = "first-listing-guided";

export const FIRST_LISTING_GUIDE = "first-listing";

export const PARTNER_CENTER_OVERVIEW = "https://partner.microsoft.com/dashboard/microsoftedge/overview";

const PRODUCT_IN_URL = /\/microsoftedge\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export const APP_STORE_CONNECT_APPS = "https://appstoreconnect.apple.com/apps";

const APP_IN_URL = /^https:\/\/appstoreconnect\.apple\.com\/apps\/(\d{6,12})(?:[/?#]|$)/i;

export function appRecordStart(dashboardUrl: unknown): { url: string; productId: string } {
  const productId = APP_IN_URL.exec(text(dashboardUrl))?.[1] ?? "";

  return productId ? { url: `${APP_STORE_CONNECT_APPS}/${productId}/distribution/privacy`, productId } : { url: APP_STORE_CONNECT_APPS, productId: "" };
}

export function signInSentence(args: { label: string; slug: string; storeName: string; signedIn: boolean }): string {
  return args.signedIn
    ? `The ${args.label} window signs in to the console by itself from your MCP sign-in and opens the ${args.slug} ${args.storeName} page. That quick sign-in reaches only this project's first ${args.storeName} listing and ends with the guided session; it never reaches billing, settings, other projects or an approval, which stays a full sign-in.`
    : `The ${args.label} window opened on the ${args.slug} ${args.storeName} page of the console; sign in to extension.dev there if it asks.`;
}

export function appRecordSay(args: { label: string; productId: string; slug: string; signedIn?: boolean }): string {
  const create = args.productId ? "" : "opens New App, ticks macOS only, types the App Store name, primary language, the project's bundle ID and an SKU, presses Create once and saves the new app's Apple ID to the project's App Store settings (no paste), then ";

  return `${signInSentence({ label: args.label, slug: args.slug, storeName: "App Store", signedIn: args.signedIn === true })} Once the page loads signed in, it opens ${args.productId ? `App Privacy of the app ${args.productId}` : "Apps"} in App Store Connect with the extension.dev tools panel open on its one button; sign in to App Store Connect there if it asks. The next step is to press ${args.productId ? '"Finish the App Store Connect steps"' : '"Create the App Store app record"'} in the panel: it ${create}answers App Privacy's data collection question only when STORE.md says the app collects no data, and presses Save. It never presses Publish on App Privacy: the person does, once the answers read right. App Store Connect's API cannot create an app or answer App Privacy, so these are the only steps on the website; every version then goes to review through the API. If no panel shows, ask the person what the console page says.`;
}

export function firstListingStart(dashboardUrl: unknown): { url: string; productId: string } {
  const productId = PRODUCT_IN_URL.exec(text(dashboardUrl))?.[1]?.toLowerCase() ?? "";

  return productId ? { url: `https://partner.microsoft.com/dashboard/microsoftedge/${productId}/packages`, productId } : { url: PARTNER_CENTER_OVERVIEW, productId: "" };
}

export function firstListingSay(args: { label: string; productId: string; slug: string; signedIn?: boolean }): string {
  const create = args.productId ? "" : "presses \"Create new extension\" once and saves the new Product ID to the project's Edge store settings (no paste), ";

  return `${signInSentence({ label: args.label, slug: args.slug, storeName: "Edge", signedIn: args.signedIn === true })} Once the page loads signed in, it opens ${args.productId ? `the Partner Center product ${args.productId}` : "the Edge overview in Partner Center"} with the extension.dev tools panel open on its one button; sign in to Partner Center there if it asks. The next step is to press ${args.productId ? '"Fill the Edge listing"' : '"Create and fill the Edge listing"'} in the panel: it ${create}uploads the platform's verified package of the latest build after checking its SHA-256, sets Availability to Hidden (the least public option), fills Properties, Privacy and Store listings from the project's store data with its images, and presses each page's Save only. Once Partner Center marks every page complete, the panel presses Publish once, and Partner Center's confirm, only after a workspace owner's extension.dev approval of this exact act reads approved: the first submission of this package at Hidden visibility. Until then it stops with a checklist and names the approval page. Once Partner Center shows the product in review, the panel marks the first submission on the project. If no panel shows, ask the person what the console page says.`;
}

function firstSubmissionWait(store: string, slug: string): string {
  return `extension_submit {action: "first-submission", store: "${store}", project: "${slug}", waitSeconds: 300}`;
}

function safariNext(slug: string, productId: string): string {
  const submit = `extension_approvals_request {act: "extension_submit", args: {action: "submit", project: "${slug}", browsers: ["safari"], buildSha: "<the build's sha>"}}`;
  const privacy = "App Privacy's Publish is not readable through any App Store Connect API, so the person approves the submit once they have pressed it.";

  return productId
    ? `The project already holds the app record ${productId}. ${privacy} Ask the owner's approval of the submit now with ${submit}.`
    : `Then, without waiting for their word, call ${firstSubmissionWait("safari", slug)}: it waits until the platform reads the app record New App creates (the app's Apple ID saved to the project) and answers at once when it does. ${privacy} Once the record is read, ask the owner's approval of the submit with ${submit}.`;
}

type UnspentApproval = { approvalId: string; buildSha: string; packageSha256: string; approvalUrl: string };

function unspentApprovalOf(raw: unknown): UnspentApproval | null {
  if (!isRow(raw)) return null;

  const row = { approvalId: text(raw.approvalId), buildSha: text(raw.buildSha), packageSha256: text(raw.packageSha256), approvalUrl: text(raw.approvalUrl) };

  return row.approvalId && row.buildSha && row.packageSha256 ? row : null;
}

/* @invariant AN APPROVED, UNSPENT APPROVAL OF THIS BUILD'S PACKAGE IS NEVER
 * ASKED FOR AGAIN (MCP ledger 1307). The platform's first-submission read
 * names the approval it would spend for the latest build and package; while
 * one reads approved and unused, the answer names it and says the panel
 * spends it on its Publish press, instead of asking for another.
 */
function unspentSentence(row: UnspentApproval): string {
  return `Approval ${row.approvalId} is already approved and unspent for build ${row.buildSha} (package SHA-256 ${row.packageSha256.slice(0, 12)}), so do not call extension_approvals_request: the panel spends ${row.approvalId} when it presses Publish once Partner Center marks every page complete. Never press Publish for the person.`;
}

/* @invariant A FIRST EDGE OR APP STORE LISTING ENDS IN THE GUIDED BROWSER, NEVER IN A
 * DEFAULT BROWSER WITHOUT EXTENSION.DEV TOOLS (MCP ledger 1151). The MCP's own
 * browser signs in to the console through the one-time handoff, bound to this
 * launch's secret and scoped by the platform to this one project and this one
 * store (Cezar, 2026-11-27, ledger 1291): no billing, settings, other projects
 * or approvals, and it ends with the guided session. The project's guided page
 * then opens the store dashboard with the panel, whatever listing text is
 * still missing, since the panel fills what it can and lists the rest. With
 * no handoff (no login, or the platform refused it) the page opens plainly and
 * the person signs in there. When the window cannot open, the answer says so
 * and why, and no default browser opens in its place.
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

  if (value.action !== "first-submission" || (value.store !== "edge" && value.store !== "safari") || !workspace || !project || !pageUrl) return null;
  if (status !== "first-submission-to-do" && status !== "first-submission-waiting") return null;

  const apple = value.store === "safari";
  const start = apple ? appRecordStart(value.dashboardUrl) : firstListingStart(value.dashboardUrl);
  const guideQuery = `?guide=${FIRST_LISTING_GUIDE}`;
  const opened = await openGuided({ workspace, next: `/${workspace}/${project}/submissions/${value.store}${guideQuery}`, plainUrl: `${pageUrl.split("?")[0]}${guideQuery}`, storePage: null, api: text(args.api) || undefined, runtime });

  if ("install" in opened || !opened.opened) {
    const note = "install" in opened
      ? `No guided window was opened: ${opened.install.why} It is not installed; install it with extension_browsers_install {action: "install", browser: "${opened.install.install}"}, then call this again.`
      : `No guided window was opened, so nothing on ${apple ? "App Store Connect" : "Partner Center"} was filled: ${opened.note.replace(/^No (?:browser was opened|window is showing): /, "")}`;
    const left = Object.fromEntries(Object.entries(value).filter(([key]) => !["opened", "openedNote", "openPages"].includes(key)));

    return envelope({
      ok: true,
      command: text(parsed.command) || "extension_submit",
      status,
      value: { ...left, opened: false, guidedBrowser: { opened: false, note } },
      hint: [note, text(parsed.hint)].filter(Boolean).join(" "),
    });
  }

  if (guidedEngine(opened.choice.browser) === "chromium") runtime.watchAttach?.({ profileDir: opened.profileDir, extensionDir: opened.extensionDir });

  const unspent = apple ? null : unspentApprovalOf(value.unspentApproval);
  const say = (apple ? appRecordSay : firstListingSay)({ label: opened.label, productId: start.productId, slug, signedIn: opened.landing.signedIn });
  const consolePage = `${pageUrl.split("?")[0]}${guideQuery}`;
  const kept = Object.fromEntries(Object.entries(value).filter(([key]) => !["opened", "openedNote", "openPages", "nextStep", "sayToPerson"].includes(key)));

  return envelope({
    ok: true,
    command: text(parsed.command) || "extension_submit",
    status: FIRST_LISTING_STATUS,
    value: {
      ...kept,
      opened: true,
      guidedBrowser: { opened: true, browser: opened.choice.browser, why: opened.choice.why, profile: opened.profileDir, reused: opened.launched.reused, ...launchFacts(opened.launched) },
      toolsExtension: { source: opened.extension.source, version: opened.extension.version, note: opened.extension.note },
      landedOn: consolePage,
      ...(apple ? { appStoreConnectPage: start.url } : { partnerCenterPage: start.url }),
      sayToPerson: say,
      nextStep: nextStep("dashboard", say, consolePage),
    },
    hint: [
      `${launchWord(opened.launched)} ${opened.choice.why} Profile: ${opened.profileDir}.`,
      opened.extension.source === "bundled" ? opened.extension.note : "",
      ...(apple
        ? [`Tell the person: "${say}" Never press Create or Publish for them.`, safariNext(slug, start.productId)]
        : unspent
          ? [unspentSentence(unspent),
            `Tell the person: "${say}" Then, without waiting for their word, call ${firstSubmissionWait("edge", slug)}: it waits while the platform reads Partner Center and answers done with the store's own word once the product is in review; while it answers waiting, call it again.`]
          : [`Now call extension_approvals_request {act: "extension_submit", args: {action: "first-submission", store: "edge", project: "${slug}"}}, which asks the owner's approval of the Publish press and answers its approvalUrl; never approve it yourself and never press Publish for the person.`,
      `Tell the person: "${say}" and give them the approvalUrl. Then, without waiting for their word, call ${firstSubmissionWait("edge", slug)}: it waits while the platform reads Partner Center and answers done with the store's own word once the product is in review; while it answers waiting, call it again.`]),
    ].filter(Boolean).join(" "),
  });
}
