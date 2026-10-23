// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

export type BuildType = "development" | "production";

export interface BuildTypeReading {
  buildType: BuildType;
  source: "engine" | "markers";
  markers: string[];
}

export const ENGINE_CONTROL_FILE = "extension-js-control.json";

const HOT_DIR = "hot";

/* @invariant THE ENGINE'S OWN RECORD OF A DIST'S BUILD TYPE OUTRANKS THE
 * MARKERS, AND SOURCE MAPS ALONE ARE NEVER A MARKER. extension_dev rewrites
 * dist/<browser> with the development build, and the engine stamps that
 * folder itself: extension.js programs/develop/plugin-reload/steps/
 * inject-bridge-producer.ts emits `extension-js-control.json` at the dist root
 * on every development compile, as `{port, instanceId}`, and a production
 * build never carries it there (programs/develop/dev-server/control-bridge/
 * production-control.ts writes its copy into the controlled build folder
 * beside dist, and dist/extension-js/<browser>/build-summary.json carries no
 * mode field). So that file's presence is the engine's word that the folder
 * is a development build, and a `buildType` field in it, read as
 * "development" or "production", is taken before any marker the moment the
 * engine writes one. With no control file, the markers stand in: the hot/
 * folder and hot-update chunks (programs/develop/rspack-config.ts
 * hotUpdateChunkFilename), content_scripts/dev-stub-N.js, dev-css-N.js and
 * dev-registry.json (programs/develop/plugin-reload/reload-lib/
 * dev-content-scripts.ts), and the engine's companion folder. A .map file is
 * not on the list: a production build can ship its source maps, and on
 * 2026-10-23 a production edge build was blamed for the dev runtime's eval,
 * stubs and maps because nothing above the hot-update chunk was read. */
const FILE_MARKERS: Array<{ name: string; test: (file: string) => boolean }> = [
  { name: `${ENGINE_CONTROL_FILE} at the dist root`, test: (file) => file === ENGINE_CONTROL_FILE },
  { name: "a hot-update chunk", test: (file) => /hot-update\./.test(file) },
  { name: "a dev content-script stub", test: (file) => /^content_scripts\/dev-(?:stub|css)-\d+\.js$/.test(file) },
  { name: "the dev content-script registry", test: (file) => file === "content_scripts/dev-registry.json" },
  { name: "the engine's companion folder", test: (file) => /(^|\/)extension-js(-devtools)?\//.test(file) },
];

function fileMarkers(files: Array<{ path: string }>): string[] {
  return FILE_MARKERS.filter((marker) => files.some((f) => marker.test(f.path))).map((marker) => marker.name);
}

export function isDevelopmentBuild(files: Array<{ path: string }>): boolean {
  return fileMarkers(files).length > 0;
}

function engineBuildType(distPath: string): BuildType | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(distPath, ENGINE_CONTROL_FILE), "utf8")) as unknown;
    const word = parsed && typeof parsed === "object" ? (parsed as { buildType?: unknown }).buildType : undefined;

    return word === "development" || word === "production" ? word : null;
  } catch {
    return null;
  }
}

function hotDirPresent(distPath: string): boolean {
  try {
    return fs.statSync(path.join(distPath, HOT_DIR)).isDirectory();
  } catch {
    return false;
  }
}

export function readBuildType(distPath: string, files: Array<{ path: string }>): BuildTypeReading {
  const engine = engineBuildType(distPath);

  if (engine) return { buildType: engine, source: "engine", markers: [`${ENGINE_CONTROL_FILE} buildType`] };

  const markers = [...fileMarkers(files), ...(hotDirPresent(distPath) ? ["the hot/ folder"] : [])];

  return markers.length
    ? { buildType: "development", source: "markers", markers }
    : { buildType: "production", source: "markers", markers };
}
