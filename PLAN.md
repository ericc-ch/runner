# Runner Architecture Evolution

## Current State

The runner currently executes TypeScript/JavaScript code using `new Function()`:

```ts
// src/lib/runner.ts:44-52
const fn = new Function(
  ...params,
  `"use strict"; return (async () => {\n${currentState.source}\n})();`,
);
return await fn(...values);
```

**Characteristics:**

- Direct execution in same Node.js process
- Live objects passed directly via context (browser, page, db connections)
- No isolation between user code and host environment
- No resource limits (memory, CPU, time)
- TypeScript requires manual transpilation (currently not implemented)

## Core Constraints

### 1. Live Objects Cannot Be Serialized

Plugins provide live objects that must remain accessible in user code:

```ts
// .runner/plugins/playwright.ts
beforeRun: async () => ({
  context: {
    browser, // Playwright Browser instance
    context, // BrowserContext instance
    page, // Page instance
  },
});
```

These objects have state, methods, and async operations that cannot be:

- Serialized to JSON
- Cloned via structured clone algorithm
- Transferred across process boundaries

**Constraint:** Any execution method must allow user code to call methods on these objects.

### 2. TypeScript Support Required

User code is TypeScript, not JavaScript. This means:

- Need transpilation before execution
- Type information is for development only (runtime is JS)
- Different runtimes have different capabilities

### 3. Security Concerns

Current `new Function()` approach has security issues:

- User code has access to all Node.js globals
- Can access `process.env`, `require`, filesystem
- Can escape via prototype pollution: `({}).constructor.constructor("return process")()`
- No memory/CPU/time limits
- No audit trail of what was called

## The Proxy/RPC Pattern

### Architecture Overview

This pattern decouples **where code runs** from **where objects live**:

```
┌─────────────────────────────────────────────────────────────────┐
│  Runtime (Isolated Sandbox)                                     │
│                                                                 │
│  User code executes here:                                       │
│    context.page.click({ selector: 'button' })                   │
│       ↓                                                         │
│    Proxy traps property access                                  │
│       ↓                                                         │
│    Builds call path: ['page', 'click']                          │
│       ↓                                                         │
│    Creates pending Promise with requestId                       │
│       ↓                                                         │
│    Send IPC: { type: 'call', requestId, objectId, method, args }│
│       ↓                                                         │
│    Return Promise (awaits response)                             │
│                                                                 │
│  Runtime has NO access to:                                      │
│    - Node.js globals (process, require, Buffer, etc.)           │
│    - Host filesystem                                            │
│    - Host network (unless explicitly allowed)                   │
│    - Actual live objects                                        │
└─────────────────────────────────────────────────────────────────┘
                      ↕ IPC Channel
┌─────────────────────────────────────────────────────────────────┐
│  Host (Main Node.js Process)                                    │
│                                                                 │
│  Receives IPC: { type: 'call', requestId, objectId, method }    │
│       ↓                                                         │
│  Lookup real object: context[objectId]                          │
│       ↓                                                         │
│  Call method: object[method](args)                              │
│       ↓                                                         │
│  Send IPC: { type: 'response', requestId, result/error }        │
└─────────────────────────────────────────────────────────────────┘
```

### Reference Implementation (executor)

Executor uses this pattern with multiple runtime implementations:

#### 1. QuickJS Runtime (quickjs-emscripten)

**File:** `/tmp/executor/packages/kernel/runtime-quickjs/src/index.ts`

```ts
// Create tool bridge - function that handles calls from sandbox
const createToolBridge = (
  context: QuickJSContext,
  toolInvoker: ToolInvoker,
  pendingDeferreds: Set<QuickJSDeferredPromise>,
): QuickJSHandle =>
  context.newFunction("__executor_invokeTool", (pathHandle, argsHandle) => {
    const path = context.getString(pathHandle);
    const args = context.dump(argsHandle);
    const deferred = context.newPromise();
    pendingDeferreds.add(deferred);

    // Execute in host process
    void Effect.runPromise(toolInvoker.invoke({ path, args })).then(
      (value) => {
        const serialized = JSON.stringify(value);
        deferred.resolve(context.newString(serialized));
      },
      (cause) => {
        deferred.reject(context.newError(toErrorMessage(cause)));
      },
    );

    return deferred.handle; // Return promise to sandbox
  });
```

**Sandbox-side proxy generation:**

```ts
// Injected into sandbox before user code
const __makeToolsProxy = (path = []) =>
  new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return __makeToolsProxy([...path, String(prop)]); // Chain path
    },
    apply(_target, _thisArg, args) {
      const toolPath = path.join(".");
      if (!toolPath) throw new Error("Tool path missing");
      // Call bridge function, parse JSON result
      return Promise.resolve(__invokeTool(toolPath, args[0])).then((raw) =>
        raw === undefined ? undefined : JSON.parse(raw),
      );
    },
  });
const tools = __makeToolsProxy();
```

**IPC Mechanism:** Direct function call bridge (same memory, different context)

**Capabilities:**

- Memory limit enforcement: `runtime.setMemoryLimit(bytes)`
- Stack size limit: `runtime.setMaxStackSize(bytes)`
- Timeout via interrupt handler: `runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline))`
- Completely isolated from Node.js

#### 2. SES Runtime (SES/Compartment)

**File:** `/tmp/executor/packages/kernel/runtime-ses/src/index.ts`

Uses Node.js child process with IPC (`process.send`):

```ts
// Host process
const onMessage = (message: WorkerMessage) => {
  if (message.type === "tool-call") {
    void Effect.runPromise(
      toolInvoker.invoke({ path: message.path, args: message.args }),
    ).then((value) => {
      sendMessage(child, {
        type: "tool-response",
        callId: message.callId,
        value,
      });
    });
  }
};
```

**Worker process (`sandbox-worker.mjs`):**

```ts
// Proxy in worker
const makeToolsProxy = (path = []) =>
  new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return makeToolsProxy([...path, prop]);
    },
    apply(_target, _thisArg, args) {
      const callId = `call_${nextCallId++}`;
      return new Promise((resolve, reject) => {
        pendingToolCalls.set(callId, { resolve, reject });
        process.send?.({
          type: "tool-call",
          callId,
          path: path.join("."),
          args: args[0],
        });
      });
    },
  });

// Handle responses from host
process.on("message", (message) => {
  if (message.type === "tool-response") {
    const pending = pendingToolCalls.get(message.callId);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.value);
  }
});
```

**IPC Mechanism:** Node.js `process.send()` / `child.on('message')`

**Capabilities:**

- SES lockdown restricts globals
- `Compartment` provides isolated evaluation
- Optional fetch blocking
- Timeout via process kill

#### 3. Deno Subprocess Runtime

**File:** `/tmp/executor/packages/kernel/runtime-deno-subprocess/src/index.ts`

Uses stdin/stdout with JSON lines:

```ts
// IPC protocol with prefix to distinguish from user output
const IPC_PREFIX = "@@executor-ipc@@";

// Host sends
const writeMessage = (stdin: NodeJS.WritableStream, message) => {
  stdin.write(`${JSON.stringify(message)}\n`);
};

// Host receives
const handleStdoutLine = (rawLine: string) => {
  const line = rawLine.trim();
  if (!line.startsWith(IPC_PREFIX)) return;

  const message = JSON.parse(line.slice(IPC_PREFIX.length));
  if (message.type === "tool_call") {
    const result = await toolInvoker.invoke({
      path: message.toolPath,
      args: message.args,
    });
    writeMessage(stdin, {
      type: "tool_result",
      requestId,
      ok: true,
      value: result,
    });
  }
};
```

**Worker process (`deno-subprocess-worker.mjs`):**

```ts
const writeIpcMessage = (message) => {
  const payload = `${IPC_PREFIX}${JSON.stringify(message)}\n`;
  Deno.stdout.writeSync(encoder.encode(payload));
};

const createToolCaller = (toolPath) => (args) =>
  new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pendingToolCalls.set(requestId, { resolve, reject });
    writeIpcMessage({ type: "tool_call", requestId, toolPath, args });
  });

// Read responses from stdin
const decodeLines = async () => {
  const reader = Deno.stdin.readable.getReader();
  // Parse JSON lines, handle tool_result messages
};
```

**IPC Mechanism:** stdin/stdout JSON lines with prefix

**Capabilities:**

- Full process isolation (separate OS process)
- Deno permission flags: `--deny-net --deny-read --deny-write --deny-env --deny-run`
- Timeout via process kill
- Different runtime (Deno instead of Node)

### IPC Channel Options

| Channel              | Implementation      | Latency | Complexity |
| -------------------- | ------------------- | ------- | ---------- |
| Direct function call | QuickJS bridge      | ~0ms    | Low        |
| `process.send()`     | Node child_process  | ~1ms    | Low        |
| stdin/stdout JSON    | Child process       | ~5ms    | Medium     |
| Worker postMessage   | Node worker_threads | ~1ms    | Medium     |
| HTTP/WebSocket       | Remote process      | ~50ms   | High       |

### Security Analysis

#### What the Pattern Actually Provides

| Concern                           | `new Function()`                           | Proxy/RPC Pattern                 |
| --------------------------------- | ------------------------------------------ | --------------------------------- |
| Access `process.env`              | ✅ Yes                                     | ❌ No (isolated)                  |
| Access `require('fs')`            | ✅ Yes                                     | ❌ No (isolated)                  |
| Access Node globals               | ✅ Yes                                     | ❌ No (isolated)                  |
| Prototype pollution escape        | ✅ `({}).constructor.constructor("...")()` | ❌ No (no access to constructors) |
| Call `page.click()`               | ✅ Yes                                     | ✅ Yes (proxied)                  |
| Call `page.evaluate(maliciousJS)` | ✅ Yes                                     | ✅ Yes (same danger)              |
| Call `browser.newContext()`       | ✅ Yes                                     | ✅ Yes (proxied)                  |
| Memory limits                     | ❌ No                                      | ✅ Yes (QuickJS/SES enforce)      |
| CPU limits                        | ❌ No                                      | ⚠️ Partial (timeout/interrupt)    |
| Timeout enforcement               | ⚠️ Manual Promise timeout                  | ✅ Yes (runtime kill/interrupt)   |
| Audit trail                       | ❌ No                                      | ✅ Yes (can log all IPC calls)    |
| Pre-call prompts                  | ❌ No                                      | ✅ Yes (intercept at host)        |
| Rate limiting                     | ❌ No                                      | ✅ Yes (intercept at host)        |

#### Key Insight

**The proxy pattern isolates WHERE code runs, not WHAT it can do with exposed objects.**

Security benefits come from:

1. **Execution environment isolation** - code cannot escape sandbox to access host internals
2. **Resource enforcement** - memory/time limits prevent runaway code
3. **Interception points** - hooks before forwarding calls enable:
   - Audit logging
   - User prompts ("Allow page.click?")
   - Rate limiting
   - Policy enforcement (deny certain methods)
4. **No prototype pollution escape** - sandbox has no access to host constructors

**But:** If you expose a browser via proxy, user code can still:

- Navigate anywhere: `page.goto('malicious.com')`
- Execute arbitrary JS in browser: `page.evaluate('steal cookies')`
- Access browser storage: `context.storageState()`

**The security is in WHAT you proxy and HOW you gatekeep it, not the pattern itself.**

### Security Through Gatekeeping

The pattern enables security hooks that `new Function()` cannot:

```ts
// Example: Auditing all calls
const toolInvoker = {
  invoke: async ({ path, args }) => {
    auditLog({ timestamp: Date.now(), path, args });

    // Example: Require user approval for navigation
    if (path === "page.goto" || path.startsWith("browser.")) {
      const approved = await promptUser(
        `Allow ${path}(${JSON.stringify(args)})?`,
      );
      if (!approved) throw new Error("User denied");
    }

    // Example: Rate limit
    if (rateLimiter.exceeded(path)) {
      throw new Error("Rate limit exceeded");
    }

    // Actually call the method
    return actualObject[path.split(".")[0]][path.split(".")[1]](args);
  },
};
```

## Runtime Implementation Details

### The Core Problem: Async Proxy Limitation

JavaScript Proxy `get()` trap must return a value **immediately** (synchronously):

```ts
const proxy = new Proxy(
  {},
  {
    get(target, prop) {
      // This function signature requires immediate return
      // Cannot return Promise, cannot await anything
      return ipc.sendAndWait({ type: "get", prop }); // WRONG - returns Promise
    },
  },
);

const value = proxy.property; // User expects value, gets Promise
await proxy.property; // Wrong usage - property access shouldn't need await
```

This is a fundamental JavaScript limitation. Property access (`obj.prop`) is synchronous by design.

**Executor's workaround:** Treat everything as method calls:

```ts
tools.page.url; // Returns Proxy, not the URL string
tools.page.url(); // apply() trap → IPC → Promise → await gives value
```

**Problem for Runner:** Playwright has actual properties, not just methods:

```ts
page.viewportSize; // Property - can't proxy via executor pattern
page.url(); // Method - works with executor pattern
response.url; // Property - can't proxy
response.status(); // Method - works
```

**Functions also cannot cross boundary:** Methods like `page.evaluate(fn)` or `page.waitForFunction(fn)` accept function arguments. Functions contain:

- Code logic
- Closure references (variables from surrounding scope)
- Cannot be serialized to JSON
- Even `fn.toString()` loses closure context

```ts
// In sandbox
const config = { timeout: 5000 };
await page.evaluate(() => config.timeout); // config is in sandbox, not host!
// Playwright can't access sandbox closure
```

**Bidirectional calls are impossible with simple IPC:**

```ts
page.route("**/*.png", async (route, request) => {
  // Playwright CALLS THIS when request comes
  // route/request objects come from Playwright (host side)
  // Handler needs to run in sandbox but use host objects
  await route.fulfill({ body: "blocked" }); // route is in host, handler in sandbox
});
```

This requires reverse proxy: host calling sandbox. Complex problem.

### Option 1: new Function (Current Approach)

**Implementation:**

```ts
const params = Object.keys(context);
const values = Object.values(context);
const fn = new Function(
  ...params,
  `"use strict"; return (async () => {\n${source}\n})();`,
);
return await fn(...values);
```

**Capabilities:**

| Feature           | Support   | Notes                                                   |
| ----------------- | --------- | ------------------------------------------------------- |
| Property access   | ✅ Direct | `page.viewportSize` works immediately                   |
| Method calls      | ✅ Direct | `page.click()` works                                    |
| Functions as args | ✅ Direct | `page.evaluate(() => {...})` works, closures accessible |
| Object mutation   | ✅ Direct | `page.viewport = {...}` works                           |
| Object inspection | ✅ Direct | `Object.keys(page)` works                               |
| Security          | ❌ None   | Access to all Node.js globals                           |
| Memory limits     | ❌ No     | Can allocate unlimited memory                           |
| Timeout           | ⚠️ Manual | Need Promise.race with timeout                          |
| Prototype escape  | ❌ Yes    | `({}).constructor.constructor("return process")()`      |

**Security vulnerabilities:**

```ts
// User code can:
process.env; // Read all environment variables
require("fs").readFileSync(); // Access filesystem
global(
  // Access Node.js globals
  {},
).constructor.constructor("return this")(); // Escape to global scope
```

**Pros:**

- Simplest implementation
- Zero latency
- Works with any object, any method, any property
- Functions with closures work perfectly

**Cons:**

- Zero security
- No resource limits
- User code has full Node.js access
- Can't intercept/audit calls

**Use case:** Development, trusted code, internal tools where security is not a concern.

### Option 2: node:vm

**Implementation:**

```ts
import vm from "node:vm";

const context = vm.createContext({
  page: pageObject,
  browser: browserObject,
  console: { log: (...args) => logs.push(args) },
  // No process, require, global, etc.
});

const script = new vm.Script(transpiledCode);
script.runInContext(context, { timeout: 5000 });
```

**Capabilities:**

| Feature           | Support     | Notes                              |
| ----------------- | ----------- | ---------------------------------- |
| Property access   | ✅ Direct   | Objects passed directly to context |
| Method calls      | ✅ Direct   | Same as new Function               |
| Functions as args | ✅ Direct   | Closures work (same context)       |
| Object mutation   | ✅ Direct   | Works                              |
| Object inspection | ✅ Direct   | Works                              |
| Security          | ⚠️ Weak     | Sandbox but escape hatches exist   |
| Memory limits     | ❌ No       | Same as new Function               |
| Timeout           | ✅ Yes      | `runInContext({ timeout: ms })`    |
| Prototype escape  | ⚠️ Possible | Some escape hatches documented     |

**Security issues:**

```ts
// Escape hatches in vm:
const vm = require("node:vm");
const context = vm.createContext({});

// This can still escape:
const script = new vm.Script(
  'this.constructor.constructor("return process")()',
);
const process = script.runInContext(context);
process.env; // Still accessible!
```

Node.js documentation explicitly states: "vm module is not a security mechanism. Do not use it to run untrusted code."

**Mitigation attempts:**

```ts
// Create context with limited globals
const sandbox = Object.freeze({
  page: pageObject,
  console: mockConsole,
  setTimeout: limitedSetTimeout,
  // Explicitly no process, require, global, constructor access
});

const context = vm.createContext(sandbox);
```

But prototype chain escapes still possible. Use `vm.runInNewContext()` for slightly better isolation.

**Pros:**

- Simple implementation
- Zero latency (same process)
- Works with any object
- Functions with closures work
- Timeout enforcement built-in

**Cons:**

- Weak security (not designed for untrusted code)
- No memory limits
- Escape hatches documented
- Same process (no isolation)

**Use case:** Mild isolation for semi-trusted code, internal tools with timeout requirements.

### Option 3: Atomics.wait + Worker Thread

**Architecture:**

```
┌────────────────────────────────────────────────────────────┐
│  Worker Thread (Sandbox)                                   │
│                                                            │
│  const proxy = new Proxy({}, {                             │
│    get(target, prop) {                                     │
│      // Write request to SharedArrayBuffer                 │
│      writeRequest(sab, { type: 'get', objectId, prop })    │
│      view[0] = REQUEST_PENDING                             │
│                                                            │
│      // BLOCK synchronously until main responds            │
│      Atomics.wait(view, 0, REQUEST_PENDING)                │
│                                                            │
│      // Main has written result to sab                      │
│      return readResult(sab)                                │
│    },                                                      │
│    apply(target, thisArg, args) {                          │
│      // Similar blocking pattern                           │
│    }                                                       │
│  })                                                        │
│                                                            │
│  const viewport = proxy.viewport  // Blocks until response │
└────────────────────────────────────────────────────────────┘
                ↕ SharedArrayBuffer (SAB)
┌────────────────────────────────────────────────────────────┐
│  Main Thread (Monitor Thread)                              │
│                                                            │
│  // Dedicated thread monitoring SAB                         │
│  while (true) {                                            │
│    Atomics.wait(view, 0, IDLE)                             │
│                                                            │
│    const request = readRequest(sab)                        │
│    const obj = context[request.objectId]                   │
│    const value = obj[request.prop]                         │
│                                                            │
│    writeResult(sab, value)                                 │
│    view[0] = IDLE                                          │
│    Atomics.notify(view, 0)  // Wake worker                 │
│  }                                                         │
└────────────────────────────────────────────────────────────┘
```

**Implementation:**

```ts
// Worker thread
import { Worker, parentPort } from "node:worker_threads";

const sab = new SharedArrayBuffer(16384); // 16KB for JSON payloads
const view = new Int32Array(sab, 0, 4); // Control flags
const buffer = new Uint8Array(sab, 4); // JSON payload area

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeRequest(data: object) {
  const json = JSON.stringify(data);
  const bytes = encoder.encode(json);
  buffer.set(bytes);
  view[1] = bytes.length; // Store length
}

function readResult(): unknown {
  const length = view[2];
  const bytes = buffer.slice(0, length);
  const json = decoder.decode(bytes);
  return JSON.parse(json);
}

const proxy = new Proxy(
  {},
  {
    get(target, prop) {
      writeRequest({ type: "get", objectId: "page", prop: String(prop) });
      view[0] = REQUEST_GET;

      // BLOCK HERE - worker pauses until main responds
      Atomics.wait(view, 0, REQUEST_GET);

      return readResult();
    },

    apply(target, thisArg, args) {
      writeRequest({
        type: "call",
        objectId: "page",
        method: "click",
        args: args[0],
      });
      view[0] = REQUEST_CALL;

      Atomics.wait(view, 0, REQUEST_CALL);
      return readResult();
    },
  },
);

// Main thread (needs dedicated thread - can't use Node.js event loop)
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";

// Option A: Use another Worker as monitor thread
const monitorWorker = new Worker("./monitor.js");

// Option B: Use separate Node.js process
const monitorProcess = spawn("node", ["monitor.js"]);

// In monitor thread/process:
const view = new Int32Array(sab, 0, 4);
const buffer = new Uint8Array(sab, 4);

function readRequest(): object {
  const length = view[1];
  const bytes = buffer.slice(0, length);
  return JSON.parse(decoder.decode(bytes));
}

function writeResult(data: unknown) {
  const json = JSON.stringify(data);
  const bytes = encoder.encode(json);
  buffer.set(bytes);
  view[2] = bytes.length;
}

while (true) {
  // Wait for worker request
  Atomics.wait(view, 0, IDLE, Infinity);

  const request = readRequest();

  if (request.type === "get") {
    const obj = context[request.objectId];
    const value = obj[request.prop];
    writeResult(value);
  } else if (request.type === "call") {
    const obj = context[request.objectId];
    const result = await obj[request.method](request.args);
    writeResult(result);
  }

  view[0] = IDLE;
  Atomics.notify(view, 0); // Wake worker
}
```

**Capabilities:**

| Feature           | Support             | Notes                              |
| ----------------- | ------------------- | ---------------------------------- |
| Property access   | ✅ Sync via SAB     | Blocks worker until response       |
| Method calls      | ✅ Sync via SAB     | Blocks worker until response       |
| Functions as args | ❌ No               | Only JSON-serializable values      |
| Object mutation   | ⚠️ Via IPC          | `page.prop = value` needs set trap |
| Object inspection | ❌ No               | `Object.keys(page)` can't proxy    |
| Security          | ✅ Worker isolation | Separate thread, no Node.js access |
| Memory limits     | ✅ Worker           | Can limit worker memory            |
| Timeout           | ⚠️ Complex          | Need separate timeout mechanism    |
| Latency           | ~1-5ms              | Each access requires IPC roundtrip |

**Limitations:**

1. **JSON-only values:** Can only pass primitives and JSON-serializable objects

   ```ts
   // Works:
   const url = proxy.url                  // string - OK
   const viewport = proxy.viewportSize    // object - OK (JSON)

   // Doesn't work:
   proxy.route('**', handler => {...})    // handler is function - FAILS
   proxy.evaluate(() => document.title)   // function arg - FAILS
   ```

2. **Dedicated monitor thread:** Main Node.js thread can't block with `Atomics.wait()`
   - Must use separate Worker or child process as monitor
   - Adds complexity and overhead

3. **SharedArrayBuffer requirements:**
   - Requires `--experimental-shared-memory` flag
   - Or proper CORS headers in browser: `Cross-Origin-Opener-Policy: same-origin`
   - Security restrictions on SharedArrayBuffer

4. **Functions can't cross boundary:**
   - No way to pass function from sandbox to host
   - `page.evaluate(fn)` impossible
   - `page.route(pattern, handler)` impossible

5. **Reverse calls impossible:**
   - Host can't call into sandbox for callbacks
   - Event handlers (`page.on('response', handler)`) won't work

**Pros:**

- Synchronous property access (unique capability)
- Worker thread isolation
- No C++ bindings (pure JS)
- Works with any Worker-compatible runtime

**Cons:**

- Functions cannot cross boundary (JSON only)
- Complex architecture (monitor thread required)
- SharedArrayBuffer setup requirements
- Can't handle bidirectional calls

**Use case:** Simple browser automation (click, navigate, read properties), APIs with pure JSON args, computation tasks.

**NOT suitable for:** Complex Playwright patterns with function args, event handlers, callbacks.

### Option 4: isolated-vm

**Architecture:**

```
┌─────────────────────────────────────────────────────────────┐
│  Isolate (V8 Isolate)                                       │
│                                                             │
│  Separate V8 heap, completely isolated from host            │
│                                                             │
│  const pageRef = ... // Reference from host                 │
│                                                             │
│  // Native synchronous operations!                          │
│  const viewportRef = pageRef.getSync('viewportSize')        │
│  const viewport = viewportRef.copySync()                    │
│                                                             │
│  // Proxy wrapper                                           │
│  const proxy = new Proxy({}, {                              │
│    get(target, prop) {                                      │
│      return pageRef.getSync(prop).copySync()                │
│    },                                                       │
│    apply(target, thisArg, args) {                           │
│      return pageRef.getSync(method)                         │
│        .applySync(undefined, args, { result: { copy: true } }) │
│    }                                                        │
│  })                                                         │
│                                                             │
│  const viewport = proxy.viewportSize  // Works sync!        │
└─────────────────────────────────────────────────────────────┘
              ↕ Reference handles (C++ bridge)
┌─────────────────────────────────────────────────────────────┐
│  Host (Main V8 Isolate)                                     │
│                                                             │
│  const pageRef = new Reference(pageObject)                  │
│  context.global.set('page', pageRef.derefInto())            │
│                                                             │
│  // Reference operations happen here when isolate calls     │
│  // getSync, copySync, applySync                            │
└─────────────────────────────────────────────────────────────┘
```

**Implementation:**

```ts
import ivm from "isolated-vm";

const isolate = new ivm.Isolate({
  memoryLimit: 128, // 128MB
  onCatastrophicError: (err) => {
    console.error("Isolate crashed:", err);
    process.abort();
  },
});

const context = await isolate.createContext();

// Create references to host objects
const pageRef = new ivm.Reference(pageObject);
const browserRef = new ivm.Reference(browserObject);

// Inject into isolate
context.global.set("page", pageRef.derefInto(), { reference: true });
context.global.set("browser", browserRef.derefInto(), { reference: true });

// Setup proxy helper in isolate
const proxySetup = await isolate.compileScript(`
  // Create proxy that uses synchronous Reference operations
  function createProxy(ref, objectId) {
    return new Proxy({}, {
      get(target, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined
        
        // Native synchronous property access!
        const propRef = ref.getSync(prop)
        const typeofProp = propRef typeof
        
        // If it's a function, return callable proxy
        if (typeofProp === 'function') {
          return (...args) => {
            return propRef.applySync(undefined, args, { 
              result: { copy: true },
              arguments: { copy: true }
            })
          }
        }
        
        // Otherwise copy the value
        return propRef.copySync()
      },
      
      set(target, prop, value) {
        ref.setSync(prop, value, { arguments: { copy: true } })
        return true
      }
    })
  }
  
  // Wrap injected references
  const page = createProxy(pageRef, 'page')
  const browser = createProxy(browserRef, 'browser')
  
  // Console
  const console = {
    log: (...args) => __log('log', args.join(' ')),
    error: (...args) => __log('error', args.join(' '))
  }
`);
await proxySetup.run(context);

// Setup log bridge
const logCallback = new ivm.Callback(
  (level, message) => {
    logs.push(`[${level}] ${message}`);
  },
  { sync: true },
);
context.global.set("__log", logCallback);

// Execute user code
const script = await isolate.compileScript(transpiledCode, {
  filename: "user-code.ts",
});

const result = await script.run(context, {
  timeout: 5000, // 5 second timeout
  result: { copy: true }, // Copy result back
});

// Cleanup
isolate.dispose();
```

**Reference API (synchronous operations):**

```ts
class Reference<T> {
  // Property access - SYNCHRONOUS!
  getSync(prop): Reference<T[prop]>; // Returns reference to property
  setSync(prop, value): void; // Sets property
  deleteSync(prop): void; // Deletes property

  // Value extraction - SYNCHRONOUS!
  copySync(): T; // Copies value to current isolate
  deref(): T; // Get actual value (if in owning isolate)

  // Method calls - SYNCHRONOUS!
  applySync(receiver, args, options): Result;

  // Async variants also available
  get(prop): Promise<Reference>;
  apply(receiver, args, options): Promise<Result>;

  // Special: Call from isolate into host with async support
  applySyncPromise(receiver, args, options): Result;
  // Only works when calling FROM isolate INTO host
  // Allows isolate to await host's async operations
}
```

**Capabilities:**

| Feature           | Support       | Notes                              |
| ----------------- | ------------- | ---------------------------------- |
| Property access   | ✅ Sync       | `ref.getSync(prop).copySync()`     |
| Property write    | ✅ Sync       | `ref.setSync(prop, value)`         |
| Method calls      | ✅ Sync       | `ref.applySync()`                  |
| Functions as args | ⚠️ Callbacks  | `Callback` class for function args |
| Object mutation   | ✅ Sync       | `ref.setSync()`                    |
| Object inspection | ⚠️ Limited    | Can't proxy `Object.keys()`        |
| Security          | ✅ V8 isolate | Separate heap, true isolation      |
| Memory limits     | ✅ Yes        | `memoryLimit: 128`                 |
| Timeout           | ✅ Yes        | `script.run({ timeout: ms })`      |
| Prototype escape  | ✅ Blocked    | No access to host constructors     |
| Latency           | ~1ms          | Native C++ bridge                  |

**Function handling with Callback:**

```ts
// Create callback for function argument
const handlerCallback = new ivm.Callback(
  (route, request) => {
    // This runs in HOST when called from sandbox
    // But route/request are sandbox objects...

    // Can use applySyncPromise for async
    return route.applySync("fulfill", [{ body: "blocked" }]);
  },
  { sync: true },
);

// Pass to sandbox
context.global.set("handler", handlerCallback.derefInto());

// In sandbox:
page.route("**", handler); // handler is callback
```

**But closures don't work:**

```ts
// In sandbox:
const config = { timeout: 5000 };
const fn = new ivm.Callback(() => config.timeout);

// Problem: config is in sandbox, callback runs in host
// Host can't access sandbox closure
```

**applySyncPromise for async host calls:**

```ts
// Special method: isolate can await host's async operations
// Only works FROM isolate INTO host

// In host:
const readFileCallback = new ivm.Callback(
  async (path) => {
    return await fs.readFile(path, "utf-8");
  },
  { async: true },
);

// In sandbox:
const content = await readFileCallback.applySyncPromise(undefined, [
  "file.txt",
]);
// Isolate waits for host's async operation
```

**Limitations:**

1. **Closures:** Functions passed to host lose closure context

   ```ts
   const localVar = 123;
   page.evaluate(() => localVar); // localVar not accessible in host
   ```

2. **Bidirectional object passing:**
   - Objects from sandbox passed to host become References
   - Host needs to call `ref.getSync()` etc. to access
   - Complex for nested object access

3. **Event handlers tricky:**

   ```ts
   page.on("response", (response) => {
     // response comes from Playwright (host)
     // handler runs in sandbox
     // response is Reference in sandbox
     response.status(); // Need: responseRef.getSync('status').applySync()
   });
   ```

4. **Native C++ binding:**
   - Requires compilation
   - Platform-specific builds
   - Larger binary size

**Pros:**

- Synchronous property access (native support!)
- True V8 isolate isolation
- Memory limits enforced
- Timeout enforcement
- No prototype pollution escape
- Can pass functions (as Callbacks)

**Cons:**

- Closures don't work (functions lose context)
- Complex for bidirectional calls
- C++ binding required
- Event handlers need careful handling
- Not pure JS (native dependency)

**Use case:** Secure execution with property access, most Playwright operations work (except closures in function args).

**NOT suitable for:** `page.evaluate(() => localVar)` patterns where closure needed.

### Comparison Summary

| Feature           | new Function | node:vm       | Atomics.wait    | isolated-vm              |
| ----------------- | ------------ | ------------- | --------------- | ------------------------ |
| Property read     | ✅ Direct    | ✅ Direct     | ✅ Sync (block) | ✅ Sync (native)         |
| Property write    | ✅ Direct    | ✅ Direct     | ⚠️ IPC          | ✅ Sync (native)         |
| Method call       | ✅ Direct    | ✅ Direct     | ✅ Sync (block) | ✅ Sync (native)         |
| Functions as args | ✅ Direct    | ✅ Direct     | ❌ JSON only    | ⚠️ Callback (no closure) |
| Closures          | ✅ Yes       | ✅ Yes        | ❌ No           | ❌ No                    |
| Event handlers    | ✅ Direct    | ✅ Direct     | ❌ Impossible   | ⚠️ Complex               |
| Security          | ❌ None      | ⚠️ Weak       | ✅ Worker       | ✅ V8 isolate            |
| Memory limits     | ❌ No        | ❌ No         | ✅ Worker       | ✅ Yes                   |
| Timeout           | ⚠️ Manual    | ✅ Built-in   | ⚠️ Complex      | ✅ Built-in              |
| Latency           | 0ms          | ~0ms          | ~1-5ms          | ~1ms                     |
| Implementation    | Simple       | Simple        | Complex         | Medium                   |
| Dependencies      | None         | Node built-in | None            | C++ binding              |

### Recommendation Matrix

**For Playwright (with function args):**

- `new Function` or `node:vm` - required for closures
- `isolated-vm` - partial (no closures)
- `Atomics.wait` - impossible (functions can't cross)

**For simple API calls (JSON args only):**

- Any option works
- Choose based on security requirements

**For untrusted code:**

- `isolated-vm` - best balance
- `Atomics.wait` - good if JSON-only
- NOT `new Function` or `node:vm`

**For development/trusted code:**

- `new Function` - simplest, fastest

## Runtime Options

### Comparison Table (Updated)

**Primary contenders (support property access):**

| Runtime        | Transform | Execution        | Property Access | Functions                | Security      | Memory Limit | Latency | Complexity |
| -------------- | --------- | ---------------- | --------------- | ------------------------ | ------------- | ------------ | ------- | ---------- |
| `new Function` | esbuild   | Direct           | ✅ Direct       | ✅ Closures work         | ❌ None       | ❌ No        | 0ms     | Low        |
| `node:vm`      | esbuild   | `runInContext()` | ✅ Direct       | ✅ Closures work         | ⚠️ Weak       | ❌ No        | ~0ms    | Low        |
| `isolated-vm`  | esbuild   | V8 isolate       | ✅ Sync native  | ⚠️ Callback (no closure) | ✅ V8 isolate | ✅ Yes       | ~1ms    | Medium     |
| `Atomics.wait` | esbuild   | Worker + monitor | ✅ Sync block   | ❌ JSON only             | ✅ Worker     | ✅ Worker    | ~1-5ms  | High       |

**Executor-style runtimes (method calls only, no property access):**

| Runtime         | Transform | Execution        | Property Access | Functions    | Security        | Memory Limit | Latency |
| --------------- | --------- | ---------------- | --------------- | ------------ | --------------- | ------------ | ------- |
| QuickJS WASM    | esbuild   | WASM interpreter | ❌ Method only  | ❌ JSON only | ✅ Memory limit | ✅ Yes       | ~1-5ms  |
| SES Compartment | esbuild   | Child process    | ❌ Method only  | ❌ JSON only | ✅ SES lockdown | ⚠️ Process   | ~1ms    |
| Deno subprocess | Native    | Child process    | ❌ Method only  | ❌ JSON only | ✅ Perm flags   | ⚠️ Process   | ~5-10ms |
| Bun subprocess  | Native    | Child process    | ❌ Method only  | ❌ JSON only | ✅ Process      | ⚠️ Process   | ~5-10ms |

**Note:** Executor-style runtimes use the proxy pattern where `obj.prop` returns a proxy, not the value. Only `obj.method()` works. These are NOT suitable for Runner's Playwright plugin which requires property access.

### TypeScript Support by Runtime

**Primary contenders:**

| Runtime        | TS Support            | Approach                 |
| -------------- | --------------------- | ------------------------ |
| `new Function` | ❌ Transform required | esbuild before execution |
| `node:vm`      | ❌ Transform required | esbuild before execution |
| `isolated-vm`  | ❌ Transform required | esbuild before execution |
| `Atomics.wait` | ❌ Transform required | esbuild before execution |

**Executor-style runtimes:**

| Runtime         | TS Support            | Approach                     |
| --------------- | --------------------- | ---------------------------- |
| QuickJS WASM    | ❌ Transform required | esbuild before execution     |
| SES             | ❌ Transform required | esbuild before execution     |
| Deno subprocess | ✅ Native             | Deno executes `.ts` directly |
| Bun subprocess  | ✅ Native             | Bun executes `.ts` directly  |

**Recommendation:** Use esbuild for transformation (fast, supports all TS features). Deno/Bun native TS support is convenient but limited to executor-style runtimes.

## Proposed Architecture for Runner

### Core Interfaces

```ts
// src/lib/types.ts

export interface RunInput {
  source: string;
  language: "typescript" | "javascript";
  context: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RunOutput {
  result: unknown;
  error: unknown;
  logs?: string[];
  [key: string]: unknown;
}

// Runtime abstraction
export interface Runtime {
  name: string;

  // Transform TS → JS (optional, some runtimes handle this)
  transform?: (source: string) => Promise<string>;

  // Execute code with proxied context
  execute(
    source: string,
    context: Record<string, unknown>,
    invoker: ContextInvoker,
  ): Promise<RunOutput>;

  teardown?: () => Promise<void>;
}

// Handles calls from sandbox to real objects
export interface ContextInvoker {
  invoke(input: {
    objectId: string;
    method: string;
    args: unknown;
  }): Promise<unknown>;
}

// Plugin provides runtime + hooks
export interface Hooks {
  // Runtime to use (first plugin wins, or default)
  runtime?: Runtime;

  // Existing hooks
  teardown?: () => Promise<void>;
  beforeRun?: (input: RunInput) => Promise<Partial<RunInput> | void>;
  afterRun?: (output: RunOutput) => Promise<Partial<RunOutput> | void>;
}

export type Plugin = () => Promise<Hooks>;
```

### Runner Implementation

```ts
// src/lib/runner.ts

export class Runner extends ServiceMap.Service<Runner>()(
  "@ericc-ch/runner/Runner",
  {
    make: Effect.sync(() => {
      let hooks: RequiredHooks[] = [];
      let runtime: Runtime | null = null;

      const init = Effect.fn(function* (plugins: RequiredPlugin[]) {
        hooks = yield* Effect.forEach(plugins, (plugin) =>
          Effect.promise(plugin),
        );

        // Find runtime from plugins (first wins)
        runtime = hooks.find((h) => h.runtime)?.runtime ?? defaultRuntime;
      });

      const execute = Effect.fn(function* (source: string) {
        const currentState: RunInput = {
          source,
          language: "typescript",
          context: {},
        };

        // beforeRun hooks populate context
        for (const hook of hooks) {
          const result = yield* Effect.tryPromise({
            try: () => hook.beforeRun(currentState),
            catch: (cause) => new HookError({ hook: "beforeRun", cause }),
          });
          if (result?.context)
            Object.assign(currentState.context, result.context);
        }

        // Create invoker that routes calls to real objects
        const invoker: ContextInvoker = {
          invoke: async ({ objectId, method, args }) => {
            const obj = currentState.context[objectId];
            if (!obj)
              throw new Error(`Object '${objectId}' not found in context`);
            if (!(method in obj))
              throw new Error(`Method '${method}' not found on '${objectId}'`);

            // Actual call happens here in host process
            return await obj[method](args);
          },
        };

        // Transform if runtime needs it
        let transformedSource = currentState.source;
        if (runtime!.transform) {
          transformedSource = await runtime!.transform(transformedSource);
        }

        // Execute in runtime
        const output = yield* Effect.tryPromise({
          try: () =>
            runtime!.execute(transformedSource, currentState.context, invoker),
          catch: (cause) => new ExecutionError({ cause }),
        });

        // afterRun hooks
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => hook.afterRun(output),
            catch: (cause) => new HookError({ hook: "afterRun", cause }),
          });
        }

        return output;
      });

      const teardown = Effect.gen(function* () {
        yield* Effect.forEach(
          hooks,
          (hook) =>
            Effect.tryPromise({
              try: () => hook.teardown(),
              catch: (cause) => new HookError({ hook: "teardown", cause }),
            }),
          { discard: true },
        );

        if (runtime?.teardown) {
          yield* Effect.tryPromise({
            try: () => runtime.teardown(),
            catch: (cause) => new ExecutionError({ cause }),
          });
        }

        hooks = [];
        runtime = null;
      });

      return { init, execute, teardown };
    }),
  },
) {
  static readonly layer = Layer.effect(Runner, Runner.make);
}

// Default runtime (new Function for backwards compat)
const defaultRuntime: Runtime = {
  name: "new-function",
  transform: async (source) => {
    const esbuild = await import("esbuild");
    const result = await esbuild.transform(source, { loader: "ts" });
    return result.code;
  },
  execute: async (source, context, invoker) => {
    // Direct execution (no isolation) - same as current
    const params = Object.keys(context);
    const values = Object.values(context);
    const fn = new Function(...params, source);
    const result = await fn(...values);
    return { result, error: undefined };
  },
};
```

### Runtime Plugin Examples

#### QuickJS Runtime Plugin

```ts
// .runner/plugins/runtime-quickjs.ts

import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten";
import type { Runtime, ContextInvoker } from "../../src/lib/types.ts";

export const quickjsRuntimePlugin = (): Plugin => async () => ({
  runtime: {
    name: "quickjs",
    transform: async (source) => {
      const esbuild = await import("esbuild");
      return esbuild.transform(source, { loader: "ts" }).code;
    },

    execute: async (source, context, invoker) => {
      const QuickJS = await getQuickJS();
      const runtime = QuickJS.newRuntime();

      // Configure limits
      runtime.setMemoryLimit(128 * 1024 * 1024); // 128MB
      runtime.setMaxStackSize(4 * 1024 * 1024); // 4MB
      runtime.setInterruptHandler(() => Date.now() > deadline);

      const vm = runtime.newContext();
      const logs: string[] = [];

      // Create proxy generator
      const proxyCode = `
        const __makeProxy = (path = []) => new Proxy(() => {}, {
          get(_, prop) {
            if (prop === 'then') return undefined
            return __makeProxy([...path, prop])
          },
          apply(_, __, args) {
            const objectId = path[0]
            const method = path.slice(1).join('.')
            return Promise.resolve(__call(objectId, method, args[0]))
              .then(r => r ? JSON.parse(r) : undefined)
          }
        })
        
        // Inject proxies for each context key
        ${Object.keys(context)
          .map((k) => `const ${k} = __makeProxy(['${k}'])`)
          .join("\n")}
        
        // Console
        const console = {
          log: (...a) => __log('log', a.join(' ')),
          error: (...a) => __log('error', a.join(' ')),
        }
      `;

      // Create call bridge
      const callBridge = vm.newFunction(
        "__call",
        (objHandle, methodHandle, argsHandle) => {
          const objectId = vm.getString(objHandle);
          const method = vm.getString(methodHandle);
          const args = vm.dump(argsHandle);

          const deferred = vm.newPromise();

          invoker
            .invoke({ objectId, method, args })
            .then((value) => {
              const json = JSON.stringify(value);
              deferred.resolve(vm.newString(json));
            })
            .catch((err) => {
              deferred.reject(vm.newError(err.message));
            });

          return deferred.handle;
        },
      );
      vm.setProp(vm.global, "__call", callBridge);
      callBridge.dispose();

      // Create log bridge
      const logBridge = vm.newFunction("__log", (levelHandle, msgHandle) => {
        logs.push(`[${vm.getString(levelHandle)}] ${vm.getString(msgHandle)}`);
        return vm.undefined;
      });
      vm.setProp(vm.global, "__log", logBridge);
      logBridge.dispose();

      // Execute
      const fullCode = proxyCode + "\n" + source;
      const result = vm.evalCode(fullCode);

      // ... handle result, errors, cleanup

      return { result, error: undefined, logs };
    },

    teardown: async () => {
      // Cleanup QuickJS runtime
    },
  },
});
```

#### Worker Thread Runtime Plugin

```ts
// .runner/plugins/runtime-worker.ts

import { Worker } from "node:worker_threads";
import type { Runtime, ContextInvoker } from "../../src/lib/types.ts";

export const workerRuntimePlugin = (): Plugin => async () => {
  let worker: Worker;

  return {
    runtime: {
      name: "worker-thread",
      transform: async (source) => {
        const esbuild = await import("esbuild");
        return esbuild.transform(source, { loader: "ts" }).code;
      },

      execute: async (source, context, invoker) => {
        // Send code to worker
        worker.postMessage({
          type: "execute",
          source,
          contextKeys: Object.keys(context),
        });

        // Handle calls from worker
        worker.on("message", async (msg) => {
          if (msg.type === "call") {
            try {
              const result = await invoker.invoke({
                objectId: msg.objectId,
                method: msg.method,
                args: msg.args,
              });
              worker.postMessage({
                type: "response",
                callId: msg.callId,
                result,
              });
            } catch (err) {
              worker.postMessage({
                type: "response",
                callId: msg.callId,
                error: err.message,
              });
            }
          }
        });

        // Wait for result
        return new Promise((resolve) => {
          worker.on("message", (msg) => {
            if (msg.type === "result") {
              resolve({ result: msg.value, error: msg.error, logs: msg.logs });
            }
          });
        });
      },

      teardown: async () => {
        worker?.terminate();
      },
    },

    init: async () => {
      // Spawn worker
      worker = new Worker("./worker-runtime.js");
    },
  };
};
```

#### Deno Runtime Plugin

```ts
// .runner/plugins/runtime-deno.ts

import { spawn } from "node:child_process";
import type { Runtime, ContextInvoker } from "../../src/lib/types.ts";

export const denoRuntimePlugin = (): Plugin => async () => ({
  runtime: {
    name: "deno-subprocess",

    // Deno handles TS natively, but we transform for context injection
    transform: async (source) => {
      // Inject context proxies
      const proxySetup = Object.keys(context)
        .map((k) => `const ${k} = createProxy('${k}');`)
        .join("\n");

      return proxySetup + "\n" + source;
    },

    execute: async (source, context, invoker) => {
      const child = spawn("deno", [
        "run",
        "--allow-net=none",
        "--allow-read=none",
        "--allow-write=none",
        "--allow-env=none",
        "--allow-run=none",
        "--allow-ffi=none",
        "/tmp/deno-worker.ts",
      ]);

      // IPC via stdin/stdout JSON lines
      child.stdin.write(JSON.stringify({ type: "start", source }) + "\n");

      child.stdout.on("data", (data) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.type === "call") {
            invoker.invoke(msg).then((result) => {
              child.stdin.write(
                JSON.stringify({
                  type: "response",
                  callId: msg.callId,
                  result,
                }) + "\n",
              );
            });
          }
        }
      });

      // Wait for completion
      // ...
    },

    teardown: async () => {
      // Cleanup process
    },
  },
});
```

## Implementation Roadmap

### Phase 1: Core Abstraction

1. Define `Runtime` and `ContextInvoker` interfaces in `src/lib/types.ts`
2. Update `Runner` to use runtime abstraction
3. Implement `defaultRuntime` (current `new Function` behavior)
4. Update existing plugins to work with new interface
5. Add esbuild transform for TypeScript support

**Goal:** Backwards compatible, foundation for runtime plugins, TypeScript support

### Phase 2: node:vm Runtime

1. Add `node:vm` runtime implementation
2. Create sandboxed context with limited globals
3. Test with Playwright plugin (should work with closures)
4. Add timeout enforcement
5. Document escape hatch risks

**Goal:** Working runtime with timeout, mild isolation, closures work

### Phase 3: isolated-vm Runtime

1. Add `isolated-vm` dependency
2. Implement Reference-based property access
3. Create proxy wrapper using `getSync/copySync`
4. Implement `Callback` for function arguments
5. Test with Playwright - document closure limitations
6. Add memory limits and timeout

**Goal:** Secure runtime with property access, document limitations

### Phase 4: Atomics.wait Runtime (Experimental)

1. Implement Worker + monitor thread architecture
2. Create SharedArrayBuffer IPC protocol
3. Implement synchronous proxy with `Atomics.wait`
4. Test JSON-only scenarios
5. Document function/closure limitations clearly

**Goal:** Proof of concept for pure-JS synchronous proxy, evaluate viability

### Phase 5: Plugin Runtime Selection

1. Add runtime selection API to plugins
2. Document which plugins work with which runtime
   - Playwright: `new Function`, `node:vm` (full), `isolated-vm` (partial), `Atomics.wait` (broken)
   - HTTP/API clients: All runtimes work
3. Add runtime configuration in `.runner/config.ts`
4. Runtime compatibility validation before execution

**Goal:** Flexible runtime selection with clear compatibility documentation

### Phase 6: Security Hooks (Optional)

1. Add `ContextInvoker` hooks for auditing
2. Add optional pre-call prompts
3. Add rate limiting example
4. Document security patterns for each runtime

**Goal:** Demonstrate security gatekeeping capabilities

## Open Questions

### Resolved

1. **Property access in isolated runtimes:** Can synchronous property access work?
   - ✅ Yes with `isolated-vm` (native `getSync/copySync`)
   - ✅ Yes with `Atomics.wait` (blocking on SharedArrayBuffer)
   - ❌ No with executor-style runtimes (proxy pattern limitation)

2. **Functions crossing isolate boundary:** Can we pass functions to methods like `page.evaluate(fn)`?
   - ✅ Yes with `new Function` and `node:vm` (same context)
   - ⚠️ Partial with `isolated-vm` (Callback class but loses closure)
   - ❌ No with `Atomics.wait` (JSON only)
   - ❌ No with executor-style runtimes (no property access + JSON only)

3. **Security vs functionality trade-off:** Can we have both security and closures?
   - ❌ No, fundamentally impossible
   - Closures exist only in sandbox memory, host cannot access
   - Must choose: security OR closure support

### Still Open

1. **Runtime selection UX:** How should users select runtime?
   - Option A: Global config in `.runner/config.ts`
   - Option B: Per-plugin declaration
   - Option C: Per-execution override
   - Option D: Auto-detect based on plugin requirements

2. **Compatibility validation:** How to prevent incompatible runtime + plugin combinations?
   - Plugin declares `{ requiresClosures: true }`
   - Runner validates before execution
   - Error message with alternatives

3. **Error handling across boundary:** How to preserve error context?
   - Stack traces get lost in IPC
   - Need to serialize error info carefully
   - `isolated-vm` preserves some stack context

4. **Streaming results:** Methods like `page.pdf()` return large binary data
   - Current: Buffer entire result in memory
   - Future: Stream chunks?
   - Different for each runtime (direct vs IPC)

5. **Performance measurement:** Actual latency in production
   - `isolated-vm`: Need benchmarks
   - `Atomics.wait`: Need benchmarks
   - Compare with Playwright's inherent latency

6. **Plugin documentation:** How to clearly communicate limitations?
   - Which methods work in which runtime?
   - Closure patterns that won't work in isolated-vm
   - Security implications of each runtime

### Future Considerations

1. **Hybrid runtime:** Could we use `isolated-vm` for most code but pass specific objects directly?
   - "Trusted objects" bypass proxy
   - Security policy for which objects can bypass

2. **WebAssembly isolation:** Could WASM-based runtimes (WASM Edge, wasm3) provide better isolation?
   - Currently limited JS support
   - Interesting future direction

3. **Container runtime:** Docker/Podman for maximum isolation
   - HTTP proxy for all calls
   - ~10-50ms latency
   - Full OS-level isolation
   - Works with closures if code runs in container's Node.js

4. **Browser runtime:** Execute in actual browser via Puppeteer/Playwright
   - page.evaluate() becomes native
   - Maximum isolation (browser sandbox)
   - Interesting but niche

## Conclusion

### Key Findings

**The fundamental problem:** JavaScript Proxy `get()` trap must return synchronously. This limits runtime options significantly.

**Executor's pattern limitation:** Executor treats all access as method calls (`obj.method()`). Property access (`obj.prop`) returns a proxy, not the value. This works for executor's pure-method APIs (MCP, OpenAPI, GraphQL) but NOT for Runner's Playwright plugin which has actual properties.

**Functions cannot cross isolate boundary:** Methods like `page.evaluate(fn)`, `page.waitForFunction(fn)`, `page.route(pattern, handler)` accept function arguments with closures. These closures reference variables in the sandbox that the host cannot access.

### Runtime Selection Guide

**For Playwright plugin (requires closures):**

| Runtime                      | Viability  | Reason                                                      |
| ---------------------------- | ---------- | ----------------------------------------------------------- |
| `new Function`               | ✅ Full    | Direct access, closures work, zero limitations              |
| `node:vm`                    | ✅ Full    | Same-context closures work, timeout built-in                |
| `isolated-vm`                | ⚠️ Partial | Property access works, but `Callback` loses closure context |
| `Atomics.wait`               | ❌ Broken  | Can't pass functions at all (JSON only)                     |
| Executor-style (QuickJS/SES) | ❌ Broken  | No property access, no function args                        |

**For simple API clients (JSON args only):**

| Runtime                        | Viability | Reason                                 |
| ------------------------------ | --------- | -------------------------------------- |
| Any runtime                    | ✅ Full   | JSON-serializable args work everywhere |
| Choose based on security needs |           |                                        |

**For untrusted code execution:**

| Runtime        | Viability | Reason                                                  |
| -------------- | --------- | ------------------------------------------------------- |
| `isolated-vm`  | ✅ Best   | True isolation, memory limits, timeout, property access |
| `Atomics.wait` | ⚠️ Good   | Isolated, but complex setup, JSON-only                  |
| `node:vm`      | ⚠️ Weak   | Timeout yes, but escape hatches exist                   |
| `new Function` | ❌ Unsafe | Zero security                                           |

### The Trade-off Triangle

Runner faces a fundamental trade-off:

```
        Security (Isolation)
              ▲
             /│\
            / │ \
           /  │  \
          /   │   \
         /    │    \
        /     │     \
       /      │      \
      /       │       \
     /        │        \
    ──────────┼──────────▶
   Functions  │  Simplicity
   (Closures) │
              │
              ▼
```

- **Maximum security** (`isolated-vm`, `Atomics.wait`): Sacrifices closures
- **Maximum functionality** (`new Function`, `node:vm`): Sacrifices security
- **Middle ground**: `isolated-vm` with documented closure limitations

### Practical Recommendation

**Phase 1-2:** Implement `new Function` + `node:vm` runtimes

- Full Playwright compatibility
- TypeScript via esbuild
- Timeout enforcement (node:vm)
- Document security risks clearly

**Phase 3:** Implement `isolated-vm` runtime

- Secure execution for non-Playwright plugins
- Document closure limitations: `page.evaluate(() => localVar)` won't work
- Memory limits, timeout, true isolation

**Phase 4:** Experimental `Atomics.wait` runtime

- Proof of concept
- Evaluate for JSON-only scenarios
- Document complexity and limitations

**Phase 5:** Runtime selection API

- Plugin declares requirements: `{ requiresClosures: true }`
- Runner validates compatibility before execution
- Clear documentation of what works where

### The Hard Truth

**For Playwright automation with closures, there is no secure runtime.**

Browser automation patterns like:

- `page.evaluate(() => localStorage.getItem('token'))`
- `page.waitForFunction(() => window.loaded)`
- `page.route('**', handler => handler.continue())`

These fundamentally require the sandbox's closure context to be accessible to the host. No isolation mechanism can solve this because the closure variables exist only in the sandbox's memory space.

**Options:**

1. Accept weak security (`node:vm`) for Playwright, use strong isolation for other plugins
2. Restrict Playwright usage to closure-free patterns
3. Document the trade-off clearly and let users decide

### Security Through Gatekeeping (Revisited)

Even with `node:vm` or `new Function`, the hook system provides some security:

```ts
// Intercept all calls regardless of runtime
const invoker = {
  invoke: async ({ objectId, method, args }) => {
    // Audit
    auditLog({ objectId, method, args });

    // Policy enforcement
    if (method === "goto" && !allowedDomains.includes(args.url)) {
      throw new Error("Domain not allowed");
    }

    // User prompt
    if (sensitiveOperations.includes(method)) {
      const approved = await promptUser(`Allow ${method}?`);
      if (!approved) throw new Error("User denied");
    }

    return context[objectId][method](args);
  },
};
```

This works with ALL runtimes. The security is in WHAT you allow, not WHERE it runs.

### Final Recommendation

**Start with `new Function` + `node:vm`:**

- Full Playwright compatibility
- TypeScript via esbuild transform
- Add gatekeeping hooks for policy enforcement
- Document clearly: "Not for truly untrusted code"

**Add `isolated-vm` for secure scenarios:**

- HTTP clients, database operations, computation
- No closures needed for these
- True isolation, memory limits, timeout

**Document runtime compatibility matrix:**

- Each plugin lists compatible runtimes
- Runner validates before execution
- User chooses based on their security/functionality needs

**Accept the trade-off:** There is no perfect solution. Security and closure support are mutually exclusive. Be honest about this limitation.
