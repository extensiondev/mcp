// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import * as create from "../tools/create";
import * as projectCreate from "../tools/project-create";
import * as workspaceCreate from "../tools/workspace-create";
import * as templates from "../tools/templates";
import * as build from "../tools/build";
import * as dev from "../tools/dev";
import * as start from "../tools/start";
import * as tryTool from "../tools/try";
import * as previewWeb from "../tools/preview-web";
import * as shares from "../tools/shares";
import * as stop from "../tools/stop";
import * as assertTool from "../tools/assert";
import * as manifestValidate from "../tools/manifest-validate";
import * as themeVerify from "../tools/theme-verify";
import * as analyze from "../tools/analyze";
import * as inspect from "../tools/inspect";
import * as listExtensions from "../tools/list-extensions";
import * as logs from "../tools/logs";
import * as evalTool from "../tools/eval";
import * as storage from "../tools/storage";
import * as reload from "../tools/reload";
import * as network from "../tools/network";
import * as open from "../tools/open";
import * as domSnapshot from "../tools/dom-snapshot";
import * as element from "../tools/element";
import * as screenshot from "../tools/screenshot";
import * as publish from "../tools/publish";
import * as releasePromote from "../tools/release-promote";
import * as releaseStatus from "../tools/release-status";
import * as approvals from "../tools/approvals";
import * as buildsTool from "../tools/builds";
import * as buildsAct from "../tools/builds-act";
import * as workspaceTool from "../tools/workspace";
import * as submitTool from "../tools/submit";
import * as approvalsRequest from "../tools/approvals-request";
import * as submitCheck from "../tools/submit-check";
import * as wait from "../tools/wait";
import * as addFeature from "../tools/add-feature";
import * as auth from "../tools/auth";
import * as browsers from "../tools/browsers";
import * as doctor from "../tools/doctor";
import * as docsSearch from "../tools/docs-search";
import { forwardable } from "./hosted-forwarder";
import { TOOL_TWINS, twinSchema } from "./tool-twins";

import type { ToolModule } from "./tool-dispatch";

const baseTools: ToolModule[] = [
  create,
  templates,
  build,
  dev,
  start,
  tryTool,
  forwardable(previewWeb),
  forwardable(shares),
  stop,
  manifestValidate,
  themeVerify,
  analyze,
  assertTool,
  inspect,
  listExtensions,
  logs,
  evalTool,
  storage,
  reload,
  network,
  open,
  domSnapshot,
  element,
  screenshot,
  forwardable(publish),
  forwardable(releaseStatus),
  forwardable(approvals),
  forwardable(buildsTool),
  forwardable(buildsAct),
  forwardable(workspaceTool),
  forwardable(releasePromote),
  forwardable(submitTool),
  forwardable(submitCheck),
  approvalsRequest,
  wait,
  addFeature,
  forwardable(auth),
  forwardable(projectCreate),
  forwardable(workspaceCreate),
  browsers,
  doctor,
  docsSearch,
];

export const tools: ToolModule[] = [
  ...baseTools,
  ...TOOL_TWINS.map((twin): ToolModule => ({
    schema: twinSchema(twin, baseTools.find((tool) => tool.schema.name === twin.of)!.schema),
    handler: async () => {
      throw new Error(`${twin.name} is answered by ${twin.of}`);
    },
  })),
];
