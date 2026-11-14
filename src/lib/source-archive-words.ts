// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const SOURCE_SKIPPED_FOLDERS = ["node_modules", "dist", ".git", ".extension-dev"];

export const SOURCE_SKIPPED_EXTENSIONS = [".zip", ".crx", ".xpi"];

export function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);

  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}
