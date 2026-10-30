// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { pathToFileURL } from "node:url";

import { adoptLocalState, localState, type LocalState } from "./local-state";
import { serverStamp, type ServerStamp } from "./server-stamp";
import { adoptKeptLogins, keptLoginEntries } from "./session-login";
import { DEFAULT_SERVER_OPTIONS, setServerOptions, type ServerOptions } from "./tool-policy";
import { ASSERT_CHECKS } from "./verdict";

export type ToolFrame = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export interface RebuiltCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface Handover {
  options: ServerOptions;
  keptLogins: Array<[string, string]>;
  local?: LocalState;
}

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RebuiltBuild {
  dispatchRebuilt: (call: RebuiltCall) => Promise<ToolFrame>;
  adoptHandover: (state: Handover) => void;
  handoverState: () => Handover;
  listRebuilt?: () => ListedTool[];
  stampRebuilt?: () => ServerStamp;
  assertChecksRebuilt?: () => string[];
}

export type BuildImporter = (specifier: string) => Promise<unknown>;

export type RebuiltDispatch = (call: RebuiltCall, options: ServerOptions) => Promise<ToolFrame>;

export type RebuiltList = (options: ServerOptions) => ListedTool[];

export const RELOAD_CONTRACT = ["dispatchRebuilt", "adoptHandover", "handoverState"] as const;

let adoptedOptions: ServerOptions | null = null;
let rebuiltDispatch: RebuiltDispatch | null = null;
let rebuiltList: RebuiltList | null = null;

export function provideRebuiltDispatch(dispatch: RebuiltDispatch): void {
  rebuiltDispatch = dispatch;
}

export function provideRebuiltList(list: RebuiltList): void {
  rebuiltList = list;
}

export function listRebuilt(): ListedTool[] {
  if (!rebuiltList) throw new Error("this build registered no tool list");

  return rebuiltList(adoptedOptions ?? DEFAULT_SERVER_OPTIONS);
}

export function handoverState(options: ServerOptions = adoptedOptions ?? DEFAULT_SERVER_OPTIONS): Handover {
  return { options, keptLogins: keptLoginEntries(), local: localState() };
}

export function adoptHandover(state: Handover): void {
  adoptedOptions = state.options;
  setServerOptions(state.options);
  adoptKeptLogins(state.keptLogins);
  adoptLocalState(state.local);
}

export function stampRebuilt(): ServerStamp {
  return serverStamp.stamp();
}

export function assertChecksRebuilt(): string[] {
  return ASSERT_CHECKS.map((check) => check.id);
}

export function carriesLocalState(candidate: RebuiltBuild, state: Handover): boolean {
  if (!state.local) return false;

  try {
    return candidate.handoverState().local === state.local;
  } catch {
    return false;
  }
}

export async function dispatchRebuilt(call: RebuiltCall): Promise<ToolFrame> {
  if (!rebuiltDispatch) throw new Error("this build registered no tool dispatcher");

  return rebuiltDispatch(call, adoptedOptions ?? DEFAULT_SERVER_OPTIONS);
}

export function isRebuiltBuild(candidate: unknown): candidate is RebuiltBuild {
  if (!candidate || typeof candidate !== "object") return false;

  return RELOAD_CONTRACT.every((name) => typeof (candidate as Record<string, unknown>)[name] === "function");
}

export function buildSpecifier(entry: string, builtAt: string, attempt: number): string {
  return `${pathToFileURL(entry).href}?stamp=${encodeURIComponent(builtAt)}&attempt=${attempt}`;
}

export type ReloadOutcome = { frame: ToolFrame; reloaded: string | null } | { reloadError: string };

export interface ActiveBuild {
  builtAt: string;
  local: boolean;
  version: string | null;
  assertChecks: string[] | null;
}

type Loaded = { build: RebuiltBuild; local: boolean } | { reloadError: string };

type Loading = { builtAt: string; done: Promise<Loaded> };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createReloader(deps: {
  entry: string;
  importBuild: BuildImporter | null;
  handover: () => Handover;
}): {
  activate: (builtAt: string) => Promise<ActiveBuild | { reloadError: string }>;
  dispatch: (call: RebuiltCall, builtAt: string) => Promise<ReloadOutcome>;
  list: (builtAt: string) => Promise<ListedTool[] | null>;
} {
  let active: { builtAt: string; build: RebuiltBuild; local: boolean; said: boolean } | null = null;
  let loading: Loading | null = null;
  let attempts = 0;

  const load = async (builtAt: string): Promise<Loaded> => {
    if (!deps.importBuild) {
      return { reloadError: "this server was started without a loader for a rebuilt build; the extension-mcp launcher provides one" };
    }

    if (!deps.entry) return { reloadError: "this server does not know which file it loaded" };

    attempts += 1;
    let candidate: unknown;

    try {
      candidate = await deps.importBuild(buildSpecifier(deps.entry, builtAt, attempts));
    } catch (err) {
      return { reloadError: `import of the ${builtAt} build failed: ${messageOf(err)}` };
    }

    if (!isRebuiltBuild(candidate)) {
      return { reloadError: `the ${builtAt} build does not export the reload contract (${RELOAD_CONTRACT.join(", ")})` };
    }

    const state = active ? active.build.handoverState() : deps.handover();

    try {
      candidate.adoptHandover(state);
    } catch (err) {
      return { reloadError: `the ${builtAt} build refused the handover: ${messageOf(err)}` };
    }

    return { build: candidate, local: carriesLocalState(candidate, state) };
  };

  const begin = (builtAt: string): Loading => {
    const pending: Loading = {
      builtAt,
      done: load(builtAt).then((loaded) => {
        if (loading === pending) loading = null;
        if (!("reloadError" in loaded)) active = { builtAt, build: loaded.build, local: loaded.local, said: false };

        return loaded;
      }),
    };
    loading = pending;

    return pending;
  };

  const activate = (builtAt: string): Promise<Loaded> => {
    if (active?.builtAt === builtAt) return Promise.resolve({ build: active.build, local: active.local });

    const pending = loading?.builtAt === builtAt ? loading : begin(builtAt);

    return pending.done;
  };

  const read = <T>(fn: (() => T) | undefined): T | null => {
    if (typeof fn !== "function") return null;

    try {
      return fn();
    } catch {
      return null;
    }
  };

  return {
    async activate(builtAt) {
      const loaded = await activate(builtAt);
      if ("reloadError" in loaded) return loaded;

      return {
        builtAt,
        local: loaded.local,
        version: read(loaded.build.stampRebuilt)?.version ?? null,
        assertChecks: read(loaded.build.assertChecksRebuilt),
      };
    },
    async list(builtAt) {
      const loaded = await activate(builtAt);
      if ("reloadError" in loaded) return null;

      return read(loaded.build.listRebuilt);
    },
    async dispatch(call, builtAt) {
      const loaded = await activate(builtAt);

      if ("reloadError" in loaded) return loaded;

      let frame: ToolFrame;

      try {
        frame = await loaded.build.dispatchRebuilt(call);
      } catch (err) {
        return { reloadError: `the ${builtAt} build threw while answering ${call.name}: ${messageOf(err)}` };
      }

      const first = active?.builtAt === builtAt && !active.said;
      if (active?.builtAt === builtAt) active.said = true;

      return { frame, reloaded: first ? builtAt : null };
    },
  };
}
