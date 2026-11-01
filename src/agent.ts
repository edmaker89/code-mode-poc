/**
 * Main Code Mode Agent - orchestrates the full loop:
 * User Query → MCP Tools → TypeScript Definitions → LLM Code Gen → Sandbox Execute → Result
 */
import { MCPClientWrapper, createTestMCPClient, MCPTool } from "./mcp-client.js";
import { generateTSDefinitions, generateSandboxContext } from "./ts-generator.js";
import { executeInSandbox, validateTypeScript, SandboxResult, InjectedBindings } from "./sandbox.js";
import { 
  buildLLMPrompt, 
  generateCodeWithOpenRouter, 
  generateCodeWithOpenRouterStream,
  simulateLLMCodeGeneration,
  validateTypeScriptWithTsc,
  LLMCodeGenOptions
} from "./llm-codegen.js";

export interface AgentConfig {
  mcpClient: MCPClientWrapper;
  namespace?: string;
  sandboxTimeoutMs?: number;
  debug?: boolean;
  // LLM config
  useRealLLM?: boolean;
  llmModel?: string;
  llmApiKey?: string;
  llmBaseURL?: string;
  streamCode?: boolean;
  onCodeChunk?: (chunk: string) => void;
}

export interface AgentResult {
  success: boolean;
  userQuery: string;
  generatedCode: string;
  sandboxResult: SandboxResult;
  tsDefinitions: string;
  promptSentToLLM: string;
  validationErrors?: string[];
}

export class CodeModeAgent {
  private mcpClient: MCPClientWrapper;
  private namespace: string;
  private sandboxTimeoutMs: number;
  private debug: boolean;
  private useRealLLM: boolean;
  private llmModel: string;
  private llmApiKey: string | undefined;
  private llmBaseURL: string | undefined;
  private streamCode: boolean;
  private onCodeChunk: ((chunk: string) => void) | undefined;

  constructor(config: AgentConfig) {
    this.mcpClient = config.mcpClient;
    this.namespace = config.namespace || "mcp";
    this.sandboxTimeoutMs = config.sandboxTimeoutMs || 10000;
    this.debug = config.debug || false;
    this.useRealLLM = config.useRealLLM || false;
    this.llmModel = config.llmModel || "openai/gpt-4o-mini";
    this.llmApiKey = config.llmApiKey;
    this.llmBaseURL = config.llmBaseURL;
    this.streamCode = config.streamCode || false;
    this.onCodeChunk = config.onCodeChunk;
  }

  /**
   * Execute a user query through the full Code Mode pipeline
   */
  async execute(userQuery: string): Promise<AgentResult> {
    // Step 1: Get MCP tools
    const tools = this.mcpClient.getTools();
    if (this.debug) {
      console.log(`[DEBUG] Available tools: ${tools.map(t => t.name).join(", ")}`);
    }

    // Step 2: Generate TypeScript definitions
    const tsDef = generateTSDefinitions(tools, this.namespace);
    const tsDefinitions = `${tsDef.interfaces}\n\n${tsDef.apiDeclaration}`;
    
    if (this.debug) {
      console.log(`[DEBUG] Generated TS definitions (${tsDefinitions.length} chars)`);
    }

    // Step 3: Build sandbox context (what the LLM sees)
    const sandboxContext = generateSandboxContext(tsDef, this.namespace);
    
    // Step 4: Build the prompt that will be sent to LLM
    const promptSentToLLM = buildLLMPrompt({
      userQuery,
      tsDefinitions,
      namespace: this.namespace,
      availableTools: tools,
    });

    // Step 5: Generate code using LLM (real or simulated)
    let generatedCode: string;
    
    if (this.useRealLLM) {
      console.log(`[INFO] Generating code with ${this.llmModel}...`);
      
      if (this.streamCode) {
        // Streaming generation
        generatedCode = "";
        for await (const chunk of generateCodeWithOpenRouterStream({
          userQuery,
          tsDefinitions,
          namespace: this.namespace,
          availableTools: tools,
          model: this.llmModel,
          apiKey: this.llmApiKey,
          baseURL: this.llmBaseURL,
          onPartialResult: (chunk) => {
            generatedCode += chunk;
            if (this.onCodeChunk) this.onCodeChunk(chunk);
          },
        })) {
          // Chunks are yielded by the generator
        }
        console.log("\n[INFO] Code generation complete");
      } else {
        // Non-streaming generation
        generatedCode = await generateCodeWithOpenRouter({
          userQuery,
          tsDefinitions,
          namespace: this.namespace,
          availableTools: tools,
          model: this.llmModel,
          apiKey: this.llmApiKey,
          baseURL: this.llmBaseURL,
        });
      }
    } else {
      generatedCode = await simulateLLMCodeGeneration({
        userQuery,
        tsDefinitions,
        namespace: this.namespace,
        availableTools: tools,
      });
    }

    if (this.debug) {
      console.log(`[DEBUG] Generated code:\n${generatedCode}`);
    }

    // Step 6: Validate generated code (basic)
    const basicValidation = validateTypeScript(generatedCode);
    if (!basicValidation.valid) {
      return {
        success: false,
        userQuery,
        generatedCode,
        sandboxResult: {
          success: false,
          output: "",
          error: `Code validation failed: ${basicValidation.errors.join(", ")}`,
          executionTimeMs: 0,
        },
        tsDefinitions,
        promptSentToLLM,
        validationErrors: basicValidation.errors,
      };
    }

    // Step 7: Validate with TypeScript compiler (tsc --noEmit)
    console.log("[INFO] Validating TypeScript with tsc --noEmit...");
    const tscValidation = await validateTypeScriptWithTsc(generatedCode);
    if (!tscValidation.valid) {
      console.error("[ERROR] TypeScript validation failed:", tscValidation.errors);
      return {
        success: false,
        userQuery,
        generatedCode,
        sandboxResult: {
          success: false,
          output: "",
          error: `TypeScript validation failed: ${tscValidation.errors.join(", ")}`,
          executionTimeMs: 0,
        },
        tsDefinitions,
        promptSentToLLM,
        validationErrors: tscValidation.errors,
      };
    }
    console.log("[INFO] TypeScript validation passed ✓");

    // Step 8: Create MCP bindings for sandbox
    const bindings = this.createMCPBindings();

    // Step 9: Execute in sandbox
    const fullCode = `${sandboxContext}\n${generatedCode}`;
    const sandboxResult = await executeInSandbox(
      fullCode,
      bindings,
      this.sandboxTimeoutMs
    );

    if (this.debug) {
      console.log(`[DEBUG] Sandbox result:`, sandboxResult);
    }

    return {
      success: sandboxResult.success,
      userQuery,
      generatedCode,
      sandboxResult,
      tsDefinitions,
      promptSentToLLM,
    };
  }

  /**
   * Create the MCP function bindings that get injected into the sandbox
   * Returns an object like { mcp: { readFile: fn, writeFile: fn, ... } }
   */
  private createMCPBindings(): InjectedBindings {
    const tools = this.mcpClient.getTools();
    const namespaceBindings: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

    for (const tool of tools) {
      const methodName = this.toCamelCase(tool.name);
      namespaceBindings[methodName] = async (input: unknown) => {
        if (this.debug) {
          console.log(`[DEBUG] Sandbox calling MCP tool: ${tool.name}`, input);
        }
        return this.mcpClient.callTool(tool.name, input as Record<string, unknown>);
      };
    }

    return { [this.namespace]: namespaceBindings };
  }

  private toCamelCase(str: string): string {
    return str
      .split(/[-_]/)
      .map((s, i) => i === 0 ? s.toLowerCase() : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
      .join("");
  }

  /**
   * Get the TypeScript definitions for inspection
   */
  getTSDefinitions(): string {
    const tools = this.mcpClient.getTools();
    const tsDef = generateTSDefinitions(tools, this.namespace);
    return `${tsDef.interfaces}\n\n${tsDef.apiDeclaration}`;
  }

  /**
   * Get available tools
   */
  getTools(): MCPTool[] {
    return this.mcpClient.getTools();
  }
}

/**
 * Factory function to create and connect agent
 */
export async function createAgent(config: Omit<AgentConfig, "mcpClient"> & { 
  mcpConfig?: { type: "stdio"; command: string; args?: string[] } 
}): Promise<CodeModeAgent> {
  let mcpClient: MCPClientWrapper;

  if (config.mcpConfig) {
    mcpClient = new MCPClientWrapper(config.mcpConfig);
    await mcpClient.connect();
  } else {
    // Default to filesystem MCP server for testing
    mcpClient = await createTestMCPClient();
  }

  return new CodeModeAgent({
    mcpClient,
    namespace: config.namespace,
    sandboxTimeoutMs: config.sandboxTimeoutMs,
    debug: config.debug,
    useRealLLM: config.useRealLLM,
    llmModel: config.llmModel,
    llmApiKey: config.llmApiKey,
    llmBaseURL: config.llmBaseURL,
    streamCode: config.streamCode,
    onCodeChunk: config.onCodeChunk,
  });
}