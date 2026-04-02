export interface RunInput {
  source: string
  context: Record<string, unknown>
}

export interface RunOutput {
  result: unknown
  error: Error | null
}

export interface Hooks {
  setup: () => Promise<void>
  teardown: () => Promise<void>
  beforeRun: (input: RunInput) => Promise<Partial<RunInput> | void>
  afterRun: (input: RunOutput) => Promise<Partial<RunOutput> | void>
}

export type Plugin = () => Promise<Hooks>
