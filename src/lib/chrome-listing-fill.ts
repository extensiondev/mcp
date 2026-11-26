// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CHROME_JUSTIFICATION_LIMIT, TAB_LABELS, type ChromeTab } from "./chrome-dashboard-agent";
import { stillSame, type PlanFile } from "./chrome-listing-plan";

import type { ChromeRun, Row, StepDeps } from "./chrome-listing-run";

const IMAGE_WAIT_MS = 30_000;
const POLL_MS = 1000;

export function addRow(run: ChromeRun, row: Row): void {
  if (!run.rows.some((have) => have.line === row.line)) run.rows.push(row);
}

async function until(deps: StepDeps, test: () => Promise<boolean>, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += POLL_MS) {
    if (await test()) return true;

    await deps.sleep(POLL_MS);
  }

  return test();
}

async function typeInto(deps: StepDeps, anchors: string[], value: string): Promise<boolean> {
  if (!(await deps.page.call<boolean>("focusText", anchors))) return false;

  await deps.page.type(value);

  const read = await deps.page.call<{ found: boolean; value?: string }>("fieldRead", anchors);

  return read.found && read.value === value;
}

export const chars = (n: number): string => n.toLocaleString("en-US");

export async function fillText(run: ChromeRun, deps: StepDeps, id: string, anchors: string[], value: string, tab: ChromeTab, label: string): Promise<void> {
  const outcome = await deps.page.call<string>("setText", anchors, value);

  if (outcome === "filled" || outcome === "unchanged" || (outcome === "needs-typing" && (await typeInto(deps, anchors, value)))) {
    run.filled.push(label);

    return;
  }

  if (outcome === "too-long") {
    const read = await deps.page.call<{ limit?: number }>("fieldRead", anchors);

    addRow(run, { tab, line: `${label} on ${TAB_LABELS[tab]}: the text is ${chars(value.length)} characters and the field takes at most ${chars(read?.limit ?? 0)}, so nothing was typed; shorten it in STORE.md` });

    return;
  }

  addRow(run, { tab, line: `${label} on ${TAB_LABELS[tab]}: ${outcome === "missing" ? "no single field for it was found" : "the field did not take the text"}; paste it from STORE.md` });
}

export async function fillChoice(run: ChromeRun, deps: StepDeps, id: string, anchors: string[], wanted: string[], tab: ChromeTab, label: string): Promise<void> {
  let why = "";

  for (const value of wanted) {
    const chosen = await deps.page.call<{ outcome: string; x?: number; y?: number }>("choose", anchors, value);

    if (chosen.outcome === "filled" || chosen.outcome === "unchanged") {
      run.filled.push(label);

      return;
    }

    if (chosen.outcome === "open" && chosen.x !== undefined && chosen.y !== undefined) {
      await deps.page.click(chosen.x, chosen.y);
      await deps.sleep(500);

      const at = await deps.page.call<{ x?: number; y?: number; found?: number; seen?: string[] } | null>("option", value);

      if (at && typeof at.x === "number" && typeof at.y === "number") {
        await deps.page.click(at.x, at.y);
        await deps.sleep(300);

        const read = await deps.page.call<{ found: boolean; value?: string }>("fieldRead", anchors);

        if (read.found && String(read.value ?? "").toLowerCase().includes(value.toLowerCase())) {
          run.filled.push(label);

          return;
        }

        why ||= `"${value}" was picked and the control still reads "${String(read.value ?? "")}"`;
      } else {
        const seen = at?.seen ?? [];

        why ||= `the open list shows ${at?.found ? `${at.found} options` : "no option"} reading "${value}"${seen.length ? ` (it shows ${seen.map((row) => `"${row}"`).join(", ")})` : ""}`;
      }
    }

    if (chosen.outcome === "missing") {
      why ||= `no single control labeled ${label} was found`;
      break;
    }

    if (chosen.outcome === "no-option") why ||= `the list has no option reading "${value}"`;
    if (chosen.outcome === "not-editable") why ||= "the dashboard keeps it disabled";
  }

  addRow(run, { tab, line: `${label} on ${TAB_LABELS[tab]}: choose ${wanted[0]} yourself${why ? `; ${why}` : ""}` });
}

async function shownMore(deps: StepDeps, slot: "icon" | "screenshots", before: number): Promise<{ more: boolean; count: number }> {
  let count = before;
  const more = await until(deps, async () => (count = await deps.page.call<number>("thumbs", slot)) > before, IMAGE_WAIT_MS);

  return { more, count };
}

export async function attach(run: ChromeRun, deps: StepDeps, slot: "icon" | "screenshots", files: PlanFile[], label: string): Promise<void> {
  if (!files.length) {
    addRow(run, { tab: "listing", line: `${label} on Store listing: the project has none to upload; add ${slot === "icon" ? "a 128x128 icon" : "a 1280x800 screenshot"} on the store card` });

    return;
  }

  let count = await deps.page.call<number>("thumbs", slot);

  if (count < 0) {
    addRow(run, { tab: "listing", line: `${label} on Store listing: no single upload slot was found` });

    return;
  }

  if (slot === "icon" && count > 0) {
    await replaceIcon(run, deps, files[0]!, label);

    return;
  }

  if (slot === "screenshots" && count > 0) {
    const kept = files.slice(0, count).map((file) => file.name);

    if (kept.length) addRow(run, { tab: "listing", line: `${label} on Store listing: the slot already holds ${count} image${count === 1 ? "" : "s"}, so ${kept.join(", ")} ${kept.length === 1 ? "was" : "were"} not attached again; extension.dev tools never removes an image, so remove the old ones on the page and attach ${kept.length === 1 ? "it" : "them"} yourself if they differ` });
  }

  for (const file of files.slice(count)) {
    if (!stillSame(file)) {
      addRow(run, { tab: "listing", line: `${label} on Store listing: ${file.name} changed on disk after its check, so it was not set` });
      continue;
    }

    const input = await deps.page.handle("fileInput", slot);

    if (!input) {
      addRow(run, { tab: "listing", line: `${label} on Store listing: no single upload slot was found` });

      return;
    }

    await deps.page.setFiles(input, [file.path]);

    const landed = await shownMore(deps, slot, count);

    count = landed.count;

    if (landed.more) run.filled.push(`${label}: ${file.name}`);
    else addRow(run, { tab: "listing", line: `${label} on Store listing: ${file.name} did not show as a thumbnail within 30 seconds` });
  }
}

async function replaceIcon(run: ChromeRun, deps: StepDeps, file: PlanFile, label: string): Promise<void> {
  if (!stillSame(file)) {
    addRow(run, { tab: "listing", line: `${label} on Store listing: ${file.name} changed on disk after its check, so it was not set` });

    return;
  }

  const before = (await deps.page.call<string[] | null>("images", "icon")) ?? [];
  const input = await deps.page.handle("fileInput", "icon");

  if (!input) {
    addRow(run, { tab: "listing", line: `${label} on Store listing: the slot already holds an icon and shows no upload input to replace it; replace it with ${file.name} yourself` });

    return;
  }

  await deps.page.setFiles(input, [file.path]);

  let after: string[] = before;
  const changed = await until(deps, async () => {
    after = (await deps.page.call<string[] | null>("images", "icon")) ?? [];

    return after.length > 0 && after.some((src) => !before.includes(src));
  }, IMAGE_WAIT_MS);

  if (changed) run.filled.push(`${label}: ${file.name} (replaced the icon the item had)`);
  else addRow(run, { tab: "listing", line: `${label} on Store listing: the slot already holds an icon and ${file.name} did not replace it within 30 seconds; replace it yourself` });
}

export function fitHostLines(lines: Array<{ permission: string; text: string }>, limit: number = CHROME_JUSTIFICATION_LIMIT): { kept: Array<{ permission: string; text: string }>; left: string[]; length: number } {
  const joined = (rows: Array<{ permission: string; text: string }>) => rows.map((row) => `${row.permission}: ${row.text}`).join("\n");
  const kept: Array<{ permission: string; text: string }> = [];
  const left: string[] = [];

  for (const line of lines) {
    if (joined([...kept, line]).length <= limit) kept.push(line);
    else left.push(line.permission);
  }

  return { kept, left, length: joined(lines).length };
}

export const isHostPattern = (permission: string): boolean => /:\/\/|^<all_urls>$|^\*/.test(permission);
