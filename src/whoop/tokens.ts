import type { Env } from "../env.ts"
import type { StoredTokens } from "./types.ts"

const KEY = "owner"

/** Load the single-tenant WHOOP token blob */
export async function loadOwner(env: Env): Promise<StoredTokens | null> {
  const raw = await env.WHOOP_TOKENS.get(KEY)
  if (!raw) {
    return null
  }
  return JSON.parse(raw) as StoredTokens
}

/** Persist the single-tenant WHOOP token blob */
export async function saveOwner(env: Env, tokens: StoredTokens): Promise<void> {
  await env.WHOOP_TOKENS.put(KEY, JSON.stringify(tokens))
}

/** Delete stored WHOOP tokens */
export async function clearOwner(env: Env): Promise<void> {
  await env.WHOOP_TOKENS.delete(KEY)
}

/** True if an owner token blob exists */
export async function ownerConnected(env: Env): Promise<boolean> {
  const raw = await env.WHOOP_TOKENS.get(KEY)
  return raw !== null
}
