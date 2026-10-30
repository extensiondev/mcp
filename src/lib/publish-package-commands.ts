// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import {
  REGISTRY_TOKEN_QUERY,
  packageAddress,
  packageAddressMode,
  packageFileOf,
  shareGrantOf,
} from "./package-address";

import type { ProjectRef } from "./registry";

type Row = Record<string, unknown>;

const PREVIEW_COMMAND = /^(npx -y extension@latest preview\s+)(\S+)(.*)$/s;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function packageCommand(command: string, ref: ProjectRef | null, grant: string, api?: string): string {
  const match = PREVIEW_COMMAND.exec(command);
  if (!match) return command;

  const raw = match[2].replace(/^["']|["']$/g, "");
  const parsed = packageFileOf(raw);
  if (!parsed) return command;

  const share = shareGrantOf(raw) || (REGISTRY_TOKEN_QUERY.test(raw) ? grant : "");
  const address = packageAddress(ref, parsed.sha, parsed.file, { api, share });

  return address ? `${match[1]}${address}${match[3]}` : command;
}

export function withPackageAddresses(data: Row, ref: ProjectRef | null, shareId: unknown, api?: string): void {
  const commands = data.previewCommands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) return;
  if (packageAddressMode(api) === "path") return;

  const grant = text(shareId) || shareGrantOf(data.shareUrl);

  data.previewCommands = Object.fromEntries(
    Object.entries(commands as Row).map(([browser, command]) => [browser, typeof command === "string" ? packageCommand(command, ref, grant, api) : command]),
  );
}
