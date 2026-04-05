import { Schema } from "effect"

export class HookError extends Schema.TaggedErrorClass<HookError>()("HookError", {
  hook: Schema.String,
  cause: Schema.Defect,
}) {}

export class ExecutionError extends Schema.TaggedErrorClass<ExecutionError>()("ExecutionError", {
  cause: Schema.Defect,
}) {}

/** Shown in `RunOutput.error` when no plugin supplied `hooks.executor`. */
export const noExecutorConfiguredMessage =
  'No executor configured. Add a plugin that sets `executor` (e.g. `defaultExecutorPlugin()` from "@ericc-ch/runner").' as const
