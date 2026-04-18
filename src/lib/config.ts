import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { executorNodeVMPlugin } from "../builtins/executor-node-vm.ts"
import { consolePlugin } from "../builtins/console.ts"
import { searchPlugin } from "../builtins/search.ts"
import { paths } from "./paths.ts"
import type { NormalizedPlugin, Plugin } from "./types.ts"

export class ConfigLoadError extends Schema.TaggedErrorClass<ConfigLoadError>()("ConfigLoadError", {
  cause: Schema.Defect,
}) {}

const isPlugin = (u: unknown): u is Plugin => typeof u === "function"

export const normalizePlugin =
  (plugin: Plugin): NormalizedPlugin =>
  async () => {
    const hooks = await plugin()
    const base = {
      teardown: hooks.teardown ?? (async () => {}),
      beforeRun: hooks.beforeRun ?? (async () => {}),
      afterRun: hooks.afterRun ?? (async () => {}),
    }
    return hooks.executor !== undefined ? { ...base, executor: hooks.executor } : base
  }

const PluginSchema = Schema.declare<Plugin>(isPlugin, {
  title: "Plugin",
  description: "A plugin function that returns hooks",
})

export class ConfigSchema extends Schema.Class<ConfigSchema>("ConfigSchema")({
  plugins: Schema.optional(Schema.Array(PluginSchema)),
  disableBuiltinPlugins: Schema.optional(Schema.Boolean),
}) {
  static readonly empty: ConfigSchema = {
    plugins: [],
    disableBuiltinPlugins: false,
  }
}

export function defineConfig(config: ConfigSchema) {
  return config
}

export interface ConfigShape {
  readonly load: () => Effect.Effect<{ plugins: Array<NormalizedPlugin> }, never, never>
}

export class Config extends Context.Service<Config, ConfigShape>()("@ericc-ch/runner/Config", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    yield* fs.makeDirectory(paths.config, { recursive: true })

    const loadFile = Effect.fn(function* (filePath: string) {
      const imported = yield* Effect.tryPromise({
        try: () => import(filePath) as Promise<{ default: ConfigSchema }>,
        catch: (cause) => new ConfigLoadError({ cause }),
      })
      return imported.default
    })

    const builtinPlugins: Plugin[] = [executorNodeVMPlugin(), consolePlugin(), searchPlugin()]

    const load = Effect.fn(function* () {
      const cwd = yield* Effect.sync(() => process.cwd())

      const globalPath = path.join(paths.config, "config.ts")
      const localPath = path.join(cwd, ".runner/config.ts")

      const global = yield* loadFile(globalPath).pipe(
        Effect.catchTag(
          "ConfigLoadError",
          Effect.fn(function* (error) {
            yield* Effect.logDebug(`Failed to load global config from ${globalPath}`, error.cause)
            return ConfigSchema.empty
          }),
        ),
      )

      const local = yield* loadFile(localPath).pipe(
        Effect.catchTag(
          "ConfigLoadError",
          Effect.fn(function* (error) {
            yield* Effect.logDebug(`Failed to load local config from ${localPath}`, error.cause)
            return ConfigSchema.empty
          }),
        ),
      )

      // Check if built-in plugins should be disabled
      const disableBuiltin =
        global.disableBuiltinPlugins === true || local.disableBuiltinPlugins === true

      // Built-in plugins first, then global, then local
      // Last executor wins, so user plugins can override built-ins
      const allPlugins: Plugin[] = [
        ...(disableBuiltin ? [] : builtinPlugins),
        ...(global.plugins ?? []),
        ...(local.plugins ?? []),
      ]
      yield* Effect.logDebug("Loaded plugins:", allPlugins.length)

      return {
        plugins: allPlugins.map(normalizePlugin),
      }
    })

    return { load }
  }),
}) {
  static readonly layer = Layer.effect(Config, Config.make)
}
