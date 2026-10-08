export function scaffoldScripts(
  template = "typescript",
  extensionBinary = "extension",
): Record<string, string> {
  const target = template.toLowerCase().includes("monorepo") ? " packages/extension" : "";
  return {
    dev: `${extensionBinary} dev${target}`,
    start: `${extensionBinary} start${target}`,
    build: `${extensionBinary} build${target}`,
    preview: `${extensionBinary} preview${target}`,
    "build:chrome": `${extensionBinary} build${target} --browser chrome`,
    "build:firefox": `${extensionBinary} build${target} --browser firefox`,
    "build:edge": `${extensionBinary} build${target} --browser edge`,
  };
}

export const SCAFFOLDER_WRITERS = {
  scaffoldScripts: { file: "extension-create/dist/module.cjs", marker: "'build:chrome'" },
} as const;
