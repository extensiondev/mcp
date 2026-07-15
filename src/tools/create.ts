import path from "node:path";
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
      parentDir: {
        type: "string",
        description:
          "Directory to create the project inside. Defaults to the MCP server's working directory, which may not be where you expect — pass this explicitly when you care where the project lands.",
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
  parentDir?: string;
  template?: string;
  install?: boolean;
}): Promise<string> {
  const start = Date.now();

  // extensionCreate treats an absolute input as the full project path, so a
  // parentDir just resolves the name against it. Without parentDir the name
  // resolves against the server's cwd (extensionCreate's own default).
  const projectInput = args.parentDir
    ? path.resolve(args.parentDir, args.projectName)
    : args.projectName;

  try {
    const result = await extensionCreate(projectInput, {
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
      nextSteps: [`cd ${result.projectPath}`, "npm run dev"],
    });
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    });
  }
}
