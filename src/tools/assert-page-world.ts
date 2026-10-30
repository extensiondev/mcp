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
import { readBaseline } from "./assert-page-world-baseline";
import { devRuntimeResourceTest, isDevRuntimeAttribute, readSessionKind } from "./assert-page-world-dev";
import { pageWorldReadScript, resourceProbeScript, staticResources, type PageWorldRead, type ResourceProbe } from "./assert-page-world-reads";
import { pageWorldVerdict, type LabeledHit, type ProbedResource } from "./assert-page-world-verdict";
import { inconclusiveCheck, type CheckResult } from "../lib/verdict";

import type { CDPClient } from "../lib/cdp";
import type { Stage } from "./assert";

export const PAGE_WORLD = "page-world-clean";

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

  const baseline = await readBaseline(stage, attached, targets, read.manifest);
  const session = readSessionKind(
    stage.projectPath,
    stage.browser,
    read.manifest,
    world.dom.hits.map((hit) => hit.attribute),
  );
  const devResource = devRuntimeResourceTest(stage.projectPath, stage.browser, distDir === null);
  const dev = session.kind === "dev";
  const hits: LabeledHit[] = world.dom.hits.map((hit) =>
    dev && isDevRuntimeAttribute(hit.attribute) ? { ...hit, devRuntime: true } : { ...hit },
  );
  const exempt = new Set(clause.pageGlobals ?? []);
  const symbols = {
    attributed: world.symbols.filter((description) => description.includes(extensionId)),
    unattributed: world.symbols.filter((description) => !description.includes(extensionId) && !exempt.has(description)),
  };
  const leaked = new Set(world.refs.map((ref) => ref.name));
  const unknown = baseline
    ? world.ownNames.filter((name) => !baseline.names.includes(name) && !exempt.has(name) && !leaked.has(name))
    : null;
  const probed: ProbedResource[] = resources.probes.map((probe) => {
    const answer = answers.find((entry) => entry.index === probe.index);

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
      coversPage: coveringMatches(probe.matches, target.url).length > 0,
      ...(dev && devResource(probe.path) ? { devRuntime: true as const } : {}),
    };
  });
  const evidence = {
    url: target.url,
    targetId: target.targetId,
    extensionId,
    ...(candidates.length > 1 ? { otherMatches: candidates.slice(1).map((page) => page.url) } : {}),
    session,
    dom: { ...world.dom, hits },
    globals: {
      own: world.ownNames.length,
      symbols: world.symbols,
      attributedSymbols: symbols.attributed,
      refs: world.refs,
      unknown,
      baseline: baseline?.source ?? null,
      ...(baseline?.note ? { baselineNote: baseline.note } : {}),
    },
    resources: { probed, skipped: resources.skipped },
  };

  return pageWorldVerdict({
    id,
    subject,
    url: target.url,
    extensionId,
    world,
    hits,
    symbols,
    unknown,
    baseline,
    probed,
    skipped: resources.skipped,
    session,
    evidence,
  });
}
