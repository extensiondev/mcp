// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { browserBuildSettingsUrl, browserBuildVerdict, readBrowserBuilds, type BrowserBuildRead, type BrowserBuildVerdict } from "./browser-builds";
import { projectApiGet, type ProjectApi } from "./project-api";
import { type ProjectRef } from "./registry";
import { MINT_CALL } from "./safari-app-record-step";
import { isRow, text } from "./ship-act";

import type { RequirementRow } from "./store-requirements";

type Row = Record<string, unknown>;

export const BUNDLE_ID_REGISTERED_ROW = "safari.bundle_id_registered";

export const browserBuildsRowId = (store: string): string => `${store}.browser_builds`;

const NAMES: Record<string, string> = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", safari: "Safari" };

interface Context {
  ref: ProjectRef | null;
  api?: string;
}

export interface BuildReadiness {
  verdicts: Record<string, BrowserBuildVerdict>;
  rows: Record<string, RequirementRow[]>;
}

export function browserBuildsRow(store: string, read: BrowserBuildRead | undefined, ctx: Context): RequirementRow | null {
  if (!read || read.enabled === null) return null;

  const name = NAMES[store] ?? store;
  const off = browserBuildVerdict({ ...read, artifact: null }, ctx);

  return {
    id: browserBuildsRowId(store),
    label: `${name} builds are on under Browser builds`,
    required: true,
    format: "the project's Browser builds setting",
    status: off ? "missing" : "have",
    satisfiedBy: "build-settings",
    how: off ? off.fix : `On under Browser builds at ${browserBuildSettingsUrl(ctx)}.`,
    actual: off ? off.reason : `${name} builds are on for this project.`,
  };
}

export function bundleIdRegisteredRow(config: unknown): RequirementRow | null {
  const safari = isRow(config) && isRow(config.safari) ? config.safari : null;
  if (!safari) return null;

  const bundleId = text(safari.bundleId);

  return {
    id: BUNDLE_ID_REGISTERED_ROW,
    label: "Bundle id saved for registration with Apple",
    required: true,
    format: "a reverse-DNS bundle id saved on the Safari store settings",
    status: bundleId ? "have" : "missing",
    satisfiedBy: "store-config: bundleId",
    how: bundleId
      ? `Registration is checked at mint: ${MINT_CALL} registers it with your Apple team.`
      : `Save one with extension_submit {action: "configure-store", store: "safari", storeSettings: {bundleId: "<id>"}}, then ${MINT_CALL} registers it; registration is checked at mint.`,
    actual: bundleId ? `${bundleId} is configured; registration is checked at mint` : "no bundle id is saved on the Safari store settings; registration is checked at mint",
  };
}

export async function readBuildReadiness(api: ProjectApi, stores: string[], buildSha: string, ctx: Context): Promise<BuildReadiness> {
  const [read, config] = await Promise.all([
    readBrowserBuilds(api, stores, buildSha),
    stores.includes("safari") ? projectApiGet<Row>(api, "stores/config").catch(() => null) : Promise.resolve(null),
  ]);
  const verdicts: Record<string, BrowserBuildVerdict> = {};
  const rows: Record<string, RequirementRow[]> = {};

  for (const store of stores) {
    const verdict = browserBuildVerdict(read[store], ctx);
    if (verdict) verdicts[store] = verdict;

    const bundle = store === "safari" && config?.ok ? bundleIdRegisteredRow(config.json) : null;
    rows[store] = [browserBuildsRow(store, read[store], ctx), bundle].filter((row): row is RequirementRow => row !== null);
  }

  return { verdicts, rows };
}

export function withBuildReadinessRows(view: Row, rows: RequirementRow[] | undefined): Row {
  const requirements = isRow(view.requirements) && Array.isArray(view.requirements.items) ? view.requirements : null;
  if (!requirements || !rows?.length) return view;

  const ids = new Set(rows.map((row) => row.id));
  const replaced = (requirements.items as unknown[]).filter((item): item is Row => isRow(item) && ids.has(text(item.id)));
  const items = [...(requirements.items as unknown[]).filter((item) => !replaced.includes(item as Row)), ...rows];
  const missing = (list: Row[], required: boolean) => list.filter((item) => item.status !== "have" && (item.required === true) === required).length;
  const count = (value: unknown, required: boolean) => (typeof value === "number" ? value : 0) + missing(rows as unknown as Row[], required) - missing(replaced, required);

  return { ...view, requirements: { ...requirements, items, missingRequired: count(requirements.missingRequired, true), missingOptional: count(requirements.missingOptional, false) } };
}
