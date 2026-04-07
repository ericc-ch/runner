# Runner Architecture Plan

## Completed

**Phase 1: Core Abstraction** - ✅ DONE

- Pluggable executor system with explicit registration (`src/lib/runner.ts`, `src/lib/types.ts`)
- `beforeRun` hook for transforms (`src/lib/runner.ts` lines 36-53)
- No implicit fallbacks - explicit executor required (`src/lib/runner.ts` lines 26-32)

**Phase 2: Type Strip Plugin** - ✅ DONE (integrated into executor-new-fn)

- `amaro` dependency in `package.json`
- Type stripping via `transformSync` in `src/builtins/executor-new-fn.ts` (lines 17-20)

## Roadmap

### Phase 3: node:vm Executor ✅ DONE

- [x] Add `node:vm` executor plugin (`src/builtins/executor-node-vm.ts`)
- [x] Create sandboxed context with `globalThis` spread (includes all globals)
- [x] Test with Playwright plugin (closures work)
- [x] Add timeout enforcement (default 30s, configurable via `NodeVMOptions.timeout`)
- [x] Document escape hatch risks in JSDoc

**Notes:**

- Non-enumerable globals (`URL`, `URLSearchParams`) explicitly added since spread operator doesn't copy them
- Timeout uses `Promise.race` to handle async code properly

### Phase 4: Executor Compatibility Documentation ⏳ PENDING

- [ ] Document plugin/executor compatibility matrix
- [ ] Add executor compatibility validation before execution
- [ ] Plugin declares requirements: `{ requiresClosures: true }`

### Phase 5: Security Hooks (Optional) ⏳ PENDING

- [ ] Add `beforeCall` / `afterCall` hooks for auditing
- [ ] Add optional pre-call prompts
- [ ] Add rate limiting example

## Key Constraints

**Live Objects Cannot Be Serialized** - Playwright browser/page instances must remain accessible directly. Functions with closures (e.g., `page.evaluate(() => localVar)`) cannot cross process boundaries.

**The Trade-off:** Security (isolation) vs Closures. Cannot have both.

| Runtime        | Closures | Security | Property Access |
| -------------- | -------- | -------- | --------------- |
| `new Function` | ✅ Yes   | ❌ None  | ✅ Direct       |
| `node:vm`      | ✅ Yes   | ⚠️ Weak  | ✅ Direct       |

**Recommendation:** Playwright plugins use `new Function` or `node:vm`.

## Open Questions

1. **Executor compatibility validation** - Plugin declares `{ requiresClosures: true }`, Runner validates before execution.

2. **Error handling across boundary** - Stack traces lost in IPC. Need careful serialization.

3. **Streaming results** - `page.pdf()` returns large binary. Current: buffer entire result. Future: stream chunks?
