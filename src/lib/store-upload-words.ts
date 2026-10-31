// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


import type { StoreUpload } from "./platform-submissions";

const STORE_NAMES: Record<string, string> = {
  chrome: "the Chrome Web Store",
  edge: "Edge Add-ons",
  firefox: "Firefox AMO",
  safari: "App Store Connect",
};

const REFUSED_WORDS: ReadonlySet<string> = new Set(["FAILED", "FAILURE"]);
const TAKEN_WORDS: ReadonlySet<string> = new Set(["SUCCEEDED", "SUCCESS"]);
const PENDING_WORDS: ReadonlySet<string> = new Set(["INPROGRESS", "PENDING"]);

export function uploadWordOf(upload: StoreUpload | undefined): string {
  return String(upload?.state ?? "").replace(/[\s_-]/g, "").toUpperCase();
}

export function uploadRefused(upload: StoreUpload | undefined): boolean {
  return REFUSED_WORDS.has(uploadWordOf(upload));
}

export function uploadTaken(upload: StoreUpload | undefined): boolean {
  return TAKEN_WORDS.has(uploadWordOf(upload));
}

export function uploadPending(upload: StoreUpload | undefined): boolean {
  return PENDING_WORDS.has(uploadWordOf(upload));
}

function storeName(store: string): string {
  const name = STORE_NAMES[store] ?? store;

  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function packageRefusedSentence(store: string, upload: StoreUpload | undefined): string {
  if (!uploadRefused(upload)) return "";

  const message = String(upload?.message ?? "").trim().replace(/[.\s]+$/, "");

  return message
    ? `${storeName(store)} refused the package: ${message}`
    : `${storeName(store)} refused the package (${upload?.state ?? "FAILED"}, no reason given)`;
}

export function storeUploadSentence(store: string, upload: StoreUpload | undefined): string {
  if (!upload) return "";
  if (uploadRefused(upload)) return packageRefusedSentence(store, upload);
  if (uploadTaken(upload)) return `${storeName(store)} took the package (${upload.state})`;
  if (uploadPending(upload)) return `${storeName(store)} is still processing the package (${upload.state})`;

  return "";
}

export function failureLineOf(store: string, upload: StoreUpload | undefined, failureReason: string): string {
  const refused = packageRefusedSentence(store, upload);
  if (refused) return `${store}: ${refused}`;

  return `${store}: ${failureReason.trim() || "the store run failed"}`;
}
