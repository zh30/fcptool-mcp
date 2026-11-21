#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, VERSION } from './server.ts';
import { prewarm } from './ops.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (flag('--version')) {
  console.log(VERSION);
  process.exit(0);
}
if (flag('--help') || flag('-h')) {
  console.log(`fcptool-mcp ${VERSION} — MCP server for Final Cut Pro 13's fcptool

Usage:
  fcptool-mcp                      stdio transport (Claude Code, Codex, Grok CLI, Cursor, …)
  fcptool-mcp --http [--port 8765] [--host 127.0.0.1]
                                   Streamable HTTP transport at http://HOST:PORT/mcp

Environment:
  FCPTOOL_PATH            fcptool binary (default: inside /Applications/Final Cut Pro.app)
  FCP_APP_PATH            Final Cut Pro.app location
  FCPTOOL_MCP_MAX_PROCS   max concurrent fcptool processes (default: cores/2, 2..6)
  FCPTOOL_MCP_TIMEOUT_MS  per-call timeout (default 600000)
  FCPTOOL_MCP_PREWARM=0   skip warming the static cache at start-up`);
  process.exit(0);
}

if (process.env.FCPTOOL_MCP_PREWARM !== '0') prewarm();

if (flag('--http')) {
  const port = Number(value('--port') ?? 8765);
  const host = value('--host') ?? '127.0.0.1';
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${host}:${port}`]);
  const http = createHttpServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    // DNS-rebinding guard: only answer requests addressed to this local host.
    if (!allowedHosts.has(req.headers.host ?? '')) {
      res.writeHead(403).end('forbidden host');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end('invalid JSON');
      return;
    }
    // Stateless: one server+transport per request; caches and locks are process-wide.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  http.listen(port, host, () => console.error(`fcptool-mcp ${VERSION} listening on http://${host}:${port}/mcp`));
} else {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`fcptool-mcp ${VERSION} ready on stdio`);
}
