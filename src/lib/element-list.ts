// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const SURFACE_CONTEXTS = ["popup", "options", "sidebar", "devtools", "newtab", "history", "bookmarks"];

export const ELEMENT_LIST_CAP = 200;
export const ELEMENT_NAME_MAX = 80;
export const ELEMENT_VALUE_MAX = 40;
export const SETTLE_WAIT_MS = 1_500;
export const SETTLE_WAIT_CEILING_MS = 5_000;

export interface ListedElement {
  role: string;
  name: string;
  selector: string;
  host?: string;
  disabled?: true;
  readOnly?: true;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  value?: string;
  options?: number;
  level?: number;
  open?: boolean;
  count?: number;
}

export interface ElementList {
  elements: ListedElement[];
  elementCount: number;
  elementsTruncated: boolean;
}

export interface Observation extends ElementList {
  settled: boolean;
  url: string;
  title: string;
}

export const ELEMENT_LIST_FUNCTION = `function (cap) {
  var ACTIONABLE = "button,a[href],input,select,textarea,summary,dialog,h1,h2,h3,h4,h5,h6,[role],[contenteditable=''],[contenteditable='true'],[tabindex]";
  var ROLES = { button: 1, link: 1, tab: 1, checkbox: 1, radio: 1, switch: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1, textbox: 1, searchbox: 1, combobox: 1, listbox: 1, slider: 1, spinbutton: 1, dialog: 1, alertdialog: 1, heading: 1 };
  var NAME_MAX = ${ELEMENT_NAME_MAX}, VALUE_MAX = ${ELEMENT_VALUE_MAX};
  function text(node) { return String((node && node.textContent) || "").replace(/\\s+/g, " ").trim(); }
  function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 3) + "..." : s; }
  function attr(el, name) { var v = el.getAttribute(name); return v == null ? null : String(v); }
  function visible(el) {
    if (el.hidden === true || attr(el, "aria-hidden") === "true") return false;
    var tag = el.tagName.toLowerCase();
    if (tag === "input" && (attr(el, "type") || "").toLowerCase() === "hidden") return false;
    if (tag === "dialog" && !el.open) return false;
    var view = el.ownerDocument.defaultView;
    var style = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    if (typeof el.getClientRects === "function" && el.getClientRects().length === 0) return false;
    return true;
  }
  function implicitRole(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "dialog") return "dialog";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      var type = (attr(el, "type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
      return "textbox";
    }
    if (el.isContentEditable === true) return "textbox";
    return null;
  }
  function role(el) {
    var explicit = (attr(el, "role") || "").trim().split(/\\s+/)[0];
    if (explicit) {
      if (!ROLES[explicit]) return null;
      if (explicit === "option" && el.closest && el.closest("[role='listbox'],select")) return null;
      return explicit;
    }
    var implicit = implicitRole(el);
    if (implicit) return implicit;
    var tabindex = attr(el, "tabindex");
    return tabindex !== null && Number(tabindex) >= 0 ? "focusable" : null;
  }
  function byIds(el, ids) {
    var root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
    var parts = [], list = ids.split(/\\s+/);
    for (var i = 0; i < list.length; i++) {
      var ref = root && root.getElementById ? root.getElementById(list[i]) : null;
      if (ref) parts.push(text(ref));
    }
    return parts.join(" ").trim();
  }
  function labelText(el) {
    var labelled = attr(el, "aria-labelledby");
    if (labelled) { var joined = byIds(el, labelled); if (joined) return joined; }
    var aria = attr(el, "aria-label");
    if (aria && aria.trim()) return aria.trim();
    if (el.labels && el.labels.length) {
      var names = [];
      for (var i = 0; i < el.labels.length; i++) names.push(text(el.labels[i]));
      var named = names.join(" ").trim();
      if (named) return named;
    }
    var tag = el.tagName.toLowerCase();
    if (tag === "input") {
      var type = (attr(el, "type") || "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return el.value || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
      if (type === "image") return attr(el, "alt") || "";
    }
    if (tag === "input" || tag === "select" || tag === "textarea") return attr(el, "placeholder") || attr(el, "title") || attr(el, "name") || "";
    var own = text(el);
    if (own) return own;
    var inner = el.querySelector ? el.querySelector("img[alt],svg title,[aria-label]") : null;
    if (inner) {
      var innerTag = inner.tagName.toLowerCase();
      return innerTag === "img" ? attr(inner, "alt") || "" : innerTag === "title" ? text(inner) : attr(inner, "aria-label") || "";
    }
    return attr(el, "title") || "";
  }
  function cssEscape(s) {
    var css = typeof CSS !== "undefined" ? CSS : null;
    return css && css.escape ? css.escape(s) : String(s).replace(/([^\\w-])/g, "\\\\$1");
  }
  function unique(root, selector, el) {
    try { var found = root.querySelectorAll(selector); return found.length === 1 && found[0] === el; } catch (e) { return false; }
  }
  function selectorFor(el, root) {
    var tag = el.tagName.toLowerCase();
    if (el.id && unique(root, "#" + cssEscape(el.id), el)) return "#" + cssEscape(el.id);
    var attrs = ["data-testid", "data-test-id", "data-test", "name", "aria-label"];
    for (var i = 0; i < attrs.length; i++) {
      var v = attr(el, attrs[i]);
      if (v) { var s = tag + "[" + attrs[i] + "=" + JSON.stringify(v) + "]"; if (unique(root, s, el)) return s; }
    }
    var parts = [], node = el;
    while (node && node.nodeType === 1) {
      var part = node.tagName.toLowerCase();
      if (node.id && unique(root, "#" + cssEscape(node.id), node)) { parts.unshift("#" + cssEscape(node.id)); break; }
      var parent = node.parentNode;
      if (parent) {
        var index = 0, same = 0, children = parent.children || [];
        for (var c = 0; c < children.length; c++) {
          if (children[c].tagName === node.tagName) { same++; if (children[c] === node) index = same; }
        }
        if (same > 1) part += ":nth-of-type(" + index + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }
  function entry(el, root, host) {
    var r = role(el);
    if (!r || !visible(el)) return null;
    var e = { role: r, name: clip(labelText(el), NAME_MAX), selector: selectorFor(el, root) };
    if (host) e.host = host;
    if (el.disabled === true || attr(el, "aria-disabled") === "true") e.disabled = true;
    if (el.readOnly === true || attr(el, "aria-readonly") === "true") e.readOnly = true;
    if (r === "checkbox" || r === "radio" || r === "switch" || r === "menuitemcheckbox" || r === "menuitemradio") {
      e.checked = typeof el.checked === "boolean" ? el.checked : attr(el, "aria-checked") === "true";
    }
    if (r === "tab" || r === "option") { var sel = attr(el, "aria-selected"); if (sel !== null) e.selected = sel === "true"; }
    if (r === "combobox" || r === "listbox") {
      if (el.tagName.toLowerCase() === "select") {
        e.options = el.options ? el.options.length : 0;
        var picked = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
        if (picked) e.value = clip(text(picked), VALUE_MAX);
      } else {
        var expanded = attr(el, "aria-expanded");
        if (expanded !== null) e.expanded = expanded === "true";
        if (r === "listbox" && el.querySelectorAll) e.options = el.querySelectorAll("[role='option']").length;
        if (typeof el.value === "string") e.value = clip(el.value, VALUE_MAX);
      }
    } else if (r === "textbox" || r === "searchbox" || r === "spinbutton" || r === "slider") {
      if (typeof el.value === "string") e.value = (attr(el, "type") || "").toLowerCase() === "password" ? (el.value ? "(hidden)" : "") : clip(el.value, VALUE_MAX);
      else if (el.isContentEditable === true) e.value = clip(text(el), VALUE_MAX);
    }
    if (r === "heading") {
      var level = attr(el, "aria-level");
      e.level = level ? Number(level) : /^h[1-6]$/i.test(el.tagName) ? Number(el.tagName.charAt(1)) : 2;
    }
    if (r === "dialog" || r === "alertdialog") e.open = el.tagName.toLowerCase() === "dialog" ? el.open === true : true;
    return e;
  }
  function same(a, b) {
    return a.role === b.role && a.name === b.name && a.host === b.host && a.disabled === b.disabled && a.readOnly === b.readOnly &&
      a.checked === b.checked && a.selected === b.selected && a.value === b.value && a.level === b.level;
  }
  var out = [], total = 0, dropped = 0;
  function walk(root, host) {
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (typeof el.matches === "function" && el.matches(ACTIONABLE)) {
        var e = entry(el, root, host);
        if (e) {
          total++;
          var last = out[out.length - 1];
          if (last && same(last, e)) last.count = (last.count || 1) + 1;
          else if (out.length < cap) out.push(e);
          else dropped++;
        }
      }
      if (el.shadowRoot) walk(el.shadowRoot, (host ? host + " >>> " : "") + selectorFor(el, root));
    }
  }
  walk(document, "");
  return { elements: out, elementCount: total, elementsTruncated: dropped > 0 };
}`;

export function elementListExpression(cap: number = ELEMENT_LIST_CAP): string {
  return `(${ELEMENT_LIST_FUNCTION})(${Math.max(1, Math.floor(cap))})`;
}

export function settleWaitWithin(timeoutMs: number | undefined): number {
  const wait = typeof timeoutMs === "number" && timeoutMs > 0 ? Math.min(SETTLE_WAIT_MS, Math.floor(timeoutMs / 2)) : SETTLE_WAIT_MS;

  return Math.max(50, Math.min(wait, SETTLE_WAIT_CEILING_MS));
}

export function observeExpression(waitMs: number = SETTLE_WAIT_MS, cap: number = ELEMENT_LIST_CAP): string {
  return `(function () {
  var list = ${ELEMENT_LIST_FUNCTION};
  var waitMs = ${Math.max(0, Math.floor(waitMs))}, started = Date.now();
  function left() { return Math.max(0, waitMs - (Date.now() - started)); }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function loaded() {
    if (document.readyState === "complete") return Promise.resolve(true);
    return new Promise(function (resolve) {
      var done = false;
      function finish(value) { if (!done) { done = true; resolve(value); } }
      window.addEventListener("load", function () { finish(true); }, { once: true });
      setTimeout(function () { finish(document.readyState === "complete"); }, left());
    });
  }
  function finiteAnimations() {
    if (typeof document.getAnimations !== "function") return [];
    var running = [];
    var all = document.getAnimations();
    for (var i = 0; i < all.length; i++) {
      var a = all[i];
      if (a.playState !== "running" && a.playState !== "pending") continue;
      var timing = a.effect && typeof a.effect.getComputedTiming === "function" ? a.effect.getComputedTiming() : null;
      if (!timing || timing.iterations === Infinity || !isFinite(Number(timing.endTime))) continue;
      running.push(a);
    }
    return running;
  }
  function settle() {
    var pending = finiteAnimations();
    if (pending.length === 0) return Promise.resolve(true);
    var budget = left();
    if (budget <= 0) return Promise.resolve(false);
    var finished = Promise.all(pending.map(function (a) { return a.finished.catch(function () {}); }));
    return Promise.race([finished.then(function () { return true; }), wait(budget).then(function () { return false; })])
      .then(function (ended) { return ended ? settle() : false; });
  }
  return loaded().then(function (isLoaded) {
    return settle().then(function (quiet) {
      return wait(0).then(function () {
        var snap = list(${Math.max(1, Math.floor(cap))});
        snap.settled = isLoaded && quiet;
        snap.url = String(location.href);
        snap.title = String(document.title || "");
        return snap;
      });
    });
  });
})()`;
}

function isListedElement(item: unknown): item is ListedElement {
  return (
    item !== null &&
    typeof item === "object" &&
    typeof (item as ListedElement).role === "string" &&
    typeof (item as ListedElement).name === "string" &&
    typeof (item as ListedElement).selector === "string"
  );
}

export function readElementList(value: unknown): ElementList | null {
  if (!value || typeof value !== "object") return null;

  const { elements, elementCount, elementsTruncated } = value as Record<string, unknown>;
  if (!Array.isArray(elements) || !elements.every(isListedElement)) return null;

  return {
    elements,
    elementCount: typeof elementCount === "number" ? elementCount : elements.length,
    elementsTruncated: elementsTruncated === true,
  };
}

export function readObservation(value: unknown): Observation | null {
  const list = readElementList(value);
  if (!list) return null;

  const { settled, url, title } = value as Record<string, unknown>;

  return {
    settled: settled === true,
    url: typeof url === "string" ? url : "",
    title: typeof title === "string" ? title : "",
    ...list,
  };
}

export const ELEMENTS_INCLUDE_NOTE =
  "elements lists the visible interactive elements (buttons, links, inputs, selects, tabs, dialogs, headings) with role, accessible name, a selector that matches exactly one element in its document (host names the shadow host when the element sits in an open shadow root) and its disabled, readOnly, checked, value and open state; runs of identical elements collapse into one entry with count, a select is one entry with its options count, and the list stops at 200 entries with elementsTruncated: true and elementCount the real total.";
