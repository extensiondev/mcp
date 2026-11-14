// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { openPagesForPerson } from "./approval-open";
import { FILE_APPROVAL_STATE } from "./approval-state-local";
import { localPackageHold } from "./build-inputs-local";
import { moveCreatedProject } from "./created-projects";
import { registerKernelHooks, type KernelHooks } from "./kernel-hooks";
import { identityHeaders } from "./session-identity";

export type LocalKernelHooks = Pick<KernelHooks, "identityHeaders" | "moveCreatedProject" | "localPackageHold" | "openPagesForPerson" | "approvalState">;

export const LOCAL_KERNEL_HOOKS: LocalKernelHooks = {
  identityHeaders: (tool) => identityHeaders(tool),
  moveCreatedProject: (apiBase, from, to) => moveCreatedProject(apiBase, from, to),
  localPackageHold: (projectPath, builds, head) => localPackageHold(projectPath, builds, head),
  openPagesForPerson: (urls) => openPagesForPerson(urls),
  approvalState: () => FILE_APPROVAL_STATE,
};

export function installLocalKernelHooks(): void {
  registerKernelHooks(LOCAL_KERNEL_HOOKS);
}
