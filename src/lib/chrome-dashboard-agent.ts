// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const AGENT_GLOBAL = "__extensionDevToolsChrome";

export const AGENT_VERSION = 4;

export const DASHBOARD_HOME = "https://chrome.google.com/webstore/devconsole";

export const CHROME_TABS = ["listing", "privacy", "distribution"] as const;

export type ChromeTab = (typeof CHROME_TABS)[number];

export const TAB_LABELS: Record<ChromeTab, string> = { listing: "Store listing", privacy: "Privacy", distribution: "Distribution" };

export type FieldSpec = { id: string; tab: ChromeTab; anchors: RegExp[]; control: "text" | "choice"; label?: string };

export const CHROME_JUSTIFICATION_LIMIT = 1000;

/* @invariant EVERY SELECTOR THE CHROME FILL READS IS NAMED HERE, IN ONE
 * TABLE, AND NONE IS PROVEN AGAINST THE LIVE DASHBOARD YET. Chrome keeps
 * every extension off the Chrome Web Store, so the fill runs as page script
 * over the guided window's debug port and finds each control by the words
 * the dashboard shows beside it, never by a generated class. A control the
 * words name more than once, or not at all, is reported missing and left
 * for the person, never guessed.
 */
export const CHROME_SELECTORS = {
  newItem: /^(?:\+\s*)?(?:add\s+)?new item$/i,
  itemsHeading: /^items$/i,
  repeated: /^(.{2,}?)\1+/,
  iconLead: /^store icon/i,
  removeImage: /^remove image\b/i,
  screenshotsLead: /^screenshots?\b/i,
  denied: /(?:^|\s)403(?:[.\s]|$)|forbidden|that’s an error|that's an error|(?:do not|don't|don’t) have (?:access|permission)|permission denied|not authorized/i,
  upload: /^upload$/i,
  save: /^save draft$/i,
  tabs: { listing: /^store listing$/i, privacy: /^privacy(?: practices)?$/i, distribution: /^distribution$/i } as Record<ChromeTab, RegExp>,
  tabPath: /\/edit(?:\/([a-z-]+))?\/?$/i,
  guarded: /publish|submit|delete|remove|unpublish|confirm|^ok$|sign|cancel|discard|withdraw|pay|unlist|archive/i,
  icon: /store icon/i,
  screenshots: /screenshots?/i,
  complete: /complete|done|check_circle|task_alt/i,
  incomplete: /error|warning|incomplete|required|missing/i,
  hostJustification: /host permission/i,
  justification: /justification/i,
  unlisted: /^unlisted\b/i,
  private: /^private\b/i,
  public: /^public\b/i,
} as const;

export const CHROME_FIELDS: readonly FieldSpec[] = [
  { id: "chrome.description", tab: "listing", anchors: [/^(?:detailed )?description\b/i], control: "text" },
  { id: "chrome.category", tab: "listing", anchors: [/^category\b/i], control: "choice" },
  { id: "chrome.language", tab: "listing", anchors: [/^language\b/i], control: "choice" },
  { id: "chrome.homepage_url", tab: "listing", anchors: [/^homepage url\b/i], control: "text", label: "Homepage URL" },
  { id: "chrome.single_purpose", tab: "privacy", anchors: [/single purpose/i], control: "text" },
  { id: "chrome.privacy_policy_url", tab: "privacy", anchors: [/privacy policy url/i], control: "text" },
];

const src = (re: RegExp) => JSON.stringify(re.source);

export const CHROME_PAGE_AGENT = `(() => {
  if (globalThis.${AGENT_GLOBAL} && globalThis.${AGENT_GLOBAL}.version === ${AGENT_VERSION}) return true;
  const S = {
    newItem: new RegExp(${src(CHROME_SELECTORS.newItem)}, "i"),
    itemsHeading: new RegExp(${src(CHROME_SELECTORS.itemsHeading)}, "i"),
    repeated: new RegExp(${src(CHROME_SELECTORS.repeated)}),
    iconLead: new RegExp(${src(CHROME_SELECTORS.iconLead)}, "i"),
    removeImage: new RegExp(${src(CHROME_SELECTORS.removeImage)}, "i"),
    screenshotsLead: new RegExp(${src(CHROME_SELECTORS.screenshotsLead)}, "i"),
    denied: new RegExp(${src(CHROME_SELECTORS.denied)}, "i"),
    upload: new RegExp(${src(CHROME_SELECTORS.upload)}, "i"),
    save: new RegExp(${src(CHROME_SELECTORS.save)}, "i"),
    tabs: { listing: new RegExp(${src(CHROME_SELECTORS.tabs.listing)}, "i"), privacy: new RegExp(${src(CHROME_SELECTORS.tabs.privacy)}, "i"), distribution: new RegExp(${src(CHROME_SELECTORS.tabs.distribution)}, "i") },
    tabPath: new RegExp(${src(CHROME_SELECTORS.tabPath)}, "i"),
    guarded: new RegExp(${src(CHROME_SELECTORS.guarded)}, "i"),
    icon: new RegExp(${src(CHROME_SELECTORS.icon)}, "i"),
    screenshots: new RegExp(${src(CHROME_SELECTORS.screenshots)}, "i"),
    complete: new RegExp(${src(CHROME_SELECTORS.complete)}, "i"),
    incomplete: new RegExp(${src(CHROME_SELECTORS.incomplete)}, "i"),
    hostJustification: new RegExp(${src(CHROME_SELECTORS.hostJustification)}, "i"),
    justification: new RegExp(${src(CHROME_SELECTORS.justification)}, "i"),
    vis: { unlisted: new RegExp(${src(CHROME_SELECTORS.unlisted)}, "i"), private: new RegExp(${src(CHROME_SELECTORS.private)}, "i"), public: new RegExp(${src(CHROME_SELECTORS.public)}, "i") },
  };
  const PANEL = "data-extension-dev-tools-panel";
  const norm = (v) => String(v == null ? "" : v).replace(/\\s+/g, " ").trim();
  const shown = (el) => { if (!el || !el.isConnected || el.closest("[" + PANEL + "]")) return false; if (el.closest("[hidden], [aria-hidden=true], [inert]")) return false; const st = getComputedStyle(el); if (st.display === "none" || st.visibility === "hidden") return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const hiddenFile = (el) => el.isConnected && !el.closest("[" + PANEL + "]");
  const dialogs = () => Array.from(document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]")).filter(shown);
  const center = (el) => { el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  const once = (t) => norm(t).replace(S.repeated, "$1");
  const visibleText = (node) => { const copy = node.cloneNode(true); copy.querySelectorAll("[aria-hidden=true]").forEach((n) => n.remove()); return once(copy.textContent); };
  const labelOf = (el) => {
    const aria = once(el.getAttribute("aria-label")); if (aria) return aria;
    const by = once((el.getAttribute("aria-labelledby") || "").split(/\\s+/).map((id) => { const n = id && document.getElementById(id); return n ? visibleText(n) : ""; }).join(" ")); if (by) return by;
    if (el.id) { const l = Array.from(document.querySelectorAll("label")).find((x) => x.htmlFor === el.id); if (l) return visibleText(l); }
    const wrap = el.closest("label"); if (wrap) return visibleText(wrap);
    let at = el;
    for (let i = 0; i < 4 && at.parentElement; i += 1) { at = at.parentElement; const t = once(Array.from(at.childNodes).filter((n) => !(n.nodeType === 1 && (n.contains(el) || n.matches("input, textarea, select") || n.getAttribute("aria-hidden") === "true"))).map((n) => n.textContent).join(" ")); if (t) return t.slice(0, 200); }
    return "";
  };
  const ICONS = "i, svg, mat-icon, .material-icons, .material-symbols-outlined, [aria-hidden=true]";
  const ownText = (el) => { const copy = el.cloneNode(true); copy.querySelectorAll(ICONS).forEach((n) => n.remove()); return norm(copy.textContent); };
  const actionLabel = (el) => norm(el.getAttribute("aria-label")) || ownText(el);
  const actions = (root) => Array.from(root.querySelectorAll("button, a[href], [role=button], [role=link], [role=tab], [role=menuitem]")).filter(shown);
  const passwordShown = () => Array.from(document.querySelectorAll("input[type=password]")).some(shown);
  const where = () => {
    const host = location.host.toLowerCase();
    const m = /\\/webstore\\/devconsole\\/([^/?#]+)(?:\\/([a-p]{32}))?/i.exec(location.pathname);
    const tm = S.tabPath.exec(location.pathname);
    const current = actions(document).find((el) => el.getAttribute("aria-current") === "page" || el.getAttribute("aria-selected") === "true");
    const byNav = current ? Object.keys(S.tabs).find((k) => S.tabs[k].test(actionLabel(current))) : "";
    const byPath = tm ? ({ "": "listing", listing: "listing", privacy: "privacy", distribution: "distribution" })[(tm[1] || "").toLowerCase()] || "" : "";
    const d = dialogs()[0];
    const heads = Array.from(document.querySelectorAll("h1, [role=heading][aria-level='1']")).filter(shown).map((h) => norm(h.textContent)).filter(Boolean);
    const acct = document.querySelector("meta[name=og-profile-acct]");
    return {
      host, path: location.pathname,
      heading: (heads[0] || "").slice(0, 120),
      itemsList: heads.some((h) => S.itemsHeading.test(h)),
      denied: !controls().length && S.denied.test((document.title || "") + " " + norm(document.body ? document.body.innerText : "").slice(0, 600)),
      signedInAs: acct ? norm(acct.getAttribute("content")) : "",
      signIn: host === "accounts.google.com" || passwordShown(),
      dashboard: host === "chrome.google.com" && /^\\/(?:u\\/\\d+\\/)?webstore\\/devconsole/i.test(location.pathname),
      publisherId: m ? m[1] : "", itemId: m && m[2] ? m[2].toLowerCase() : "",
      tab: byNav || byPath,
      dialog: d ? norm(d.textContent).replace(/\\S{16,}/g, "[hidden]").slice(0, 240) : null,
      dialogTakesZip: Boolean(d && Array.from(d.querySelectorAll("input[type=file]")).some(hiddenFile)),
    };
  };
  const gate = (kind) => {
    if (passwordShown()) return { ok: false, reason: "signed-out" };
    const d = dialogs()[0];
    const tab = kind.indexOf("tab:") === 0 ? kind.slice(4) : "";
    const rule = tab ? S.tabs[tab] : S[kind];
    if (!rule) return { ok: false, reason: "no-button" };
    if (kind === "upload") { if (!d) return { ok: false, reason: "no-button" }; }
    else if (d) return { ok: false, reason: "dialog", asks: norm(d.textContent).replace(/\\S{16,}/g, "[hidden]").slice(0, 240) };
    const hits = actions(kind === "upload" ? d : document).filter((el) => rule.test(actionLabel(el)));
    if (!hits.length) return { ok: false, reason: "no-button" };
    if (hits.length > 1) return { ok: false, reason: "many-buttons" };
    const el = hits[0];
    const label = actionLabel(el);
    if (S.guarded.test(label)) return { ok: false, reason: "guarded" };
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return { ok: false, reason: "disabled" };
    const at = center(el);
    return { ok: true, label: label, x: at.x, y: at.y };
  };
  const scopeOf = (input) => { let at = input; for (let i = 0; i < 6 && at.parentElement && at.parentElement !== document.body && at.parentElement.querySelectorAll("input[type=file]").length <= 1; i += 1) at = at.parentElement; return at; };
  const slotRule = (slot) => slot === "icon" ? S.icon : S.screenshots;
  const slotLead = (slot) => slot === "icon" ? S.iconLead : S.screenshotsLead;
  const slotLabel = (input) => once(input.getAttribute("aria-label")) || visibleText(scopeOf(input));
  const fileInput = (slot) => {
    if (slot === "package") { const d = dialogs()[0]; const ins = d ? Array.from(d.querySelectorAll("input[type=file]")).filter(hiddenFile) : []; return ins.length === 1 ? ins[0] : null; }
    const inputs = Array.from(document.querySelectorAll("input[type=file]")).filter(hiddenFile);
    const lead = inputs.filter((input) => slotLead(slot).test(slotLabel(input)));
    if (lead.length === 1) return lead[0];
    const re = slotRule(slot);
    const hits = inputs.filter((input) => re.test(norm(scopeOf(input).textContent) + " " + norm(input.getAttribute("aria-label"))));
    return hits.length === 1 ? hits[0] : null;
  };
  const images = (slot) => {
    const input = fileInput(slot);
    if (!input) return null;
    return Array.from(scopeOf(input).querySelectorAll("img")).filter((img) => img.getAttribute("src") && shown(img) && !/placeholder/i.test(img.getAttribute("src") || "")).map((img) => img.getAttribute("src"));
  };
  const thumbs = (slot) => { const srcs = images(slot); return srcs ? srcs.length : -1; };
  const tiles = (slot) => {
    const input = fileInput(slot);
    if (!input) return [];
    return Array.from(scopeOf(input).querySelectorAll("img")).filter((img) => img.getAttribute("src") && shown(img) && !/placeholder/i.test(img.getAttribute("src") || "")).map((img) => {
      const holder = img.closest("[data-image-key]");
      const key = holder ? holder.getAttribute("data-image-key") : String(img.getAttribute("src")).replace(/=[^/]*$/, "");
      let at = img; let remove = null;
      for (let i = 0; i < 5 && at && !remove; i += 1) { at = at.parentElement; if (!at) break; const hits = actions(at).filter((el) => S.removeImage.test(actionLabel(el))); if (hits.length === 1) remove = hits[0]; else if (hits.length > 1) break; }
      return { key: key, img: img, remove: remove };
    });
  };
  const slotImages = (slot) => tiles(slot).map((t) => ({ key: t.key, label: t.remove ? actionLabel(t.remove).replace(S.removeImage, "").trim() : "", removable: Boolean(t.remove) }));
  const removeAt = (slot, key) => {
    if (dialogs().length) return null;
    const hits = tiles(slot).filter((t) => t.key === key && t.remove);
    if (hits.length !== 1) return null;
    const el = hits[0].remove;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return null;
    const at = center(el);
    return { x: at.x, y: at.y };
  };
  const controls = () => Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=file]):not([type=radio]):not([type=checkbox]), textarea, select, [role=combobox], [role=listbox][aria-expanded], [aria-haspopup=listbox]:not(input), [contenteditable=true]")).filter(shown).filter((el, i, all) => !all.some((other) => other !== el && other.contains(el)));
  const findControl = (anchors) => {
    const res = anchors.map((a) => new RegExp(a, "i"));
    const hits = controls().filter((el) => { const l = labelOf(el); return res.some((re) => re.test(l)); });
    return hits.length === 1 ? hits[0] : null;
  };
  const valueOf = (el) => { if (el.tagName === "SELECT") return norm(el.selectedOptions[0] ? el.selectedOptions[0].text : ""); if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.value; const sel = el.querySelector("[role=option][aria-selected=true]"); return sel ? visibleText(sel) : visibleText(el); };
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  const sameChoice = (a, b) => { const x = norm(a).toLowerCase(); const y = norm(b).toLowerCase(); return Boolean(x) && (x === y || y.endsWith(" " + x) || y.endsWith(">" + x) || y.endsWith("\\u203a " + x)); };
  const fieldRead = (anchors) => { const el = findControl(anchors); return el ? { found: true, kind: el.tagName === "SELECT" ? "select" : el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? "text" : "combo", value: valueOf(el), editable: !(el.disabled || el.readOnly || el.getAttribute("aria-disabled") === "true"), limit: el.maxLength > 0 ? el.maxLength : 0 } : { found: false }; };
  const setText = (anchors, text) => {
    const el = findControl(anchors);
    if (!el) return "missing";
    if (el.disabled || el.readOnly) return "not-editable";
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return "missing";
    if (el.value === text) return "unchanged";
    if (el.maxLength > 0 && text.length > el.maxLength) return "too-long";
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, "value");
    if (d && d.set) d.set.call(el, text); else el.value = text;
    fire(el, "input"); fire(el, "change"); fire(el, "blur");
    return el.value === text ? "filled" : "needs-typing";
  };
  const focusText = (anchors) => { const el = findControl(anchors); if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return false; el.focus(); el.select(); return true; };
  const choose = (anchors, wanted) => {
    const el = findControl(anchors);
    if (!el) return { outcome: "missing" };
    if (el.tagName === "SELECT") {
      if (el.disabled) return { outcome: "not-editable" };
      const opt = Array.from(el.options).find((o) => !o.disabled && (sameChoice(wanted, o.text) || sameChoice(wanted, o.value)));
      if (!opt) return { outcome: "no-option" };
      if (el.value === opt.value) return { outcome: "unchanged" };
      el.value = opt.value; fire(el, "input"); fire(el, "change");
      return { outcome: el.value === opt.value ? "filled" : "no-option" };
    }
    if (sameChoice(wanted, valueOf(el))) return { outcome: "unchanged" };
    const at = center(el);
    return { outcome: "open", x: at.x, y: at.y };
  };
  const option = (wanted) => {
    const all = Array.from(document.querySelectorAll("[role=option], [role=menuitemradio]")).filter(shown);
    let opts = all.filter((o) => sameChoice(wanted, visibleText(o)));
    if (opts.length > 1) opts = opts.filter((o) => !o.closest("[aria-expanded=false]"));
    if (opts.length > 1) { const exact = opts.filter((o) => visibleText(o).toLowerCase() === norm(wanted).toLowerCase()); if (exact.length) opts = exact; }
    if (opts.length !== 1) return { found: opts.length, seen: all.map(visibleText).filter(Boolean).slice(0, 20) };
    const at = center(opts[0]);
    return { x: at.x, y: at.y };
  };
  const justificationBoxes = () => controls().filter((el) => (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && S.justification.test(labelOf(el)));
  const justify = (lines) => {
    const boxes = justificationBoxes();
    const out = [];
    const isHost = (p) => /:\\/\\/|^<all_urls>$|^\\*/.test(p);
    const hostLines = lines.filter((l) => isHost(l.permission));
    const hostBox = boxes.filter((el) => S.hostJustification.test(labelOf(el)));
    if (hostLines.length) {
      if (hostBox.length === 1) out.push({ key: "host", outcome: setOn(hostBox[0], hostLines.map((l) => l.permission + ": " + l.text).join("\\n")) });
      else out.push({ key: "host", outcome: "missing" });
    }
    for (const l of lines.filter((x) => !isHost(x.permission))) {
      const name = l.permission.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
      const re = new RegExp("(^|[^a-z.])" + name + "([^a-z.]|$)", "i");
      const hit = boxes.filter((el) => !S.hostJustification.test(labelOf(el)) && re.test(labelOf(el)));
      out.push({ key: l.permission, outcome: hit.length === 1 ? setOn(hit[0], l.text) : "missing" });
    }
    return out;
  };
  const setOn = (el, text) => {
    if (el.disabled || el.readOnly) return "not-editable";
    if (el.value === text) return "unchanged";
    if (el.maxLength > 0 && text.length > el.maxLength) return "too-long";
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, "value");
    if (d && d.set) d.set.call(el, text); else el.value = text;
    fire(el, "input"); fire(el, "change"); fire(el, "blur");
    return el.value === text ? "filled" : "needs-typing";
  };
  const radios = () => Array.from(document.querySelectorAll("input[type=radio], [role=radio]")).filter((el) => el.isConnected && !el.closest("[" + PANEL + "]"));
  const radioChecked = (el) => el.tagName === "INPUT" ? el.checked : el.getAttribute("aria-checked") === "true";
  const visibility = () => {
    const pick = (re) => radios().filter((el) => re.test(labelOf(el)));
    const u = pick(S.vis.unlisted), p = pick(S.vis.private), o = pick(S.vis.public);
    const read = u.some(radioChecked) ? "unlisted" : p.some(radioChecked) ? "private" : o.some(radioChecked) ? "public" : "unknown";
    return { read: read, offers: { unlisted: u.length === 1, private: p.length === 1, public: o.length === 1 } };
  };
  const visibilityAt = (which) => {
    const hits = radios().filter((el) => S.vis[which].test(labelOf(el)));
    if (hits.length !== 1) return null;
    const target = hits[0].tagName === "INPUT" ? (hits[0].closest("label") || (hits[0].id && Array.from(document.querySelectorAll("label")).find((x) => x.htmlFor === hits[0].id)) || hits[0]) : hits[0];
    if (hits[0].disabled || hits[0].getAttribute("aria-disabled") === "true") return null;
    const at = center(shown(target) ? target : hits[0]);
    return { x: at.x, y: at.y };
  };
  const marks = () => {
    const out = {};
    for (const k of Object.keys(S.tabs)) {
      const el = actions(document).find((a) => S.tabs[k].test(actionLabel(a)));
      if (!el) continue;
      const words = Array.from(el.querySelectorAll("[aria-label], " + ICONS + ", svg title")).map((n) => norm(n.getAttribute && n.getAttribute("aria-label")) || norm(n.textContent)).join(" ");
      out[k] = S.incomplete.test(words) ? "incomplete" : S.complete.test(words) ? "complete" : "unknown";
    }
    return out;
  };
  const inventory = () => ({
    controls: controls().map((el) => labelOf(el).slice(0, 48) || el.tagName.toLowerCase()).slice(0, 16),
    uploads: Array.from(document.querySelectorAll("input[type=file]")).filter(hiddenFile).map((input) => (norm(input.getAttribute("aria-label")) || norm(scopeOf(input).textContent)).slice(0, 48)).slice(0, 8),
    buttons: actions(document).map(actionLabel).filter(Boolean).slice(0, 24),
  });
  globalThis.${AGENT_GLOBAL} = { version: ${AGENT_VERSION}, inventory, images, slotImages, removeAt, where, gate, fileInput, thumbs, fieldRead, setText, focusText, choose, option, justify, visibility, visibilityAt, marks };
  return true;
})()`;
