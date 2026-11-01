/**
 * Sandbox executor using Node's vm module
 * In production, this would use V8 isolates (Cloudflare Workers) or similar
 */
import { createContext, runInContext, Context } from "vm";

export interface SandboxResult {
  success: boolean;
  output: string;
  error?: string;
  executionTimeMs: number;
}

export interface InjectedBindings {
  [key: string]: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Create a sandbox context with injected bindings
 */
export function createSandboxContext(bindings: InjectedBindings): Context {
  // Create a restricted global object
  const sandboxGlobals: Record<string, unknown> = {
    // Allowlisted globals
    console: {
      log: (...args: unknown[]) => {
        globalThis.__sandbox_console_log?.(args);
      },
      error: (...args: unknown[]) => {
        globalThis.__sandbox_console_error?.(args);
      },
      warn: (...args: unknown[]) => {
        globalThis.__sandbox_console_warn?.(args);
      },
    },
    // Standard JS globals (subset)
    JSON,
    Math,
    Date,
    Promise,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    ReferenceError,
    SyntaxError,
    RangeError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    // Async utilities
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };

  // Inject bindings at top level (flatten { mcp: { readFile: fn } } → { mcp: { readFile: fn } })
  // The bindings object has namespace as key, e.g., { mcp: { readFile: fn, writeFile: fn } }
  Object.assign(sandboxGlobals, bindings);

  const context = createContext(sandboxGlobals);
  return context;
}

/**
 * Execute code in sandbox with timeout
 */
export async function executeInSandbox(
  code: string,
  bindings: InjectedBindings,
  timeoutMs = 10000
): Promise<SandboxResult> {
  const startTime = Date.now();
  const consoleOutput: string[] = [];

  // Create console handlers that capture output
  const consoleHandlers = {
    log: (...args: unknown[]) => consoleOutput.push(args.map(formatArg).join(" ")),
    error: (...args: unknown[]) => consoleOutput.push("[ERROR] " + args.map(formatArg).join(" ")),
    warn: (...args: unknown[]) => consoleOutput.push("[WARN] " + args.map(formatArg).join(" ")),
  };

  // Inject console handlers into globalThis for sandbox access
  const originalGlobalLog = globalThis.__sandbox_console_log;
  const originalGlobalError = globalThis.__sandbox_console_error;
  const originalGlobalWarn = globalThis.__sandbox_console_warn;
  
  globalThis.__sandbox_console_log = consoleHandlers.log;
  globalThis.__sandbox_console_error = consoleHandlers.error;
  globalThis.__sandbox_console_warn = consoleHandlers.warn;

  try {
    const context = createSandboxContext(bindings);
    
    // Wrap in async IIFE to support top-level await
    // Strip TypeScript type annotations AND markdown code fences (vm runs JavaScript, not TypeScript)
    let jsCode = code
      // Remove markdown code fences
      .replace(/^```(?:javascript|js|typescript|ts)?\n?/i, "")
      .replace(/\n?```$/i, "")
      // Remove TypeScript type annotations
      .replace(/:\s*(any|string|number|boolean|object|unknown|Promise<[^>]+>|Array<[^>]+>|Record<[^>]+>)\s*([,=)])/g, "$2")
      .replace(/\(err:\s*any\)/g, "(err)")
      .replace(/\(e:\s*any\)/g, "(e)")
      .replace(/catch\s*\(err:\s*[^)]+\)/g, "catch (err)")
      .replace(/catch\s*\(e:\s*[^)]+\)/g, "catch (e)");
    
    const wrappedCode = `
      (async () => {
        try {
          ${jsCode}
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          throw e;
        }
      })();
    `;

    // Execute with timeout
    await Promise.race([
      runInContext(wrappedCode, context, { 
        timeout: timeoutMs, 
        breakOnSigint: true 
      }),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`Execution timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);

    const executionTimeMs = Date.now() - startTime;
    
    return {
      success: true,
      output: consoleOutput.join("\n"),
      executionTimeMs,
    };
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;
    return {
      success: false,
      output: consoleOutput.join("\n"),
      error: error instanceof Error ? error.message : String(error),
      executionTimeMs,
    };
  } finally {
    // Cleanup global handlers
    if (originalGlobalLog === undefined) delete globalThis.__sandbox_console_log;
    else globalThis.__sandbox_console_log = originalGlobalLog;
    if (originalGlobalError === undefined) delete globalThis.__sandbox_console_error;
    else globalThis.__sandbox_console_error = originalGlobalError;
    if (originalGlobalWarn === undefined) delete globalThis.__sandbox_console_warn;
    else globalThis.__sandbox_console_warn = originalGlobalWarn;
  }
}

function formatArg(arg: unknown): string {
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  if (typeof arg === "object") {
    try { return JSON.stringify(arg, null, 2); } catch { return String(arg); }
  }
  return String(arg);
}

/**
 * Validate TypeScript code before execution (basic syntax check)
 */
export function validateTypeScript(code: string): { valid: boolean; errors: string[] } {
  // Basic checks - in production use `tsc --noEmit` or similar
  const errors: string[] = [];
  
  // Check for forbidden patterns
  const forbiddenPatterns = [
    { pattern: /require\s*\(/, msg: "require() not allowed in sandbox" },
    { pattern: /process\./, msg: "process not available in sandbox" },
    { pattern: /fs\./, msg: "fs not available in sandbox" },
    { pattern: /eval\s*\(/, msg: "eval() not allowed" },
    { pattern: /Function\s*\(/, msg: "Function constructor not allowed" },
  ];

  for (const { pattern, msg } of forbiddenPatterns) {
    if (pattern.test(code)) {
      errors.push(msg);
    }
  }

  // Check for balanced braces/parens
  let braces = 0, parens = 0, brackets = 0;
  for (const char of code) {
    if (char === "{") braces++;
    if (char === "}") braces--;
    if (char === "(") parens++;
    if (char === ")") parens--;
    if (char === "[") brackets++;
    if (char === "]") brackets--;
  }
  if (braces !== 0) errors.push("Unbalanced braces");
  if (parens !== 0) errors.push("Unbalanced parentheses");
  if (brackets !== 0) errors.push("Unbalanced brackets");

  return { valid: errors.length === 0, errors };
}