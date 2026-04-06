import { transformSync } from "amaro"
import { Formatter } from "effect"
import ivm from "isolated-vm"
import type { Executor, ExecutorInput, Plugin, RunOutput } from "../lib/types.ts"
import { ExecutionError } from "../lib/errors.ts"

const defaultMemoryLimitMb = 128
const defaultTimeoutMs = 30_000

export type IsolatedVmExecutorOptions = {
  memoryLimitMb?: number
  timeoutMs?: number
  isLiveObject?: (value: unknown) => boolean
}

type ObjectId = string

interface LiveObjectRegistry {
  objects: Map<ObjectId, unknown>
  idCounter: number
}

const PROXY_HELPER_CODE = `
function __createLiveProxy(id, __bridge) {
  return new Proxy(Object.assign(() => {}, { __isLiveProxy: true, __id: id }), {
    get(target, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      if (prop === '__isLiveProxy') return target.__isLiveProxy;
      if (prop === '__id') return target.__id;
      return (...args) => {
        return __bridge(id, prop, args).then(r => {
          if (r && typeof r === 'object' && r.__liveObjectId) {
            return __createLiveProxy(r.__liveObjectId, __bridge);
          }
          return r;
        });
      };
    },
    apply(target, _thisArg, args) {
      return __bridge(id, '__call__', args).then(r => {
        if (r && typeof r === 'object' && r.__liveObjectId) {
          return __createLiveProxy(r.__liveObjectId, __bridge);
        }
        return r;
      });
    }
  });
}
globalThis.__createLiveProxy = __createLiveProxy;
`

function createRegistry(): LiveObjectRegistry {
  return { objects: new Map(), idCounter: 0 }
}

function registerObject(registry: LiveObjectRegistry, obj: unknown): ObjectId {
  const id = `obj_${++registry.idCounter}`
  registry.objects.set(id, obj)
  return id
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

const defaultIsLiveObject = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) return false
  if (isPlainObject(value)) return false
  return true
}

function createBridgeCallback(
  registry: LiveObjectRegistry,
  isLiveObject: (value: unknown) => boolean,
): ivm.Callback {
  return new ivm.Callback(
    async (objectId: string, method: string, args: unknown[]): Promise<unknown> => {
      const obj = registry.objects.get(objectId)
      if (!obj) {
        throw new Error(`Live object not found: ${objectId}`)
      }

      const target = obj as Record<string, unknown>
      let result: unknown

      if (method === "__call__") {
        const fn = target as unknown as (...args: unknown[]) => unknown
        result = await fn(...args)
      } else {
        const prop = target[method]
        if (typeof prop === "function") {
          result = await prop.call(obj, ...args)
        } else {
          result = prop
        }
      }

      if (isLiveObject(result)) {
        const newId = registerObject(registry, result)
        return { __liveObjectId: newId }
      }

      return result
    },
    { async: true },
  )
}

export function createIsolatedVmExecutor(options?: IsolatedVmExecutorOptions): Executor {
  const memoryLimit = Math.max(8, options?.memoryLimitMb ?? defaultMemoryLimitMb)
  const timeout = options?.timeoutMs ?? defaultTimeoutMs
  const isLiveObject = options?.isLiveObject ?? defaultIsLiveObject

  return async ({ code, context }: ExecutorInput): Promise<RunOutput> => {
    const isolate = new ivm.Isolate({ memoryLimit })
    const registry = createRegistry()

    try {
      const contextHandle = await isolate.createContext()
      const globalRef = contextHandle.global

      const bridgeCallback = createBridgeCallback(registry, isLiveObject)
      globalRef.setSync("__bridge", bridgeCallback)

      const setupScript = await isolate.compileScript(`"use strict";\n${PROXY_HELPER_CODE}`, {
        filename: "file:///proxy-helper.js",
      })
      await setupScript.run(contextHandle)

      for (const [key, value] of Object.entries(context)) {
        if (isLiveObject(value)) {
          const id = registerObject(registry, value)
          const proxyCode = `__createLiveProxy(${JSON.stringify(id)}, __bridge)`
          const proxyScript = await isolate.compileScript(proxyCode)
          const proxyHandle = await proxyScript.run(contextHandle, {
            reference: true,
          })
          globalRef.setSync(key, proxyHandle.derefInto())
        } else if (typeof value === "function") {
          const fn = value as (...args: unknown[]) => unknown
          if (fn.constructor.name === "AsyncFunction") {
            throw new Error(
              "isolated-vm executor: async functions in `context` are not supported (Callback cannot return Promises across the isolate boundary). Use a synchronous function or the `new Function` executor for full async host bindings.",
            )
          }
          const callback = new ivm.Callback((...args: unknown[]) => fn(...args), {
            sync: true,
          })
          globalRef.setSync(key, callback)
        } else if (value === undefined) {
          globalRef.setSync(key, null)
        } else {
          try {
            globalRef.setSync(key, value, { copy: true })
          } catch {
            globalRef.setSync(key, new ivm.ExternalCopy(value).copyInto())
          }
        }
      }

      const wrappedCode = `(async () => {\n${code}\n})()`
      const { code: strippedCode } = transformSync(wrappedCode, {
        mode: "strip-only",
      })

      const script = await isolate.compileScript(`"use strict";\n${strippedCode}`, {
        filename: "file:///runner-user-code.js",
      })

      const rawResult = await script.run(contextHandle, {
        ...(timeout > 0 ? { timeout } : {}),
        promise: true,
      })

      let result: unknown = undefined
      if (rawResult instanceof ivm.Reference) {
        result = rawResult.copySync()
      } else {
        result = rawResult
      }

      return { result, error: undefined }
    } catch (cause) {
      const error = new ExecutionError({ cause })
      return { result: undefined, error: Formatter.format(error) }
    } finally {
      isolate.dispose()
    }
  }
}

export const executorIsolatedVm: Executor = createIsolatedVmExecutor()

export const executorIsolatedVmPlugin =
  (options?: IsolatedVmExecutorOptions): Plugin =>
  async () => ({
    executor: createIsolatedVmExecutor(options),
  })
