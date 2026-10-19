// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import path from "node:path";

import { serverOf } from "./credential-server";
import { credentialsPath } from "./credentials";
import { withFileLock, writePrivateJson } from "./private-file";

type CreatedFile = Record<string, Record<string, number>>;

export function createdProjectsPath(): string {
  return path.join(path.dirname(credentialsPath()), "created-projects.json");
}

function readCreated(): CreatedFile {
  try {
    const data = JSON.parse(fs.readFileSync(createdProjectsPath(), "utf8"));

    return data && typeof data === "object" && !Array.isArray(data) ? (data as CreatedFile) : {};
  } catch {
    return {};
  }
}

export function rememberCreatedProject(apiBase: string, project: string): boolean {
  const server = serverOf(apiBase);
  const ref = project.toLowerCase();
  const file = createdProjectsPath();

  try {
    withFileLock(file, "created projects record", () => {
      const created = readCreated();
      const onServer = created[server] && typeof created[server] === "object" ? created[server] : {};
      created[server] = { ...onServer, [ref]: Math.floor(Date.now() / 1000) };
      writePrivateJson(file, created);
    });

    return true;
  } catch {
    return false;
  }
}

export function createdOnServer(apiBase: string, project: string): boolean {
  const onServer = readCreated()[serverOf(apiBase)];

  return Boolean(onServer && typeof onServer === "object" && project.toLowerCase() in onServer);
}
