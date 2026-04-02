import { Effect, Schema } from "effect"
import type { RequiredPlugin, RunInput, RunOutput } from "./types"

export class HookError extends Schema.TaggedErrorClass<HookError>()("HookError", {
  hook: Schema.String,
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
        Object.assign(currentState, result)
      }
    }

    const currentOutput: RunOutput = yield* Effect.try({
      try: () => {
        const params = Object.keys(currentState.context)
        const fn = new Function(
          ...params,
          `"use strict"; return (async () => {\n${currentState.source}\n})();`,
        )
        return fn(...Object.values(currentState.context))
      },
      catch: (error: unknown): unknown => error,
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
