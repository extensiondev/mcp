import { extensionCreate } from "extension-create";

export const schema = {
  name: "extension_create",
  description:
    "Create a new browser extension project from a template in the extension.dev template catalog. Use extension_list_templates to see available options.",
  inputSchema: {
    type: "object" as const,
    properties: {
      projectName: {
        type: "string",
        description: "Name of the extension project (used as directory name)",
      },
      template: {
        type: "string",
        default: "typescript",
        description:
          "Template slug from the extension.dev template catalog (e.g. 'react', 'sidebar-claude', 'content-vue'). Use extension_list_templates to discover options.",
      },
      install: {
        type: "boolean",
        default: true,
        description: "Install dependencies after creation",
      },
    },
    required: ["projectName"],
  },
};

export async function handler(args: {
  projectName: string;
  template?: string;
  install?: boolean;
}): Promise<string> {
  const start = Date.now();

  try {
    const result = await extensionCreate(args.projectName, {
      template: args.template ?? "typescript",
      install: args.install ?? true,
      logger: {
        log: () => {},
        error: () => {},
      },
    });

    return JSON.stringify({
      projectPath: result.projectPath,
      projectName: result.projectName,
      template: result.template,
      depsInstalled: result.depsInstalled,
      duration: Date.now() - start,
      nextSteps: [`cd ${result.projectName}`, "npm run dev"],
    });
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    });
  }
}
