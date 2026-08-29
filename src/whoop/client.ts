import type { Env } from "../env.ts"
import { API_BASE, refreshTokens } from "./oauth.ts"
import { expandDateRange } from "./present.ts"
import { loadOwner } from "./tokens.ts"
import type {
  StoredTokens,
  WhoopBody,
  WhoopCollection,
  WhoopCycle,
  WhoopProfile,
  WhoopRecovery,
  WhoopSleep,
  WhoopWorkout,
} from "./types.ts"

const PAGE_LIMIT = 25
const MAX_PAGES = 8

export class WhoopDisconnected extends Error {
  constructor() {
    super("WHOOP disconnected. Owner must visit /connect.")
    this.name = "WhoopDisconnected"
  }
}

export class WhoopRateLimited extends Error {
  retryAfter: number
  constructor(retryAfter: number) {
    super("WHOOP rate limited. Retry after " + String(retryAfter) + "s.")
    this.name = "WhoopRateLimited"
    this.retryAfter = retryAfter
  }
}

export class WhoopHttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "WhoopHttpError"
    this.status = status
  }
}

export class WhoopClient {
  private env: Env
  private tokens: StoredTokens | null
  private latestOffset: string | null
  // ponytail: isolate-local lock. Durable Object if two Workers still race.
  private refreshInFlight: Promise<StoredTokens> | null

  constructor(env: Env) {
    this.env = env
    this.tokens = null
    this.latestOffset = null
    this.refreshInFlight = null
  }

  /** Load tokens and refresh if expired. Safe to call in parallel. */
  async ensureTokens(): Promise<StoredTokens> {
    if (!this.tokens) {
      this.tokens = await loadOwner(this.env)
    }
    if (!this.tokens) {
      throw new WhoopDisconnected()
    }
    if (Date.now() >= this.tokens.expires_at) {
      return this.refreshOnce()
    }
    return this.tokens
  }

  /** Refresh now even if the access token is still valid. */
  async refreshNow(): Promise<StoredTokens> {
    if (!this.tokens) {
      this.tokens = await loadOwner(this.env)
    }
    if (!this.tokens) {
      throw new WhoopDisconnected()
    }
    return this.refreshOnce()
  }

  /** Basic profile (caller must drop email at present layer) */
  async fetchProfile(): Promise<WhoopProfile> {
    return this.requestJson<WhoopProfile>("/v2/user/profile/basic")
  }

  /** Body measurements; null if WHOOP has none */
  async fetchBody(): Promise<WhoopBody | null> {
    return this.requestJsonOrNull<WhoopBody>("/v2/user/measurement/body")
  }

  /** One page of latest cycles */
  async fetchCyclesPage(limit: number): Promise<WhoopCycle[]> {
    const col = await this.requestJson<WhoopCollection<WhoopCycle>>(
      "/v2/cycle",
      { limit: String(limit) },
    )
    return col.records || []
  }

  /** One page of latest recoveries */
  async fetchRecoveriesPage(limit: number): Promise<WhoopRecovery[]> {
    const col = await this.requestJson<WhoopCollection<WhoopRecovery>>(
      "/v2/recovery",
      { limit: String(limit) },
    )
    return col.records || []
  }

  /** One page of latest sleeps */
  async fetchSleepsPage(limit: number): Promise<WhoopSleep[]> {
    const col = await this.requestJson<WhoopCollection<WhoopSleep>>(
      "/v2/activity/sleep",
      { limit: String(limit) },
    )
    return col.records || []
  }

  /** Offset from the latest cycle, or +00:00 */
  async timezoneOffset(): Promise<string> {
    if (this.latestOffset) {
      return this.latestOffset
    }
    const cycles = await this.fetchCyclesPage(1)
    if (cycles[0] && cycles[0].timezone_offset) {
      this.latestOffset = cycles[0].timezone_offset
      return this.latestOffset
    }
    this.latestOffset = "+00:00"
    return this.latestOffset
  }

  /** Auto-page a collection until MAX_PAGES */
  async collectAll<T>(
    path: string,
    params: { start?: string; end?: string },
  ): Promise<{ records: T[]; pages: number; truncated: boolean }> {
    const records: T[] = []
    let next: string | null = null
    let pages = 0
    let truncated = false
    while (pages < MAX_PAGES) {
      const query: Record<string, string> = { limit: String(PAGE_LIMIT) }
      if (params.start) {
        query.start = params.start
      }
      if (params.end) {
        query.end = params.end
      }
      if (next) {
        query.nextToken = next
      }
      const col = await this.requestJson<WhoopCollection<T>>(path, query)
      pages += 1
      const batch = col.records || []
      for (let i = 0; i < batch.length; i++) {
        records.push(batch[i])
      }
      if (!col.next_token) {
        return { records, pages, truncated }
      }
      next = col.next_token
    }
    truncated = true
    return { records, pages, truncated }
  }

  /** Expand YYYY-MM-DD range and page four collections for a day/summary */
  async rangeWindow(
    start: string,
    end: string,
    timezoneOffset: string | undefined,
  ): Promise<{
    offset: string
    startUtc: string
    endUtc: string
    days: number
    recoveries: { records: WhoopRecovery[]; pages: number; truncated: boolean }
    sleeps: { records: WhoopSleep[]; pages: number; truncated: boolean }
    cycles: { records: WhoopCycle[]; pages: number; truncated: boolean }
    workouts: { records: WhoopWorkout[]; pages: number; truncated: boolean }
  }> {
    await this.ensureTokens()
    let offset = timezoneOffset
    if (!offset) {
      offset = await this.timezoneOffset()
    }
    const window = expandDateRange(start, end, offset)
    const params = { start: window.startUtc, end: window.endUtc }
    const pair = await Promise.all([
      this.collectAll<WhoopRecovery>("/v2/recovery", params),
      this.collectAll<WhoopSleep>("/v2/activity/sleep", params),
      this.collectAll<WhoopCycle>("/v2/cycle", params),
      this.collectAll<WhoopWorkout>("/v2/activity/workout", params),
    ])
    return {
      offset,
      startUtc: window.startUtc,
      endUtc: window.endUtc,
      days: window.days,
      recoveries: pair[0],
      sleeps: pair[1],
      cycles: pair[2],
      workouts: pair[3],
    }
  }

  private async requestJsonOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.requestJson<T>(path)
    } catch (err) {
      if (err instanceof WhoopHttpError && err.status === 404) {
        return null
      }
      throw err
    }
  }

  private async requestJson<T>(
    path: string,
    query?: Record<string, string>,
  ): Promise<T> {
    const tokens = await this.ensureTokens()
    let res = await this.whoopFetch(path, query, tokens.access_token)
    if (res.status === 429) {
      const seconds = retryAfterSeconds(res)
      if (seconds <= 2) {
        await delay(seconds * 1000)
        res = await this.whoopFetch(path, query, tokens.access_token)
      }
      if (res.status === 429) {
        throw new WhoopRateLimited(retryAfterSeconds(res))
      }
    }
    if (res.status === 401) {
      return this.refreshAndRetry<T>(path, query)
    }
    return this.readOk<T>(res)
  }

  private async refreshAndRetry<T>(
    path: string,
    query: Record<string, string> | undefined,
  ): Promise<T> {
    try {
      const next = await this.refreshOnce()
      const res = await this.whoopFetch(path, query, next.access_token)
      if (res.status === 401) {
        throw new WhoopDisconnected()
      }
      return this.readOk<T>(res)
    } catch (err) {
      if (err instanceof WhoopDisconnected) {
        throw err
      }
      const again = await loadOwner(this.env)
      if (!again) {
        throw new WhoopDisconnected()
      }
      this.tokens = again
      const res = await this.whoopFetch(path, query, again.access_token)
      if (res.status === 401) {
        throw new WhoopDisconnected()
      }
      return this.readOk<T>(res)
    }
  }

  private refreshOnce(): Promise<StoredTokens> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.rotateTokens().finally(() => {
        this.refreshInFlight = null
      })
    }
    return this.refreshInFlight
  }

  private async rotateTokens(): Promise<StoredTokens> {
    let stored = this.tokens
    if (!stored) {
      stored = await loadOwner(this.env)
    }
    if (!stored) {
      throw new WhoopDisconnected()
    }
    try {
      const next = await refreshTokens(this.env, stored)
      this.tokens = next
      return next
    } catch {
      const again = await loadOwner(this.env)
      if (!again) {
        throw new WhoopDisconnected()
      }
      this.tokens = again
      if (Date.now() >= again.expires_at) {
        throw new WhoopDisconnected()
      }
      return again
    }
  }

  private async whoopFetch(
    path: string,
    query: Record<string, string> | undefined,
    accessToken: string,
  ): Promise<Response> {
    const url = new URL(API_BASE + path)
    if (query) {
      const keys = Object.keys(query)
      for (let i = 0; i < keys.length; i++) {
        url.searchParams.set(keys[i], query[keys[i]])
      }
    }
    return fetch(url.toString(), {
      headers: {
        Authorization: "Bearer " + accessToken,
        Accept: "application/json",
      },
    })
  }

  private async readOk<T>(res: Response): Promise<T> {
    if (res.status === 404) {
      throw new WhoopHttpError(404, "WHOOP 404")
    }
    if (!res.ok) {
      console.log(JSON.stringify({ whoop_status: res.status, error_code: "whoop_http" }))
      if (res.status >= 500) {
        throw new WhoopHttpError(res.status, "WHOOP unavailable (HTTP " + String(res.status) + ").")
      }
      throw new WhoopHttpError(res.status, "WHOOP " + String(res.status) + ": request failed")
    }
    return res.json() as Promise<T>
  }
}

function retryAfterSeconds(res: Response): number {
  const raw = res.headers.get("Retry-After")
  if (!raw) {
    return 60
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    return 60
  }
  return n
}

function delay(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}
