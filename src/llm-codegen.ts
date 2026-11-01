/**
 * Real LLM code generator using OpenRouter (OpenAI-compatible API)
 * Supports streaming for incremental results
 */
import { MCPTool } from "./mcp-client.js";
import { generateSandboxContext } from "./ts-generator.js";
import { execAsync } from "./utils.js";

export interface LLMCodeGenOptions {
  userQuery: string;
  tsDefinitions: string;
  namespace: string;
  availableTools: MCPTool[];
  model?: string;
  apiKey?: string;
  baseURL?: string;
  onPartialResult?: (chunk: string) => void;
}

/**
 * System prompt that teaches the LLM how to write Code Mode code
 */
export const CODE_MODE_SYSTEM_PROMPT = `You are an AI agent that writes JavaScript code (NOT TypeScript) to accomplish tasks using MCP tools.

You have access to a JavaScript API called \`mcp\` that provides functions for each available MCP tool.

RULES:
1. Write ONLY JavaScript code - no explanations, no markdown fences, no comments outside code
2. Use the \`mcp\` object to call tools - e.g., \`await mcp.listDirectory({ path: "." })\`
3. All tool calls are async and return Promises
4. Output results using \`console.log(JSON.stringify(result))\` - this is how results are returned to you
5. You can use variables, loops, conditionals, helper functions
6. Handle errors with try/catch - use \`catch (err)\` NOT \`catch (err: any)\`
7. For multiple operations, chain them in a single code block
8. DO NOT use: require, import, process, fs, eval, Function constructor
9. DO NOT access globals not provided in the sandbox
10. Use console.log() incrementally for partial results if needed
11. NO TypeScript syntax: no type annotations, no interfaces, no generics in code

AVAILABLE TOOLS:
{{TOOLS_LIST}}

EXAMPLES:

User: "List all files in the current directory"
Code:
const result = await mcp.listDirectory({ path: "." });
console.log(JSON.stringify(result));

User: "Read the package.json file"
Code:
const result = await mcp.readTextFile({ path: "package.json" });
console.log(JSON.stringify(result));

User: "Search for TypeScript files"
Code:
const result = await mcp.searchFiles({ path: ".", pattern: "*.ts" });
console.log(JSON.stringify(result));

User: "Create a file hello.txt with content 'Hello'"
Code:
const result = await mcp.writeFile({ path: "hello.txt", content: "Hello" });
console.log(JSON.stringify(result));

User: "List files then read package.json"
Code:
const files = await mcp.listDirectory({ path: "." });
console.log(JSON.stringify(files));
const pkg = await mcp.readTextFile({ path: "package.json" });
console.log(JSON.stringify(pkg));

GITHUB MCP TOOLS GUIDE:
- listRepositories(): list repos (no args) - PREFERRED for listing user repos
- searchRepositories({ query }): search repos - query like "user:octocat" (NOT "user:@me")
- getFileContents({ owner, repo, path }): read file - REQUIRES owner, repo, path
- searchCode({ q }): search code - q like "repo:owner/name language:typescript"
- listCommits({ owner, repo }): list commits
- listIssues({ owner, repo, state }): list issues - state: "open" | "closed" | "all"
- createIssue({ owner, repo, title, body }): create issue
- searchIssues({ q }): search issues - q like "repo:owner/name state:open"
- createPullRequest({ owner, repo, title, head, base }): create PR

IMPORTANT: Tool names in mcp API are CAMELCASE (e.g., mcp.searchRepositories, mcp.getFileContents).
Use the exact names from the type definitions provided.

GITHUB QUERY TIPS:
- "user:@me" DOES NOT WORK in GitHub search - use listRepositories() instead
- For authenticated user's repos: listRepositories() (no args)
- For searching public repos: searchRepositories({ query: "topic:typescript stars:>1000" })
- For code search: MUST specify repo in query: "repo:facebook/react language:typescript"
- For issues: use listIssues({ owner, repo }) not searchIssues with @me

CURRENT REPO CONTEXT:
When user says "current repository", try listRepositories() first to find a repo, then use that owner/repo.
If no listRepositories tool, searchRepositories with a broad query.

FOR GITHUB: Always specify owner and repo when needed. Use searchCode for finding files in repos.
DO NOT output markdown code fences - write raw JavaScript only.`;

/**
 * Generate the prompt for the LLM
 */
export function buildLLMPrompt(options: LLMCodeGenOptions): string {
  const toolsList = options.availableTools.map(t => 
    `- ${t.name}: ${t.description || "No description"}`
  ).join("\n");

  const systemPrompt = CODE_MODE_SYSTEM_PROMPT.replace("{{TOOLS_LIST}}", toolsList);

  return `${systemPrompt}

=== TYPE DEFINITIONS ===
${options.tsDefinitions}

=== USER QUERY ===
${options.userQuery}

=== YOUR CODE ===
`;
}

/**
 * Validate TypeScript code using tsc --noEmit
 */
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

export async function validateTypeScriptWithTsc(code: string): Promise<{ valid: boolean; errors: string[] }> {
  // Write code to a temp file with the context
  const tempDir = "/tmp/code-mode-validation";
  await mkdir(tempDir, { recursive: true });
  
  // Create a minimal tsconfig for validation
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2022"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      allowJs: false,
      resolveJsonModule: true,
      isolatedModules: true,
      types: ["node"]
    }
  };
  
  await writeFile(join(tempDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  
  // Write the code with declare const mcp for type checking
  const validationCode = `
// Type definitions for validation
declare const mcp: {
  listDirectory: (input: { path: string }) => Promise<any>;
  readTextFile: (input: { path: string; head?: number; tail?: number }) => Promise<any>;
  searchFiles: (input: { path: string; pattern: string; excludePatterns?: string[] }) => Promise<any>;
  writeFile: (input: { path: string; content: string }) => Promise<any>;
  readFile: (input: { path: string; head?: number; tail?: number }) => Promise<any>;
  readMediaFile: (input: { path: string }) => Promise<any>;
  readMultipleFiles: (input: { paths: string[] }) => Promise<any>;
  editFile: (input: { path: string; edits: { oldText: string; newText: string }[]; dryRun?: boolean }) => Promise<any>;
  createDirectory: (input: { path: string }) => Promise<any>;
  listDirectoryWithSizes: (input: { path: string; sortBy?: "name" | "size" }) => Promise<any>;
  directoryTree: (input: { path: string; excludePatterns?: string[] }) => Promise<any>;
  moveFile: (input: { source: string; destination: string }) => Promise<any>;
  getFileInfo: (input: { path: string }) => Promise<any>;
  listAllowedDirectories: (input: {}) => Promise<any>;
  listRepositories: (input: {}) => Promise<any>;
  getFileContents: (input: { path: string }) => Promise<any>;
};

${code}
`;
  
  await writeFile(join(tempDir, "validate.ts"), validationCode);
  
  try {
    const result = await execAsync(`cd ${tempDir} && npx tsc --noEmit`);
    return { valid: true, errors: [] };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // Extract TypeScript errors
    const errors = errorMsg
      .split("\n")
      .filter(line => line.includes("error TS"))
      .map(line => line.trim());
    return { valid: errors.length === 0, errors };
  }
}

/**
 * Generate code using OpenAI-compatible API (OpenRouter, 9router local, etc.)
 * Configure via env vars:
 *   LLM_API_KEY - API key (required)
 *   LLM_BASE_URL - Base URL (default: https://openrouter.ai/api/v1, use http://localhost:9000/v1 for 9router)
 *   LLM_MODEL - Model name (default: qwen2.5-coder-7b for local, openai/gpt-4o-mini for OpenRouter)
 */
export async function generateCodeWithOpenRouter(
  options: LLMCodeGenOptions
): Promise<string> {
  const apiKey = options.apiKey || process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;
  const baseURL = options.baseURL || process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
  // Default to qwen2.5-coder-7b for local (small, good at code), gpt-4o-mini for OpenRouter
  const model = options.model || process.env.LLM_MODEL || (baseURL.includes("localhost") || baseURL.includes("127.0.0.1") ? "qwen2.5-coder-7b" : "openai/gpt-4o-mini");
  
  if (!apiKey) {
    throw new Error("LLM_API_KEY not set. Export it: export LLM_API_KEY=your-key");
  }

  const prompt = buildLLMPrompt(options);
  
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/douglassilva/code-mode-poc",
      "X-Title": "Code Mode PoC",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: prompt.split("=== USER QUERY ===")[0] },
        { role: "user", content: prompt.split("=== USER QUERY ===")[1]?.split("=== YOUR CODE ===")[0] || "" },
      ],
      temperature: 0.1,
      max_tokens: 3000,
      stream: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`LLM API error (${baseURL}): ${response.status} - ${error}`);
  }

  const data = await response.json();
  const code = data.choices[0]?.message?.content?.trim() || "";
  
  // Clean up code - remove markdown fences if present
  return code
    .replace(/^```typescript\n?/i, "")
    .replace(/^```\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();
}

/**
 * Generate code with streaming for incremental results
 */
export async function* generateCodeWithOpenRouterStream(
  options: LLMCodeGenOptions
): AsyncGenerator<string, string, unknown> {
  const apiKey = options.apiKey || process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;
  const baseURL = options.baseURL || process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
  const model = options.model || process.env.LLM_MODEL || (baseURL.includes("localhost") || baseURL.includes("127.0.0.1") ? "qwen2.5-coder-7b" : "openai/gpt-4o-mini");
  
  if (!apiKey) {
    throw new Error("LLM_API_KEY not set");
  }

  const prompt = buildLLMPrompt(options);
  
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/douglassilva/code-mode-poc",
      "X-Title": "Code Mode PoC",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: prompt.split("=== USER QUERY ===")[0] },
        { role: "user", content: prompt.split("=== USER QUERY ===")[1]?.split("=== YOUR CODE ===")[0] || "" },
      ],
      temperature: 0.1,
      max_tokens: 3000,
      stream: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  let fullCode = "";
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  
  if (!reader) throw new Error("No response body");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");
    
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices[0]?.delta?.content || "";
          if (delta) {
            fullCode += delta;
            if (options.onPartialResult) {
              options.onPartialResult(delta);
            }
            yield delta;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  }
  
  // Clean up and return final code
  const cleaned = fullCode
    .replace(/^```typescript\n?/i, "")
    .replace(/^```\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();
  
  return cleaned;
}

/**
 * Simulated LLM response - for testing without API key
 * Pattern matching for demo purposes
 */
export async function simulateLLMCodeGeneration(options: LLMCodeGenOptions): Promise<string> {
  const { userQuery, availableTools } = options;
  const query = userQuery.toLowerCase();

  const findTool = (names: string[]) => availableTools.find(t => names.includes(t.name));

  if (query.includes("list") && (query.includes("file") || query.includes("directory") || query.includes("folder"))) {
    const tool = findTool(["list_directory", "listDirectory", "ls", "dir"]);
    if (tool) {
      const path = query.includes("current") || query.includes(".") ? "." : 
                   query.match(/["']([^"']+)["']/)?.[1] || ".";
      return `const result = await mcp.${toCamelCase(tool.name)}({ path: "${path}" });
console.log(JSON.stringify(result));`;
    }
  }

  if ((query.includes("read") || query.includes("show") || query.includes("cat")) && query.includes("file")) {
    const tool = findTool(["read_text_file", "readTextFile", "read_file", "cat"]);
    if (tool) {
      const path = query.match(/["']([^"']+)["']/)?.[1] || "package.json";
      return `const result = await mcp.${toCamelCase(tool.name)}({ path: "${path}" });
console.log(JSON.stringify(result));`;
    }
  }

  if ((query.includes("write") || query.includes("create")) && query.includes("file")) {
    const tool = findTool(["write_file", "writeFile", "create_file"]);
    if (tool) {
      const pathMatch = query.match(/["']([^"']+)["']/);
      const contentMatch = query.match(/content\s+['"]([^'"]+)['"]/i) || query.match(/["']([^'"]+)['"]\s*(?:with|content)/i);
      const path = pathMatch?.[1] || "output.txt";
      const content = contentMatch?.[1] || "Hello from Code Mode!";
      return `const result = await mcp.${toCamelCase(tool.name)}({ path: "${path}", content: "${content}" });
console.log(JSON.stringify(result));`;
    }
  }

  if (query.includes("search") || query.includes("find") || query.includes("glob")) {
    const tool = findTool(["search_files", "searchFiles", "grep", "glob"]);
    if (tool) {
      const pattern = query.match(/["']([^"']+)["']/)?.[1] || "*.ts";
      return `const result = await mcp.${toCamelCase(tool.name)}({ path: ".", pattern: "${pattern}" });
console.log(JSON.stringify(result));`;
    }
  }

  if (query.includes("tree") || query.includes("structure")) {
    const tool = findTool(["directory_tree", "directoryTree"]);
    if (tool) {
      return `const result = await mcp.${toCamelCase(tool.name)}({ path: "." });
console.log(JSON.stringify(result));`;
    }
  }

  // GitHub-specific queries
  if (query.includes("repository") || query.includes("repo")) {
    const tool = findTool(["list_repositories", "listRepositories", "get_repositories"]);
    if (tool) {
      return `const result = await mcp.${toCamelCase(tool.name)}({});
console.log(JSON.stringify(result));`;
    }
  }

  if (query.includes("readme") || query.includes("read_me")) {
    const tool = findTool(["get_file_contents", "getFileContents", "read_file", "readFile"]);
    if (tool) {
      return `const result = await mcp.${toCamelCase(tool.name)}({ path: "README.md" });
console.log(JSON.stringify(result));`;
    }
  }

  // Preferred tools fallback
  const preferredTools = ["list_directory", "read_text_file", "search_files", "directory_tree", "list_repositories", "get_file_contents"];
  for (const preferred of preferredTools) {
    const tool = findTool([preferred]);
    if (tool) {
      const args = getDefaultArgs(tool.name);
      return `// No specific pattern matched, trying tool: ${tool.name}
const result = await mcp.${toCamelCase(tool.name)}(${args});
console.log(JSON.stringify(result));`;
    }
  }

  if (availableTools.length > 0) {
    const tool = availableTools[0];
    const args = getDefaultArgs(tool.name);
    return `// Fallback to first tool: ${tool.name}
const result = await mcp.${toCamelCase(tool.name)}(${args});
console.log(JSON.stringify(result));`;
  }

  return `console.log(JSON.stringify({ error: "No tools available" }));`;
}

function getDefaultArgs(toolName: string): string {
  switch (toolName) {
    case "list_directory": return "{ path: \".\" }";
    case "read_text_file": return "{ path: \"package.json\" }";
    case "search_files": return "{ path: \".\", pattern: \"*.ts\" }";
    case "directory_tree": return "{ path: \".\" }";
    case "read_file": return "{ path: \"package.json\" }";
    case "write_file": return "{ path: \"output.txt\", content: \"Hello\" }";
    case "list_allowed_directories": return "{}";
    case "list_repositories": return "{}";
    case "get_file_contents": return "{ path: \"README.md\" }";
    default: return "{}";
  }
}

function toCamelCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((s, i) => i === 0 ? s.toLowerCase() : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join("");
}