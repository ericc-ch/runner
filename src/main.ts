const logs: string[] = []

const customConsole = {
  log: (...args: any[]) => logs.push(args.join(" ")),
  error: (...args: any[]) => logs.push("[ERROR] " + args.join(" ")),
  warn: (...args: any[]) => logs.push("[WARN] " + args.join(" ")),
}

const exampleCode = `
console.log('hello')
console.log('world')
return typeof fetch
`

const fn = new Function("console", exampleCode)
const result = fn(customConsole)

console.log("result:", result)
console.log("logs:", logs)
