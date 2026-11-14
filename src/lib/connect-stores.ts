// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const CONNECT_STORES = ["chrome", "firefox", "edge", "safari"] as const;

export type ConnectStore = (typeof CONNECT_STORES)[number];

export const CONNECT_STORE_NAMES: Record<ConnectStore, string> = {
  chrome: "the Chrome Web Store",
  firefox: "Firefox Add-ons",
  edge: "Edge Add-ons",
  safari: "the App Store",
};
