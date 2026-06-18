# Security Policy

## Reporting a Vulnerability

**Do not open a public issue.** Email the maintainer directly with details.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Yes    |
| < 0.1.0 | ❌ No     |

## Security Model

DeepSeek Orcana is a local-first terminal agent. Key security boundaries:

### 1. API Key Management

API keys are read from environment variables (`DEEPSEEK_API_KEY`) or `.env` files. **Never commit `.env` to version control.** The `.gitignore` excludes `.env` by default, but verify before pushing.

### 2. Sandbox

The path-guard sandbox blocks writes to system directories:
- Windows: `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`
- Unix: `/System`, `/etc`, `/boot`, `/sys`, `/proc`

The job-object sandbox (Windows) limits child process resource usage.

### 3. Permission System

Three-tier permission enforcement:
1. **Global Deny** — hard blocks (system paths, destructive commands)
2. **User Config** — `~/.deepseek-code/permissions.json`
3. **Project Config** — `.deepseek-code/permissions.json`

Configure via `settings.json` or the `permissions.json` files directly.

### 4. MCP Server Isolation

MCP servers run as child processes with their own environment. Server configs are stored in `~/.deepseek-code/mcp.json`. Validate server commands before adding them.

### 5. Network Safety

- `web_fetch` blocks all private IP ranges (RFC 1918, loopback, link-local)
- `web_search` goes through configurable provider endpoints only

## What to Report

- API key leakage or insecure credential storage
- Sandbox bypass or path traversal
- Command injection in tool parameters
- Unsafe defaults that could cause data loss
- MCP server RCE vectors

## Acknowledgments

We appreciate responsible disclosure. Critical security issues will be addressed within 48 hours.
