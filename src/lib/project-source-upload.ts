// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { identityHeaders } from "./session-identity";

export const SOURCE_TOO_LARGE_CODE = "SOURCE_TOO_LARGE";

export const SOURCE_UPLOAD_CONSUMED_CODE = "SOURCE_UPLOAD_CONSUMED";

export function projectCreateUrl(apiBase: string): string {
  return `${apiBase}/api/cli/projects/create`;
}

export function projectSourceUploadUrl(apiBase: string): string {
  return `${apiBase}/api/cli/projects/source`;
}

export interface SourceUploadReceipt {
  uploadId: string;
  bytes: number;
  files: number;
  manifest: { name: string; version: string };
  expiresAt: string;
}

export type SourceUploadOutcome =
  | { ok: true; receipt: SourceUploadReceipt; body: Record<string, unknown> }
  | { ok: false; kind: "network"; message: string }
  | { ok: false; kind: "unreadable"; status: number; message: string }
  | { ok: false; kind: "refused"; status: number; code: string; message: string; body: Record<string, unknown>; res: Response };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

export function readUploadReceipt(body: unknown): { ok: true; receipt: SourceUploadReceipt } | { ok: false; why: string } {
  const record = asRecord(body);
  if (!record) return { ok: false, why: "the answer was not a JSON object" };

  const uploadId = text(record.uploadId);
  if (!uploadId) return { ok: false, why: "the answer named no uploadId" };

  const manifest = asRecord(record.manifest);

  return {
    ok: true,
    receipt: {
      uploadId,
      bytes: Number(record.bytes) || 0,
      files: Number(record.files) || 0,
      manifest: { name: text(manifest?.name), version: text(manifest?.version) },
      expiresAt: text(record.expiresAt),
    },
  };
}

export async function uploadProjectSource(options: {
  apiBase: string;
  token: string;
  zip: Buffer;
  command: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<SourceUploadOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let res: Response;

  try {
    res = await fetchImpl(projectSourceUploadUrl(options.apiBase), {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/zip",
        ...identityHeaders(options.command),
      },
      body: new Uint8Array(options.zip),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err: any) {
    return { ok: false, kind: "network", message: err?.message || String(err) };
  }

  let raw: string;

  try {
    raw = await res.text();
  } catch (err: any) {
    return { ok: false, kind: "unreadable", status: res.status, message: err?.message || String(err) };
  }

  let body: Record<string, unknown>;

  try {
    body = asRecord(JSON.parse(raw)) ?? { message: raw };
  } catch {
    body = { message: raw };
  }

  if (!res.ok) {
    return {
      ok: false,
      kind: "refused",
      status: res.status,
      code: text(body.code),
      message: text(body.message) || text(body.error) || raw.slice(0, 300) || `upload failed (${res.status})`,
      body,
      res,
    };
  }

  const receipt = readUploadReceipt(body);

  if (!receipt.ok) return { ok: false, kind: "unreadable", status: res.status, message: receipt.why };

  return { ok: true, receipt: receipt.receipt, body };
}
