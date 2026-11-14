// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { AsyncLocalStorage } from "node:async_hooks";

export type MemoryRows = Array<[string, unknown]>;
export type CarriedMemory = Record<string, MemoryRows>;

export const MEMORY_SHELF_ROWS = 256;
export const MEMORY_SHELVES = 8;

interface CallMemory {
  seed: CarriedMemory;
  shelves: Map<string, Map<string, unknown>>;
  scratch: Map<string, Map<string, unknown>>;
}

const calls = new AsyncLocalStorage<CallMemory>();
const own = new Map<string, Map<string, unknown>>();

function rowsOf(value: unknown): MemoryRows {
  if (!Array.isArray(value)) return [];

  return value.filter((row): row is [string, unknown] => Array.isArray(row) && row.length === 2 && typeof row[0] === "string").slice(-MEMORY_SHELF_ROWS);
}

export function readCarriedMemory(value: unknown): CarriedMemory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MEMORY_SHELVES)
      .map(([name, rows]) => [name, rowsOf(rows)]),
  );
}

/* @invariant WHAT A TOOL REMEMBERS BETWEEN TWO CALLS LIVES WITH THE PROCESS
 * THAT SEES BOTH CALLS. On this machine that is the server process, so a
 * shelf is a map of this module. A host that keeps no state between calls
 * (the hosted lane, where two calls can land on two function instances) runs
 * the tool inside withCallMemory: the shelves start from what the caller
 * carried in, a row the tool's own reader does not accept is dropped, and
 * what the shelves hold when the tool answers goes back to the caller, who
 * keeps it and carries it into the next call. The carried rows only shape
 * what the same caller is told (a build dispatched and not recorded yet, a
 * second 5xx on the same write, the project a connect session was opened
 * for); no credential is ever put on a shelf. What must not travel (a held
 * create session carries its provisioning grant) sits on a scratch shelf
 * instead: this process's own map here, and on such a host a map that ends
 * with the call, so the record is read again from where it is kept.
 */
export function memoryShelf<V>(name: string, accepts: (value: unknown) => value is V): Map<string, V> {
  const call = calls.getStore();
  const shelves = call ? call.shelves : own;
  const held = shelves.get(name);
  if (held) return held as Map<string, V>;

  const shelf = new Map<string, unknown>((call?.seed[name] ?? []).filter(([, value]) => accepts(value)));
  shelves.set(name, shelf);

  return shelf as Map<string, V>;
}

export function scratchShelf<V>(name: string): Map<string, V> {
  const shelves = calls.getStore()?.scratch ?? own;
  const held = shelves.get(`scratch:${name}`);
  if (held) return held as Map<string, V>;

  const shelf = new Map<string, unknown>();
  shelves.set(`scratch:${name}`, shelf);

  return shelf as Map<string, V>;
}

export async function withCallMemory<T>(carried: unknown, run: () => Promise<T>): Promise<{ result: T; memory: CarriedMemory }> {
  const call: CallMemory = { seed: readCarriedMemory(carried), shelves: new Map(), scratch: new Map() };
  const result = await calls.run(call, run);
  const memory: CarriedMemory = { ...call.seed };

  for (const [name, shelf] of call.shelves) memory[name] = [...shelf.entries()].slice(-MEMORY_SHELF_ROWS);

  return { result, memory };
}
