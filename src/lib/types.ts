export interface RunInput {
  source: string
  context: Record<string, unknown>
  [key: string]: unknown
}

export type RunOutput = {
  result: unknown
  error: unknown
  [key: string]: unknown
}

export interface ExecutorInput {
  code: string
  context: Record<string, unknown>
}

export type Executor = (input: ExecutorInput) => Promise<RunOutput>

export interface Hooks {
  teardown?: () => Promise<void>
  beforeRun?: (input: RunInput) => Promise<Partial<RunInput> | void>
  afterRun?: (input: RunOutput) => Promise<Partial<RunOutput> | void>
  /** First plugin in config order that sets this wins at init */
  executor?: Executor
}

export type Plugin = () => Promise<Hooks>

/** Per-plugin hooks with every lifecycle hook defined (executor resolved separately). */
export interface RequiredHooks {
  teardown: () => Promise<void>
  beforeRun: (input: RunInput) => Promise<Partial<RunInput> | void>
  afterRun: (output: RunOutput) => Promise<Partial<RunOutput> | void>
}

/** After `normalizePlugin`; `executor` is read once at init then not stored on `RequiredHooks`. */
export type NormalizedPluginResult = RequiredHooks & {
  executor?: Executor
}

export type NormalizedPlugin = () => Promise<NormalizedPluginResult>
