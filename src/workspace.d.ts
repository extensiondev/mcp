declare module "extension-create" {
  export interface CreateOptions {
    template?: string;
    install?: boolean;
    cliVersion?: string;
    logger?: { log: (...args: any[]) => void; error: (...args: any[]) => void };
  }

  export interface CreateResult {
    projectPath: string;
    projectName: string;
    template: string;
    depsInstalled: boolean;
  }

  export function extensionCreate(
    projectName: string,
    options: CreateOptions,
  ): Promise<CreateResult>;
}

declare module "extension-develop" {
  export interface BuildOptions {
    browser?: string;
    zip?: boolean;
    zipSource?: boolean;
    exitOnError?: boolean;
    install?: boolean;
    chromiumBinary?: string;
    geckoBinary?: string;
    firefoxBinary?: string;
    [key: string]: unknown;
  }

  export interface BuildSummary {
    [key: string]: unknown;
  }

  export function extensionBuild(
    pathOrRemoteUrl: string | undefined,
    buildOptions?: BuildOptions,
  ): Promise<BuildSummary>;
}

declare module "extension-install" {
  export interface InstallOptions {
    browser: string;
  }

  export function extensionInstall(options: InstallOptions): Promise<void>;
  export function getManagedBrowsersCacheRoot(): string;
  export function getManagedBrowserInstallDir(browser: string): string;
}
