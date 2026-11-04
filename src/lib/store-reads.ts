// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface StoreReadView {
  word: string;
  readAt: string;
  source: string;
  state: string;
  visibility?: string;
  crxVersion?: string;
  liveState?: string;
  liveCrxVersion?: string;
  versionState?: string;
  reviewSubmissionState?: string;
}

export const STORE_READS_MAX = 50;

const DETAIL_FIELDS = ["visibility", "crxVersion", "liveState", "liveCrxVersion", "versionState", "reviewSubmissionState"] as const;

function str(value: unknown): string | undefined {
  const text = String(value ?? "").trim();

  return text || undefined;
}

export function storeReadOf(raw: unknown): StoreReadView | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const row = raw as Record<string, unknown>;
  const word = str(row.word)?.toLowerCase();
  const readAt = str(row.readAt);
  const source = str(row.source);
  const state = str(row.state);
  if (!word || !readAt || !source || !state || !Number.isFinite(Date.parse(readAt))) return undefined;

  const out: StoreReadView = { word, readAt, source, state };

  for (const key of DETAIL_FIELDS) {
    const text = str(row[key]);
    if (text) out[key] = text;
  }

  return out;
}

export function storeReadsOf(raw: unknown): StoreReadView[] | undefined {
  const reads = (Array.isArray(raw) ? raw : []).map(storeReadOf).filter((read): read is StoreReadView => Boolean(read));

  if (reads.length === 0) return undefined;
  if (reads.length <= STORE_READS_MAX) return reads;

  return [reads[0]!, ...reads.slice(reads.length - (STORE_READS_MAX - 1))];
}
