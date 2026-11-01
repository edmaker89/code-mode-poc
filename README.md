# Code Mode PoC - MCP via TypeScript API + Sandbox

A proof-of-concept implementation of Cloudflare's **Code Mode** pattern:
> Convert MCP tools to TypeScript API → LLM writes code → Execute in sandbox

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐     ┌─────────────┐     ┌────────────┐
│ User Query  │────▶│  MCP Tools       │────▶│  TS Defs     │────▶│  LLM Code   │────▶│ Sandbox    │
│             │     │  (schema)        │     │  (interfaces)│     │  Generation │     │ (vm)       │
└─────────────┘     └──────────────────┘     └──────────────┘     └─────────────┘     └────────────┘
                                                                        │
                                                                        ▼
                                                               ┌──────────────────┐
                                                               │ MCP Bindings     │
                                                               │ (injected at     │
                                                               │  runtime)        │
                                                               └──────────────────┘
                                                                        │
                                                                        ▼
                                                               ┌──────────────────┐
                                                               │ MCP Server       │
                                                               │ (filesystem)     │
                                                               └──────────────────┘
```

## Quick Start

```bash
cd code-mode-poc
npm install
npm run start
```

## How It Works

### 1. MCP Client (`src/mcp-client.ts`)
Connects to any MCP server (stdio, SSE) and fetches tool schemas.

### 2. TypeScript Generator (`src/ts-generator.ts`)
Converts MCP tool schemas → TypeScript interfaces + `declare const mcp` API.

Example output:
```typescript
interface ListDirectoryInput {
  path: string;
}

declare const mcp: {
  listDirectory: (input: ListDirectoryInput) => Promise<ListDirectoryOutput>;
  readTextFile: (input: ReadTextFileInput) => Promise<ReadTextFileOutput>;
  // ... all tools
};
```

### 3. LLM Code Generator (`src/llm-codegen.ts`)
Simulates an LLM writing TypeScript code using the `mcp` API.

**In production**: Replace `simulateLLMCodeGeneration()` with actual OpenAI/Anthropic API call using `buildLLMPrompt()`.

### 4. Sandbox (`src/sandbox.ts`)
Executes generated code in Node's `vm` module with:
- Restricted globals (no `process`, `fs`, `require`, etc.)
- Injected MCP bindings (`mcp.listDirectory`, `mcp.readTextFile`, etc.)
- Console capture via `globalThis` hooks
- Timeout protection

### 5. Agent Orchestrator (`src/agent.ts`)
Ties everything together: query → tools → TS defs → LLM code → sandbox → result.

## Example Output

```
🔍 Query: "List all files in the current directory"

📝 Generated Code:
const result = await mcp.listDirectory({ path: "." });
console.log(JSON.stringify(result));

⚡ Sandbox Execution: ✅ Success (2ms)
Output: [DIR] node_modules
        [FILE] package.json
        [FILE] tsconfig.json
        [DIR] src
```

## Key Differences from Traditional MCP

| Traditional MCP (Function Calling) | Code Mode (This PoC) |
|-----------------------------------|---------------------|
| LLM outputs special tokens | LLM writes TypeScript code |
| One tool call per LLM turn | Multiple calls in one code block |
| Tool results fed back to LLM | Results via `console.log()` |
| Limited tools (~10-20) | Unlimited tools (hundreds) |
| LLM struggles with complex args | Full TypeScript expressivity |

## Production Considerations

For production use, replace components:

| Component | PoC | Production |
|-----------|-----|------------|
| Sandbox | Node `vm` | Cloudflare V8 Isolates / Deno / Firecracker |
| LLM | Simulated | OpenAI/Anthropic/VLLM API |
| MCP Transport | stdio | stdio / SSE / Streamable HTTP |
| Bindings | Manual | Cloudflare Worker Loader API |

## Files

```
src/
├── index.ts           # Demo entry point
├── agent.ts           # Main orchestrator
├── mcp-client.ts      # MCP connection & tool fetching
├── ts-generator.ts    # MCP schema → TypeScript definitions
├── llm-codegen.ts     # LLM code generation (simulated)
└── sandbox.ts         # vm-based code execution
```

## Extending

### Add a new MCP server
```typescript
const agent = await createAgent({
  mcpConfig: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
  },
  // or SSE:
  // mcpConfig: { type: "sse", url: "https://..." },
});
```

### Use real LLM
```typescript
// In llm-codegen.ts, uncomment and use:
const code = await generateCodeWithOpenAI(options, process.env.OPENAI_API_KEY);
```

### Add more sandbox globals
Edit `createSandboxContext()` in `sandbox.ts` to allowlist additional globals.

## References

- [Cloudflare Code Mode Blog](https://blog.cloudflare.com/code-mode/)
- [MCP Specification](https://modelcontextprotocol.io/)
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/)
- [Worker Loader API](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)