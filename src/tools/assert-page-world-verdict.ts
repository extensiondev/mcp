// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { devRuntimeTrailer, type SessionRead } from "./assert-page-world-dev";
import { failCheck, passCheck, type CheckResult } from "../lib/verdict";

import type { Baseline } from "./assert-page-world-baseline";
import type { PageWorldRead, SkippedResource } from "./assert-page-world-reads";

const UNKNOWN_SHOWN = 12;

export interface ProbedResource {
  index: number;
  path: string;
  pattern?: string;
  matches: string[];
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
  coversPage: boolean;
  devRuntime?: true;
}

export interface LabeledHit {
  tag: string;
  attribute: string;
  value: string;
  devRuntime?: true;
}

export interface VerdictInput {
  id: string;
  subject: string;
  url: string;
  extensionId: string;
  world: PageWorldRead;
  hits: LabeledHit[];
  symbols: { attributed: string[]; unattributed: string[] };
  unknown: string[] | null;
  baseline: Baseline | null;
  probed: ProbedResource[];
  skipped: SkippedResource[];
  session: SessionRead;
  evidence: Record<string, unknown>;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count(n)} ${n === 1 ? singular : pluralForm}`;
}

function hitText(hit: LabeledHit): string {
  return hit.attribute === "#text" ? `${hit.tag} text "${hit.value}"` : `${hit.tag}[${hit.attribute}]="${hit.value}"`;
}

function warnings(input: VerdictInput): string[] {
  const notes: string[] = [];

  for (const skip of input.skipped) notes.push(`${skip.reason}.`);

  for (const probe of input.probed) {
    if (!probe.ok && !probe.coversPage) {
      notes.push(
        `web_accessible_resources[${probe.index}] (${probe.path}) was refused from a page not covered by its matches (${probe.matches.join(", ")}), which proves nothing for the pages they do cover.`,
      );
    }
  }

  if (input.symbols.unattributed.length > 0) {
    notes.push(
      `Warning: ${plural(input.symbols.unattributed.length, "unattributed symbol")} on window (${input.symbols.unattributed
        .map((description) => `Symbol(${description})`)
        .join(", ")}); none names the extension's id or base url, and a site defines symbols of its own, so this is a read, not a leak.`,
    );
  }

  if (input.unknown === null) {
    notes.push("Warning: no baseline could be read, so the page's own globals were not compared against the browser's.");
  } else if (input.unknown.length > 0) {
    notes.push(
      `Warning: ${plural(input.unknown.length, "own window property", "own window properties")} not on a ${
        input.baseline?.source === "same-origin-frame" ? "blank same-origin frame" : "blank tab"
      } and not in pageGlobals (${input.unknown.slice(0, UNKNOWN_SHOWN).join(", ")}${
        input.unknown.length > UNKNOWN_SHOWN ? `, and ${input.unknown.length - UNKNOWN_SHOWN} more` : ""
      }); pages define their own globals, so this is a read, not a leak.`,
    );
  }

  if (input.baseline?.note) notes.push(input.baseline.note);

  const excluded =
    input.hits.filter((hit) => hit.devRuntime).length + input.probed.filter((probe) => probe.ok && probe.devRuntime).length;
  if (excluded > 0) notes.push(devRuntimeTrailer(excluded, input.session));

  return notes;
}

function leaks(input: VerdictInput): string[] {
  const out: string[] = [];
  const hits = input.hits.filter((hit) => !hit.devRuntime);
  const refs = input.world.refs;

  if (hits.length > 0) {
    out.push(
      `${plural(hits.length, "DOM reference")} to its id (${hits.slice(0, 3).map(hitText).join(", ")}${
        hits.length > 3 ? ", and more in evidence.dom.hits" : ""
      })`,
    );
  }

  if (input.symbols.attributed.length > 0) {
    out.push(
      `${plural(input.symbols.attributed.length, "symbol marker")} on window naming the extension (${input.symbols.attributed
        .map((description) => `Symbol(${description})`)
        .join(", ")})`,
    );
  }

  if (refs.length > 0) {
    out.push(
      `${plural(refs.length, "window global")} naming the extension (${refs
        .slice(0, 3)
        .map((ref) => (ref.where === "name" ? ref.name : `${ref.name} = "${ref.value}"`))
        .join(", ")}${refs.length > 3 ? ", and more in evidence.globals.refs" : ""})`,
    );
  }

  for (const probe of input.probed) {
    if (!probe.ok || probe.devRuntime) continue;

    out.push(
      `web_accessible_resources[${probe.index}] answers ${probe.status ?? "ok"} at ${probe.url} fetched from the page (matches: ${probe.matches.join(", ")}), so the extension is fingerprintable by url guessing`,
    );
  }

  return out;
}

export function pageWorldVerdict(input: VerdictInput): CheckResult {
  const notes = warnings(input);
  const trailer = notes.length ? ` ${notes.join(" ")}` : "";
  const found = leaks(input);

  if (found.length > 0) {
    return failCheck(
      input.id,
      input.subject,
      `The main world of ${input.url} can tell the extension is installed: ${found.join("; ")}.${trailer}`,
      input.evidence,
    );
  }

  const shipped = input.probed.filter((probe) => !probe.devRuntime);
  const { world } = input;

  return passCheck(
    input.id,
    input.subject,
    `Nothing in the main world of ${input.url} names the extension: ${count(world.dom.bytes)} bytes of outerHTML over ${count(world.dom.elements)} elements (${plural(world.dom.shadowRoots, "open shadow root")}) hold no occurrence of ${input.extensionId}, ${plural(world.ownNames.length, "own window property", "own window properties")} carry no symbol marker naming it and none names the extension, and ${plural(shipped.length, "static web_accessible_resources path")} fetched from the page ${
      shipped.length === 0 ? "were declared, so there was nothing to guess" : `${shipped.length === 1 ? "was" : "were"} refused (${shipped.map((probe) => probe.path).join(", ")})`
    }.${trailer}`,
    input.evidence,
  );
}
