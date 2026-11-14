// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

export const CREATE_STUCK_AFTER_SECONDS = 6 * 60;

export interface CreatingAge {
  seconds: number;
  startedAtIso: string;
  stuck: boolean;
}

function platformStartedAtMs(data: Record<string, unknown>): number | null {
  const raw = data.startedAt;

  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw < 1e12 ? raw * 1000 : raw;
  }

  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function platformAgeSeconds(data: Record<string, unknown>, now: number): number | null {
  const said = Number(data.ageSeconds);

  if (data.ageSeconds !== undefined && data.ageSeconds !== null && Number.isFinite(said) && said >= 0) {
    return said;
  }

  const startedAt = platformStartedAtMs(data);

  return startedAt === null ? null : Math.max(0, (now - startedAt) / 1000);
}

export function creatingAgeAt(data: Record<string, unknown>, now: number, firstSeen: number): CreatingAge {
  const ownSeconds = (now - firstSeen) / 1000;
  const platformSeconds = platformAgeSeconds(data, now);
  const seconds = Math.floor(Math.max(ownSeconds, platformSeconds ?? 0));
  const platformStart = platformStartedAtMs(data);
  const startedAt =
    platformStart !== null && platformSeconds !== null && platformSeconds >= ownSeconds
      ? platformStart
      : now - seconds * 1000;

  return {
    seconds,
    startedAtIso: new Date(startedAt).toISOString(),
    stuck: seconds >= CREATE_STUCK_AFTER_SECONDS,
  };
}

export function creatingForWords(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  if (minutes === 0) return `${rest} s`;

  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

export const CREATE_CEILING_SENTENCE = `A 'creating' answer carries when the platform started this create (startedAt) and how long it has been at it (creatingForSeconds); past ${CREATE_STUCK_AFTER_SECONDS / 60} minutes this tool answers create-stuck instead.`;
