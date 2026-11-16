// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export interface Discarded {
  slot: string;
  reason: string;
}

export function discardedTints(tints: Record<string, unknown>): Discarded[] {
  const out: Discarded[] = [];

  for (const [key, value] of Object.entries(tints)) {
    if (!Array.isArray(value) || value.length !== 3) {
      out.push({
        slot: `tints.${key}`,
        reason:
          "malformed tint value, Chrome expects [h, s, l] with three numbers",
      });
    } else if (value.some((channel) => typeof channel !== "number")) {
      out.push({
        slot: `tints.${key}`,
        reason: "non-numeric tint channel, Chrome skips the tint",
      });
    }
  }

  return out;
}

export function discardedProperties(properties: Record<string, unknown>): Discarded[] {
  const out: Discarded[] = [];

  for (const [key, value] of Object.entries(properties)) {
    if (key === "ntp_logo_alternate" && typeof value !== "number") {
      out.push({
        slot: `properties.${key}`,
        reason:
          "not a number (Chrome reads 0 or 1), the logo falls back to the derived default",
      });
    }

    if (
      (key === "ntp_background_alignment" || key === "ntp_background_repeat") &&
      typeof value !== "string"
    ) {
      out.push({
        slot: `properties.${key}`,
        reason: "not a string, Chrome falls back to the default",
      });
    }
  }

  return out;
}
