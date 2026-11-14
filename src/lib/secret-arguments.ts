// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { CONNECT_STORE_NAMES, type ConnectStore } from "./connect-stores";
import { envelope } from "./envelope";

export type SecretKind = "private-key" | "amo-jwt-issuer" | "amo-jwt-secret" | "google-client-secret" | "google-token" | "named-secret";

interface Shape {
  kind: SecretKind;
  store: ConnectStore | null;
  test: RegExp;
}

const SHAPES: Shape[] = [
  { kind: "private-key", store: "safari", test: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: "amo-jwt-issuer", store: "firefox", test: /\buser:\d+:\d+\b/ },
  { kind: "google-client-secret", store: "chrome", test: /\bGOCSPX-[A-Za-z0-9_-]{10,}/ },
  { kind: "google-token", store: "chrome", test: /\bya29\.[A-Za-z0-9_-]{20,}|\b1\/\/0[A-Za-z0-9_-]{20,}/ },
];

const SECRET_KEY_NAME = /^(?:jwt_?secret|api_?secret|client_?secret|api_?key|private_?key|refresh_?token|access_?token|password|secret|asc_?key_?p8|p8)$/i;

const HEX_SECRET = /^[0-9a-f]{64}$/i;

const OWN_REFUSAL = new Set(["storeSettings"]);

const MAX_DEPTH = 6;

export interface SecretHit {
  path: string;
  kind: SecretKind;
  store: ConnectStore | null;
}

function walk(value: unknown, path: string, depth: number, hits: SecretHit[], hexPaths: string[], names = true): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;

  if (typeof value === "string") {
    const shape = SHAPES.find((candidate) => candidate.test.test(value));
    if (shape) hits.push({ path, kind: shape.kind, store: shape.store });
    else if (HEX_SECRET.test(value.trim())) hexPaths.push(path);

    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1, hits, hexPaths, names));

    return;
  }

  if (typeof value !== "object") return;

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const at = path ? `${path}.${key}` : key;

    if (names && SECRET_KEY_NAME.test(key) && typeof item === "string" && item.trim()) {
      hits.push({ path: at, kind: "named-secret", store: null });
      continue;
    }

    walk(item, at, depth + 1, hits, hexPaths, names && !(depth === 0 && OWN_REFUSAL.has(key)));
  }
}

export function findSecretArguments(args: Record<string, unknown>): SecretHit[] {
  const hits: SecretHit[] = [];
  const hexPaths: string[] = [];

  walk(args, "", 0, hits, hexPaths);

  if (hits.some((hit) => hit.kind === "amo-jwt-issuer")) {
    for (const path of hexPaths) hits.push({ path, kind: "amo-jwt-secret", store: "firefox" });
  }

  return hits;
}

export function secretArgumentRefusal(tool: string, args: Record<string, unknown>): string | null {
  const hits = findSecretArguments(args);
  if (!hits.length) return null;

  const store = hits.find((hit) => hit.store)?.store ?? null;
  const paths = [...new Set(hits.map((hit) => hit.path))];
  const kinds = [...new Set(hits.map((hit) => hit.kind))];
  const connectCall = `extension_submit {action: "connect", store: "${store ?? "<store>"}"}`;
  const name = store ? CONNECT_STORE_NAMES[store] : "the store";
  const say = `That looks like a store key, so this call was refused and nothing was sent or stored. Store keys go from your clipboard or file straight to extension.dev on the connect page, never through the chat: I can open it with ${connectCall}. Because this key has now passed through the chat, rotate it in ${name} and paste the new one on that page.`;

  return envelope({
    ok: false,
    command: tool,
    status: "credentials-console-only",
    value: {
      refusedArguments: paths,
      kinds,
      ...(store ? { store } : {}),
      connectCall,
      rotate: true,
      sayToPerson: say,
      nextStep: { kind: "connect", say, url: null },
    },
    error: {
      code: "E_CONSOLE_ONLY",
      name: "SecretArgumentRefused",
      message: `${paths.map((path) => `"${path}"`).join(", ")} carries what reads as store key material, which this server never takes, stores or forwards. Nothing was sent.`,
    },
    hint: say,
  });
}
