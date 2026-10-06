// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  CALL_TIMEOUT,
  SESSION_BROWSER,
  SESSION_PROJECT_PATH,
} from "../lib/common-schema";
import fs from "node:fs";
import { runActVerb } from "../lib/act";
import { listBridgeTabs } from "../lib/bridge-tabs";
import { isChromiumFamily, WEBKIT_FAMILY } from "../lib/browser-family";
import {
  readExtensionRoots,
  readWebDriverSession,
  readyExtensionId,
  sameDocument,
  WEBDRIVER_SESSION_MISSING_HINT,
  WebDriverClient,
} from "../lib/webdriver";
import { CDPClient } from "../lib/cdp";
import { CDP_PORT_MISSING_HINT, resolveCdpPort } from "../lib/cdp-port";
import { envelope, isEnvelope } from "../lib/envelope";
import { verifyGuestLoaded } from "../lib/guest-load-oracle";
import { contentScriptsForbidden, coveringMatches } from "../lib/match-patterns";
import {
  declaredBackground,
  declaredContentScripts,
  manifestCandidates,
  readBuiltManifest,
  type ReadManifest,
} from "../lib/project-manifest";
import { logsPath, readyContractPath } from "../lib/session-paths";
import { resolveSessionBrowser } from "../lib/session-browser";
import {
  ASSERT_CHECKS,
  assertVerdict,
  checkKey,
  failCheck,
  inconclusiveCheck,
  passCheck,
  verdictSentence,
  type CheckResult,
} from "../lib/verdict";
import { version } from "../../package.json";
import { readLogEvents } from "./logs-filter";
import { emptyReason, readLogRunId, staleFileNote } from "./logs";
import {
  declaredSurfaces,
  resolveExtensionId,
  surfaceDocument,
  SURFACE_MANIFEST_KEYS,
} from "./open";

const COMMAND = "extension_assert";

/* @invariant The vocabulary an agent types IS the check registry's id list. A
   second spelling of the same five expectations is a second thing to keep in
   sync, and the one that drifts is always the one the caller reads. */
export const ASSERT_KINDS: string[] = ASSERT_CHECKS.map((check) => check.id);

const BACKGROUND = "background-worker-booted";
const SURFACE = "surface-rendered";
const CONTENT_SCRIPT = "content-script-injected";
const STORAGE = "storage-key-present";
const CONSOLE = "console-errors-empty";

const SURFACES = [
  "popup",
  "options",
  "sidebar",
  "newtab",
  "history",
  "bookmarks",
] as const;

const STORAGE_AREAS = ["local", "sync", "session", "managed"] as const;

const STORAGE_CONTEXTS = [
  "background",
  "popup",
  "options",
  "sidebar",
  "content",
] as const;

export const schema = {
  name: COMMAND,
  description:
    "Run a test stage against a live dev session: state expectations and read one verdict for each, instead of reading a blob and hand-rolling the judgement. Every expectation comes back pass, fail or inconclusive, where inconclusive means this platform cannot cover the question today and the verdict says what would settle it. An inconclusive check is never a pass. Start the session with extension_dev; use extension_inspect or extension_logs when you want the raw reading instead of a verdict.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      expect: {
        type: "array",
        items: { type: "object" },
        description:
          "One object per expectation, each { assert: <check id>, ...args }. background-worker-booted: no args. surface-rendered: surface (popup, options, sidebar, newtab, history, bookmarks), optional selector and minNodes. content-script-injected: url. storage-key-present: key, optional area (default local), equals, context. console-errors-empty: optional context (array), since (seq cursor), ignore (substrings).",
      },
      browser: SESSION_BROWSER,
      timeout: CALL_TIMEOUT,
    },
    required: ["projectPath", "expect"],
  },
};

interface BackgroundClause {
  assert: typeof BACKGROUND;
  subject: null;
}
interface SurfaceClause {
  assert: typeof SURFACE;
  subject: string;
  surface: string;
  selector?: string;
  minNodes?: number;
}
interface ContentScriptClause {
  assert: typeof CONTENT_SCRIPT;
  subject: string;
  url: string;
}
interface StorageClause {
  assert: typeof STORAGE;
  subject: string;
  key: string;
  area: string;
  equals?: unknown;
  hasEquals: boolean;
  context?: string;
}
interface ConsoleClause {
  assert: typeof CONSOLE;
  subject: string | null;
  context?: string[];
  since?: number;
  ignore?: string[];
}

type Clause =
  | BackgroundClause
  | SurfaceClause
  | ContentScriptClause
  | StorageClause
  | ConsoleClause;

interface ParseResult {
  clauses: Clause[];
  issues: string[];
}

export function parseClauses(raw: unknown): ParseResult {
  const clauses: Clause[] = [];
  const issues: string[] = [];
  if (!Array.isArray(raw)) {
    return { clauses, issues: ["expect must be an array of objects"] };
  }
  if (raw.length === 0) {
    return {
      clauses,
      issues: [
        "expect is empty, and a stage that states nothing cannot report a pass",
      ],
    };
  }
  raw.forEach((entry, index) => {
    const at = `expect[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push(`${at} must be an object`);
      return;
    }
    const clause = entry as Record<string, unknown>;
    const kind = String(clause.assert ?? "");
    if (!ASSERT_KINDS.includes(kind)) {
      issues.push(
        `${at}.assert is ${JSON.stringify(clause.assert)}; expected one of: ${ASSERT_KINDS.join(", ")}`,
      );
      return;
    }
    if (kind === BACKGROUND) {
      clauses.push({ assert: BACKGROUND, subject: null });
      return;
    }
    if (kind === SURFACE) {
      const surface = String(clause.surface ?? "");
      if (!(SURFACES as readonly string[]).includes(surface)) {
        issues.push(
          `${at}.surface is ${JSON.stringify(clause.surface)}; expected one of: ${SURFACES.join(", ")}`,
        );
        return;
      }
      const minNodes =
        clause.minNodes === undefined ? undefined : Number(clause.minNodes);
      if (minNodes !== undefined && (!Number.isFinite(minNodes) || minNodes < 1)) {
        issues.push(`${at}.minNodes must be a number of at least 1`);
        return;
      }
      const selector =
        clause.selector === undefined ? undefined : String(clause.selector);
      clauses.push({
        assert: SURFACE,
        subject: selector ? `${surface} ${selector}` : surface,
        surface,
        ...(selector === undefined ? {} : { selector }),
        ...(minNodes === undefined ? {} : { minNodes }),
      });
      return;
    }
    if (kind === CONTENT_SCRIPT) {
      const url = String(clause.url ?? "").trim();
      if (!url) {
        issues.push(
          `${at}.url is required: a content script is asserted against the page it should have injected into`,
        );
        return;
      }
      clauses.push({ assert: CONTENT_SCRIPT, subject: url, url });
      return;
    }
    if (kind === STORAGE) {
      const key = String(clause.key ?? "").trim();
      if (!key) {
        issues.push(`${at}.key is required`);
        return;
      }
      const area = String(clause.area ?? "local");
      if (!(STORAGE_AREAS as readonly string[]).includes(area)) {
        issues.push(
          `${at}.area is ${JSON.stringify(clause.area)}; expected one of: ${STORAGE_AREAS.join(", ")}`,
        );
        return;
      }
      const context =
        clause.context === undefined ? undefined : String(clause.context);
      if (
        context !== undefined &&
        !(STORAGE_CONTEXTS as readonly string[]).includes(context)
      ) {
        issues.push(
          `${at}.context is ${JSON.stringify(clause.context)}; expected one of: ${STORAGE_CONTEXTS.join(", ")}`,
        );
        return;
      }
      clauses.push({
        assert: STORAGE,
        subject: `${area}.${key}`,
        key,
        area,
        hasEquals: "equals" in clause,
        ...("equals" in clause ? { equals: clause.equals } : {}),
        ...(context === undefined ? {} : { context }),
      });
      return;
    }
    const context =
      clause.context === undefined
        ? undefined
        : Array.isArray(clause.context)
          ? clause.context.map(String)
          : [String(clause.context)];
    const since = clause.since === undefined ? undefined : Number(clause.since);
    if (since !== undefined && !Number.isFinite(since)) {
      issues.push(`${at}.since must be a number, the seq cursor to read from`);
      return;
    }
    const ignore =
      clause.ignore === undefined
        ? undefined
        : Array.isArray(clause.ignore)
          ? clause.ignore.map(String)
          : [String(clause.ignore)];
    clauses.push({
      assert: CONSOLE,
      subject: context?.length ? context.join("+") : null,
      ...(context === undefined ? {} : { context }),
      ...(since === undefined ? {} : { since }),
      ...(ignore === undefined ? {} : { ignore }),
    });
  });

  /* @invariant Two clauses that judge the same thing are rejected before the
     run, not after it. The verdict document is keyed by check id and subject,
     so a repeat would make it undecidable which one gates, exactly as the
     upstream contract says about a repeated id. */
  const seen = new Set<string>();
  for (const clause of clauses) {
    const key = clause.subject
      ? `${clause.assert}:${clause.subject}`
      : clause.assert;
    if (seen.has(key)) {
      issues.push(
        `${key} is asserted more than once, so which verdict gates would be undecidable`,
      );
    }
    seen.add(key);
  }

  return { clauses, issues };
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
}

const NO_SESSION_SETTLED_BY =
  "Start the session with extension_dev, confirm it with extension_wait, then assert again.";

class Stage {
  readonly chromium: boolean;
  readonly webkit: boolean;
  private cdpPort: number | null | undefined;
  private discovered: CdpTarget[] | null = null;
  private manifestRead: ReadManifest | null | undefined;
  private client: CDPClient | null = null;
  private extensionIdRead: string | null | undefined;

  constructor(
    readonly projectPath: string,
    readonly browser: string,
    readonly timeout?: number,
  ) {
    this.chromium = isChromiumFamily(browser);
    this.webkit = WEBKIT_FAMILY.has(browser);
  }

  webdriver(): WebDriverClient | null {
    const info = readWebDriverSession(this.projectPath, this.browser);
    return info ? new WebDriverClient(info) : null;
  }


  async port(): Promise<number | null> {
    if (this.cdpPort === undefined) {
      const resolved = await resolveCdpPort(this.projectPath, this.browser);
      this.cdpPort = resolved ? resolved.port : null;
    }
    return this.cdpPort;
  }

  async targets(): Promise<CdpTarget[] | null> {
    const port = await this.port();
    if (port === null) return null;
    if (this.discovered === null) {
      try {
        this.discovered = (await CDPClient.discoverTargets(
          port,
        )) as CdpTarget[];
      } catch {
        return null;
      }
    }
    return this.discovered;
  }

  manifest(): ReadManifest | null {
    if (this.manifestRead === undefined) {
      this.manifestRead = readBuiltManifest(this.projectPath, this.browser);
    }
    return this.manifestRead;
  }

  async extensionId(): Promise<string | null> {
    if (this.extensionIdRead === undefined) {
      this.extensionIdRead = await resolveExtensionId(
        this.projectPath,
        this.browser,
      );
    }
    return this.extensionIdRead;
  }

  async attach(
    targetId: string,
  ): Promise<{ cdp: CDPClient; sessionId: string } | null> {
    const port = await this.port();
    if (port === null) return null;
    try {
      if (!this.client) {
        const ws = await CDPClient.discoverBrowserWsUrl(port);
        const cdp = new CDPClient();
        await cdp.connect(ws);
        this.client = cdp;
      }
      const sessionId = await this.client.attachToTarget(targetId);
      await this.client.enableDomains(sessionId);
      return { cdp: this.client, sessionId };
    } catch {
      return null;
    }
  }

  dispose(): void {
    try {
      this.client?.disconnect();
    } catch {
      this.client = null;
    }
    this.client = null;
  }

  noManifest(id: string, subject: string | null): CheckResult {
    return inconclusiveCheck(
      id,
      subject,
      `No readable manifest for this project and browser, so what the extension declares is unknown. Looked at: ${manifestCandidates(
        this.projectPath,
        this.browser,
      ).join(", ")}.`,
      "Build the project with extension_build, or pass the browser whose dist you mean, then assert again.",
    );
  }

  noSession(id: string, subject: string | null): CheckResult {
    return inconclusiveCheck(
      id,
      subject,
      `No dev session with a debugging port was found for ${this.browser}, so the browser was never asked. ${CDP_PORT_MISSING_HINT}`,
      NO_SESSION_SETTLED_BY,
    );
  }

  notChromium(id: string, subject: string | null, instead: string): CheckResult {
    return inconclusiveCheck(
      id,
      subject,
      `This expectation is read off the Chrome DevTools Protocol target list, and ${this.browser} exposes no such list to this server.`,
      instead,
    );
  }
}

function truncate(value: unknown, max = 200): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const WORKER_TARGET_TYPES = new Set([
  "service_worker",
  "worker",
  "background_page",
  "shared_worker",
]);

async function assertBackgroundWorker(
  clause: BackgroundClause,
  stage: Stage,
): Promise<CheckResult> {
  const id = BACKGROUND;
  const read = stage.manifest();
  if (!read) return stage.noManifest(id, null);

  const background = declaredBackground(read.manifest);
  if (background.kind === "none") {
    return failCheck(
      id,
      null,
      `${read.file} declares no background, so no worker can boot. Nothing about the session is implicated.`,
      { manifestFile: read.file },
    );
  }
  if (!stage.chromium) {
    /* @invariant On Gecko the proof is the control channel itself: the
       bridge executor that answers it runs inside the extension's background,
       so a tabs query that comes back is a background that booted. Silence is inconclusive, since the channel may be off by
       choice or the session not attached yet. */
    const listed = await listBridgeTabs(
      stage.projectPath,
      stage.browser,
      stage.timeout,
      "extension_assert",
    );
    if ("tabs" in listed) {
      return passCheck(
        id,
        null,
        `The ${background.kind} answered a tabs query over the control channel; the bridge executor runs inside the background, so it has booted.`,
        { backgroundKind: background.kind, tabsSeen: listed.tabs.length },
      );
    }
    return inconclusiveCheck(
      id,
      null,
      `The control channel did not answer on ${stage.browser}, so the background could not be asked.`,
      "Start the session with allowControl: true (extension_dev) and extension_wait for ready, then assert again; extension_logs (context: ['background']) shows what the background wrote meanwhile.",
    );
  }

  const targets = await stage.targets();
  if (targets === null) return stage.noSession(id, null);

  const guest = await verifyGuestLoaded(stage.projectPath, stage.browser);
  if (!guest.checked) {
    return inconclusiveCheck(id, null, guest.reason, NO_SESSION_SETTLED_BY);
  }
  /* @invariant NO TARGET IS NOT "NOT LOADED". An idle MV3 worker with no
     page of its extension open lists nothing, exactly like a rejected load,
     so the target list alone cannot tell them apart. The one thing that can
     is the contract: the CLI stamps `extension_load_refused` when the browser
     refused the load. That is the FAIL; anything else falls through to the
     log evidence and, failing that, to inconclusive. */
  if (!guest.loaded) {
    const refusal = contractLoadRefusal(stage.projectPath, stage.browser);
    if (refusal) {
      return failCheck(
        id,
        null,
        `The browser refused to load the extension (${refusal}), so its ${background.kind} never started. ${guest.reason}`,
        { guestIds: guest.guestIds },
      );
    }
  }

  const workers = targets.filter(
    (target) =>
      WORKER_TARGET_TYPES.has(target.type) &&
      guest.guestIds.some((guestId) =>
        String(target.url ?? "").startsWith(`chrome-extension://${guestId}/`),
      ),
  );
  if (workers.length > 0) {
    return passCheck(
      id,
      null,
      `The browser lists ${workers.length} live ${background.kind} target for this extension (${workers
        .map((worker) => worker.url)
        .join(", ")}).`,
      {
        targets: workers.map((worker) => ({
          type: worker.type,
          url: worker.url,
        })),
      },
    );
  }

  const runId = readLogRunId(stage.projectPath, stage.browser);
  const stale = staleFileNote(stage.projectPath, stage.browser, runId);
  const backgroundLines = readLogEvents(stage.projectPath, stage.browser, {
    context: ["background"],
  });
  if (backgroundLines.length > 0 && !stale) {
    return passCheck(
      id,
      null,
      `No live ${background.kind} target is listed, but the background context wrote ${backgroundLines.length} log line(s) in run ${runId || "(unnamed)"}, which only a booted background can do. Chrome delists a dormant service worker, so this is the same verdict read from evidence that outlives the target.`,
      { backgroundLogLines: backgroundLines.length, runId },
    );
  }

  /* @invariant Absence of a worker target is not a failed boot. Chrome delists
     an idle MV3 service worker, so a red here would accuse the extension of a
     bug the browser's own lifecycle produced. */
  return inconclusiveCheck(
    id,
    null,
    `${read.file} declares a ${background.kind}${background.ref ? ` (${background.ref})` : ""}, and the browser lists no live worker target for it${
      guest.loaded ? " although the extension is loaded" : ` and no other target of this extension (${guest.reason})`
    }. That is not proof it never booted: Chrome delists an idle service worker, so absence here means no evidence either way.${
      stale
        ? ` The log file could not settle it either: ${stale}`
        : " Nothing in this run's logs came from the background context either."
    }`,
    "Wake it and assert again: extension_open (surface: 'action') or any message to the worker starts it, and one console line from the background makes this answerable from the log stream even after it idles out.",
    { runId, backgroundLogLines: backgroundLines.length },
  );
}

/* @invariant RENDERED MEANS SOMETHING A PERSON WOULD SEE. The templates ship
   `<noscript>You need to enable JavaScript</noscript><div id="root"></div>`,
   which an unmounted bundle leaves as two or three elements and, through the
   textContent fallback, fifty characters of noscript prose: that passed the
   old count. A rendered reading excludes script, style, noscript, template,
   link and meta, measures innerText only, and counts a lone canvas, image or
   control as rendered. The old fields stay for an
   engine that does not report the new ones. */
export function renderedFromEvidence(evidence: {
  bodyElementCount?: number;
  textLength?: number;
  renderedElementCount?: number;
  visualElementCount?: number;
  renderedTextLength?: number;
}): boolean {
  if (typeof evidence.renderedElementCount === "number") {
    const rendered = evidence.renderedElementCount;
    const text = evidence.renderedTextLength ?? 0;
    const visual = evidence.visualElementCount ?? 0;
    return rendered > 0 && (text > 0 || visual > 0 || rendered > 1);
  }
  const elements = evidence.bodyElementCount ?? 0;
  const text = evidence.textLength ?? 0;
  return elements > 0 && (text > 0 || elements > 1);
}

async function assertSurfaceRendered(
  clause: SurfaceClause,
  stage: Stage,
): Promise<CheckResult> {
  const id = SURFACE;
  const subject = clause.subject;
  const declared = declaredSurfaces(stage.projectPath, stage.browser);
  if (declared === null) return stage.noManifest(id, subject);

  const document = surfaceDocument(
    stage.projectPath,
    stage.browser,
    clause.surface,
  );
  if (!document) {
    return failCheck(
      id,
      subject,
      `This extension declares no ${clause.surface}: nothing sets ${
        SURFACE_MANIFEST_KEYS[clause.surface] ?? clause.surface
      } in its manifest, so there is no document to render. Surfaces it does declare: ${
        declared.length ? declared.join(", ") : "none"
      }.`,
      { declaredSurfaces: declared },
    );
  }
  if (!stage.chromium) {
    /* @invariant On Gecko the surface relay answers only from an open
       document, so an inspect in that context is the rendering proof. A selector cannot be probed through that verb, so a clause
       with one stays inconclusive and says which tool reads it. */
    const raw = await runActVerb(
      [
        "inspect",
        stage.projectPath,
        "--context",
        clause.surface,
        "--include",
        "summary",
        "--browser",
        stage.browser,
        ...(stage.timeout != null ? ["--timeout", String(stage.timeout)] : []),
      ],
      stage.projectPath,
      stage.timeout,
      "extension_assert",
    );
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
    }
    if (parsed?.ok === true) {
      const summary = parsed.value?.summary ?? {};
      const children = Number(summary.bodyChildCount ?? 0);
      if (clause.selector) {
        return inconclusiveCheck(
          id,
          subject,
          `The ${clause.surface} document is open (${parsed.value?.url ?? document}), but a selector cannot be probed through the surface relay on ${stage.browser}.`,
          `Read it with extension_inspect (url: the document's moz-extension:// address, probe: ['${clause.selector}']) or extension_eval context: '${clause.surface}'.`,
          { url: parsed.value?.url, summary },
        );
      }
      if (children === 0) {
        return failCheck(
          id,
          subject,
          `The ${clause.surface} document is open (${parsed.value?.url ?? document}) but its body has no child elements: nothing rendered into it.`,
          { url: parsed.value?.url, summary },
        );
      }
      if (clause.minNodes != null && children < clause.minNodes) {
        return failCheck(
          id,
          subject,
          `The ${clause.surface} document is open but its body has ${children} child element${children === 1 ? "" : "s"}, fewer than the ${clause.minNodes} expected.`,
          { url: parsed.value?.url, summary },
        );
      }
      return passCheck(
        id,
        subject,
        `The ${clause.surface} document (${document}) is open and rendering: the surface relay answered with ${children} body child element${children === 1 ? "" : "s"}.`,
        { url: parsed.value?.url, summary },
      );
    }
    const message = String(parsed?.error?.message ?? raw);
    if (parsed?.error?.code === "E_TARGET_NOT_FOUND" || /\bis not open\b/i.test(message)) {
      return failCheck(
        id,
        subject,
        `The ${clause.surface} is declared (${document}) but nothing is rendering it: the surface relay has no open document to answer from. Open it with extension_open (surface: '${clause.surface}') before asserting.`,
        { document },
      );
    }
    return inconclusiveCheck(
      id,
      subject,
      `The surface relay could not be asked on ${stage.browser}: ${message.slice(0, 200)}`,
      "Start the session with allowControl: true (extension_dev) and extension_wait for ready, then assert again.",
    );
  }

  const targets = await stage.targets();
  if (targets === null) return stage.noSession(id, subject);

  const extensionId = await stage.extensionId();
  if (!extensionId) {
    return inconclusiveCheck(
      id,
      subject,
      "The extension's id could not be resolved from the running session, so the surface's own url cannot be formed and no target can be matched to it.",
      NO_SESSION_SETTLED_BY,
    );
  }

  const wanted = `chrome-extension://${extensionId}/${document}`;
  const target = targets.find(
    (candidate) =>
      candidate.type === "page" &&
      String(candidate.url ?? "").startsWith(wanted),
  );
  if (!target) {
    return failCheck(
      id,
      subject,
      `The ${clause.surface} is declared (${document}) but nothing is rendering it: no page target for ${wanted} is open in the session. Open it with extension_open (surface: '${clause.surface}', asTab: true) before asserting.`,
      {
        expectedUrl: wanted,
        openPages: targets
          .filter((candidate) => candidate.type === "page")
          .map((candidate) => candidate.url),
      },
    );
  }

  const attached = await stage.attach(target.id);
  if (!attached) {
    return inconclusiveCheck(
      id,
      subject,
      `A page target for ${wanted} exists but this server could not attach to it, so its document was never read.`,
      NO_SESSION_SETTLED_BY,
    );
  }

  const evidence = await attached.cdp.getRenderEvidence(attached.sessionId);
  if (!evidence) {
    return inconclusiveCheck(
      id,
      subject,
      `The ${clause.surface} page answered nothing to the render probe, so neither a rendered nor an empty document was observed.`,
      "Assert again once the page has settled, or read it with extension_inspect to see what the document is doing.",
    );
  }
  if (evidence.readyState === "loading") {
    return inconclusiveCheck(
      id,
      subject,
      `The ${clause.surface} document is still loading (document.readyState is "loading"), so a verdict now would judge a page that has not finished rendering.`,
      "Assert again once it has settled; extension_wait or a short retry is enough.",
      { evidence: evidence as Record<string, unknown> },
    );
  }

  if (clause.selector) {
    const probes = await attached.cdp.probeSelectors(attached.sessionId, [
      clause.selector,
    ]);
    const probe = probes?.[0];
    if (probe?.error) {
      return inconclusiveCheck(
        id,
        subject,
        `The selector ${clause.selector} could not be probed in the ${clause.surface}: the page refused it (${probe.error}).`,
        "Fix the selector (it must be a CSS selector the page's querySelectorAll accepts) and assert again.",
        { evidence: evidence as Record<string, unknown> },
      );
    }
    const count = probe?.count ?? 0;
    const wantedCount = clause.minNodes ?? 1;
    return count >= wantedCount
      ? passCheck(
          id,
          subject,
          `The ${clause.surface} is rendering ${count} node(s) matching ${clause.selector}, and at least ${wantedCount} was expected.`,
          { count, evidence: evidence as Record<string, unknown> },
        )
      : failCheck(
          id,
          subject,
          `The ${clause.surface} is open but ${clause.selector} matches ${count} node(s), fewer than the ${wantedCount} expected. The document holds ${evidence.bodyElementCount ?? 0} element(s) in all.`,
          { count, evidence: evidence as Record<string, unknown> },
        );
  }

  if (clause.minNodes != null) {
    const rendered = evidence.renderedElementCount ?? evidence.bodyElementCount ?? 0;
    return rendered >= clause.minNodes
      ? passCheck(
          id,
          subject,
          `The ${clause.surface} is rendering ${rendered} element(s), and at least ${clause.minNodes} were expected.`,
          { evidence: evidence as Record<string, unknown> },
        )
      : failCheck(
          id,
          subject,
          `The ${clause.surface} is open but renders ${rendered} element(s), fewer than the ${clause.minNodes} expected.`,
          { evidence: evidence as Record<string, unknown> },
        );
  }
  return renderedFromEvidence(evidence)
    ? passCheck(
        id,
        subject,
        `The ${clause.surface} is rendering ${document}: ${evidence.bodyElementCount ?? 0} element(s) and ${evidence.textLength ?? 0} character(s) of text in the body.`,
        { evidence: evidence as Record<string, unknown> },
      )
    : failCheck(
        id,
        subject,
        `The ${clause.surface} page is open at ${document} but nothing rendered into it: ${evidence.bodyElementCount ?? 0} element(s) and ${evidence.textLength ?? 0} character(s) of text in the body. A mount point with nothing mounted looks exactly like this.`,
        { evidence: evidence as Record<string, unknown> },
      );
}

function contractLoadRefusal(projectPath: string, browser: string): string | null {
  try {
    const contract = JSON.parse(
      fs.readFileSync(readyContractPath(projectPath, browser), "utf8"),
    ) as { code?: unknown; message?: unknown; extensionLoadRefusedReason?: unknown };
    if (contract.code !== "extension_load_refused") return null;
    return String(contract.extensionLoadRefusedReason || contract.message || "extension_load_refused");
  } catch {
    return null;
  }
}

function samePage(eventUrl: string, wanted: string): boolean {
  if (!eventUrl || !wanted) return false;
  if (eventUrl === wanted) return true;
  try {
    const a = new URL(eventUrl);
    const b = new URL(wanted);
    const strip = (pathname: string) => pathname.replace(/\/+$/, "") || "/";
    return a.origin === b.origin && strip(a.pathname) === strip(b.pathname);
  } catch {
    return false;
  }
}

function contractCompiledAtMs(projectPath: string, browser: string): number | null {
  try {
    const contract = JSON.parse(
      fs.readFileSync(readyContractPath(projectPath, browser), "utf8"),
    ) as { compiledAt?: unknown };
    const ms = typeof contract.compiledAt === "string" ? Date.parse(contract.compiledAt) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

async function assertContentScriptInjected(
  clause: ContentScriptClause,
  stage: Stage,
): Promise<CheckResult> {
  const id = CONTENT_SCRIPT;
  const subject = clause.subject;

  const forbidden = contentScriptsForbidden(clause.url, stage.browser);
  if (forbidden) {
    return failCheck(
      id,
      subject,
      `No content script can run at ${clause.url}: ${forbidden}. No manifest change makes this expectation true.`,
    );
  }

  const read = stage.manifest();
  if (!read) return stage.noManifest(id, subject);

  const scripts = declaredContentScripts(read.manifest);
  const patterns = scripts.flatMap((entry) => entry.matches);
  const covering = coveringMatches(patterns, clause.url);

  const runId = readLogRunId(stage.projectPath, stage.browser);
  const stale = staleFileNote(stage.projectPath, stage.browser, runId);
  /* @invariant A LINE COUNTS WHEN IT CAME FROM THAT PAGE, IN THIS BUILD. The
     engine's url filter is a substring test, so a line from /cart/checkout
     or from a page whose query carried the wanted url passed for /cart; and
     a line written early in the run kept passing after an edit broke the
     script. The event's origin and path must equal the clause's, and the
     event must be newer than the contract's compiledAt. */
  const compiledAt = contractCompiledAtMs(stage.projectPath, stage.browser);
  const lines = readLogEvents(stage.projectPath, stage.browser, {
    context: ["content"],
  }).filter((event) => {
    const ev = event as { url?: unknown; timestamp?: unknown };
    if (!samePage(String(ev.url ?? ""), clause.url)) return false;
    if (compiledAt !== null && typeof ev.timestamp === "number" && ev.timestamp < compiledAt) {
      return false;
    }
    return true;
  });

  if (lines.length > 0 && !stale) {
    return passCheck(
      id,
      subject,
      `The content context wrote ${lines.length} log line(s) at ${clause.url} in run ${runId || "(unnamed)"}, and only an injected content script writes from that context.`,
      { lines: lines.length, runId, coveringMatches: covering },
    );
  }

  if (stage.webkit) {
    return assertContentScriptInjectedOnWebKit(clause, stage, {
      covering,
      patterns,
    });
  }

  /* @invariant A declared match is never a pass. Whether a content script ran
     on a given page is not observable from outside its isolated world, so the
     only positive evidence this platform holds is a line the script itself
     wrote. Passing on coverage would report on the manifest while claiming to
     report on the run, which is the guess this tool exists to replace. */
  return inconclusiveCheck(
    id,
    subject,
    covering.length > 0
      ? `${covering.length} declared content_scripts match(es) cover ${clause.url} (${covering.join(", ")}), but nothing observable proves the script executed there: this platform cannot see into a content script's isolated world, and the content context logged nothing at that url in run ${runId || "(unnamed)"}.${stale ? ` ${stale}` : ""}`
      : `The built manifest (${read.file}) declares no content_scripts match covering ${clause.url}${patterns.length ? ` (declared: ${patterns.join(", ")})` : " and declares no content script at all"}. That is not proof of non-injection either: scripts registered at runtime with chrome.scripting.registerContentScripts are invisible to this reader.`,
    "Have the content script write one line, a console call or a dx.signal, and this check reads it from the log stream. To settle it now, read a marker the script sets with extension_eval (context: 'content', url: the page), which runs in the same isolated world the content script does.",
    { coveringMatches: covering, declaredMatches: patterns, runId },
  );
}

/* @invariant On Safari the background is observable only through the line
 * it writes into the dev session's log stream over the extension's bridge,
 * because no debugging protocol lists its worker. A written line is a booted
 * background; silence is inconclusive, since a background that logs nothing
 * looks identical to one that never started.
 */
async function assertBackgroundOnWebKit(
  clause: BackgroundClause,
  stage: Stage,
): Promise<CheckResult> {
  const id = BACKGROUND;
  const subject = clause.subject;
  const runId = readLogRunId(stage.projectPath, stage.browser);
  const stale = staleFileNote(stage.projectPath, stage.browser, runId);
  const lines = readLogEvents(stage.projectPath, stage.browser, {
    context: ["background"],
  });
  if (lines.length > 0 && !stale) {
    return passCheck(
      id,
      subject,
      `The background context wrote ${lines.length} log line(s) in run ${runId || "(unnamed)"} over the extension's bridge, and only a running background writes from that context.`,
      { lines: lines.length, runId },
    );
  }
  return inconclusiveCheck(
    id,
    subject,
    `${stage.browser} lists no background worker to this server, and the background context logged nothing in run ${runId || "(unnamed)"}${stale ? ` (${stale})` : ""}.`,
    "Have the background write one line on start (a console call), which reaches the dev session's log over the bridge once the extension is enabled; or open Web Inspector (Develop > Web Extension Background Content), attended.",
    { runId },
  );
}

/* @invariant On Safari the evidence is a DOM root the script mounted, read
 * from the page's main world through the dev session's automation window,
 * because that window is the only reach Safari grants and it carries no
 * console feed. An Extension.js content script stamps each root it mounts
 * with an owner naming the extension, so an owned root is proof the script
 * ran on this page. A page with no root is not proof it did not: a script
 * that mounts nothing leaves nothing to read, so that reading stays
 * inconclusive and names the marker that would settle it.
 */
async function assertContentScriptInjectedOnWebKit(
  clause: ContentScriptClause,
  stage: Stage,
  declared: { covering: string[]; patterns: string[] },
): Promise<CheckResult> {
  const id = CONTENT_SCRIPT;
  const subject = clause.subject;
  const client = stage.webdriver();
  if (!client) {
    return inconclusiveCheck(
      id,
      subject,
      `The content context logged nothing at ${clause.url} in this run, and no safaridriver session is recorded for ${stage.browser}, so no page was read either.${declared.covering.length ? ` ${declared.covering.length} declared match(es) cover the url (${declared.covering.join(", ")}), which is not proof the script ran.` : ""}`,
      `Open ${clause.url} in Safari with the extension enabled, have the content script write one line (a console call), and assert again: the line reaches the dev session's log over the bridge. ${WEBDRIVER_SESSION_MISSING_HINT}`,
      { coveringMatches: declared.covering, declaredMatches: declared.patterns },
    );
  }

  let reading: Awaited<ReturnType<typeof readExtensionRoots>>;
  try {
    const current = await client.currentUrl();
    if (!sameDocument(current, clause.url)) {
      await client.navigate(clause.url);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    reading = await readExtensionRoots(client);
  } catch (error) {
    return inconclusiveCheck(
      id,
      subject,
      `The Safari automation window could not be read: ${error instanceof Error ? error.message : String(error)}.`,
      "Confirm the dev session still holds its window with extension_doctor, restart extension_dev --browser=safari if it ended, then assert again.",
      { coveringMatches: declared.covering, declaredMatches: declared.patterns },
    );
  }

  const extensionId =
    readyExtensionId(stage.projectPath, stage.browser) ??
    (await stage.extensionId());
  if (!extensionId) {
    return inconclusiveCheck(
      id,
      subject,
      `The Safari automation window shows ${reading.roots} extension root(s) at ${reading.url}, but this session recorded no extension id, so none of them can be attributed to this extension rather than another one.`,
      "Restart extension_dev --browser=safari on an Extension.js that stamps extensionId into ready.json, then assert again.",
      { roots: reading.roots, owners: reading.owners, url: reading.url },
    );
  }
  const owned = reading.owners.filter(
    (owner) => owner.length > 0 && owner.includes(extensionId),
  );
  if (owned.length > 0) {
    return passCheck(
      id,
      subject,
      `${owned.length} extension root(s) mounted by this extension's content script are in the DOM at ${reading.url}, read from the Safari automation window; only an injected content script mounts them.`,
      {
        roots: reading.roots,
        owners: owned,
        url: reading.url,
        coveringMatches: declared.covering,
      },
    );
  }

  return inconclusiveCheck(
    id,
    subject,
    declared.covering.length > 0
      ? `${declared.covering.length} declared content_scripts match(es) cover ${clause.url} (${declared.covering.join(", ")}), and the Safari automation window shows ${reading.roots} extension root(s) at ${reading.url}${reading.roots > 0 ? " none of which names this extension as owner" : ""}. A script that mounts no root leaves nothing this reader can see, and Safari carries no console feed over WebDriver to read a line instead.`
      : `The built manifest declares no content_scripts match covering ${clause.url}${declared.patterns.length ? ` (declared: ${declared.patterns.join(", ")})` : " and declares no content script at all"}, and the Safari automation window shows ${reading.roots} extension root(s) there.`,
    "Have the content script mount an element with data-extension-root (Extension.js stamps the owner on it), or set any DOM marker and read it with extension_eval (context: 'page', url: the page). A console line would need the WebDriver BiDi log domain, which this server does not speak yet.",
    {
      roots: reading.roots,
      owners: reading.owners,
      url: reading.url,
      coveringMatches: declared.covering,
      declaredMatches: declared.patterns,
    },
  );
}

interface StorageRead {
  shape: "found" | "absent" | "unreadable";
  value?: unknown;
}

/* @invariant chrome.storage.get answers with an object that simply lacks the
   key when nothing is stored, so an object without the key is a real absence
   and not a shape this reader failed to understand. Anything that is neither
   that object nor a bare value is reported unreadable, which is inconclusive;
   guessing a value out of an unrecognised frame is how an assertion passes
   over a read that never happened. */
export function readStorageValue(value: unknown, key: string): StorageRead {
  if (value === null || value === undefined) return { shape: "absent" };
  if (typeof value !== "object") return { shape: "found", value };
  if (Array.isArray(value)) return { shape: "unreadable" };
  const record = value as Record<string, unknown>;
  if (key in record) {
    return record[key] === undefined
      ? { shape: "absent" }
      : { shape: "found", value: record[key] };
  }
  if (record.result !== undefined) return readStorageValue(record.result, key);
  if (record.value !== undefined && record.key === key) {
    return { shape: "found", value: record.value };
  }
  return { shape: "absent" };
}

function sameValue(left: unknown, right: unknown): boolean {
  const encode = (value: unknown): string =>
    JSON.stringify(value ?? null) ?? "null";
  return encode(left) === encode(right);
}

async function assertStorageKeyPresent(
  clause: StorageClause,
  stage: Stage,
): Promise<CheckResult> {
  const id = STORAGE;
  const subject = clause.subject;
  const cli = [
    "storage",
    "get",
    stage.projectPath,
    "--area",
    clause.area,
    "--key",
    clause.key,
  ];
  if (clause.context) cli.push("--context", clause.context);
  cli.push("--browser", stage.browser);
  if (stage.timeout != null) cli.push("--timeout", String(stage.timeout));

  const raw = await runActVerb(cli, stage.projectPath, stage.timeout, COMMAND);
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return inconclusiveCheck(
      id,
      subject,
      `The storage read returned something this server could not parse, so nothing was learned about ${subject}: ${truncate(raw)}`,
      "Run extension_storage with the same arguments and read the frame directly.",
    );
  }

  /* @invariant A platform refusal is inconclusive, not a failed expectation. A
     session started without allowControl, a dead control channel or an engine
     below the flag's floor all mean the key was never read, and reporting that
     as a failure blames the extension for the harness. */
  if (!isEnvelope(frame) || frame.ok === false) {
    const message =
      isEnvelope(frame) && frame.error
        ? frame.error.message
        : `the read did not return a usable envelope: ${truncate(frame)}`;
    return inconclusiveCheck(
      id,
      subject,
      `The platform refused the read, so ${subject} was never observed: ${message}`,
      (isEnvelope(frame) && typeof frame.hint === "string" && frame.hint) ||
        "Start the session with extension_dev and allowControl: true, then assert again.",
    );
  }

  const read = readStorageValue(frame.value, clause.key);
  if (read.shape === "unreadable") {
    return inconclusiveCheck(
      id,
      subject,
      `The engine's storage frame carried a shape this reader does not understand, so ${subject} was not observed: ${truncate(frame.value)}`,
      "Read it with extension_storage and compare the frame; this check refuses to guess a value out of it.",
    );
  }
  if (read.shape === "absent") {
    return failCheck(
      id,
      subject,
      `chrome.storage.${clause.area} holds no value for "${clause.key}".`,
      { area: clause.area, key: clause.key },
    );
  }
  if (clause.hasEquals && !sameValue(read.value, clause.equals)) {
    return failCheck(
      id,
      subject,
      `chrome.storage.${clause.area}.${clause.key} is ${truncate(read.value)}, and ${truncate(clause.equals)} was expected.`,
      { area: clause.area, key: clause.key, value: read.value },
    );
  }
  return passCheck(
    id,
    subject,
    clause.hasEquals
      ? `chrome.storage.${clause.area}.${clause.key} is ${truncate(read.value)}, as expected.`
      : `chrome.storage.${clause.area} holds "${clause.key}" (${truncate(read.value)}).`,
    { area: clause.area, key: clause.key, value: read.value },
  );
}

function assertConsoleErrorsEmpty(
  clause: ConsoleClause,
  stage: Stage,
): CheckResult {
  const id = CONSOLE;
  const subject = clause.subject;
  const file = logsPath(stage.projectPath, stage.browser);
  const all = readLogEvents(stage.projectPath, stage.browser, {});
  const maxSeq = all.reduce(
    (max, event) => {
      const seq = (event as { seq?: unknown }).seq;
      return typeof seq === "number" && seq > max ? seq : max;
    },
    -1,
  );

  /* @invariant An empty timeline is inconclusive, never a pass. "No errors"
     read off a session that never built, exited, or wrote a single line is the
     false green this whole stage exists to stop: extension_logs already says
     so in a warning, and an agent counting events in the payload cannot see
     it. */
  if (all.length === 0) {
    const reason = emptyReason(stage.projectPath, stage.browser);
    return inconclusiveCheck(
      id,
      subject,
      reason ??
        `No log event has been written to ${file} for this session, so there is no timeline to judge and "no errors" would only mean "nothing happened".`,
      "Drive the extension first with extension_open, or open a page its content script matches, then assert again.",
      { logFile: file },
    );
  }

  const runId = readLogRunId(stage.projectPath, stage.browser);
  const stale = staleFileNote(stage.projectPath, stage.browser, runId);
  if (stale) {
    return inconclusiveCheck(
      id,
      subject,
      `The log file holds ${all.length} event(s) but they do not belong to a live run, so they cannot answer for the session being tested. ${stale}`,
      "Start the session with extension_dev and drive it, then assert again.",
      { logFile: file, runId },
    );
  }

  /* @invariant THE GUARD AND THE VERDICT READ THE SAME SCOPE. The empty-
     timeline guard used to run unscoped while the verdict ran with the
     clause's context and since, so "no errors in popup" passed on a popup
     that never opened, and a since cursor from an earlier process (seq
     restarts at 1) passed over everything. Errors are
     counted as EVENTS, so one with empty text still counts. */
  const scopeQuery = {
    ...(clause.context ? { context: clause.context } : {}),
    ...(clause.since === undefined ? {} : { since: clause.since }),
  };
  if (clause.since !== undefined && clause.since > maxSeq) {
    return inconclusiveCheck(
      id,
      subject,
      `The since cursor ${clause.since} is past the newest event in this run (seq ${maxSeq}), so it belongs to another run or process and selects nothing.`,
      "Read extension_logs to find the current run's seq, then assert with a cursor from it.",
      { logFile: file, runId, maxSeq },
    );
  }
  const inScope = readLogEvents(stage.projectPath, stage.browser, scopeQuery);
  if (inScope.length === 0) {
    return inconclusiveCheck(
      id,
      subject,
      `No log event matches this clause's scope (${
        clause.context?.length ? `context ${clause.context.join(", ")}` : "all contexts"
      }${clause.since === undefined ? "" : `, after seq ${clause.since}`}) in run ${runId || "(unnamed)"}, so "no errors" there would only mean "nothing happened there".`,
      "Drive that part of the extension first (open the surface, load the page), then assert again.",
      { logFile: file, runId, events: all.length },
    );
  }
  const errorEvents = readLogEvents(stage.projectPath, stage.browser, {
    ...scopeQuery,
    level: "error",
  });
  const errors = errorEvents.map((event) => {
    const ev = event as { messageParts?: unknown[]; message?: unknown; errorName?: unknown; stack?: unknown };
    const parts = Array.isArray(ev.messageParts) ? ev.messageParts : null;
    let text = parts
      ? parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ")
      : typeof ev.message === "string"
        ? ev.message
        : "";
    if (!text && typeof ev.errorName === "string") text = ev.errorName;
    text = text.replace(/\s+/g, " ").trim();
    return text || "(error event with no message text)";
  });
  const ignored = clause.ignore ?? [];
  const kept = errors.filter(
    (message) => !ignored.some((needle) => message.includes(needle)),
  );
  const scope = clause.context?.length
    ? ` in context(s) ${clause.context.join(", ")}`
    : "";

  if (kept.length > 0) {
    return failCheck(
      id,
      subject,
      `${kept.length} error-level log event(s)${scope} in run ${runId || "(unnamed)"}: ${kept
        .slice(0, 5)
        .map((message) => `"${message}"`)
        .join("; ")}${kept.length > 5 ? ` and ${kept.length - 5} more` : ""}.`,
      { errors: kept.slice(0, 20), runId },
    );
  }

  return passCheck(
    id,
    subject,
    `No error-level log event${scope} among ${all.length} event(s) in run ${runId || "(unnamed)"}${
      ignored.length && errors.length
        ? `, and ${errors.length} matched an ignore entry and were not counted`
        : ""
    }.`,
    { events: all.length, ignored: errors.length - kept.length, runId },
  );
}

async function evaluateClause(
  clause: Clause,
  stage: Stage,
): Promise<CheckResult> {
  if (stage.webkit && clause.assert === BACKGROUND) {
    return assertBackgroundOnWebKit(clause, stage);
  }
  switch (clause.assert) {
    case BACKGROUND:
      return assertBackgroundWorker(clause, stage);
    case SURFACE:
      return assertSurfaceRendered(clause, stage);
    case CONTENT_SCRIPT:
      return assertContentScriptInjected(clause, stage);
    case STORAGE:
      return assertStorageKeyPresent(clause, stage);
    default:
      return assertConsoleErrorsEmpty(clause, stage);
  }
}

export async function handler(args: {
  projectPath: string;
  expect: unknown;
  browser?: string;
  timeout?: number;
}): Promise<string> {
  const { clauses, issues } = parseClauses(args.expect);
  if (issues.length > 0) {
    return envelope({
      ok: false,
      command: COMMAND,
      status: "bad-request",
      error: {
        code: "E_BAD_REQUEST",
        name: "BadRequest",
        message: `expect could not be read as a list of expectations: ${issues.join("; ")}`,
      },
      value: {
        checks: ASSERT_CHECKS.map((check) => ({
          assert: check.id,
          title: check.title,
        })),
      },
      hint: "Each entry is an object whose `assert` names one of the checks above, plus that check's own arguments.",
    });
  }

  const { browser } = resolveSessionBrowser(
    args.projectPath,
    args.browser,
    "chrome",
  );
  const stage = new Stage(args.projectPath, browser, args.timeout);
  const checks: CheckResult[] = [];
  try {
    for (const clause of clauses) {
      checks.push(await evaluateClause(clause, stage));
    }
  } finally {
    stage.dispose();
  }

  const verdict = assertVerdict({
    checks,
    producer: { name: "@extension.dev/mcp", version },
    subject: { projectPath: args.projectPath, browser },
  });

  return envelope({
    ok: verdict.passed,
    command: COMMAND,
    status: verdict.outcome,
    value: verdict,
    hint: verdictSentence(verdict),
    warnings: verdict.inconclusive.length
      ? [
          `Inconclusive: ${verdict.inconclusive.join(" | ")}. Read each check's settledBy for the evidence that would answer it; none of these is a pass.`,
        ]
      : [],
  });
}

export { checkKey };
