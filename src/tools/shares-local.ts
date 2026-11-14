// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { uploadPreview } from "../lib/preview-upload";
import { readSharedPreviews } from "../lib/share-record";
import { unpackZip } from "../lib/zip-entries";

import type { SharesLocal } from "./shares-create";

export const SHARES_LOCAL: SharesLocal = {
  readSharedPreviews,
  makeStagingDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "extdev-share-build-")),
  unpackPackage: unpackZip,
  readStagedManifest: (distDir) => JSON.parse(fs.readFileSync(path.join(distDir, "manifest.json"), "utf8")),
  uploadPreview,
  removeStagingDir: (distDir) => fs.rmSync(distDir, { recursive: true, force: true }),
};
