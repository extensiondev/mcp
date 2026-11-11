// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators


export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const reads = (openWorld = false): ToolAnnotations => ({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: openWorld,
});

const acts = (
  over: Partial<Omit<ToolAnnotations, "readOnlyHint">> = {},
): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  ...over,
});

export const TOOL_ANNOTATIONS = {
  extension_create: acts({ openWorldHint: true }),
  extension_templates: reads(true),
  extension_docs_search: reads(true),
  extension_add_feature: reads(),
  extension_build: acts({ idempotentHint: true }),
  extension_dev: acts(),
  extension_start: acts(),
  extension_wait: reads(),
  extension_stop: acts({ idempotentHint: true, destructiveHint: true }),
  extension_manifest_validate: reads(),
  extension_theme_verify: reads(),
  extension_analyze: reads(),
  extension_assert: acts({ idempotentHint: true }),
  extension_inspect: acts({ idempotentHint: true }),
  extension_dom_snapshot: reads(),
  extension_screenshot: acts({ idempotentHint: true }),
  extension_try: acts({ openWorldHint: true }),
  extension_list_extensions: reads(),
  extension_logs: reads(),
  extension_doctor: reads(),
  extension_eval: acts({ destructiveHint: true, openWorldHint: true }),
  extension_storage: acts({ destructiveHint: true }),
  extension_reload: acts({ idempotentHint: true }),
  extension_open: acts({ openWorldHint: true }),
  extension_browsers: acts({ destructiveHint: true, openWorldHint: true }),
  extension_auth: acts({ openWorldHint: true, destructiveHint: true }),
  extension_workspace_create: acts({ openWorldHint: true }),
  extension_project_create: acts({ openWorldHint: true }),
  extension_preview_web: acts({ openWorldHint: true }),
  extension_shares: acts({ destructiveHint: true, openWorldHint: true }),
  extension_publish: acts({ openWorldHint: true }),
  extension_release_status: reads(true),
  extension_approvals: acts({ destructiveHint: true, openWorldHint: true }),
  extension_builds: acts({ destructiveHint: true, openWorldHint: true }),
  extension_workspace: acts({ openWorldHint: true }),
  extension_release_promote: acts({ destructiveHint: true, openWorldHint: true }),
  extension_submit: acts({ destructiveHint: true, openWorldHint: true }),
  extension_submit_check: reads(true),
} satisfies Record<string, ToolAnnotations>;

export function repeatChangesNothing(command: string): boolean {
  const annotations = (TOOL_ANNOTATIONS as Record<string, ToolAnnotations | undefined>)[command];

  return annotations ? annotations.readOnlyHint || annotations.idempotentHint : false;
}
