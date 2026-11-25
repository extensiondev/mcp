// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { holdsSecret, isInstallConfig, isSecretFile, SECRET_FOLDERS } from "./source-archive";

export const LOCAL_BUILD_CONTRACT = "extension-dev-local-build-v1";

export const LOCAL_BUILD_ORIGIN = "https://preview.extension.dev";

export const LOCAL_BUILD_KEY_HEADER = "x-extension-dev-local-key";

export const LOCAL_BUILD_TOKEN_HEADER = "x-extension-dev-local-token";

export const LOCAL_BUILD_LIMITS = {
  files: 500,
  bytes: 25 * 1024 * 1024,
  keyMs: 10 * 60 * 1000,
  tokenMs: 15 * 60 * 1000,
  lifeMs: 20 * 60 * 1000,
  idleMs: 5 * 60 * 1000,
  wrongKeys: 5,
} as const;

const SKIPPED_NAMES = new Set(["node_modules", ".git", ".DS_Store", "__MACOSX"]);

const FILES_PREFIX = "/v1/files/";

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

const VARY = "Origin, Access-Control-Request-Private-Network, Access-Control-Request-Headers";

interface ListedFile {
  absolute: string;
  size: number;
}

export type LocalBuildListing =
  | { ok: true; files: Map<string, ListedFile>; bytes: number; leftOut: string[] }
  | { ok: false; reason: "too-many-files" | "too-large" | "empty" | "unreadable"; message: string };

export type LocalBuildStart =
  | { ok: true; server: LocalBuildServer }
  | { ok: false; stage: "list"; reason: string; message: string }
  | { ok: false; stage: "bind"; code: string };

export function isSafeLocalBuildPath(value: string): boolean {
  if (!value || value.length > 1024) return false;

  if (value.startsWith("/") || value.includes("\\") || value.includes("%")) return false;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 0x20 || code === 0x7f) return false;
  }

  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function listLocalBuild(distDir: string): LocalBuildListing {
  const files = new Map<string, ListedFile>();
  const leftOut: string[] = [];
  let bytes = 0;
  let over: "too-many-files" | "too-large" | null = null;

  const walk = (dir: string, prefix: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (over) return;

      if (SKIPPED_NAMES.has(name)) continue;

      const absolute = path.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(absolute);

      if (stat.isSymbolicLink() || !isSafeLocalBuildPath(relative)) continue;

      if (stat.isDirectory()) {
        if (SECRET_FOLDERS.includes(name)) {
          leftOut.push(`${relative}/`);
          continue;
        }

        walk(absolute, relative);
        continue;
      }

      if (!stat.isFile()) continue;

      if (isSecretFile(name) || isInstallConfig(name) || holdsSecret(name, absolute, stat.size)) {
        leftOut.push(relative);
        continue;
      }

      files.set(relative, { absolute, size: stat.size });
      bytes += stat.size;

      if (files.size > LOCAL_BUILD_LIMITS.files) over = "too-many-files";
      else if (bytes > LOCAL_BUILD_LIMITS.bytes) over = "too-large";
    }
  };

  try {
    walk(distDir, "");
  } catch {
    return { ok: false, reason: "unreadable", message: `The build folder ${distDir} could not be read.` };
  }

  if (over === "too-many-files") {
    return {
      ok: false,
      reason: over,
      message: `The build holds more than ${LOCAL_BUILD_LIMITS.files} files, over what a local preview reads.`,
    };
  }

  if (over === "too-large") {
    return { ok: false, reason: over, message: "The build is over the 25 MB a local preview reads." };
  }

  if (files.size === 0) {
    return { ok: false, reason: "empty", message: `The build folder ${distDir} holds no file a local preview can read.` };
  }

  return { ok: true, files, bytes, leftOut };
}

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function matches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;

  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function secret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function singleHost(req: http.IncomingMessage): string | null {
  let found: string | null = null;

  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]!.toLowerCase() !== "host") continue;

    if (found !== null) return null;

    found = req.rawHeaders[index + 1] ?? "";
  }

  return found;
}

function decodePath(raw: string): string | null {
  const segments = raw.split("/");
  const decoded: string[] = [];

  for (const segment of segments) {
    let value: string;

    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }

    if (value.includes("/")) return null;

    decoded.push(value);
  }

  const joined = decoded.join("/");

  return isSafeLocalBuildPath(joined) ? joined : null;
}

export class LocalBuildServer {
  readonly port: number;
  readonly startedAt: number;
  readonly keyExpiresAt: number;
  readonly closesBy: number;
  readonly files: number;
  readonly bytes: number;
  readonly leftOut: string[];
  readonly closed: Promise<void>;

  #key: string;
  #keySpent = false;
  #wrongKeys = 0;
  #token: string | null = null;
  #tokenExpiresAt = 0;
  #listing: Map<string, ListedFile> | null = null;
  #root: string;
  #distDir: string;
  #name: string;
  #server: http.Server;
  #lifeTimer: NodeJS.Timeout;
  #idleTimer: NodeJS.Timeout | null = null;
  #resolveClosed!: () => void;
  #closing = false;

  constructor(server: http.Server, port: number, distDir: string, name: string, listing: Extract<LocalBuildListing, { ok: true }>) {
    this.#server = server;
    this.port = port;
    this.#distDir = distDir;
    this.#root = fs.realpathSync(distDir);
    this.#name = name;
    this.#key = secret();
    this.startedAt = Date.now();
    this.keyExpiresAt = this.startedAt + LOCAL_BUILD_LIMITS.keyMs;
    this.closesBy = this.startedAt + LOCAL_BUILD_LIMITS.lifeMs;
    this.files = listing.files.size;
    this.bytes = listing.bytes;
    this.leftOut = listing.leftOut;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });

    this.#lifeTimer = setTimeout(() => void this.close(), LOCAL_BUILD_LIMITS.lifeMs);
    this.#lifeTimer.unref();
    server.on("request", (req, res) => this.#answer(req, res));
  }

  get address(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  fragment(): string {
    return `k=${this.#key}`;
  }

  close(): Promise<void> {
    if (this.#closing) return this.closed;

    this.#closing = true;
    clearTimeout(this.#lifeTimer);

    if (this.#idleTimer) clearTimeout(this.#idleTimer);

    this.#keySpent = true;
    this.#token = null;
    this.#listing = null;
    this.#server.close(() => this.#resolveClosed());
    this.#server.closeAllConnections();

    return this.closed;
  }

  #touch(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);

    this.#idleTimer = setTimeout(() => void this.close(), LOCAL_BUILD_LIMITS.idleMs);
    this.#idleTimer.unref();
  }

  #answer(req: http.IncomingMessage, res: http.ServerResponse): void {
    const send = (status: number, headers: Record<string, string> = {}, body?: string | Buffer): void => {
      res.writeHead(status, { ...BASE_HEADERS, ...headers });
      res.end(body);
    };

    if (this.#closing) return send(410);

    const host = singleHost(req);

    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return send(403);

    if (req.headers.origin !== LOCAL_BUILD_ORIGIN) return send(403);

    const cors = { "access-control-allow-origin": LOCAL_BUILD_ORIGIN, vary: VARY };

    if (req.method === "OPTIONS") {
      const asked = req.headers["access-control-request-method"];

      if (asked !== undefined && asked !== "GET") return send(405);

      const privateNetwork: Record<string, string> =
        req.headers["access-control-request-private-network"] === "true"
          ? { "access-control-allow-private-network": "true" }
          : {};

      return send(204, {
        ...cors,
        ...privateNetwork,
        "access-control-allow-methods": "GET",
        "access-control-allow-headers": `${LOCAL_BUILD_KEY_HEADER}, ${LOCAL_BUILD_TOKEN_HEADER}`,
        "access-control-max-age": "60",
      });
    }

    if (req.method !== "GET") return send(405);

    const url = req.url ?? "";

    if (url === "/v1/build") return this.#mint(req, cors, send);

    if (url.startsWith(FILES_PREFIX) && !url.includes("?") && !url.includes("#")) {
      return this.#serveFile(req, res, url.slice(FILES_PREFIX.length), cors, send);
    }

    return send(404, cors);
  }

  #mint(
    req: http.IncomingMessage,
    cors: Record<string, string>,
    send: (status: number, headers?: Record<string, string>, body?: string) => void,
  ): void {
    if (this.#keySpent || Date.now() >= this.keyExpiresAt) return send(410, cors);

    if (!matches(req.headers[LOCAL_BUILD_KEY_HEADER], this.#key)) {
      this.#wrongKeys += 1;

      if (this.#wrongKeys >= LOCAL_BUILD_LIMITS.wrongKeys) this.#keySpent = true;

      return send(401, cors);
    }

    this.#keySpent = true;

    const listing = listLocalBuild(this.#distDir);

    if (!listing.ok) return send(413, cors);

    this.#listing = listing.files;
    this.#token = secret();
    this.#tokenExpiresAt = Date.now() + LOCAL_BUILD_LIMITS.tokenMs;
    this.#touch();

    const body = JSON.stringify({
      contract: LOCAL_BUILD_CONTRACT,
      name: this.#name,
      token: this.#token,
      expiresAt: new Date(this.#tokenExpiresAt).toISOString(),
      files: [...listing.files].map(([file, entry]) => ({ path: file, size: entry.size })),
    });

    send(200, { ...cors, "content-type": "application/json" }, body);
  }

  #serveFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    raw: string,
    cors: Record<string, string>,
    send: (status: number, headers?: Record<string, string>) => void,
  ): void {
    if (this.#token === null || this.#listing === null) return send(401, cors);

    if (Date.now() >= this.#tokenExpiresAt) return send(410, cors);

    if (!matches(req.headers[LOCAL_BUILD_TOKEN_HEADER], this.#token)) return send(401, cors);

    const relative = decodePath(raw);
    const entry = relative === null ? undefined : this.#listing.get(relative);

    if (!entry) return send(404, cors);

    this.#touch();

    let fd: number;

    try {
      fd = fs.openSync(entry.absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      return send(404, cors);
    }

    try {
      const stat = fs.fstatSync(fd);
      const real = fs.realpathSync(entry.absolute);

      if (!stat.isFile() || stat.size !== entry.size || !real.startsWith(`${this.#root}${path.sep}`)) {
        fs.closeSync(fd);

        return send(409, cors);
      }
    } catch {
      fs.closeSync(fd);

      return send(404, cors);
    }

    res.writeHead(200, {
      ...BASE_HEADERS,
      ...cors,
      "content-type": "application/octet-stream",
      "content-length": String(entry.size),
    });

    if (entry.size === 0) {
      fs.closeSync(fd);
      res.end();

      return;
    }

    const stream = fs.createReadStream("", { fd, start: 0, end: entry.size - 1, autoClose: true });

    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }
}

export async function startLocalBuildServer(options: { distDir: string; name: string }): Promise<LocalBuildStart> {
  const listing = listLocalBuild(options.distDir);

  if (!listing.ok) return { ok: false, stage: "list", reason: listing.reason, message: listing.message };

  const server = http.createServer();

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;
  server.on("clientError", (_err, socket) => socket.destroy());

  const port = await new Promise<number | { code: string }>((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => resolve({ code: err.code ?? "EUNKNOWN" }));
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const address = server.address();

      resolve(address && typeof address === "object" ? address.port : { code: "ENOADDRESS" });
    });
  });

  if (typeof port !== "number") {
    server.close();

    return { ok: false, stage: "bind", code: port.code };
  }

  server.unref();

  try {
    return { ok: true, server: new LocalBuildServer(server, port, options.distDir, options.name, listing) };
  } catch {
    server.close();

    return { ok: false, stage: "list", reason: "unreadable", message: `The build folder ${options.distDir} could not be read.` };
  }
}
