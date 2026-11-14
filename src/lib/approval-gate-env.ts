// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const APPROVAL_GATE_ENV = "EXTENSION_DEV_APPROVAL_GATE";

export function approvalGateEnabled(defaultOn = false): boolean {
  const raw = String(process.env[APPROVAL_GATE_ENV] || "")
    .trim()
    .toLowerCase();
  if (raw === "") return defaultOn;

  return raw !== "0" && raw !== "false" && raw !== "off";
}
