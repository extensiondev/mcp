// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const LOGIN_LIFETIMES = ["hour", "day", "week"] as const;

export type LoginLifetime = (typeof LOGIN_LIFETIMES)[number];

export const DEFAULT_LOGIN_LIFETIME: LoginLifetime = "day";

export function readLoginLifetime(value: unknown): LoginLifetime | null {
  if (value === undefined || value === null || value === "") return DEFAULT_LOGIN_LIFETIME;

  return (LOGIN_LIFETIMES as readonly unknown[]).includes(value) ? (value as LoginLifetime) : null;
}
