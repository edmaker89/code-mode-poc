/**
 * Quick test for local 9router / OpenRouter + GitHub MCP integration
 * Run with: npx tsx test-openrouter.ts
 * 
 * Environment variables:
 *   LLM_API_KEY    - Your API key (required)
 *   LLM_BASE_URL   - Base URL (default: https://openrouter.ai/api/v1)
 *                    For 9router local: http://localhost:9000/v1
 *   LLM_MODEL      - Model name (auto-detected: qwen2.5-coder-7b for local)
 *   GITHUB_TOKEN   - GitHub PAT for GitHub MCP (optional)
 */

import { createAgent } from "./src/agent.js";

async function testGitHubMCP() {
  const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;
  const baseURL = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
  const model = process.env.LLM_MODEL || (baseURL.includes("localhost") || baseURL.includes("127.0.0.1") ? "qwen2.5-coder-7b" : "openai/gpt-4o-mini");
  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  console.log("🤖 LLM Configuration:");
  console.log(`   Base URL: ${baseURL}`);
  console.log(`   Model: ${model}`);
  console.log(`   API Key: ${apiKey ? "✅ set" : "❌ missing"}`);
  console.log("");

  if (!apiKey) {
    console.log("❌ LLM_API_KEY not set");
    console.log("   export LLM_API_KEY=your-key");
    console.log("   (or OPENROUTER_API_KEY for OpenRouter)");
    process.exit(1);
  }

  if (!githubToken) {
    console.log("⚠️  GITHUB_TOKEN not set - will use filesystem MCP instead");
    console.log("   export GITHUB_TOKEN=ghp_xxx  # for GitHub MCP");
    console.log("");
  }

  try {
    const agent = await createAgent({
      mcpConfig: githubToken ? {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
      } : {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
      },
      namespace: "mcp",
      sandboxTimeoutMs: 60000,
      debug: true,
      useRealLLM: true,
      llmModel: model,
      llmApiKey: apiKey,
      llmBaseURL: baseURL,
      streamCode: true,
      onCodeChunk: (chunk) => process.stdout.write(chunk),
    });

    console.log("\n\n✅ Connected to MCP server");
    console.log("");

    // Test queries - adjusted for GitHub MCP tools available
    const queries = githubToken ? [
      // Query 1: List repos - uses listRepositories if available, else search
      "List my repositories using listRepositories tool if available, otherwise use searchRepositories with a simple query",
      
      // Query 2: Get README - needs owner/repo, so we'll ask for a specific one
      // The LLM will try to find a repo first, then read README
      "Try to list repositories, then read the README.md from the first repository found",
      
      // Query 3: Search code in a known repo - more reliable than user:@me
      "Search for TypeScript files in the repository facebook/react using searchCode tool",
    ] : [
      "List all files in the current directory",
      "Read the package.json file",
      "Search for TypeScript files (*.ts)",
    ];

    for (const query of queries) {
      console.log(`\n🔍 Query: "${query}"`);
      console.log("─".repeat(60));

      const result = await agent.execute(query);

      console.log(`\n📝 Generated Code:\n${result.generatedCode}`);
      console.log(`\n⚡ Result: ${result.sandboxResult.success ? "✅ Success" : "❌ Failed"}`);
      console.log(`   Time: ${result.sandboxResult.executionTimeMs}ms`);
      if (result.sandboxResult.output) {
        const out = result.sandboxResult.output.slice(0, 800);
        console.log(`   Output: ${out}${result.sandboxResult.output.length > 800 ? "..." : ""}`);
      }
      if (result.sandboxResult.error) {
        console.log(`   Error: ${result.sandboxResult.error}`);
      }
      if (result.validationErrors?.length) {
        console.log(`   Validation Errors: ${result.validationErrors.join(", ")}`);
      }
    }

    await (agent as any).mcpClient?.disconnect?.();
    console.log("\n✅ Done!");
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

testGitHubMCP();