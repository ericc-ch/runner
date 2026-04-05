import { Effect, FileSystem, Layer, Path, Schema, ServiceMap } from "effect"
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
}) {
  static readonly empty: ConfigSchema = { plugins: [] }
}

export function defineConfig(config: ConfigSchema): ConfigSchema {
  return config
}

export class Config extends ServiceMap.Service<Config>()("@ericc-ch/runner/Config", {
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

      const allPlugins = [...(global.plugins ?? []), ...(local.plugins ?? [])]
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
