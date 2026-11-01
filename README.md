# Code Mode PoC

> **Proof-of-Concept** implementing Cloudflare's [Code Mode pattern](https://blog.cloudflare.com/code-mode/): convert MCP tools → TypeScript API → LLM writes code → executes in sandbox → calls MCP servers via injected bindings.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐     ┌─────────────────┐
│   Query     │────▶│  LLM (Code Gen)  │────▶│   Sandbox   │────▶│   MCP Server    │
│  (Natural)  │     │  TypeScript Code │     │  (Node vm)  │     │  (GitHub, etc.) │
└─────────────┘     └──────────────────┘     └─────────────┘     └─────────────────┘
                           ▲                       │                       │
                           │                       ▼                       ▼
                    ┌──────────────────┐     ┌─────────────┐     ┌─────────────────┐
                    │  MCP → TS Types  │     │  Filters,   │     │  Returns clean  │
                    │  (Auto-generated)│     │  aggregates │     │  JSON result    │
                    └──────────────────┘     └─────────────┘     └─────────────────┘
```

**Key insight**: The LLM writes code **once**, the sandbox executes it locally (filtering, mapping, Promise.all), and only the final clean result goes back to the LLM context — saving ~90% tokens vs traditional tool calling.

---

## Quick Start

### Prerequisites

- Node.js 20+
- npm/pnpm/yarn
- **9router local** running at `http://127.0.0.1:20128/v1` (or any OpenAI-compatible endpoint)
- **GitHub Personal Access Token** with `repo` and `public_repo` scopes

### Install

```bash
git clone https://github.com/edmaker89/code-mode-poc.git
cd code-mode-poc
npm install
```

### Environment Variables

Create `.env` file (or export in shell):

```bash
# Required
LLM_API_KEY=your-9router-api-key
LLM_BASE_URL=http://127.0.0.1:20128/v1
LLM_MODEL=qwen2.5-coder-7b          # or whatever model 9router serves
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxx  # GitHub PAT with repo + public_repo scopes

# Optional
SANDBOX_TIMEOUT_MS=60000
```

---

## Running the PoC

### 1. Direct Test (GitHub MCP + 9router)

```bash
# Terminal 1: Run test suite
LLM_API_KEY=$LLM_API_KEY LLM_BASE_URL=$LLM_BASE_URL GITHUB_TOKEN=$GITHUB_TOKEN npm run test:github
```

This runs 3 test queries against real GitHub MCP:
1. List repositories
2. List repos + read README from first
3. Search TypeScript files in `facebook/react`

### 2. MCP Server Mode (for Claude Code, OpenCode, Codex)

The MCP server exposes `code_mode` and `code_mode_list_servers` tools via stdio.

```bash
# Terminal 1: Start MCP server (keep running)
LLM_API_KEY=$LLM_API_KEY LLM_BASE_URL=$LLM_BASE_URL GITHUB_TOKEN=$GITHUB_TOKEN npm run mcp
# Output: "Code Mode MCP Server running on stdio"
```

**Terminal 2**: Connect your AI client (see configurations below).

---

## Connecting to AI Clients

### ⚠️ IMPORTANT: OpenCode uses DIFFERENT config format

| Client | Config File | Key Differences |
|--------|-------------|-----------------|
| **Claude Code / VS Code / Cursor** | `mcp.json` | `"mcpServers"`, `"command"` + `"args"`, `"env"` |
| **OpenCode** | `~/.config/opencode/opencode.json` | `"mcp"`, `"command": [...]` (array), `"environment"`, `"type": "local"` |

---

### 1. Claude Code

```bash
# Option A: CLI (recommended)
claude mcp add code-mode \
  -e LLM_API_KEY=$LLM_API_KEY \
  -e LLM_BASE_URL=$LLM_BASE_URL \
  -e LLM_MODEL=$LLM_MODEL \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  -- npx tsx /full/path/to/code-mode-poc/src/mcp-server.ts

# Option B: Manual config (~/.claude/mcp_servers.json or project .mcp.json)
{
  "mcpServers": {
    "code-mode": {
      "command": "npx",
      "args": ["tsx", "/full/path/to/code-mode-poc/src/mcp-server.ts"],
      "env": {
        "LLM_API_KEY": "your-key",
        "LLM_BASE_URL": "http://127.0.0.1:20128/v1",
        "LLM_MODEL": "qwen2.5-coder-7b",
        "GITHUB_TOKEN": "ghp_xxx"
      }
    }
  }
}
```

**Usage in Claude Code:**
```
/mcp code-mode code_mode "List my GitHub repositories and read the first one's README"
```

---

### 2. OpenCode

**File:** `~/.config/opencode/opencode.json`

```json
{
  "mcp": {
    "code-mode": {
      "type": "local",
      "command": [
        "npx",
        "tsx",
        "/full/path/to/code-mode-poc/src/mcp-server.ts"
      ],
      "environment": {
        "LLM_API_KEY": "your-9router-key",
        "LLM_BASE_URL": "http://127.0.0.1:20128/v1",
        "LLM_MODEL": "qwen2.5-coder-7b",
        "GITHUB_TOKEN": "ghp_xxx"
      }
    }
  }
}
```

**Key differences from Claude format:**
- Root key: `"mcp"` (not `"mcpServers"`)
- Command is single array: `["npx", "tsx", "..."]` (not separate `command` + `args`)
- Env vars: `"environment"` (not `"env"`)
- Required: `"type": "local"`

**Or via CLI:**
```bash
opencode mcp add --global \
  --env LLM_API_KEY="your-key" \
  --env LLM_BASE_URL="http://127.0.0.1:20128/v1" \
  --env LLM_MODEL="qwen2.5-coder-7b" \
  --env GITHUB_TOKEN="ghp_xxx" \
  code-mode -- npx tsx /full/path/to/code-mode-poc/src/mcp-server.ts
```

**Verify:**
```bash
opencode mcp list
# Should show: code-mode  local  connected
```

**Usage in OpenCode:**
```
You: "Use code_mode to list my GitHub repositories and show me the first one's README"
```

---

### 3. Codex (VS Code Extension)

**Settings > MCP** or `~/.codex/mcp.json`:

```json
{
  "mcpServers": {
    "code-mode": {
      "command": "npx",
      "args": ["tsx", "/full/path/to/code-mode-poc/src/mcp-server.ts"],
      "env": {
        "LLM_API_KEY": "your-key",
        "LLM_BASE_URL": "http://127.0.0.1:20128/v1",
        "LLM_MODEL": "qwen2.5-coder-7b",
        "GITHUB_TOKEN": "ghp_xxx"
      }
    }
  }
}
```

*Note: Codex uses Claude-style format (`mcpServers`, `command` + `args`, `env`)*

---

### 4. Multiple MCP Servers (Advanced)

Configure multiple MCP servers via `MCP_SERVERS` env var:

```bash
export MCP_SERVERS='[
  {"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"ghp_xxx"}},
  {"name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/home/user/projects"]},
  {"name":"postgres","command":"npx","args":["-y","@modelcontextprotocol/server-postgres"],"env":{"DATABASE_URL":"postgresql://..."}}
]'

# Then start server with just LLM config:
LLM_API_KEY=$LLM_API_KEY LLM_BASE_URL=$LLM_BASE_URL npm run mcp
```

The `code_mode` tool accepts optional `mcpServer` parameter to choose which server to use.

---

## Available Tools (via MCP)

| Tool | Description |
|------|-------------|
| `code_mode` | Execute a task: MCP → TS types → LLM code gen → sandbox → result |
| `code_mode_list_servers` | List configured MCP server names |

**Example `code_mode` input:**
```json
{
  "query": "Search for TypeScript files in facebook/react repo",
  "mcpServer": "github"
}
```

**Example output:**
```json
{
  "success": true,
  "query": "Search for TypeScript files in facebook/react repo",
  "generatedCode": "try { const result = await mcp.searchCode({ q: \"repo:facebook/react language:typescript\" }); console.log(JSON.stringify(result)); } catch (err) { console.log(JSON.stringify({ error: err.message })); }",
  "output": "[{\"type\":\"text\",\"text\":\"{\\\"total_count\\\":1234,...}\"}]",
  "executionTimeMs": 268
}
```

---

## Project Structure

```
src/
├── agent.ts           # Main orchestrator (CodeModeAgent)
├── llm-codegen.ts     # LLM integration (OpenRouter/9router) + prompts
├── sandbox.ts         # Node vm sandbox with TS/markdown stripping
├── ts-generator.ts    # MCP schema → TypeScript definitions
├── mcp-client.ts      # MCP stdio/SSE client wrapper
├── mcp-server.ts      # MCP server exposing code_mode tool
├── index.ts           # CLI demo (simulated LLM)
test-openrouter.ts     # Test suite for GitHub MCP + real LLM
```

---

## How It Works (Internals)

1. **MCP Client** connects to MCP server (stdio), fetches tool list + schemas
2. **TS Generator** converts JSON schemas → TypeScript type definitions (`declare const mcp: { toolName: (args) => Promise<any> }`)
3. **LLM Codegen** sends system prompt + TS types + user query to 9router → LLM returns TypeScript code
4. **TypeScript Validation** runs `tsc --noEmit` on generated code (catches syntax errors)
5. **Sandbox** strips TS annotations + markdown fences, executes in Node `vm` with injected `mcp` bindings
6. **MCP Bindings** in sandbox forward tool calls back to real MCP server via stdio
7. **Result** returned as clean JSON to LLM for final response

---

## Security Notes

- **No API keys in code** — all via environment variables
- **Sandbox uses Node `vm`** — NOT production secure (no network/filesystem isolation)
- **For production**: Use Cloudflare V8 Isolates, Deno, `isolated-vm`, or Firecracker
- **Bindings injected** into sandbox global — user code never sees credentials

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `LLM_API_KEY required` | Export `LLM_API_KEY` or add to `.env` |
| `Authentication Failed: Requires authentication` (searchCode) | GitHub PAT needs `public_repo` scope |
| `tsc --noEmit` fails | Check generated code — LLM sometimes outputs invalid TS |
| MCP server not connecting | Verify `npx tsx src/mcp-server.ts` runs manually first |
| OpenCode not seeing tools | Check `opencode mcp list` — must show `connected` |

---

## Research & Background

- **Blog**: [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/)
- **Research doc**: `work/research/cloudflare-code-mode-research.md` (in sibling workspace)
- **OpenCode MCP config guide**: `work/research/opencode-mcp-config.md`

---

## License

ISC — Use freely for learning, experimentation, production (with proper sandbox).