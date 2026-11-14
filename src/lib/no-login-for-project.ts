// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { envelope } from "./envelope";
import { kernelHook } from "./kernel-hooks";

type Args = Record<string, unknown>;

export const NO_LOGIN_FOR_PROJECT_STATUS = "no-login-for-project";
export const NO_LOGIN_FOR_PROJECT_CODE = "E_NO_LOGIN_FOR_PROJECT";

export function noLoginForProjectRefusal(args: {
  name: string;
  callArgs: Args;
  projectPath: string;
  named: string[];
  defaultLogin: string | null;
  api?: string;
}): string {
  const ref = args.named[0] ?? "";
  const next = kernelHook("unloggedProjectStep")(ref, args.projectPath, args.api);
  const local = kernelHook("localPreflightHalf")(args.name, args.callArgs, args.projectPath);
  const localSaid = "local" in local ? " The local half of the preflight is in value.local (STORE.md lines and the built icon); each store's readiness reads unknown until the project has a login." : "";
  const defaultSaid = args.defaultLogin ? ` The default login here is ${args.defaultLogin}, and it was not used in its place.` : "";

  return envelope({
    ok: false,
    command: args.name,
    status: NO_LOGIN_FOR_PROJECT_STATUS,
    value: {
      projectPath: args.projectPath,
      named: args.named,
      ...next.value,
      ...(args.defaultLogin ? { defaultLogin: args.defaultLogin } : {}),
      ...local,
    },
    error: {
      code: NO_LOGIN_FOR_PROJECT_CODE,
      name: "NoLoginForProject",
      message: `projectPath ${args.projectPath} is the project ${args.named.join(" or ")}, and no login stored on this machine is for it, so nothing was read or sent.${defaultSaid}`,
    },
    hint: `${next.hint}${localSaid}`,
  });
}
