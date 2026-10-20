// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

type Row = Record<string, unknown>;

export interface ApprovalSubject {
  extension: string;
  version?: string;
  storeVersion?: string;
  buildSha?: string;
  store?: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function readApprovalSubject(raw: unknown): ApprovalSubject | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const row = raw as Row;
  const extension = text(row.extension);

  if (!extension) return null;

  return {
    extension,
    ...(text(row.version) ? { version: text(row.version) } : {}),
    ...(text(row.storeVersion) ? { storeVersion: text(row.storeVersion) } : {}),
    ...(text(row.buildSha) ? { buildSha: text(row.buildSha) } : {}),
    ...(text(row.store) ? { store: text(row.store) } : {}),
  };
}

export function approvalSubjectPhrase(subject: ApprovalSubject | null): string {
  if (!subject) return "";

  const name = subject.version ? `${subject.extension} ${subject.version}` : subject.extension;

  return subject.buildSha ? `${name}, build ${subject.buildSha}` : name;
}

export function subjectOf(value: Row): ApprovalSubject | null {
  return readApprovalSubject(value.subject);
}
