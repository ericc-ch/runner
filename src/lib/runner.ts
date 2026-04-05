import { Effect, Formatter, Layer, ServiceMap } from "effect"
import { ExecutionError, HookError, noExecutorConfiguredMessage } from "./errors.ts"
import type { Executor, NormalizedPlugin, RequiredHooks, RunInput, RunOutput } from "./types.ts"

export { ExecutionError, HookError, noExecutorConfiguredMessage } from "./errors.ts"

export class Runner extends ServiceMap.Service<Runner>()("@ericc-ch/runner/Runner", {
  make: Effect.sync(() => {
    let hooks: RequiredHooks[] = []
    let activeExecutor: Executor | undefined

    const init = Effect.fn(function* (plugins: NormalizedPlugin[]) {
      const resolved = yield* Effect.forEach(plugins, (plugin) => Effect.promise(plugin))

      const lastWithExecutor = resolved.findLast((h) => h.executor !== undefined)
      activeExecutor = lastWithExecutor?.executor

      hooks = resolved.map(({ teardown, beforeRun, afterRun }) => ({
        teardown,
        beforeRun,
        afterRun,
      }))
    })

    const execute = Effect.fn(function* (source: string) {
      const executor = activeExecutor
      if (executor === undefined) {
        return yield* Effect.succeed<RunOutput>({
          result: undefined,
          error: noExecutorConfiguredMessage,
        })
      }

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

      const currentOutput = yield* Effect.tryPromise({
        try: () =>
          executor.execute({
            code: currentState.source,
            context: currentState.context,
          }),
        catch: (cause) => new ExecutionError({ cause }),
      }).pipe(
        Effect.match({
          onFailure: (error) => ({
            result: undefined,
            error: Formatter.format(error),
          }),
          onSuccess: (output) => output,
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
    })

    const teardown = Effect.gen(function* () {
      yield* Effect.forEach(
        hooks,
        (hook) =>
          Effect.tryPromise({
            try: () => hook.teardown(),
            catch: (cause) => new HookError({ hook: "teardown", cause }),
          }),
        { discard: true },
      )

      const executor = activeExecutor
      if (executor !== undefined) {
        yield* Effect.tryPromise({
          try: () => executor.teardown?.() ?? Promise.resolve(),
          catch: (cause) => new HookError({ hook: "executor.teardown", cause }),
        })
      }

      hooks = []
      activeExecutor = undefined
    })

    return { init, execute, teardown }
  }),
}) {
  static readonly layer = Layer.effect(Runner, Runner.make)
}
