import { Effect, Schema } from "effect"
import type { RequiredPlugin, RunInput, RunOutput } from "./types"

export class HookError extends Schema.TaggedErrorClass<HookError>()("HookError", {
  hook: Schema.String,
  cause: Schema.Defect,
}) {}

export class ExecutionError extends Schema.TaggedErrorClass<ExecutionError>()("ExecutionError", {
  cause: Schema.Defect,
}) {}

export const run = Effect.fn((source: string, plugins: RequiredPlugin[]) =>
  Effect.gen(function* () {
    const hooks = yield* Effect.forEach(plugins, (plugin) =>
      Effect.acquireRelease(Effect.promise(plugin), (hook) =>
        Effect.promise(() => hook.teardown()),
      ),
    )

    yield* Effect.forEach(
      hooks,
      (hook) =>
        Effect.tryPromise({
          try: () => hook.setup(),
          catch: (cause) => new HookError({ hook: "setup", cause }),
        }),
      { discard: true },
    )

    const currentState: RunInput = { source, context: {} }
    for (const hook of hooks) {
      const result = yield* Effect.tryPromise({
        try: () => hook.beforeRun(currentState),
        catch: (cause) => new HookError({ hook: "beforeRun", cause }),
      })
      if (result) {
        if (result.context) {
          Object.assign(currentState.context, result.context)
        }
        for (const key of Object.keys(result)) {
          if (key !== "context") {
            currentState[key as keyof RunInput] = result[
              key as keyof typeof result
            ] as RunInput[keyof RunInput]
          }
        }
      }
    }

    const currentOutput: RunOutput = yield* Effect.tryPromise({
      try: async () => {
        const params = Object.keys(currentState.context)
        const values = Object.values(currentState.context)
        const fn = new Function(
          ...params,
          `"use strict"; return (async () => {\n${currentState.source}\n})();`,
        )
        return await fn(...values)
      },
      catch: (cause) => new ExecutionError({ cause }),
    }).pipe(
      Effect.match({
        onFailure: (error) => ({
          result: undefined,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
        onSuccess: (result) => ({ result, error: null }),
      }),
    )

    for (const hook of hooks) {
      const result = yield* Effect.tryPromise({
        try: () => hook.afterRun(currentOutput),
        catch: (cause) => new HookError({ hook: "afterRun", cause }),
      })
      if (result) {
        Object.assign(currentOutput, result)
      }
    }

    return currentOutput
  }),
)
