// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CHROME_FIELDS, CHROME_JUSTIFICATION_LIMIT, CHROME_TABS, DASHBOARD_HOME, TAB_LABELS, type ChromeTab } from "./chrome-dashboard-agent";
import { addRow, attach, chars, fillChoice, fillText, fitHostLines, isHostPattern } from "./chrome-listing-fill";
import { languageStep, pendingLanguage, readsAs, type PickerRead } from "./chrome-listing-languages";
import { stillSame, type ChromePlan } from "./chrome-listing-plan";

export { fitHostLines } from "./chrome-listing-fill";

export type Where = {
  host: string;
  path: string;
  heading?: string;
  rendered?: boolean;
  itemsList?: boolean;
  denied?: boolean;
  signedInAs?: string;
  signIn: boolean;
  dashboard: boolean;
  publisherId: string;
  itemId: string;
  tab: string;
  dialog: string | null;
  dialogTakesZip: boolean;
};

export type Gate = { ok: true; label: string; x: number; y: number } | { ok: false; reason: string; asks?: string };

export interface ChromePage {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  handle(method: string, ...args: unknown[]): Promise<string | null>;
  setFiles(objectId: string, files: string[]): Promise<void>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  navigate(url: string): Promise<void>;
}

export type Row = { tab: ChromeTab | "any"; line: string };

export type PrivacyAsks = { remoteCode: boolean; dataUsage: boolean; certified: number; certifications: number; types: string[] };

export type Inventory = { controls: string[]; uploads: string[]; buttons: string[] };

async function sawOn(deps: StepDeps): Promise<string> {
  const seen = await deps.page.call<Inventory | null>("inventory").catch(() => null);

  if (!seen || typeof seen !== "object") return "";

  const list = (rows: unknown) => (Array.isArray(rows) && rows.length ? rows.map((row) => `"${String(row)}"`).join(", ") : "none");

  return `labeled fields ${list(seen.controls)}; upload inputs ${list(seen.uploads)}; buttons ${list(seen.buttons)}`;
}

export type ChromeRun = {
  slug: string;
  plan: ChromePlan;
  publisherId: string;
  itemId: string;
  created: boolean;
  itemSaved: string;
  saveTries: number;
  newPressed: boolean;
  createPressedAt: number;
  zipSet: boolean;
  uploadPressed: boolean;
  itemOpens: number;
  authUser: number;
  tried: string[];
  done: ChromeTab[];
  filled: string[];
  rows: Row[];
  languages: Array<{ locale: string; line: string }>;
  defaultLanguage: string;
  marks: Record<string, string>;
  line: string;
  stopped: string;
  finished: boolean;
  startedAt: number;
  blankSince: number | null;
};

export type StepDeps = { page: ChromePage; sleep: (ms: number) => Promise<void>; now: () => number; image?: (url: string) => Promise<Buffer | null> };

export const SIGN_IN_LINE = "Sign in to the Chrome Web Store developer dashboard in this window. The fill starts by itself once the dashboard shows.";

export function signInLine(account: string): string {
  return account ? `Sign in as ${account}, the Google account that holds the Chrome Web Store item, in this window. The fill starts by itself once the item shows.` : SIGN_IN_LINE;
}

const ITEM_OPENS = 3;

const AUTH_USERS = 5;

function seenOn(where: Where): string {
  const shows = where.denied ? "a 403 page (this account has no access to it)" : where.itemsList ? "the Items list" : where.heading ? `"${where.heading}"` : "a page without a heading";

  return `${shows} at ${where.path}${where.signedInAs ? `, signed in as ${where.signedInAs}` : ""}`;
}

function switchTo(run: ChromeRun): string {
  return run.plan.account ? `Sign in as ${run.plan.account} in this window` : "Sign in in this window to the Google account whose publisher holds the item";
}

const CREATE_WAIT_MS = 120_000;

export const RENDER_WAIT_MS = 60_000;

const REFUSED: Record<string, string> = {
  "signed-out": "The dashboard asks for a sign-in; sign in in this window and the fill goes on by itself.",
  dialog: "The dashboard opened a dialog extension.dev tools does not answer for you.",
  "no-button": "The button for this step is not on the page, so nothing was pressed.",
  "many-buttons": "The page shows more than one button for this step, so nothing was pressed.",
  guarded: "The only button for this step carries words extension.dev tools never presses.",
  disabled: "The dashboard keeps the button for this step disabled.",
};

export function newRun(slug: string, plan: ChromePlan, now: number): ChromeRun {
  return {
    slug,
    plan,
    publisherId: plan.item?.publisherId ?? "",
    itemId: plan.item?.itemId ?? "",
    created: false,
    itemSaved: "",
    saveTries: 0,
    newPressed: false,
    createPressedAt: 0,
    zipSet: false,
    uploadPressed: false,
    itemOpens: 0,
    authUser: 0,
    tried: [],
    done: [],
    filled: [],
    rows: [],
    languages: [],
    defaultLanguage: "",
    marks: {},
    line: "Opening the Chrome Web Store developer dashboard.",
    stopped: "",
    finished: false,
    startedAt: now,
    blankSince: null,
  };
}

export function itemUrl(run: Pick<ChromeRun, "publisherId" | "itemId"> & { authUser?: number }): string {
  const home = run.authUser ? DASHBOARD_HOME.replace("/webstore/", `/u/${run.authUser}/webstore/`) : DASHBOARD_HOME;

  return `${home}/${run.publisherId}/${run.itemId}/edit`;
}

function stop(run: ChromeRun, why: string): "stopped" {
  run.stopped = `${why} Nothing else was pressed.`;
  run.line = `Stopped. ${run.stopped}`;

  return "stopped";
}

async function press(deps: StepDeps, kind: string): Promise<Gate> {
  const gate = await deps.page.call<Gate>("gate", kind);

  if (gate.ok) await deps.page.click(gate.x, gate.y);

  return gate;
}

async function createItem(run: ChromeRun, deps: StepDeps, where: Where): Promise<string> {
  if (!run.plan.pkg) return stop(run, "No item exists for this project yet and the platform holds no verified Chrome package to create one with. Build the project for Chrome, then call this again.");
  if (!stillSame(run.plan.pkg)) return stop(run, "The verified package changed on disk after it was checked, so it was not uploaded.");

  if (!run.newPressed) {
    const gate = await press(deps, "newItem");
    if (!gate.ok) return stop(run, `"New item" was not pressed: ${REFUSED[gate.reason] ?? gate.reason}${gate.ok === false && gate.asks ? ` It shows "${gate.asks}".` : ""}`);

    run.newPressed = true;
    run.createPressedAt = deps.now();
    run.line = `Pressed "${gate.label}" once.`;

    return "moved";
  }

  if (where.dialogTakesZip && !run.zipSet) {
    const input = await deps.page.handle("fileInput", "package");
    if (!input) return stop(run, "The new item dialog shows no single file field for the package.");

    await deps.page.setFiles(input, [run.plan.pkg.path]);
    run.zipSet = true;
    run.line = `Attached the verified package (SHA-256 ${run.plan.pkg.sha256.slice(0, 12)}).`;

    return "moved";
  }

  if (where.dialogTakesZip && !run.uploadPressed) {
    const upload = await deps.page.call<Gate>("gate", "upload");

    if (upload.ok) {
      await deps.page.click(upload.x, upload.y);
      run.uploadPressed = true;
      run.line = `Pressed "${upload.label}" once.`;

      return "moved";
    }

    if (upload.reason !== "disabled" && upload.reason !== "no-button") return stop(run, `"Upload" was not pressed: ${REFUSED[upload.reason] ?? upload.reason}`);
  }

  if (deps.now() - run.createPressedAt > CREATE_WAIT_MS) return stop(run, "\"New item\" was pressed once and no item came back within two minutes, so it is not pressed again. Open the new item from the dashboard list, then call this again.");

  run.line = run.zipSet ? "Waiting for the dashboard to create the item from the package." : "Waiting for the new item dialog.";

  return "wait";
}

export function tabsOf(run: Pick<ChromeRun, "plan">): ChromeTab[] {
  return CHROME_TABS.filter((tab) => tab !== "distribution" || !run.plan.live);
}


async function fillTab(run: ChromeRun, deps: StepDeps, tab: ChromeTab): Promise<void> {
  const fields = run.plan.fields;
  const before = run.rows.length;

  for (const spec of CHROME_FIELDS.filter((row) => row.tab === tab)) {
    const anchors = spec.anchors.map((re) => re.source);

    if (spec.id === "chrome.language") {
      const set = await deps.page.call<{ found: boolean; value?: string }>("fieldRead", anchors);

      if (set.found && set.value && !/^(?:select|choose)\b/i.test(set.value)) continue;

      await fillChoice(run, deps, spec.id, anchors, ["English (United States)", "English"], tab, "Language");
      continue;
    }

    const value = fields[spec.id];
    if (!value) continue;

    if (spec.control === "choice") await fillChoice(run, deps, spec.id, anchors, [value], tab, run.plan.labels[spec.id] ?? spec.id);
    else await fillText(run, deps, spec.id, anchors, value, tab, spec.label ?? run.plan.labels[spec.id] ?? spec.id);
  }

  if (tab === "listing") {
    await attach(run, deps, "icon", run.plan.icon, "Store icon");
    await attach(run, deps, "screenshots", run.plan.screenshots, "Screenshots");
  }

  if (tab === "privacy") {
    if (run.plan.justifications.length) {
      const hosts = fitHostLines(run.plan.justifications.filter((line) => isHostPattern(line.permission)));
      const lines = [...run.plan.justifications.filter((line) => !isHostPattern(line.permission)), ...hosts.kept];
      const set = await deps.page.call<Array<{ key: string; outcome: string }>>("justify", lines);

      for (const row of set) {
        const name = row.key === "host" ? "Host permission justification" : `${row.key} justification`;
        const text = run.plan.justifications.find((line) => line.permission === row.key)?.text ?? "";

        if (row.outcome === "filled" || row.outcome === "unchanged") run.filled.push(row.key === "host" && hosts.left.length ? `${name} (${hosts.kept.length} of ${hosts.kept.length + hosts.left.length} host reasons)` : name);
        else if (row.outcome === "too-long") addRow(run, { tab, line: `${name} on Privacy: the text is ${chars(text.length)} characters and Chrome takes at most ${chars(CHROME_JUSTIFICATION_LIMIT)}, so nothing was typed; shorten it in STORE.md` });
        else addRow(run, { tab, line: `${name} on Privacy: ${row.outcome === "missing" ? "no single box for it was found" : "the box did not take the text"}; paste it from STORE.md` });
      }

      if (hosts.left.length) addRow(run, { tab, line: `Host permission justification on Privacy: the host reasons in STORE.md join to ${chars(hosts.length)} characters and Chrome takes at most ${chars(CHROME_JUSTIFICATION_LIMIT)}, so ${hosts.left.join(", ")} ${hosts.left.length === 1 ? "was" : "were"} left out whole, never cut mid-sentence; shorten the host bullets under Permissions justification in STORE.md and sync again` });
    }

    const asks = run.plan.declarations.length ? await deps.page.call<PrivacyAsks | null>("privacyAsks").catch(() => null) : null;

    for (const declaration of run.plan.declarations) {
      if (asks && /remote code/i.test(declaration) && !asks.remoteCode) run.filled.push(`${declaration}: Chrome does not ask about remote code for this item, so there is nothing to answer`);
      else if (asks && /data usage/i.test(declaration) && asks.dataUsage && asks.certifications > 0 && asks.certified === asks.certifications) run.filled.push(`${declaration}: already answered on the page (${asks.certified} certifications ticked; data types ${asks.types.length ? asks.types.join(", ") : "none"}); change them on Privacy if STORE.md says otherwise`);
      else addRow(run, { tab, line: `${declaration} on Privacy: yours to answer; extension.dev tools never ticks a certification` });
    }
  }

  if (tab === "distribution") await chooseVisibility(run, deps);

  if (run.rows.slice(before).some((row) => /no single (?:field|upload slot|box)/.test(row.line))) {
    const saw = await sawOn(deps);

    if (saw) addRow(run, { tab, line: `What ${TAB_LABELS[tab]} showed when a field was not found: ${saw}` });
  }
}

/* @invariant A FIRST CHROME DRAFT IS NEVER PUBLIC
 * (store_submissions_default_least_public). Unlisted is chosen unless
 * STORE.md asks for Private, Public is never pressed, and what the page reads
 * afterwards is what the run reports.
 */
async function chooseVisibility(run: ChromeRun, deps: StepDeps): Promise<void> {
  const want = run.plan.visibility;
  const read = await deps.page.call<{ read: string; offers: Record<string, boolean> }>("visibility");

  if (read.read === want) {
    run.filled.push(`Visibility: ${want === "private" ? "Private" : "Unlisted"}`);

    return;
  }

  const at = await deps.page.call<{ x: number; y: number } | null>("visibilityAt", want);

  if (at) {
    await deps.page.click(at.x, at.y);
    await deps.sleep(300);
  }

  const after = await deps.page.call<{ read: string }>("visibility");

  if (after.read === want) run.filled.push(`Visibility: ${want === "private" ? "Private" : "Unlisted"} (the least public option)`);
  else addRow(run, { tab: "distribution", line: `Visibility on Distribution: choose ${want === "private" ? "Private" : "Unlisted"}; the page still reads ${after.read}` });
}

async function save(run: ChromeRun, deps: StepDeps, tab: ChromeTab, where: Where): Promise<string> {
  const gate = await press(deps, "save");

  if (!gate.ok && gate.reason !== "disabled") {
    const saw = gate.asks ? "" : await sawOn(deps);

    return stop(run, `"Save draft" was not pressed on ${TAB_LABELS[tab]}: ${REFUSED[gate.reason] ?? gate.reason}${gate.asks ? ` It shows "${gate.asks}".` : ` The page shows ${seenOn(where)}${saw ? `, with ${saw}` : ""}.`}`);
  }

  await deps.sleep(1500);

  const after = await deps.page.call<Where>("where");

  if (after.dialog) return stop(run, `After "Save draft" on ${TAB_LABELS[tab]} the dashboard shows "${after.dialog}"; answer it on the page yourself.`);

  run.done.push(tab);
  run.line = gate.ok ? `Saved the draft on ${TAB_LABELS[tab]}.` : `${TAB_LABELS[tab]} holds nothing new to save.`;

  return "moved";
}

export function publishCall(slug: string): string {
  return `extension_approvals_request {act: "extension_submit", args: {action: "publish", project: "${slug}", browsers: ["chrome"]}}`;
}

export function submitRow(run: Pick<ChromeRun, "slug" | "created">): string {
  if (run.created) return `Submit for review: this item was made in the dashboard, so the platform holds no draft record of it to send yet; extension_approvals_request {act: "extension_submit", args: {action: "submit", project: "${run.slug}", browsers: ["chrome"], buildSha: "<the build's sha>"}} records the build as the item's draft once a workspace owner approves it, and then ${publishCall(run.slug)} sends it to review the same way`;

  return `Submit for review: ${publishCall(run.slug)} asks a workspace owner to approve it on extension.dev, and extension_submit with the same arguments and that approvalId sends this saved draft to Chrome's review through the Chrome Web Store API under the project's saved Chrome mode, then reads the review state back; nothing is pressed on the page`;
}

export function openRows(run: Pick<ChromeRun, "rows" | "plan" | "slug" | "created">, marks: Record<string, string>): string[] {
  const rows = run.rows.filter((row) => row.tab === "any" || marks[row.tab] !== "complete").map((row) => row.line);

  return [...rows, ...run.plan.left.map((label) => `${label}: still missing on the platform side`), submitRow(run)];
}

/* @invariant ONE STEP OF THE GUIDED FIRST CHROME LISTING, ON THE ITEM THIS
 * RUN MADE OR THE PROJECT NAMES AND NO OTHER. Each step reads where the
 * dashboard tab is, does the one next thing, and says why it stopped
 * otherwise. Sign-in pages are only waited on, never read or written; New
 * item is pressed at most once; every press goes through the page gate, which
 * refuses any control that names submitting, publishing, deleting, removing,
 * confirming or signing; and the run ends at a checklist that leaves the
 * certifications and Submit for review to the person.
 */
export async function chromeStep(run: ChromeRun, deps: StepDeps): Promise<string> {
  if (run.stopped) return "stopped";

  const where = await deps.page.call<Where>("where");

  if (where.signIn) {
    if (run.authUser >= AUTH_USERS) Object.assign(run, { authUser: 0, itemOpens: 0, tried: [] });

    run.line = signInLine(run.plan.account);

    return "wait";
  }

  if (!where.dashboard) {
    await deps.page.navigate(run.itemId ? itemUrl(run) : DASHBOARD_HOME);

    return "moved";
  }

  if (where.rendered === false) {
    run.blankSince ??= deps.now();

    if (deps.now() - run.blankSince > RENDER_WAIT_MS) return stop(run, `The Chrome Web Store dashboard never rendered at ${where.path}: after ${RENDER_WAIT_MS / 1000} seconds it still shows no heading, no fields and no buttons. Reload the window, then call this again with replace: true.`);

    run.line = "Waiting for the Chrome Web Store dashboard to finish loading before filling anything.";

    return "wait";
  }

  run.blankSince = null;

  if (where.dialog && !(run.newPressed && !run.itemId && where.dialogTakesZip)) {
    const cancel = await deps.page.call<{ x: number; y: number } | null>("dialogButton", "cancel");

    if (typeof cancel?.x === "number" && typeof cancel.y === "number") {
      await deps.page.click(cancel.x, cancel.y);
      await deps.sleep(800);
      run.line = "Canceled a Remove Image confirmation left open on the page; no image was removed by it.";

      return "moved";
    }

    return stop(run, `The dashboard shows a dialog: "${where.dialog}". Answer it on the page yourself.`);
  }

  if (!run.itemId) {
    if (where.itemId) {
      if (!run.newPressed) return stop(run, "This item was not made by this run and the project names none, so nothing is filled on it. Open the dashboard home in this tab, then call this again.");

      run.itemId = where.itemId;
      run.publisherId = where.publisherId;
      run.created = true;
      run.line = `The dashboard made item ${run.itemId}.`;

      return "moved";
    }

    return createItem(run, deps, where);
  }

  const otherPublisher = Boolean(run.publisherId && where.publisherId && where.publisherId.toLowerCase() !== run.publisherId.toLowerCase());

  if (otherPublisher || !where.itemId || where.itemsList || where.denied) {
    if (run.authUser >= AUTH_USERS) {
      run.line = `No account signed in to this window opens item ${run.itemId} of publisher ${run.publisherId}${run.tried.length ? ` (tried ${run.tried.join(", ")})` : ""}. ${switchTo(run)}; the fill goes on by itself once the item opens. Nothing was filled or pressed.`;

      return "wait";
    }

    if (otherPublisher || where.denied || run.itemOpens >= ITEM_OPENS) {
      const seen = `/u/${run.authUser}/ ${seenOn(where)}${otherPublisher ? ` of publisher ${where.publisherId}` : ""}`;

      if (!run.tried.includes(seen)) run.tried.push(seen);

      run.authUser += 1;
      run.itemOpens = 0;

      if (run.authUser >= AUTH_USERS) {
        run.line = `No account signed in to this window opens item ${run.itemId} of publisher ${run.publisherId} (tried ${run.tried.join(", ")}). ${switchTo(run)}; the fill goes on by itself once the item opens. Nothing was filled or pressed.`;

        return "wait";
      }
    }

    run.itemOpens += 1;
    run.line = `Opening item ${run.itemId} as signed-in account /u/${run.authUser}/; the last page showed ${seenOn(where)}.`;
    await deps.page.navigate(itemUrl(run));

    return "moved";
  }

  if (where.itemId !== run.itemId) return stop(run, `This tab shows item ${where.itemId}, not ${run.itemId}, so nothing is filled on it.`);

  const language = run.done.includes("listing") ? pendingLanguage(run) : null;

  if (language) {
    run.line = `Filling the ${language.locale} listing on Store listing.`;

    return languageStep(run, deps, where, language);
  }

  const tab = tabsOf(run).find((row) => !run.done.includes(row));

  if (!tab) {
    run.marks = (await deps.page.call<Record<string, string>>("marks")) ?? {};

    const rows = openRows(run, run.marks);

    run.finished = true;
    run.line = `The draft is filled and saved, and it stays a draft. ${rows.length > 1 ? "Left for you:" : ""}`.trim();

    return "checklist";
  }

  if (where.tab !== tab) {
    const gate = await press(deps, `tab:${tab}`);
    if (!gate.ok) return stop(run, `The ${TAB_LABELS[tab]} tab was not opened: ${REFUSED[gate.reason] ?? gate.reason} The page shows ${seenOn(where)}.`);

    await deps.sleep(1500);

    return "moved";
  }

  if (tab === "listing" && run.plan.locales.length) {
    const picker = await deps.page.call<PickerRead>("languagePicker");
    const shows = picker?.state === "picker" ? run.plan.locales.find((row) => readsAs(picker.value, row.locale)) : undefined;

    if (shows && picker?.state === "picker") return stop(run, `Store listing shows the ${shows.locale} listing ("${picker.value}"), not the default language's, so the default description is not typed over it. Pick the default language at the top of Store listing, then call this again with replace: true.`);
    if (picker?.state === "picker") run.defaultLanguage = picker.value;
  }

  run.line = `Filling ${TAB_LABELS[tab]}.`;
  await fillTab(run, deps, tab);

  return save(run, deps, tab, where);
}

export type ItemSave = (ids: { itemId: string; publisherId: string }) => Promise<{ ok: true } | { ok: false; message: string }>;

const SAVE_TRIES = 5;

/* @invariant A NEW CHROME ITEM IS SAVED ON THE PROJECT ONCE, AS EDGE SAVES
 * ITS NEW PRODUCT. Only an item this run made is written, as the item id and
 * the publisher id the dashboard address showed, and a refused write is tried
 * again a few times and then reported, never written under another id.
 */
export async function saveNewItem(run: ChromeRun, write: ItemSave): Promise<void> {
  if (!run.created || !run.itemId || !run.publisherId || run.itemSaved === "saved" || run.saveTries >= SAVE_TRIES) return;

  run.saveTries += 1;

  const saved = await write({ itemId: run.itemId, publisherId: run.publisherId }).catch((err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }));

  run.itemSaved = saved.ok ? "saved" : saved.message || "the platform did not answer";
}
