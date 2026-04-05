# Runner Architecture Plan

## Completed

**Phase 1: Core Abstraction** - Pluggable executor system with explicit registration, `beforeRun` hook for transforms, no implicit fallbacks.

**Phase 2: Type Strip Plugin** - `amaro` dependency, `typeStripPlugin` strips TS annotations via `beforeRun`.

## Roadmap

### Phase 3: node:vm Executor

- Add `node:vm` executor plugin
- Create sandboxed context with limited globals
- Test with Playwright plugin (closures should work)
- Add timeout enforcement
- Document escape hatch risks

### Phase 4: isolated-vm Executor

- Add `isolated-vm` dependency
- Implement Reference-based property access with `getSync/copySync`
- Implement `Callback` for function arguments
- Test with Playwright - document closure limitations
- Add memory limits and timeout

### Phase 5: Executor Compatibility Documentation

- Document plugin/executor compatibility matrix
- Add executor compatibility validation before execution
- Plugin declares requirements: `{ requiresClosures: true }`

### Phase 6: Security Hooks (Optional)

- Add `beforeCall` / `afterCall` hooks for auditing
- Add optional pre-call prompts
- Add rate limiting example

## Key Constraints

**Live Objects Cannot Be Serialized** - Playwright browser/page instances must remain accessible directly. Functions with closures (e.g., `page.evaluate(() => localVar)`) cannot cross process boundaries.

**The Trade-off:** Security (isolation) vs Closures. Cannot have both.

| Runtime        | Closures | Security   | Property Access |
| -------------- | -------- | ---------- | --------------- |
| `new Function` | ✅ Yes   | ❌ None    | ✅ Direct       |
| `node:vm`      | ✅ Yes   | ⚠️ Weak    | ✅ Direct       |
| `isolated-vm`  | ❌ No    | ✅ Isolate | ✅ Sync native  |

**Recommendation:** Playwright plugins use `new Function` or `node:vm`. Simple API clients use `isolated-vm` for security.

## Open Questions

1. **Executor compatibility validation** - Plugin declares `{ requiresClosures: true }`, Runner validates before execution.

2. **Error handling across boundary** - Stack traces lost in IPC. Need careful serialization.

3. **Streaming results** - `page.pdf()` returns large binary. Current: buffer entire result. Future: stream chunks?
