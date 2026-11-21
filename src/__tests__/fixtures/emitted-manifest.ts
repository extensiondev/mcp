import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Body = Record<string, unknown>;

type FrozenEngineAnswers = {
  engine: string;
  table: { manifest: Body; answers: Record<string, Body> };
  emitted: Array<{ browser: string; source: Body; answer: Body }>;
};

const answersFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "engine-manifest-answers.json");

export function frozenEngineAnswers(): FrozenEngineAnswers {
  return JSON.parse(fs.readFileSync(answersFile, "utf8")) as FrozenEngineAnswers;
}

export function writeEmittedManifest(projectPath: string, browser: string, source: Body): Body {
  const key = JSON.stringify(source);
  const frozen = frozenEngineAnswers().emitted.find(
    (entry) => entry.browser === browser && JSON.stringify(entry.source) === key,
  );
  if (!frozen) throw new Error(`No frozen engine answer for ${browser} and ${key} in ${answersFile}`);
  const emitted = frozen.answer;
  const distDir = path.join(projectPath, "dist", browser);
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "manifest.json"), JSON.stringify(emitted));

  return emitted;
}
