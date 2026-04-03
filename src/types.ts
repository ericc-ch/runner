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

export interface Hooks {
  setup?: () => Promise<void>
  teardown?: () => Promise<void>
  beforeRun?: (input: RunInput) => Promise<Partial<RunInput> | void>
  afterRun?: (input: RunOutput) => Promise<Partial<RunOutput> | void>
}
export type Plugin = () => Promise<Hooks>

export type RequiredHooks = Required<Hooks>
export type RequiredPlugin = () => Promise<RequiredHooks>
