/**
 * Code Mode PoC - Main Entry Point
 * Demonstrates the full Code Mode pipeline with real LLM (OpenRouter)
 */
import { createAgent, CodeModeAgent } from "./agent.js";
import { MCPClientWrapper } from "./mcp-client.js";
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.log("🚀 Code Mode PoC - Starting...\n");

  // Check for OpenRouter API key
  const hasApiKey = !!process.env.OPENROUTER_API_KEY;
  if (hasApiKey) {
    console.log("🔑 OpenRouter API key found - using real LLM");
  } else {
    console.log("⚠️  No OPENROUTER_API_KEY - using simulated LLM");
    console.log("   Get a key at https://openrouter.ai/keys");
  }

  // Try GitHub MCP server first, fallback to filesystem
  let agent: CodeModeAgent;
  let useGitHub = false;

  // Check if GitHub token is available
  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  
  if (githubToken && hasApiKey) {
    console.log("\n🐙 Attempting GitHub MCP server...");
    try {
      agent = await createAgent({
        mcpConfig: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
        },
        namespace: "mcp",
        sandboxTimeoutMs: 30000,
        debug: true,
        useRealLLM: true,
        llmModel: "openai/gpt-4o-mini",
        streamCode: true,
        onCodeChunk: (chunk) => process.stdout.write(chunk),
      });
      useGitHub = true;
      console.log("✅ Connected to GitHub MCP server");
    } catch (e) {
      console.log(`⚠️  GitHub MCP failed: ${e instanceof Error ? e.message : e}`);
      console.log("   Falling back to filesystem MCP...");
    }
  }

  if (!useGitHub) {
    console.log("\n📁 Using Filesystem MCP server (current directory)...");
    agent = await createAgent({
      mcpConfig: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
      },
      namespace: "mcp",
      sandboxTimeoutMs: 30000,
      debug: true,
      useRealLLM: hasApiKey,
      llmModel: "openai/gpt-4o-mini",
      streamCode: hasApiKey,
      onCodeChunk: hasApiKey ? (chunk) => process.stdout.write(chunk) : undefined,
    });
  }

  // Show available tools
  const tools = agent.getTools();
  console.log(`\n📦 Available MCP Tools (${tools.length}):`);
  tools.forEach(t => console.log(`  - ${t.name}: ${t.description?.slice(0, 80) || "No description"}...`));
  console.log();

  // Show generated TypeScript definitions
  console.log("📝 Generated TypeScript Definitions (truncated):");
  console.log("─".repeat(60));
  const tsDefs = agent.getTSDefinitions();
  console.log(tsDefs.slice(0, 2000) + (tsDefs.length > 2000 ? "\n... (truncated)" : ""));
  console.log("─".repeat(60));
  console.log();

  // Test queries based on available tools
  const isGitHub = useGitHub;
  const testQueries = isGitHub ? [
    "List repositories for the authenticated user",
    "Get the contents of the README.md in the current repository",
    "Search for TypeScript files in the repository",
  ] : [
    "List all files in the current directory",
    "Read the package.json file",
    "Search for TypeScript files (*.ts)",
    "Create a file called hello.txt with content 'Hello Code Mode!'",
  ];

  for (const query of testQueries) {
    console.log(`\n🔍 Query: "${query}"`);
    console.log("─".repeat(60));

    const result = await agent.execute(query);

    console.log(`\n📝 Generated Code:`);
    console.log(result.generatedCode);
    console.log();

    console.log(`⚡ Sandbox Execution:`);
    console.log(`  Success: ${result.sandboxResult.success}`);
    console.log(`  Time: ${result.sandboxResult.executionTimeMs}ms`);
    
    if (result.validationErrors && result.validationErrors.length > 0) {
      console.log(`  Validation Errors: ${result.validationErrors.join(", ")}`);
    }
    
    if (result.sandboxResult.output) {
      console.log(`  Output:\n${result.sandboxResult.output.slice(0, 1000)}${result.sandboxResult.output.length > 1000 ? "\n... (truncated)" : ""}`);
    }
    if (result.sandboxResult.error) {
      console.log(`  Error: ${result.sandboxResult.error}`);
    }
    
    console.log("─".repeat(60));
  }

  // Interactive mode
  console.log("\n💬 Interactive Mode (type 'exit' to quit)");
  console.log("─".repeat(60));
  
  const readline = await import("readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    const query = await rl.question("\n🔍 Query: ");
    if (query.toLowerCase() === "exit" || query.toLowerCase() === "quit") break;
    if (!query.trim()) continue;

    console.log("─".repeat(60));
    const result = await agent.execute(query);
    
    console.log(`\n📝 Generated Code:\n${result.generatedCode}`);
    console.log(`\n⚡ Result: ${result.sandboxResult.success ? "✅ Success" : "❌ Failed"}`);
    console.log(`   Time: ${result.sandboxResult.executionTimeMs}ms`);
    if (result.sandboxResult.output) console.log(`   Output: ${result.sandboxResult.output.slice(0, 500)}`);
    if (result.sandboxResult.error) console.log(`   Error: ${result.sandboxResult.error}`);
  }

  rl.close();
  
  // Cleanup
  await (agent as any).mcpClient?.disconnect?.();
  console.log("\n✅ Done!");
}

main().catch(console.error);