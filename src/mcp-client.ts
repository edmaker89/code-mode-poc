/**
 * MCP Client wrapper - connects to MCP servers and fetches tool schemas
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPServerConfig {
  type: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
}

export class MCPClientWrapper {
  private client: Client;
  private tools: MCPTool[] = [];

  constructor(private config: MCPServerConfig) {
    this.client = new Client({
      name: "code-mode-poc",
      version: "1.0.0",
    });
  }

  async connect(): Promise<void> {
    let transport;
    
    if (this.config.type === "stdio") {
      transport = new StdioClientTransport({
        command: this.config.command!,
        args: this.config.args || [],
      });
    } else if (this.config.type === "sse") {
      transport = new SSEClientTransport(new URL(this.config.url!));
    } else {
      throw new Error(`Unknown transport type: ${this.config.type}`);
    }

    await this.client.connect(transport);
    
    // Fetch available tools
    const toolsResult = await this.client.listTools();
    this.tools = toolsResult.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as MCPTool["inputSchema"],
    }));
  }

  getTools(): MCPTool[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.client.callTool({ name, arguments: args });
    return result.content;
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }
}

/**
 * Connect to a public MCP server for testing
 * Example: GitHub MCP, Filesystem MCP, etc.
 */
export async function createTestMCPClient(): Promise<MCPClientWrapper> {
  // Using a simple stdio MCP server for testing
  // You can replace with any MCP server
  const client = new MCPClientWrapper({
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
  });
  
  await client.connect();
  return client;
}