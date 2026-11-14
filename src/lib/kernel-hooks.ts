// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import type { AmoChannel } from "./amo-update-url";

type Args = Record<string, unknown>;

export type PathLoginRead =
  | { state: "unnamed" }
  | { state: "match"; project: string; via: string }
  | { state: "unmatched"; named: string[] };

export interface UnloggedProjectStep {
  hint: string;
  value: Args;
}

export interface KernelHooks {
  shapeStoreAnswer(command: string, args: Args, result: string): string;
  openApprovalOnce(result: string, options: { noShip: boolean }): string;
  connectSessionProject(session: unknown): string | null;
  serverLogins(api?: string): { live: string[]; kept: string | null };
  loginForPath(projectPath: string, api?: string): PathLoginRead;
  loginForOrigin(dir: string, api?: string): { project: string; owner: string; repo: string } | null;
  unloggedProjectStep(ref: string, projectPath: string, api?: string): UnloggedProjectStep;
  localPreflightHalf(name: string, args: Args, projectPath: string): Args;
  platformFirefoxChannel(): Promise<AmoChannel | null>;
}

let registered: Partial<KernelHooks> = {};

export function registerKernelHooks(hooks: Partial<KernelHooks>): void {
  registered = { ...registered, ...hooks };
}

export function registeredKernelHooks(): Array<keyof KernelHooks> {
  return Object.keys(registered) as Array<keyof KernelHooks>;
}

export function kernelHook<K extends keyof KernelHooks>(name: K): KernelHooks[K] {
  const hook = registered[name];
  if (!hook) throw new Error(`The kernel hook ${name} is not registered.`);

  return hook;
}
