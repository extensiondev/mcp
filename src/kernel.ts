// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export { kernelHook, registerKernelHooks, registeredKernelHooks, type KernelHooks, type PathLoginRead, type UnloggedProjectStep } from "./lib/kernel-hooks";
export { createToolDispatcher, installToolHandlers, listedTools, toolResultFrame, type ToolModule } from "./lib/tool-dispatch";
export { envelope, isEnvelope, type Envelope } from "./lib/envelope";
export { requestCredential, withRequestCredential, type RequestCredential, type ScopedProject } from "./lib/credential-scope";
export { installRequestFetch } from "./lib/request-fetch";
export type { ServerOptions, ToolAnnotations } from "./lib/tool-policy";
