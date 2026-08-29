import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import type { Env } from "../src/env.ts"
import { WhoopClient } from "../src/whoop/client.ts"
import { loadOwner } from "../src/whoop/tokens.ts"
import type { StoredTokens } from "../src/whoop/types.ts"

const origFetch = globalThis.fetch

afterEach(function () {
  globalThis.fetch = origFetch
})

describe("WHOOP refresh", function () {
  it("one token POST for three parallel expired calls", async function () {
    const env = testEnv(expiredTokens("old-r"))
    const stats = installWhoopFetch({ reuseReject: true })
    const whoop = new WhoopClient(env)
    const rows = await Promise.all([
      whoop.fetchRecoveriesPage(5),
      whoop.fetchSleepsPage(5),
      whoop.fetchCyclesPage(2),
    ])
    assert.equal(stats.tokenPosts, 1)
    assert.equal(rows.length, 3)
    const stored = await loadOwner(env)
    assert.equal(stored?.refresh_token, "r1")
  })

  it("one token POST for three parallel 401s", async function () {
    const env = testEnv(liveTokens("old-r"))
    const stats = installWhoopFetch({ reuseReject: true, rejectOldAccess: true })
    const whoop = new WhoopClient(env)
    await Promise.all([
      whoop.fetchRecoveriesPage(5),
      whoop.fetchSleepsPage(5),
      whoop.fetchCyclesPage(2),
    ])
    assert.equal(stats.tokenPosts, 1)
  })

  it("keeps the previous refresh token if WHOOP omits it", async function () {
    const env = testEnv(expiredTokens("keep-me"))
    installWhoopFetch({ omitRefresh: true })
    const whoop = new WhoopClient(env)
    await whoop.refreshNow()
    const stored = await loadOwner(env)
    assert.equal(stored?.refresh_token, "keep-me")
  })
})

function expiredTokens(refresh: string): StoredTokens {
  return {
    version: 1,
    access_token: "old-a",
    refresh_token: refresh,
    expires_at: Date.now() - 1000,
    scope: "offline",
    token_type: "bearer",
    connected_at: 1,
  }
}

function liveTokens(refresh: string): StoredTokens {
  return {
    version: 1,
    access_token: "old-a",
    refresh_token: refresh,
    expires_at: Date.now() + 60 * 60 * 1000,
    scope: "offline",
    token_type: "bearer",
    connected_at: 1,
  }
}

function testEnv(tokens: StoredTokens): Env {
  let raw: string | null = JSON.stringify(tokens)
  return {
    WHOOP_TOKENS: {
      get: async function () {
        return raw
      },
      put: async function (_key: string, value: string) {
        raw = value
      },
      delete: async function () {
        raw = null
      },
    } as KVNamespace,
    WHOOP_CLIENT_ID: "id",
    WHOOP_CLIENT_SECRET: "secret",
    MCP_TOKEN: "mcp",
    WHOOP_REDIRECT_URI: "http://localhost/cb",
  }
}

function installWhoopFetch(opts: {
  reuseReject?: boolean
  omitRefresh?: boolean
  rejectOldAccess?: boolean
}): { tokenPosts: number } {
  const spent = new Set<string>()
  const stats = { tokenPosts: 0 }
  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const url = String(input)
    if (url.indexOf("/oauth/oauth2/token") !== -1) {
      const body = String(init?.body || "")
      const rt = new URLSearchParams(body).get("refresh_token") || ""
      if (opts.reuseReject && spent.has(rt)) {
        return new Response("reuse", { status: 400 })
      }
      spent.add(rt)
      stats.tokenPosts += 1
      await new Promise(function (resolve) {
        setTimeout(resolve, 30)
      })
      const payload: Record<string, unknown> = {
        access_token: "new-a",
        expires_in: 3600,
        token_type: "bearer",
        scope: "offline",
      }
      if (!opts.omitRefresh) {
        payload.refresh_token = "r" + String(stats.tokenPosts)
      }
      return Response.json(payload)
    }
    if (opts.rejectOldAccess) {
      const headers = init?.headers as Record<string, string> | undefined
      const auth = headers ? headers.Authorization : ""
      if (auth !== "Bearer new-a") {
        return new Response("", { status: 401 })
      }
    }
    return Response.json({ records: [], next_token: null })
  } as typeof fetch
  return stats
}
