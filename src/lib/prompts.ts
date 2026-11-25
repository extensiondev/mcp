// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

import { ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

import { isToolListed, type ServerOptions } from "./tool-policy";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface ServerPrompt {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
  render: (args: Record<string, string>, options: ServerOptions) => string;
}

const PROJECT_PATH: PromptArgument = {
  name: "projectPath",
  description: "The extension project root. Left out, the agent uses the project it is working in.",
  required: false,
};

const BROWSER: PromptArgument = {
  name: "browser",
  description: "The browser to run it in: chrome (the default), edge, firefox or safari.",
  required: false,
};

const READ_EVERY_ANSWER = "Read hint and warnings in every answer before the next call, and treat ok: false as the answer.";

const DONE_RULE = "Call it done only after seeing it work in a real browser through extension_dev, never on a mocked chrome object or from a build alone.";

const project = (args: Record<string, string>): string => (args.projectPath ? `the project at ${args.projectPath}` : "the extension project in the working directory");

const browser = (args: Record<string, string>): string => args.browser || "chrome";

const numbered = (steps: string[]): string => steps.map((step, index) => `${index + 1}. ${step}`).join("\n");

export const PROMPTS: ServerPrompt[] = [
  {
    name: "create-extension",
    title: "Create and run a new extension",
    description: "Start a new browser extension from a template, run it in a real browser and prove it does what was asked.",
    arguments: [
      { name: "idea", description: "What the extension does, in a sentence.", required: true },
      BROWSER,
    ],
    render: (args) =>
      [
        `Create a browser extension that does this: ${args.idea}`,
        "Use the extension-dev tools in this order:",
        numbered([
          "extension_templates with query set to the idea, and pick the closest template slug.",
          "extension_create with a projectName and that template. Never scaffold by hand.",
          "Edit the project's files so it does what was asked, then extension_manifest_validate with projectPath.",
          `extension_dev with projectPath and browser: "${browser(args)}". It answers once the session is ready.`,
          "extension_assert with the expectations that prove the idea: content-script-injected {url} for a content script, surface-rendered {surface} for a popup, side panel or options page, and console-errors-empty.",
        ]),
        `${READ_EVERY_ANSWER} ${DONE_RULE}`,
        "Report what was created and the verdict of each check, then name one next step: try it in the open session.",
      ].join("\n\n"),
  },
  {
    name: "verify-change",
    title: "Verify a change in a real browser",
    description: "Prove that an edit to an extension works by running it in a real browser and reading a verdict.",
    arguments: [
      { name: "change", description: "What changed and what should now be seen, in a sentence.", required: true },
      PROJECT_PATH,
      BROWSER,
    ],
    render: (args) =>
      [
        `Verify this change in ${project(args)}: ${args.change}`,
        "Use the extension-dev tools in this order:",
        numbered([
          "extension_manifest_validate with projectPath, when the manifest was edited.",
          `extension_dev with projectPath and browser: "${browser(args)}". When a session is already running it says so: keep it; it reloads on each save, and extension_logs shows an edit that did not land.`,
          "Do what a person would do to see the change: extension_open for a surface, a url or the toolbar action, and extension_element_act to click or type.",
          "extension_assert with one expectation per thing that should now be true, and console-errors-empty.",
          "On a fail or an inconclusive check, read extension_logs and extension_dom_snapshot, fix the code and assert again.",
        ]),
        `${READ_EVERY_ANSWER} ${DONE_RULE}`,
        "Report each check's verdict as the tool gave it, then name one next step: the fix a failing check points at, or extension_stop when every check passed.",
      ].join("\n\n"),
  },
  {
    name: "debug-extension",
    title: "Debug an extension that does nothing",
    description: "Find out why a content script, popup, side panel or background script does not do what it should, from a live session.",
    arguments: [
      { name: "symptom", description: "What does not happen, and on which page or surface.", required: true },
      PROJECT_PATH,
      BROWSER,
    ],
    render: (args) =>
      [
        `Debug ${project(args)}. The symptom: ${args.symptom}`,
        "Use the extension-dev tools in this order, and change no code before step 4:",
        numbered([
          `extension_doctor with projectPath: it reads the session leg by leg. With no session, extension_dev with projectPath and browser: "${browser(args)}".`,
          "extension_manifest_validate with projectPath: a match pattern that misses the page, a missing permission or a wrong path is the usual cause.",
          "extension_logs with level: \"error\" for every context, then read the place the symptom names: extension_inspect with the page's url and include: [\"summary\", \"console\", \"extension_roots\"] for a content script, extension_dom_snapshot with context set to the surface for a popup, side panel or options page.",
          "Say the cause in one sentence with the evidence that shows it, then fix it.",
          "extension_assert with the expectation that was failing (content-script-injected {url}, surface-rendered {surface} or background-worker-booted) and console-errors-empty.",
        ]),
        `${READ_EVERY_ANSWER} ${DONE_RULE}`,
        "Report the cause, the fix and each check's verdict, then name one next step.",
      ].join("\n\n"),
  },
  {
    name: "prepare-store-submission",
    title: "Prepare a store submission as a draft",
    description: "Get an extension ready for a store and stop before anything goes to review.",
    arguments: [
      { name: "stores", description: "The stores, comma separated: chrome, firefox, edge, safari. Left out, chrome.", required: false },
      PROJECT_PATH,
    ],
    render: (args, options) => {
      const stores = (args.stores || "chrome")
        .split(",")
        .map((store) => store.trim().toLowerCase())
        .filter(Boolean);
      const list = JSON.stringify(stores);
      const head = `Prepare ${project(args)} for these stores: ${stores.join(", ")}. Nothing goes to review in this task.`;
      const validate = `extension_manifest_validate with projectPath, browsers: ${list} and include: ["storeReadiness"]. Fix every buildBlocking error and report each store readiness line.`;

      if (!isToolListed("extension_submit_check", options)) {
        return [
          head,
          "Use the extension-dev tools in this order:",
          numbered([
            validate,
            "extension_build with projectPath, zip: true and one browser a call. Never zip the source folder by hand.",
            "Report the store review risks the build answer names.",
          ]),
          READ_EVERY_ANSWER,
          "Report what is ready and what is missing, then name one next step. Starting this server with --features=local,platform lists the store submission tools.",
        ].join("\n\n");
      }

      return [
        head,
        "Use the extension-dev tools in this order:",
        numbered([
          validate,
          `extension_submit_read with action: "preflight", browsers: ${list} and projectPath. Follow value.nextStep: when a store is not connected, give the person value.connectUrl and stop until their next message.`,
          `When the preflight says STORE.md covers a failing listing check, extension_submit with action: "sync-listing", browsers: ${list} and projectPath.`,
          `extension_submit_check with browsers: ${list} and the buildSha extension_builds_read lists, leaving dryRun at its default: it rehearses the submit and sends nothing.`,
        ]),
        `${READ_EVERY_ANSWER} A real submit needs the person's clear yes and a workspace owner's approval, and it lands as the least public outcome each store offers unless the project's store settings say otherwise.`,
        "Report what each store still needs and give value.trackUrl, then name one next step: the one value.nextStep says.",
      ].join("\n\n");
    },
  },
];

const listed = (prompt: ServerPrompt) => ({
  name: prompt.name,
  title: prompt.title,
  description: prompt.description,
  arguments: prompt.arguments,
});

export function renderPrompt(name: string, given: Record<string, unknown> | undefined, options: ServerOptions): { description: string; text: string } {
  const prompt = PROMPTS.find((entry) => entry.name === name);

  if (!prompt) {
    throw new McpError(ErrorCode.InvalidParams, `No prompt is named "${name}". Call prompts/list for the names: ${PROMPTS.map((entry) => entry.name).join(", ")}.`);
  }

  const args: Record<string, string> = {};

  for (const argument of prompt.arguments) {
    const value = String(given?.[argument.name] ?? "").trim();

    if (value) args[argument.name] = value;
    else if (argument.required) {
      throw new McpError(ErrorCode.InvalidParams, `The prompt ${name} needs the argument "${argument.name}": ${argument.description} Call prompts/get again with it.`);
    }
  }

  return { description: prompt.description, text: prompt.render(args, options) };
}

export function installPromptHandlers(server: Server, options: ServerOptions): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS.map(listed) }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const rendered = renderPrompt(request.params.name, request.params.arguments, options);

    return {
      description: rendered.description,
      messages: [{ role: "user" as const, content: { type: "text" as const, text: rendered.text } }],
    };
  });
}
