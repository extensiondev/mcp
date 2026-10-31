// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface ReleaseTypeChange {
  from: string;
  to: string;
}

export interface ReleaseTypeChangeRefused {
  from: string;
  to: string;
  text: string;
}

export interface ReleaseChange {
  releaseTypeChanged?: ReleaseTypeChange;
  releaseTypeChangeRefused?: ReleaseTypeChangeRefused;
}

function str(value: unknown): string | undefined {
  const text = String(value ?? "").trim();

  return text || undefined;
}

function changeOf(raw: unknown): ReleaseTypeChange | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const row = raw as Record<string, unknown>;
  const from = str(row.from)?.toUpperCase();
  const to = str(row.to)?.toUpperCase();

  return from && to ? { from, to } : undefined;
}

function refusalOf(raw: unknown): ReleaseTypeChangeRefused | undefined {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const text = row ? str(row.text) : str(raw);
  if (!text) return undefined;

  return { from: (row && str(row.from)?.toUpperCase()) || "AFTER_APPROVAL", to: (row && str(row.to)?.toUpperCase()) || "MANUAL", text };
}

export function releaseChangeOfRow(publish: Record<string, unknown> | null): ReleaseChange {
  const releaseTypeChanged = publish ? changeOf(publish.releaseTypeChanged) : undefined;
  const releaseTypeChangeRefused = publish ? refusalOf(publish.releaseTypeChangeRefused) : undefined;

  return { ...(releaseTypeChanged ? { releaseTypeChanged } : {}), ...(releaseTypeChangeRefused ? { releaseTypeChangeRefused } : {}) };
}

const RELEASE_TYPE_NAMES: Record<string, string> = {
  AFTER_APPROVAL: "release after approval",
  MANUAL: "manual release",
  SCHEDULED: "a scheduled release",
};

function releaseTypeName(type: string): string {
  return RELEASE_TYPE_NAMES[type] ?? type;
}

export function releaseChangeSentence(view: ReleaseChange | undefined): string {
  if (view?.releaseTypeChanged) {
    return `set from ${releaseTypeName(view.releaseTypeChanged.from)} to ${releaseTypeName(view.releaseTypeChanged.to)} by the review act`;
  }

  if (view?.releaseTypeChangeRefused) {
    return `Apple refused to set it to ${releaseTypeName(view.releaseTypeChangeRefused.to)}: ${view.releaseTypeChangeRefused.text}`;
  }

  return "";
}
