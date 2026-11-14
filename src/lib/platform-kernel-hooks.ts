// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { platformFirefoxChannel } from "./amo-platform-channel";
import { openApprovalOnce } from "./approval-open";
import { carriedRow } from "./forward-lane-answer";
import { registerKernelHooks, type KernelHooks } from "./kernel-hooks";
import { LOCAL_KERNEL_HOOKS } from "./local-kernel-hooks";
import { loginForOrigin, loginForPath, serverLogins } from "./path-project";
import { localPreflightHalf, nextStepForUnloggedProject } from "./unlogged-project";

export const CONNECT_SESSIONS_SHELF = "connect-sessions";

/* @invariant THIS PROCESS SHAPES NO STORE ANSWER AND KEEPS NO CONNECT
 * SESSION OF ITS OWN. The hosted lane shapes a store answer before it
 * sends it, so the hook here hands the answer on as it came. The project a
 * connect session was opened for is something the lane's tool remembered:
 * it came back beside that answer and sits in the memory this forwarder
 * carries, so a wait on the session is bound to its project from there.
 */
export const PLATFORM_KERNEL_HOOKS: KernelHooks = {
  shapeStoreAnswer: (_command, _args, result) => result,
  openApprovalOnce: (result, options) => openApprovalOnce(result, options),
  connectSessionProject: (session) => {
    const project = typeof session === "string" ? carriedRow(CONNECT_SESSIONS_SHELF, session.trim()) : null;

    return typeof project === "string" && project ? project : null;
  },
  serverLogins,
  loginForPath,
  loginForOrigin,
  unloggedProjectStep: nextStepForUnloggedProject,
  localPreflightHalf,
  platformFirefoxChannel,
  ...LOCAL_KERNEL_HOOKS,
};

export function installPlatformKernelHooks(): void {
  registerKernelHooks(PLATFORM_KERNEL_HOOKS);
}
