/**
 * Code Mode MCP Server
 * Exposes the Code Mode agent as an MCP tool
 * Works with: Claude Code, OpenCode, Codex, any MCP client
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createAgent } from "./agent.js";
import { MCPClientWrapper } from "./mcp-client.js";

interface CodeModeConfig {
  // LLM config
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  // MCP servers to connect (array of stdio configs)
  mcpServers: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
  sandboxTimeoutMs?: number;
}

class CodeModeMCPServer {
  private server: Server;
  private agents: Map<string, Awaited<ReturnType<typeof createAgent>>> = new Map();
  private config: CodeModeConfig;

  constructor(config: CodeModeConfig) {
    this.config = config;
    this.server = new Server(
      {
        name: "code-mode",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "code_mode",
          description: "Execute a task using Code Mode: converts MCP tools to TypeScript API, LLM writes code, executes in sandbox",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The task/query to execute (e.g., 'List all TypeScript files in facebook/react repo')",
              },
              mcpServer: {
                type: "string",
                description: "Which MCP server to use (from configured servers). Optional - uses first if not specified.",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "code_mode_list_servers",
          description: "List configured MCP servers",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === "code_mode_list_servers") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                this.config.mcpServers.map((s) => s.name),
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === "code_mode") {
        const { query, mcpServer } = args as { query: string; mcpServer?: string };

        try {
          // Get or create agent for the specified MCP server
          const serverName = mcpServer || this.config.mcpServers[0]?.name;
          if (!serverName) {
            throw new Error("No MCP servers configured");
          }

          let agent = this.agents.get(serverName);
          if (!agent) {
            const serverConfig = this.config.mcpServers.find((s) => s.name === serverName);
            if (!serverConfig) {
              throw new Error(`MCP server not found: ${serverName}`);
            }

            const mcpClient = new MCPClientWrapper({
              type: "stdio",
              command: serverConfig.command,
              args: serverConfig.args,
              env: serverConfig.env,
            });
            await mcpClient.connect();

            agent = new (await import("./agent.js")).CodeModeAgent({
              mcpClient,
              namespace: "mcp",
              sandboxTimeoutMs: this.config.sandboxTimeoutMs || 60000,
              debug: false,
              useRealLLM: true,
              llmModel: this.config.llmModel,
              llmApiKey: this.config.llmApiKey,
              llmBaseURL: this.config.llmBaseUrl,
              streamCode: false,
            });

            this.agents.set(serverName, agent);
          }

          const result = await agent.execute(query);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: result.success,
                    query: result.userQuery,
                    generatedCode: result.generatedCode,
                    output: result.sandboxResult.output,
                    error: result.sandboxResult.error,
                    executionTimeMs: result.sandboxResult.executionTimeMs,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      throw new Error(`Unknown tool: ${name}`);
    });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Code Mode MCP Server running on stdio");
  }

  async stop() {
    for (const agent of this.agents.values()) {
      await (agent as any).mcpClient?.disconnect?.();
    }
    await this.server.close();
  }
}

// CLI entry point
async function main() {
  // Config via environment variables
  const config: CodeModeConfig = {
    llmApiKey: process.env.LLM_API_KEY || "",
    llmBaseUrl: process.env.LLM_BASE_URL || "http://localhost:9000/v1",
    llmModel: process.env.LLM_MODEL || "qwen2.5-coder-7b",
    sandboxTimeoutMs: parseInt(process.env.SANDBOX_TIMEOUT_MS || "60000"),
    mcpServers: [],
  };

  // Parse MCP servers from env
  // Format: MCP_SERVERS='[{"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"xxx"}}]'
  if (process.env.MCP_SERVERS) {
    try {
      config.mcpServers = JSON.parse(process.env.MCP_SERVERS);
    } catch (e) {
      console.error("Invalid MCP_SERVERS JSON:", e);
      process.exit(1);
    }
  } else {
    // Default: GitHub MCP if token available
    if (process.env.GITHUB_TOKEN) {
      config.mcpServers.push({
        name: "github",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN },
      });
    }
    // Always add filesystem as fallback
    config.mcpServers.push({
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
    });
  }

  if (!config.llmApiKey) {
    console.error("LLM_API_KEY required");
    process.exit(1);
  }

  if (config.mcpServers.length === 0) {
    console.error("At least one MCP server required");
    process.exit(1);
  }

  const server = new CodeModeMCPServer(config);

  // Handle shutdown
  process.on("SIGINT", async () => {
    await server.stop();
    process.exit(0);
  });

  await server.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});