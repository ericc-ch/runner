import { Effect, Formatter, Layer, Ref, Schema, ServiceMap } from "effect"
import type { RequiredHooks, RequiredPlugin, RunInput, RunOutput } from "./types.ts"

export class HookError extends Schema.TaggedErrorClass<HookError>()("HookError", {
  hook: Schema.String,
  cause: Schema.Defect,
}) {}

export class ExecutionError extends Schema.TaggedErrorClass<ExecutionError>()("ExecutionError", {
  cause: Schema.Defect,
}) {}

export class Runner extends ServiceMap.Service<Runner>()("@ericc-ch/runner/Runner", {
  make: Effect.gen(function* () {
    const hooksRef = yield* Ref.make<RequiredHooks[]>([])

    const init = Effect.fn((plugins: RequiredPlugin[]) =>
      Effect.gen(function* () {
        const hooks = yield* Effect.forEach(plugins, (plugin) => Effect.promise(plugin))

        yield* Effect.forEach(hooks, (hook) =>
          Effect.tryPromise({
            try: () => hook.setup(),
            catch: (cause) => new HookError({ hook: "setup", cause }),
          }),
        )

        yield* Ref.set(hooksRef, hooks)
      }),
    )

    const execute = Effect.fn((source: string) =>
      Effect.gen(function* () {
        const hooks = yield* Ref.get(hooksRef)
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
              error: Formatter.format(error),
            }),
            onSuccess: (result) => ({ result, error: undefined }),
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

    const teardown = Effect.gen(function* () {
      const hooks = yield* Ref.get(hooksRef)
      yield* Effect.forEach(
        hooks,
        (hook) =>
          Effect.tryPromise({
            try: () => hook.teardown(),
            catch: (cause) => new HookError({ hook: "teardown", cause }),
          }),
        { discard: true },
      )
      yield* Ref.set(hooksRef, [])
    })

    return { init, execute, teardown }
  }),
}) {
  static readonly layer = Layer.effect(Runner, Runner.make)
}
