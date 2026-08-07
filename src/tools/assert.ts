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
import { runActVerb } from "../lib/act";
import { isChromiumFamily } from "../lib/browser-family";
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
import { logsPath } from "../lib/session-paths";
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
import { recentErrorLogs } from "./doctor";
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
      if (minNodes !== undefined && !Number.isFinite(minNodes)) {
        issues.push(`${at}.minNodes must be a number`);
        return;
      }
      if (minNodes !== undefined && clause.selector === undefined) {
        issues.push(
          `${at}.minNodes counts selector matches, so it needs a selector`,
        );
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
    return stage.notChromium(
      id,
      null,
      "On this browser family the MCP reads the debugger's root actor, which lists installed add-ons and no contexts. Read what the background itself wrote with extension_logs (context: ['background']); a line there is proof it ran.",
    );
  }

  const targets = await stage.targets();
  if (targets === null) return stage.noSession(id, null);

  const guest = await verifyGuestLoaded(stage.projectPath, stage.browser);
  if (!guest.checked) {
    return inconclusiveCheck(id, null, guest.reason, NO_SESSION_SETTLED_BY);
  }
  if (!guest.loaded) {
    return failCheck(
      id,
      null,
      `The extension is not loaded in the running browser, so its ${background.kind} never started. ${guest.reason}`,
      { guestIds: guest.guestIds },
    );
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
    `${read.file} declares a ${background.kind}${background.ref ? ` (${background.ref})` : ""}, the extension is loaded, and the browser lists no live worker target for it. That is not proof it never booted: Chrome delists an idle service worker, so absence here means no evidence either way.${
      stale
        ? ` The log file could not settle it either: ${stale}`
        : " Nothing in this run's logs came from the background context either."
    }`,
    "Wake it and assert again: extension_open (surface: 'action') or any message to the worker starts it, and one console line from the background makes this answerable from the log stream even after it idles out.",
    { runId, backgroundLogLines: backgroundLines.length },
  );
}

export function renderedFromEvidence(evidence: {
  bodyElementCount?: number;
  textLength?: number;
}): boolean {
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
    return stage.notChromium(
      id,
      subject,
      `Read the surface over the agent bridge instead: extension_dom_snapshot with context: '${clause.surface}' returns the rendered document on this browser family.`,
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
    const count = probes?.[0]?.count ?? 0;
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

async function assertContentScriptInjected(
  clause: ContentScriptClause,
  stage: Stage,
): Promise<CheckResult> {
  const id = CONTENT_SCRIPT;
  const subject = clause.subject;

  const forbidden = contentScriptsForbidden(clause.url);
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
  const lines = readLogEvents(stage.projectPath, stage.browser, {
    context: ["content"],
    url: clause.url,
  });

  if (lines.length > 0 && !stale) {
    return passCheck(
      id,
      subject,
      `The content context wrote ${lines.length} log line(s) at ${clause.url} in run ${runId || "(unnamed)"}, and only an injected content script writes from that context.`,
      { lines: lines.length, runId, coveringMatches: covering },
    );
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

  const errors = recentErrorLogs(stage.projectPath, stage.browser, 1000, {
    ...(clause.context ? { context: clause.context } : {}),
    ...(clause.since === undefined ? {} : { since: clause.since }),
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
