// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { platformFirefoxChannel } from "./amo-platform-channel";
import { openApprovalOnce } from "./approval-open";
import { connectSessionProject } from "./connect-session-projects";
import { registerKernelHooks, type KernelHooks } from "./kernel-hooks";
import { loginForOrigin, loginForPath, serverLogins } from "./path-project";
import { shapeStoreAnswer } from "./store-answer";
import { localPreflightHalf, nextStepForUnloggedProject } from "./unlogged-project";

export const PLATFORM_KERNEL_HOOKS: KernelHooks = {
  shapeStoreAnswer,
  openApprovalOnce: (result, options) => openApprovalOnce(result, options),
  connectSessionProject,
  serverLogins,
  loginForPath,
  loginForOrigin,
  unloggedProjectStep: nextStepForUnloggedProject,
  localPreflightHalf,
  platformFirefoxChannel,
};

export function installPlatformKernelHooks(): void {
  registerKernelHooks(PLATFORM_KERNEL_HOOKS);
}
