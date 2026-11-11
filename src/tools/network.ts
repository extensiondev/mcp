// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { isChromiumFamily, isGeckoFamily } from "../lib/browser-family";
import { CDP_PORT_MISSING_HINT, resolveCdpPort } from "../lib/cdp-port";
import { SESSION_BROWSER, SESSION_PROJECT_PATH } from "../lib/common-schema";
import { envelope } from "../lib/envelope";
import {
  describeRule,
  dropNetworkStubs,
  liveNetworkStubs,
  openNetworkStubs,
  parseStubRule,
  type StubRequest,
  type StubRule,
  type StubSession,
} from "../lib/network-stubs";
import { ambiguousSessionRefusal, resolveSessionBrowser } from "../lib/session-browser";

export const schema = {
  name: "extension_network",
  description:
    "Stub a network response on a Chromium session: add a rule (method, URL or glob, status, body or json), list or clear the rules, or read which requests hit one or missed. Rules last until extension_stop. Firefox is refused.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectPath: SESSION_PROJECT_PATH,
      action: {
        type: "string",
        enum: ["add", "list", "clear", "requests"],
        description: "add a rule, list or clear the rules, or read the requests seen.",
      },
      method: { type: "string", description: "add: HTTP method; default ANY." },
      url: { type: "string", description: "add: exact URL, or a glob with * and ?." },
      status: { type: "number", default: 200, description: "add: HTTP status to answer." },
      body: { type: "string", description: "add: response text." },
      json: { description: "add: response as a JSON value; not with body." },
      contentType: { type: "string", description: "add: Content-Type; default by body or json." },
      browser: SESSION_BROWSER,
    },
    required: ["projectPath", "action"],
  },
};

type Action = "add" | "list" | "clear" | "requests";

const RULES_SHOWN = 50;

function ruleRow(rule: StubRule): Record<string, unknown> {
  return {
    id: rule.id,
    method: rule.method,
    url: rule.url,
    status: rule.status,
    contentType: rule.contentType,
    bodyLength: rule.body.length,
    ...(Object.keys(rule.headers).length ? { headers: rule.headers } : {}),
    hits: rule.hits,
  };
}

function requestRow(request: StubRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url,
    target: request.target,
    ...(request.ruleId ? { ruleId: request.ruleId } : {}),
    atMs: request.at,
  };
}

function refusal(status: string, code: string, message: string, hint: string, value: Record<string, unknown> = {}): string {
  return envelope({ ok: false, command: schema.name, status, error: { code, message }, value, hint });
}

function engineRefusal(browser: string): string {
  const engine = isGeckoFamily(browser) ? "Firefox bridge" : "Safari bridge";

  return refusal(
    "not-supported",
    "E_UNSUPPORTED_BROWSER",
    `Network stubs ride the Chrome DevTools Protocol's Fetch domain, and the engine's ${engine} does not carry request interception yet, so no rule can be installed on a ${browser} session.`,
    "Run the same project with extension_dev on chrome, chromium or edge, then call extension_network again; on this browser, read the real traffic in its own network panel.",
    { browser },
  );
}

function enableWarning(session: StubSession): string | null {
  if (session.enableErrors.length === 0) return null;

  return `${session.enableErrors.length} target(s) refused interception (${session.enableErrors.slice(0, 3).join("; ")}); a request from one of those is neither stubbed nor listed.`;
}

function rulesValue(session: StubSession | null): Record<string, unknown> {
  const rules = session ? session.rules : [];

  return {
    rules: rules.slice(0, RULES_SHOWN).map(ruleRow),
    ...(rules.length > RULES_SHOWN ? { rulesTruncated: rules.length - RULES_SHOWN } : {}),
    live: session !== null && session.live && rules.length > 0,
    requestsSeen: session ? session.requests.length : 0,
  };
}

export async function handler(args: {
  projectPath: string;
  action: Action;
  method?: string;
  url?: string;
  status?: number;
  body?: string;
  json?: unknown;
  contentType?: string;
  browser?: string;
}): Promise<string> {
  const ambiguous = ambiguousSessionRefusal(schema.name, args.projectPath, args.browser);
  if (ambiguous) return ambiguous;

  const { browser } = resolveSessionBrowser(args.projectPath, args.browser);
  const [current] = liveNetworkStubs(args.projectPath, browser);
  const session = current ?? null;

  if (args.action === "list") {
    const rules = session ? session.rules : [];

    return envelope({
      ok: true,
      command: schema.name,
      status: "rules-listed",
      value: { browser, ...rulesValue(session) },
      warnings: [session ? enableWarning(session) : null],
      hint: rules.length
        ? `${rules.length} rule(s) are live on the ${browser} session: ${rules.slice(0, 5).map(describeRule).join("; ")}. extension_network {action: "requests"} says which requests hit one; {action: "clear"} takes them all down.`
        : `No network stub is live on the ${browser} session, so every request reaches its real server. extension_network {action: "add", url, status, json} installs one.`,
    });
  }

  if (args.action === "requests") {
    if (!session || session.rules.length === 0) {
      return envelope({
        ok: true,
        command: schema.name,
        status: "no-rules",
        value: { browser, hit: [], missed: [], ...rulesValue(session) },
        hint: `Requests are recorded only while a rule set is live, and none is on the ${browser} session. extension_network {action: "add", url, status, json} installs one; the requests made from then on are listed here.`,
      });
    }

    const hit = session.requests.filter((request) => request.ruleId !== null);
    const missed = session.requests.filter((request) => request.ruleId === null);
    const shownHit = hit.slice(-RULES_SHOWN);
    const shownMissed = missed.slice(-RULES_SHOWN);
    const unhit = session.rules.filter((rule) => rule.hits === 0);

    return envelope({
      ok: true,
      command: schema.name,
      status: "requests-read",
      value: {
        browser,
        counts: { hit: hit.length, missed: missed.length, total: session.requests.length },
        hit: shownHit.map(requestRow),
        missed: shownMissed.map(requestRow),
        ...(hit.length > shownHit.length || missed.length > shownMissed.length ? { showingNewest: RULES_SHOWN } : {}),
        rules: session.rules.map(ruleRow),
      },
      warnings: [enableWarning(session)],
      hint: `${hit.length} request(s) were answered by a rule and ${missed.length} reached their real server since the rules went live. ${
        unhit.length
          ? `Rule(s) ${unhit.map((rule) => rule.id).join(", ")} answered nothing yet: a request made before the rule, startup included, was not covered (extension_reload replays the background's startup under the rules), and a missed row with a near URL means the pattern does not match it.`
          : "Every rule answered at least once."
      } Read what the page did with it through extension_dom_snapshot or extension_eval.`,
    });
  }

  if (args.action === "clear") {
    const cleared = dropNetworkStubs(args.projectPath, browser);

    return envelope({
      ok: true,
      command: schema.name,
      status: cleared ? "rules-cleared" : "nothing-to-clear",
      value: { browser, cleared, rules: [], live: false },
      hint: cleared
        ? `${cleared} rule(s) were taken down and the request record was dropped; from now on every request from the ${browser} session reaches its real server. Reads no longer carry the stub warning.`
        : `No network stub was live on the ${browser} session, so nothing changed.`,
    });
  }

  if (!isChromiumFamily(browser)) return engineRefusal(browser);

  const parsed = parseStubRule(args, session ? session.rules.map((rule) => rule.id) : []);

  if ("problem" in parsed) {
    return refusal("bad-request", "E_BAD_REQUEST", parsed.problem, 'Call extension_network {action: "add", url, status, json} again with the field fixed.', { browser });
  }

  let stubs = session;

  if (!stubs) {
    const resolved = await resolveCdpPort(args.projectPath, browser);

    if (!resolved) {
      return refusal(
        "no-session",
        "E_NO_SESSION",
        `No ${browser} session with a debugging port was found for this project, so there is no browser to install the rule on. ${CDP_PORT_MISSING_HINT}`,
        "Start the session with extension_dev (or extension_start with allowControl: true), wait for extension_wait to answer ready, then add the rule again.",
        { browser },
      );
    }

    try {
      stubs = await openNetworkStubs(args.projectPath, browser, resolved.port);
    } catch (error) {
      return refusal(
        "cdp-unreachable",
        "E_CDP",
        `The ${browser} session lists debug port ${resolved.port}, but this server could not attach to it (${error instanceof Error ? error.message : String(error)}), so no rule was installed.`,
        "Call extension_doctor to read what the debug port is doing, then add the rule again.",
        { browser, port: resolved.port },
      );
    }
  }

  await stubs.add(parsed.rule);

  return envelope({
    ok: true,
    command: schema.name,
    status: "rule-added",
    value: {
      browser,
      rule: ruleRow(parsed.rule),
      ...rulesValue(stubs),
      covers: "requests the extension's pages and background make from now on; requests already made, startup included, were not covered",
      until: "extension_stop, or extension_network {action: \"clear\"}",
    },
    warnings: [enableWarning(stubs)],
    hint: `${describeRule(parsed.rule)} from now on, on every page and background context of the ${browser} session, until extension_stop. A request made before this call was not covered: extension_reload replays the background's startup under the rule, and extension_open reopens a surface so its first fetch meets it. Then read the outcome with extension_dom_snapshot or extension_eval; extension_network {action: "requests"} says which requests hit the rule and which missed it.`,
  });
}
