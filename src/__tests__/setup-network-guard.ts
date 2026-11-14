import net from "node:net";

import { afterEach, expect } from "vitest";

/* @invariant NO TEST IN THIS PACKAGE REACHES A REAL HOST, AND ONE THAT TRIES
 * GOES RED. A test whose fetch nobody stubbed passed wherever the machine
 * could reach the host, and a fail-soft caller swallowed the error wherever
 * it could not, so the suite was green both ways. The global fetch and the
 * socket connect every other client ends at are refused, each refusal is
 * remembered, and the hook below fails the test that made it. A test that
 * stubs fetch replaces this guard for as long as its stub stands, which is
 * the statement that the call was thought about.
 *
 * Loopback is open only on a port a server in this test's own process
 * listens on: a loopback name proves nothing about who answers. A unix
 * socket path, the data: and blob: schemes and a name under .invalid stay
 * open, since none of them can reach a host. The monorepo's suites carry the
 * same rule in scripts/lib/spec-network-guard.mjs; a child process this
 * suite spawns is outside it.
 */
export const NETWORK_REFUSAL = "UNSTUBBED NETWORK CALL";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "::"]);
const refused: string[] = [];
const ownPorts = new Set<number>();

function staysOnThisMachine(host: string): boolean {
  const name = host.trim().toLowerCase();

  return !name || LOOPBACK_HOSTS.has(name) || name.endsWith(".localhost") || name.endsWith(".invalid") || /^127(?:\.\d{1,3}){3}$/.test(name) || name.startsWith("::ffff:127.");
}

function neverConnects(host: string): boolean {
  const name = host.trim().toLowerCase();

  return !name || name.endsWith(".invalid");
}

function refuse(target: string): Error {
  const error = new Error(
    `${NETWORK_REFUSAL}: ${target}. Stub it; a test never reaches a real host, and reaches loopback only on a port its own server listens on.`,
  );

  refused.push(error.message);

  return error;
}

export function drainRefusedCalls(): string[] {
  return refused.splice(0, refused.length);
}

const realFetch = globalThis.fetch;

globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const target = input instanceof Request ? input.url : String(input);
  let url: URL | null = null;

  try {
    url = new URL(target);
  } catch {
    url = null;
  }

  const port = url ? Number(url.port || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80)) : 0;
  const local = url !== null && (url.protocol === "data:" || url.protocol === "blob:" || (staysOnThisMachine(url.hostname) && (neverConnects(url.hostname) || ownPorts.has(port))));

  return local ? realFetch(input, init) : Promise.reject(refuse(`fetch ${target}`));
}) as typeof fetch;

const realConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === "object" ? (first as { path?: string; host?: string; port?: number | string }) : null;

  if (options?.path || (typeof first === "string" && !/^\d+$/.test(first))) return Reflect.apply(realConnect, this, args);

  const host = (options ? options.host : typeof args[1] === "string" ? args[1] : "") || "localhost";
  const port = options ? options.port : first;

  if (neverConnects(host) || (staysOnThisMachine(host) && ownPorts.has(Number(port)))) return Reflect.apply(realConnect, this, args);

  throw refuse(`socket ${host}:${String(port ?? "")}`);
} as typeof realConnect;

const realListen = net.Server.prototype.listen;

net.Server.prototype.listen = function guardedListen(this: net.Server, ...args: unknown[]) {
  this.once("listening", () => {
    const address = this.address();

    if (address && typeof address === "object") ownPorts.add(address.port);
  });

  return Reflect.apply(realListen, this, args);
} as typeof realListen;

if (!/\.live\.test\.ts$/.test(String(expect.getState().testPath ?? ""))) {
  afterEach(() => {
    const seen = drainRefusedCalls();

    if (seen.length > 0) throw new Error(seen.join("\n"));
  });
}
