// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import path from "node:path";

import { filterPageTargets, matchTargetsByUrl } from "../lib/cdp-targets";
import { coveringMatches } from "../lib/match-patterns";
import { isSourceManifest } from "../lib/project-manifest";
import {
  BASELINE_SCRIPT,
  pageWorldReadScript,
  resourceProbeScript,
  staticResources,
  type PageWorldRead,
  type ResourceProbe,
} from "./assert-page-world-reads";
import { failCheck, inconclusiveCheck, passCheck, type CheckResult } from "../lib/verdict";

import type { CDPClient } from "../lib/cdp";
import type { Stage } from "./assert";

export const PAGE_WORLD = "page-world-clean";

const UNKNOWN_SHOWN = 12;
const PROBE_TIMEOUT_MS = 15_000;

export interface PageWorldClause {
  assert: typeof PAGE_WORLD;
  subject: string;
  url: string;
  pageGlobals?: string[];
}

export function parsePageWorldClause(
  at: string,
  clause: Record<string, unknown>,
  issues: string[],
): PageWorldClause | null {
  const url = String(clause.url ?? "").trim();

  if (!url) {
    issues.push(
      `${at}.url is required: the page world is read off an open page the extension's content scripts match`,
    );

    return null;
  }

  if (clause.pageGlobals !== undefined && !Array.isArray(clause.pageGlobals)) {
    issues.push(`${at}.pageGlobals must be an array of window property names the page itself defines`);

    return null;
  }

  const pageGlobals = Array.isArray(clause.pageGlobals) ? clause.pageGlobals.map(String) : undefined;

  return { assert: PAGE_WORLD, subject: url, url, ...(pageGlobals ? { pageGlobals } : {}) };
}

interface ProbeAnswer {
  index: number;
  ok: boolean;
  status?: number;
  error?: string;
}

async function probeResources(
  cdp: CDPClient,
  sessionId: string,
  extensionId: string,
  probes: ResourceProbe[],
): Promise<ProbeAnswer[]> {
  if (probes.length === 0) return [];

  const reply = (await cdp.sendCommand(
    "Runtime.evaluate",
    {
      expression: resourceProbeScript(
        probes.map((probe) => ({ index: probe.index, url: `chrome-extension://${extensionId}/${probe.path}` })),
      ),
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
    PROBE_TIMEOUT_MS,
  )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } } | undefined;

  if (reply?.exceptionDetails) {
    throw new Error(reply.exceptionDetails.text ?? "the resource probe threw in the page");
  }

  return Array.isArray(reply?.result?.value) ? (reply.result.value as ProbeAnswer[]) : [];
}

async function readBaseline(
  stage: Stage,
  cdp: CDPClient,
  targets: Array<{ id: string; type: string; url: string }>,
): Promise<{ names: string[]; source: "existing-blank" | "created-blank" } | null> {
  const spare = targets.find((target) => target.type === "page" && target.url === "about:blank");
  let createdId: string | null = null;

  try {
    let targetId = spare?.id ?? null;

    if (!targetId) {
      const created = (await cdp.sendCommand("Target.createTarget", { url: "about:blank", background: true })) as
        | { targetId?: string }
        | undefined;
      if (typeof created?.targetId !== "string") return null;

      createdId = created.targetId;
      targetId = createdId;
    }

    const attached = await stage.attach(targetId);
    if (!attached) return null;

    const names = await attached.cdp.evaluate(attached.sessionId, BASELINE_SCRIPT);
    if (!Array.isArray(names)) return null;

    return { names: names.map(String), source: createdId ? "created-blank" : "existing-blank" };
  } catch {
    return null;
  } finally {
    if (createdId) await cdp.sendCommand("Target.closeTarget", { targetId: createdId }).catch(() => undefined);
  }
}

function isPageWorldRead(value: unknown): value is PageWorldRead {
  const read = value as Partial<PageWorldRead> | null;

  return (
    !!read &&
    typeof read === "object" &&
    !!read.dom &&
    typeof read.dom.bytes === "number" &&
    Array.isArray(read.dom.hits) &&
    Array.isArray(read.ownNames) &&
    Array.isArray(read.symbols) &&
    Array.isArray(read.refs)
  );
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count(n)} ${n === 1 ? singular : pluralForm}`;
}

export async function assertPageWorldClean(clause: PageWorldClause, stage: Stage): Promise<CheckResult> {
  const id = PAGE_WORLD;
  const subject = clause.subject;

  if (!stage.chromium) {
    return stage.notChromium(
      id,
      subject,
      `Read the page's main world by hand with extension_eval (context: 'page', url: '${clause.url}'): Object.getOwnPropertySymbols(window), the own window properties and document.documentElement.outerHTML searched for the extension's id and its moz-extension:// or safari-web-extension:// base url, then fetch each static web_accessible_resources path from the page at that base url; a Chromium session answers all of it with this check.`,
    );
  }

  const read = stage.manifest();
  if (!read) return stage.noManifest(id, subject);

  const targets = await stage.targets();
  if (targets === null) return stage.noSession(id, subject);

  const extensionId = await stage.extensionId();

  if (!extensionId) {
    return inconclusiveCheck(
      id,
      subject,
      "The extension's id could not be resolved from the running session, so neither its base url nor its resource urls can be looked for in the page.",
      "Start the session with extension_dev, confirm it with extension_wait, then assert again.",
    );
  }

  const pages = filterPageTargets(targets as Array<{ id: string; type: string; url: string; title: string }>).filter(
    (target) => !target.url.startsWith("chrome-extension://"),
  );
  const candidates = matchTargetsByUrl(pages, clause.url);
  const target = candidates[0];

  if (!target) {
    return inconclusiveCheck(
      id,
      subject,
      `No page target in the session matches ${clause.url}, so its main world was never read. Open pages: ${
        pages.length ? pages.map((page) => page.url).join(", ") : "none"
      }.`,
      `Open it with extension_open (url: '${clause.url}'), wait for it to load, then assert again.`,
      { openPages: pages.map((page) => page.url) },
    );
  }

  const attached = await stage.attach(target.targetId);

  if (!attached) {
    return inconclusiveCheck(
      id,
      subject,
      `A page target for ${target.url} is open but this server could not attach to it, so its main world was never read.`,
      "Confirm the session with extension_doctor, reload the page, then assert again.",
    );
  }

  let world: unknown;

  try {
    world = await attached.cdp.evaluate(attached.sessionId, pageWorldReadScript(extensionId));
  } catch (error) {
    return inconclusiveCheck(
      id,
      subject,
      `The main world of ${target.url} did not answer the read: ${error instanceof Error ? error.message : String(error)}.`,
      "Reload the page, or resume a paused debugger in it, then assert again.",
    );
  }

  if (!isPageWorldRead(world)) {
    return inconclusiveCheck(
      id,
      subject,
      `The main world of ${target.url} answered a shape this reader does not understand, so nothing was judged.`,
      "Reload the page and assert again.",
    );
  }

  const distDir = isSourceManifest(read.file, stage.projectPath) ? null : path.dirname(read.file);
  const resources = staticResources(read.manifest, distDir);
  let answers: ProbeAnswer[];

  try {
    answers = await probeResources(attached.cdp, attached.sessionId, extensionId, resources.probes);
  } catch (error) {
    return inconclusiveCheck(
      id,
      subject,
      `The page read its own world, but the web_accessible_resources probe did not answer from ${target.url}: ${error instanceof Error ? error.message : String(error)}.`,
      "Reload the page and assert again.",
    );
  }

  const baseline = await readBaseline(stage, attached.cdp, targets);
  const exempt = new Set(clause.pageGlobals ?? []);
  const symbols = world.symbols.filter((description) => !exempt.has(description));
  const leaked = new Set(world.refs.map((ref) => ref.name));
  const unknown = baseline
    ? world.ownNames.filter((name) => !baseline.names.includes(name) && !exempt.has(name) && !leaked.has(name))
    : null;
  const probed = resources.probes.map((probe) => {
    const answer = answers.find((entry) => entry.index === probe.index);
    const coversPage = coveringMatches(probe.matches, target.url).length > 0;

    return {
      index: probe.index,
      path: probe.path,
      ...(probe.pattern ? { pattern: probe.pattern } : {}),
      matches: probe.matches,
      url: `chrome-extension://${extensionId}/${probe.path}`,
      ok: answer?.ok === true,
      ...(answer?.status !== undefined ? { status: answer.status } : {}),
      ...(answer?.error !== undefined ? { error: answer.error } : {}),
      ...(answer ? {} : { error: "no answer" }),
      coversPage,
    };
  });
  const answered = probed.filter((probe) => probe.ok);
  const evidence = {
    url: target.url,
    targetId: target.targetId,
    extensionId,
    ...(candidates.length > 1 ? { otherMatches: candidates.slice(1).map((page) => page.url) } : {}),
    dom: world.dom,
    globals: {
      own: world.ownNames.length,
      symbols: world.symbols,
      refs: world.refs,
      unknown,
      baseline: baseline?.source ?? null,
    },
    resources: { probed, skipped: resources.skipped },
  };
  const notes: string[] = [];

  for (const skip of resources.skipped) notes.push(`${skip.reason}.`);

  for (const probe of probed) {
    if (!probe.ok && !probe.coversPage) {
      notes.push(
        `web_accessible_resources[${probe.index}] (${probe.path}) was refused from a page not covered by its matches (${probe.matches.join(", ")}), which proves nothing for the pages they do cover.`,
      );
    }
  }

  if (unknown === null) {
    notes.push("Warning: no about:blank baseline could be read, so the page's own globals were not compared against the browser's.");
  } else if (unknown.length > 0) {
    notes.push(
      `Warning: ${plural(unknown.length, "own window property", "own window properties")} not on about:blank and not in pageGlobals (${unknown
        .slice(0, UNKNOWN_SHOWN)
        .join(", ")}${unknown.length > UNKNOWN_SHOWN ? `, and ${unknown.length - UNKNOWN_SHOWN} more` : ""}); pages define their own globals, so this is a read, not a leak.`,
    );
  }

  const trailer = notes.length ? ` ${notes.join(" ")}` : "";
  const leaks: string[] = [];

  if (world.dom.hits.length > 0) {
    leaks.push(
      `${plural(world.dom.hits.length, "DOM reference")} to its id (${world.dom.hits
        .slice(0, 3)
        .map((hit) => (hit.attribute === "#text" ? `${hit.tag} text "${hit.value}"` : `${hit.tag}[${hit.attribute}]="${hit.value}"`))
        .join(", ")}${world.dom.hits.length > 3 ? ", and more in evidence.dom.hits" : ""})`,
    );
  }

  if (symbols.length > 0) {
    leaks.push(`${plural(symbols.length, "symbol marker")} on window (${symbols.map((description) => `Symbol(${description})`).join(", ")})`);
  }

  if (world.refs.length > 0) {
    leaks.push(
      `${plural(world.refs.length, "window global")} naming the extension (${world.refs
        .slice(0, 3)
        .map((ref) => (ref.where === "name" ? ref.name : `${ref.name} = "${ref.value}"`))
        .join(", ")}${world.refs.length > 3 ? ", and more in evidence.globals.refs" : ""})`,
    );
  }

  for (const probe of answered) {
    leaks.push(
      `web_accessible_resources[${probe.index}] answers ${probe.status ?? "ok"} at ${probe.url} fetched from the page (matches: ${probe.matches.join(", ")}), so the extension is fingerprintable by url guessing`,
    );
  }

  if (leaks.length > 0) {
    return failCheck(
      id,
      subject,
      `The main world of ${target.url} can tell the extension is installed: ${leaks.join("; ")}.${trailer}`,
      evidence,
    );
  }

  return passCheck(
    id,
    subject,
    `Nothing in the main world of ${target.url} names the extension: ${count(world.dom.bytes)} bytes of outerHTML over ${count(world.dom.elements)} elements (${plural(world.dom.shadowRoots, "open shadow root")}) hold no occurrence of ${extensionId}, ${plural(world.ownNames.length, "own window property", "own window properties")} carry no symbol marker and none names the extension, and ${plural(resources.probes.length, "static web_accessible_resources path")} fetched from the page ${
      resources.probes.length === 0 ? "were declared, so there was nothing to guess" : `${resources.probes.length === 1 ? "was" : "were"} refused (${resources.probes.map((probe) => probe.path).join(", ")})`
    }.${trailer}`,
    evidence,
  );
}
