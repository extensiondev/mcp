// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// MIT License (c) Cezar Augusto and the extension.dev collaborators

export interface TemplateMeta {
  slug: string;
  name: string;
  title?: string;
  version: string;
  manifest_version: number;
  description: string;
  uiContext: string[];
  surfaces: string[];
  entrypoints: string[];
  uiFramework: string;
  css: string;
  configFiles: string[];
  hasBackground: boolean;
  hasEnv: boolean;
  permissions: string[];
  host_permissions: string[];
  optional_permissions: string[];
  featured: boolean;
  tags?: string[];
  difficulty?: "beginner" | "intermediate" | "advanced";
  timeToFirstSuccessMinutes?: number;
  firstSteps?: string[];
  useCases?: string[];
  docsUrl?: string;
  files: string[];
  browsers: string[];
  screenshot: string | null;
  icon: string | null;
  downloads?: Record<string, string>;
  repositoryUrl?: string;
  aiPromptExamples?: string[];
  aiRecommendFor?: string[];
  patternExplanation?: string;
  keyFiles?: string[];
}

export interface TemplatesMetaV2 {
  version: "2";
  sourceRepo: string;
  generatorVersion: string;
  commit: string;
  generatedAt: string;
  templates: TemplateMeta[];
}

export interface ReadyContract {
  status: "starting" | "ready" | "error" | "stopped";
  message?: string;
  errors?: string[];
  code?: string;
  browserExitCode?: number | null;
  browserExitedAt?: string;
  command: "dev" | "start";
  browser: string;
  runId?: string;
  startedAt?: string;
  distPath?: string;
  manifestPath?: string;
  // The engine allocates the real dev-server port BEFORE it creates the
  // metadata writer, so this is the port it actually bound, not the one that
  // was requested. Tools must report ports from here, never from their args.
  port?: number | null;
  host?: string;
  cdpPort?: number;
  pid?: number;
  ts?: string;
  compiledAt?: string | null;
  // Stamped by the engine when the extension's runtime executor connects.
  // Never appears in a noBrowser (build-only) session.
  executorAttachedAt?: string;
  runtime?: string;
}

export interface ProcessInfo {
  pid: number;
  browser: string;
  port?: number;
  projectPath: string;
  command: "dev" | "start" | "preview";
  // True for build-only sessions (dev --no-browser): no browser will launch,
  // so no executor will ever attach. extension_wait reads this to return
  // immediately at compile time instead of waiting out an attach that cannot
  // happen.
  noBrowser?: boolean;
}

export type BrowserType =
  | "chrome"
  | "edge"
  | "firefox"
  | "chromium-based"
  | "gecko-based";
