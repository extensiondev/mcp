// Minimal ambient types for cross-spawn (no @types/cross-spawn dependency).
// cross-spawn's default export is a drop-in for child_process.spawn that runs
// without a shell and resolves .cmd shims on Windows safely. We only use the
// default export.
declare module "cross-spawn" {
  import type { ChildProcess, SpawnOptions } from "node:child_process";
  function spawn(
    command: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ): ChildProcess;
  export = spawn;
}
