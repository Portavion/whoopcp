import type { Env } from "./env.ts"

const STATE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"

/** Extract a bearer or raw token from Authorization */
export function parseBearer(header: string | null): string | null {
  if (!header) {
    return null
  }
  let trimmed = header.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      trimmed = trimmed.slice(1, -1).trim()
    }
  }
  if (trimmed.length === 0) {
    return null
  }
  const lower = trimmed.toLowerCase()
  if (lower === "bearer") {
    return null
  }
  if (lower.startsWith("bearer ")) {
    return parseBearer(trimmed.slice(7))
  }
  return trimmed
}

/** Gate token from Authorization, X-MCP-Token, or X-Api-Key */
export function mcpTokenFromRequest(request: Request): string | null {
  const fromAuth = parseBearer(request.headers.get("Authorization"))
  if (fromAuth) {
    return fromAuth
  }
  const fromMcp = parseBearer(request.headers.get("X-MCP-Token"))
  if (fromMcp) {
    return fromMcp
  }
  return parseBearer(request.headers.get("X-Api-Key"))
}

/** 401 unless Authorization matches MCP_TOKEN; localhost may skip if unset */
export async function requireMcpBearer(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url)
  const token = env.MCP_TOKEN
  if (!token) {
    if (isLocalhost(url.hostname)) {
      return null
    }
    return new Response("MCP_TOKEN not configured", { status: 503 })
  }
  const provided = mcpTokenFromRequest(request)
  if (!provided) {
    return unauthorized()
  }
  const ok = await secretsEqual(provided, token)
  if (!ok) {
    return unauthorized()
  }
  return null
}

/** CONNECT_TOKEN, or MCP_TOKEN if connect secret is unset */
export function connectSecret(env: Env): string | null {
  if (env.CONNECT_TOKEN) {
    return env.CONNECT_TOKEN
  }
  if (env.MCP_TOKEN) {
    return env.MCP_TOKEN
  }
  return null
}

/** Compare a provided connect secret to CONNECT_TOKEN/MCP_TOKEN */
export async function connectTokenValid(provided: string | null, env: Env): Promise<boolean> {
  const expected = connectSecret(env)
  if (!expected || !provided) {
    return false
  }
  return secretsEqual(provided, expected)
}

/** True when hostname is loopback */
export function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

/** 8 url-safe chars for WHOOP OAuth state */
export function randomState(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    out += STATE_CHARS[bytes[i] % 64]
  }
  return out
}

/** 32-byte hex nonce */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return hex(buf)
}

/** HMAC cookie value exp.nonce.mac bound to the connect secret */
export async function mintConnectCookie(env: Env, ttlMs: number): Promise<string | null> {
  const secret = connectSecret(env)
  if (!secret) {
    return null
  }
  const exp = Date.now() + ttlMs
  const nonce = randomHex(32)
  const payload = String(exp) + "." + nonce
  const mac = await hmacHex(secret, payload)
  return payload + "." + mac
}

/** Verify and consume a whoop_connect cookie value */
export async function connectCookieValid(value: string | null, env: Env): Promise<boolean> {
  if (!value) {
    return false
  }
  const secret = connectSecret(env)
  if (!secret) {
    return false
  }
  const parts = value.split(".")
  if (parts.length !== 3) {
    return false
  }
  const exp = Number(parts[0])
  if (!Number.isFinite(exp) || Date.now() > exp) {
    return false
  }
  const payload = parts[0] + "." + parts[1]
  const mac = await hmacHex(secret, payload)
  return secretsEqual(mac, parts[2])
}

/** Read one cookie by name */
export function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie")
  if (!header) {
    return null
  }
  const parts = header.split(";")
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i].trim()
    const eq = piece.indexOf("=")
    if (eq <= 0) {
      continue
    }
    if (piece.slice(0, eq) === name) {
      return piece.slice(eq + 1)
    }
  }
  return null
}

/** Set-Cookie string; Secure only on https */
export function setCookie(
  name: string,
  value: string,
  maxAge: number,
  https: boolean,
): string {
  let cookie =
    name +
    "=" +
    value +
    "; Path=/; HttpOnly; Max-Age=" +
    String(maxAge) +
    "; SameSite=Lax"
  if (https) {
    cookie += "; Secure"
  }
  return cookie
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer" },
  })
}

async function secretsEqual(a: string, b: string): Promise<boolean> {
  const ha = await sha256(a)
  const hb = await sha256(b)
  return xorEqual(ha, hb)
}

async function sha256(s: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return new Uint8Array(buf)
}

async function hmacHex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data))
  return hex(new Uint8Array(sig))
}

function xorEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false
  }
  let out = 0
  for (let i = 0; i < a.length; i++) {
    out |= a[i] ^ b[i]
  }
  return out === 0
}

function hex(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0")
  }
  return out
}
