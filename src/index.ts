import { createMcpHandler } from "agents/mcp/server"
import { requireMcpBearer } from "./auth.ts"
import type { Env } from "./env.ts"
import { createWhoopServer } from "./mcp.ts"
import { disconnect, handleCallback, startConnect } from "./whoop/oauth.ts"
import { ownerConnected } from "./whoop/tokens.ts"

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      return health(env)
    }
    if (url.pathname === "/connect") {
      return startConnect(request, env)
    }
    if (url.pathname === "/whoop/callback") {
      return handleCallback(request, env)
    }
    if (url.pathname === "/disconnect") {
      return disconnect(request, env)
    }
    if (url.pathname === "/mcp") {
      if (request.method !== "OPTIONS") {
        const denied = await requireMcpBearer(request, env)
        if (denied) {
          return denied
        }
      }
      return createMcpHandler(function () {
        return createWhoopServer(env)
      }, { route: "/mcp" })(request, env, ctx)
    }
    if (url.pathname === "/privacy") {
      return privacy()
    }
    if (url.pathname === "/") {
      return new Response("whoopcp — personal WHOOP MCP\n/health\n/connect\n/privacy\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    return new Response("Not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>

async function health(env: Env): Promise<Response> {
  const connected = await ownerConnected(env)
  return Response.json({ ok: true, whoop_connected: connected })
}

function privacy(): Response {
  return new Response(
    `<!doctype html>
<meta charset="utf-8">
<title>whoopcp privacy</title>
<h1>Privacy</h1>
<p>whoopcp is a personal, read-only bridge from one WHOOP account to a coach agent.</p>
<p>It stores WHOOP OAuth tokens in Cloudflare KV. It does not store sleep, recovery, or workout payloads. It does not sell or share data. Email from WHOOP is dropped before any tool result.</p>
<p>Revoke access with POST /disconnect on this host, or in the WHOOP app.</p>
`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  )
}
