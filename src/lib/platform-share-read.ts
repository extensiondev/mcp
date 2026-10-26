// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { missedRead, type RecordRead } from "./act-outcome";
import { platformFetch } from "./platform-fetch";
import { identityHeaders } from "./session-identity";

export interface ShareRecord {
  id: string;
  expiresAt: string | null;
}

export async function readShareRecord(args: {
  base: string;
  id: string;
  ref: { workspace: string; project: string };
  buildSha?: string;
}): Promise<RecordRead<ShareRecord>> {
  const url = new URL(`${args.base}/api/public/share/${encodeURIComponent(args.id)}`);
  url.searchParams.set("workspace", args.ref.workspace);
  url.searchParams.set("project", args.ref.project);
  if (args.buildSha) url.searchParams.set("build", args.buildSha);

  const sent = await platformFetch(url.toString(), {
    headers: { accept: "application/json", ...identityHeaders("extension_publish") },
  });

  if (!sent.ok) return { ok: false, message: sent.unreached.message, transient: true };

  const res = sent.res;

  if (res.status === 404) return { ok: true, record: null };

  let body: Record<string, unknown> | null = null;

  try {
    const parsed: unknown = JSON.parse(await res.text());
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }

  if (!res.ok || !body) return missedRead({ status: res.status, message: `${url.origin}${url.pathname} answered ${res.status}` });

  const epoch = typeof body.expiresAt === "number" ? body.expiresAt : Number(body.expiresAt);
  const expiresAt = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString() : null;

  return { ok: true, record: { id: args.id, expiresAt } };
}
