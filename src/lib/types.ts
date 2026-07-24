// ███╗   ███╗ ██████╗██████╗
// ████╗ ████║██╔════╝██╔══██╗
// ██╔████╔██║██║     ██████╔╝
// ██║╚██╔╝██║██║     ██╔═══╝
// ██║ ╚═╝ ██║╚██████╗██║
// ╚═╝     ╚═╝ ╚═════╝╚═╝
// Apache License 2.0 (c) 2026 Cezar Augusto and the extension.dev collaborators

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
  port?: number | null;
  host?: string;
  cdpPort?: number;
  pid?: number;
  ts?: string;
  compiledAt?: string | null;
  executorAttachedAt?: string;
  runtime?: string;
}

export interface ProcessInfo {
  pid: number;
  browser: string;
  port?: number;
  projectPath: string;
  command: "dev" | "start" | "preview";
  noBrowser?: boolean;
}

export type BrowserType =
  | "chrome"
  | "edge"
  | "firefox"
  | "chromium-based"
  | "gecko-based";
