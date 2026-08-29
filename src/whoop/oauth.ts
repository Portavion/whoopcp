import {
  connectCookieValid,
  connectSecret,
  connectTokenValid,
  cookieValue,
  mintConnectCookie,
  randomState,
  setCookie,
} from "../auth.ts"
import type { Env } from "../env.ts"
import { clearOwner, loadOwner, saveOwner } from "./tokens.ts"
import type { StoredTokens } from "./types.ts"

const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
export const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
export const API_BASE = "https://api.prod.whoop.com/developer"
const SCOPES =
  "offline read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement"

const NO_STORE = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
}

/** Route GET/POST /connect: form, cookie swap, or authorize redirect */
export async function startConnect(request: Request, env: Env): Promise<Response> {
  if (!connectSecret(env)) {
    return new Response("CONNECT_TOKEN not configured", { status: 503 })
  }
  const url = new URL(request.url)
  const https = url.protocol === "https:"

  if (request.method === "GET") {
    const queryToken = url.searchParams.get("token")
    if (queryToken) {
      const ok = await connectTokenValid(queryToken, env)
      if (!ok) {
        return new Response("Unauthorized", { status: 401 })
      }
      const cookie = await mintConnectCookie(env, 120_000)
      if (!cookie) {
        return new Response("CONNECT_TOKEN not configured", { status: 503 })
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/connect",
          "Set-Cookie": setCookie("whoop_connect", cookie, 120, https),
          ...NO_STORE,
        },
      })
    }
    const connectCookie = cookieValue(request, "whoop_connect")
    if (connectCookie) {
      const ok = await connectCookieValid(connectCookie, env)
      if (!ok) {
        return html(connectForm(), 200)
      }
      return beginAuthorize(env, https, true)
    }
    return html(connectForm(), 200)
  }

  if (request.method === "POST") {
    const form = await request.formData()
    const token = form.get("token")
    let provided: string | null = null
    if (typeof token === "string") {
      provided = token
    }
    const ok = await connectTokenValid(provided, env)
    if (!ok) {
      return html(connectForm(), 401)
    }
    return beginAuthorize(env, https, false)
  }

  return new Response("Method not allowed", { status: 405 })
}

/** Exchange the authorization code and store tokens */
export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const expected = cookieValue(request, "whoop_oauth_state")
  if (!code || !state || !expected || state !== expected) {
    return html("<p>WHOOP connect failed.</p>", 400)
  }
  try {
    const tokens = await exchangeCode(env, code)
    await saveOwner(env, tokens)
  } catch {
    return html("<p>WHOOP connect failed.</p>", 400)
  }
  const https = url.protocol === "https:"
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" })
  headers.append("Set-Cookie", setCookie("whoop_oauth_state", "", 0, https))
  headers.append("Set-Cookie", setCookie("whoop_connect", "", 0, https))
  return new Response("<p>WHOOP connected. You can close this tab.</p>", {
    status: 200,
    headers,
  })
}

/** Revoke WHOOP access and delete stored tokens */
export async function disconnect(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }
  const url = new URL(request.url)
  let provided: string | null = url.searchParams.get("token")
  const contentType = request.headers.get("content-type")
  if (contentType && contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData()
    const token = form.get("token")
    if (typeof token === "string") {
      provided = token
    }
  }
  const cookieOk = await connectCookieValid(cookieValue(request, "whoop_connect"), env)
  const tokenOk = await connectTokenValid(provided, env)
  if (!cookieOk && !tokenOk) {
    return new Response("Unauthorized", { status: 401 })
  }
  const stored = await loadOwner(env)
  if (stored) {
    try {
      await revokeAccess(stored.access_token)
    } catch {
      // owner can always unbind locally
    }
  }
  await clearOwner(env)
  return Response.json({ ok: true })
}

/** Refresh using the stored refresh token; persist the new pair */
export async function refreshTokens(env: Env, stored: StoredTokens): Promise<StoredTokens> {
  const body = new URLSearchParams()
  body.set("grant_type", "refresh_token")
  body.set("refresh_token", stored.refresh_token)
  body.set("client_id", env.WHOOP_CLIENT_ID)
  body.set("client_secret", env.WHOOP_CLIENT_SECRET)
  body.set("scope", "offline")
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!res.ok) {
    throw new Error("WHOOP refresh failed")
  }
  const next = await parseTokenResponse(res, stored.connected_at, stored.user_id, stored.refresh_token)
  await saveOwner(env, next)
  return next
}

async function exchangeCode(env: Env, code: string): Promise<StoredTokens> {
  const body = new URLSearchParams()
  body.set("grant_type", "authorization_code")
  body.set("code", code)
  body.set("client_id", env.WHOOP_CLIENT_ID)
  body.set("client_secret", env.WHOOP_CLIENT_SECRET)
  body.set("redirect_uri", env.WHOOP_REDIRECT_URI)
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!res.ok) {
    throw new Error("WHOOP token exchange failed")
  }
  return parseTokenResponse(res, Date.now(), undefined, undefined)
}

async function parseTokenResponse(
  res: Response,
  connectedAt: number,
  userId: number | undefined,
  previousRefresh: string | undefined,
): Promise<StoredTokens> {
  const json: unknown = await res.json()
  if (!json || typeof json !== "object") {
    throw new Error("WHOOP token response invalid")
  }
  const rec = json as Record<string, unknown>
  if (typeof rec.access_token !== "string" || typeof rec.expires_in !== "number") {
    throw new Error("WHOOP token response invalid")
  }
  let refresh = previousRefresh
  if (typeof rec.refresh_token === "string" && rec.refresh_token.length > 0) {
    refresh = rec.refresh_token
  }
  if (!refresh) {
    throw new Error("WHOOP token response missing refresh_token")
  }
  let scope = SCOPES
  if (typeof rec.scope === "string" && rec.scope.length > 0) {
    scope = rec.scope
  }
  return {
    version: 1,
    access_token: rec.access_token,
    refresh_token: refresh,
    expires_at: Date.now() + rec.expires_in * 1000 - 60_000,
    scope,
    token_type: "bearer",
    connected_at: connectedAt,
    user_id: userId,
  }
}

async function revokeAccess(accessToken: string): Promise<void> {
  await fetch(API_BASE + "/v2/user/access", {
    method: "DELETE",
    headers: { Authorization: "Bearer " + accessToken },
  })
}

function beginAuthorize(env: Env, https: boolean, clearConnectCookie: boolean): Response {
  const state = randomState()
  const auth = new URL(AUTH_URL)
  auth.searchParams.set("client_id", env.WHOOP_CLIENT_ID)
  auth.searchParams.set("redirect_uri", env.WHOOP_REDIRECT_URI)
  auth.searchParams.set("response_type", "code")
  auth.searchParams.set("scope", SCOPES)
  auth.searchParams.set("state", state)
  const headers = new Headers({
    Location: auth.toString(),
    ...NO_STORE,
  })
  headers.append("Set-Cookie", setCookie("whoop_oauth_state", state, 600, https))
  if (clearConnectCookie) {
    headers.append("Set-Cookie", setCookie("whoop_connect", "", 0, https))
  }
  return new Response(null, { status: 302, headers })
}

function connectForm(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Connect WHOOP</title>
<form method="post" action="/connect" autocomplete="off">
  <label>Connect token <input name="token" type="password" required></label>
  <button type="submit">Connect WHOOP</button>
</form>`
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}
