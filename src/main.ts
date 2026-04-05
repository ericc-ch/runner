export { defaultExecutor, defaultExecutorPlugin } from "./builtins/default-executor.ts"
export { consolePlugin } from "./builtins/console.ts"
export { searchPlugin } from "./builtins/search.ts"
export { Config, ConfigLoadError, ConfigSchema, defineConfig, normalizePlugin } from "./lib/config.ts"
export { paths } from "./lib/paths.ts"
export type {
  Executor,
  ExecutorInput,
  Hooks,
  NormalizedPlugin,
  NormalizedPluginResult,
  Plugin,
  RequiredHooks,
  RunInput,
  RunOutput,
} from "./lib/types.ts"
export {
  ExecutionError,
  HookError,
  noExecutorConfiguredMessage,
  Runner,
} from "./lib/runner.ts"
