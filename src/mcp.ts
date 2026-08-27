import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { Env } from "./env.ts"
import { WhoopClient, WhoopDisconnected, WhoopHttpError, WhoopRateLimited } from "./whoop/client.ts"
import { dayQueryWindow, presentDay } from "./whoop/day.ts"
import {
  InvalidRange,
  expandDateRange,
  presentLatest,
  presentProfile,
  presentRecovery,
  presentSleep,
  presentWorkout,
} from "./whoop/present.ts"
import { presentSummary } from "./whoop/summarize.ts"
import type { WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from "./whoop/types.ts"

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const OFFSET = z.string().optional()
const JSON_CAP = 18_000
const LIST_DEFAULT = 90
const LIST_MAX = 100

const INSTRUCTIONS =
  'Call get_latest for “how recovered am I today?” or last night’s sleep. Call summarize_range for weekly/block planning. Call get_day for a specific calendar date. Call list_recoveries / list_sleep / list_workouts for row-level trends. Call get_profile only for name or body measurements. WHOOP cycles are sleep-to-sleep, not calendar days. Do not request continuous heart-rate samples; they are not available.'

/** Build a per-request MCP server bound to this Worker env */
export function createWhoopServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "whoopcp", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  )
  const whoop = new WhoopClient(env)

  server.registerTool(
    "ping",
    { description: "Liveness check. Does not call WHOOP.", inputSchema: {} },
    async function () {
      return ok({ ok: true })
    },
  )

  server.registerTool(
    "get_profile",
    {
      description:
        "Return the WHOOP member's name, user id, height, weight, and max heart rate. Omit email. Do not use this for recovery, sleep, or strain — use get_latest or get_day.",
      inputSchema: {},
    },
    async function () {
      return runTool("get_profile", async function () {
        const profile = await whoop.fetchProfile()
        const body = await whoop.fetchBody()
        return presentProfile(profile, body)
      })
    },
  )

  server.registerTool(
    "get_latest",
    {
      description:
        "Call get_latest for “how recovered am I today?”, last night’s sleep, or today’s strain so far. One call. Do not use for a specific past date (get_day) or a week (summarize_range).",
      inputSchema: {},
    },
    async function () {
      return runTool("get_latest", async function () {
        const pair = await Promise.all([
          whoop.fetchRecoveriesPage(5),
          whoop.fetchSleepsPage(5),
          whoop.fetchCyclesPage(2),
        ])
        return presentLatest(pair[0], pair[1], pair[2], new Date().toISOString())
      })
    },
  )

  server.registerTool(
    "get_day",
    {
      description:
        "Call get_latest for today-in-general. Call get_day for a specific YYYY-MM-DD. Call summarize_range for a week or month. A WHOOP cycle is sleep-to-sleep, not a calendar day.",
      inputSchema: {
        date: DATE,
        timezone_offset: OFFSET,
      },
    },
    async function (args: { date: string; timezone_offset?: string }) {
      return runTool("get_day", async function () {
        let offset = args.timezone_offset
        if (!offset) {
          offset = await whoop.timezoneOffset()
        }
        const window = dayQueryWindow(args.date, offset)
        const params = { start: window.startUtc, end: window.endUtc }
        const pair = await Promise.all([
          whoop.collectAll<WhoopCycle>("/v2/cycle", params),
          whoop.collectAll<WhoopRecovery>("/v2/recovery", params),
          whoop.collectAll<WhoopSleep>("/v2/activity/sleep", params),
          whoop.collectAll<WhoopWorkout>("/v2/activity/workout", params),
        ])
        return presentDay(
          args.date,
          offset,
          pair[0].records,
          pair[1].records,
          pair[2].records,
          pair[3].records,
        )
      })
    },
  )

  server.registerTool(
    "list_recoveries",
    {
      description:
        "Recovery / HRV / RHR rows for a date range. Use get_day or get_latest for a single day. Pending rows are included.",
      inputSchema: rangeSchema(),
    },
    async function (args: RangeArgs) {
      return runTool("list_recoveries", async function () {
        const fetched = await fetchRange(whoop, args)
        const rows = fetched.recoveries.records.map(function (r) {
          return presentRecovery(r, fetched.offset)
        })
        return listPayload(rows, fetched.recoveries.truncated, fetched.recoveries.pages, args.limit)
      })
    },
  )

  server.registerTool(
    "list_sleep",
    {
      description:
        "Sleep series for a date range, including stages. Prefer summarize_range for weekly averages. Set include_naps=false to drop naps.",
      inputSchema: {
        ...rangeSchema(),
        include_naps: z.boolean().optional(),
      },
    },
    async function (args: RangeArgs & { include_naps?: boolean }) {
      return runTool("list_sleep", async function () {
        const fetched = await fetchRange(whoop, args)
        let rows = fetched.sleeps.records.map(presentSleep)
        if (args.include_naps === false) {
          rows = rows.filter(function (s) {
            return !s.nap
          })
        }
        return listPayload(rows, fetched.sleeps.truncated, fetched.sleeps.pages, args.limit)
      })
    },
  )

  server.registerTool(
    "list_workouts",
    {
      description:
        "Workout sessions: sport, duration, strain, HR, zones, distance. WHOOP does not expose continuous heart-rate samples. Optional sport is a case-insensitive substring of sport_name.",
      inputSchema: {
        ...rangeSchema(),
        sport: z.string().optional(),
      },
    },
    async function (args: RangeArgs & { sport?: string }) {
      return runTool("list_workouts", async function () {
        const fetched = await fetchRange(whoop, args)
        let rows = fetched.workouts.records.map(presentWorkout)
        if (args.sport) {
          const needle = args.sport.toLowerCase()
          rows = rows.filter(function (w) {
            return w.sport.toLowerCase().indexOf(needle) !== -1
          })
        }
        return listPayload(rows, fetched.workouts.truncated, fetched.workouts.pages, args.limit)
      })
    },
  )

  server.registerTool(
    "summarize_range",
    {
      description:
        "Weekly or block averages: recovery bands (red score < 34, yellow 34–66, green >= 67), sleep hours, cycle strain, workout counts. Prefer this over listing 30+ raw rows. Max 90 days.",
      inputSchema: {
        start: DATE,
        end: DATE,
        timezone_offset: OFFSET,
      },
    },
    async function (args: { start: string; end: string; timezone_offset?: string }) {
      return runTool("summarize_range", async function () {
        const window = await whoop.rangeWindow(args.start, args.end, args.timezone_offset)
        const truncated =
          window.recoveries.truncated ||
          window.sleeps.truncated ||
          window.cycles.truncated ||
          window.workouts.truncated
        return presentSummary(
          args.start,
          args.end,
          window.offset,
          window.days,
          truncated,
          window.recoveries.records,
          window.sleeps.records,
          window.cycles.records,
          window.workouts.records,
        )
      })
    },
  )

  return server
}

type RangeArgs = {
  start: string
  end: string
  timezone_offset?: string
  limit?: number
}

function rangeSchema() {
  return {
    start: DATE,
    end: DATE,
    timezone_offset: OFFSET,
    limit: z.number().int().min(1).max(LIST_MAX).optional(),
  }
}

async function fetchRange(whoop: WhoopClient, args: RangeArgs) {
  let offset = args.timezone_offset
  if (!offset) {
    offset = await whoop.timezoneOffset()
  }
  const window = expandDateRange(args.start, args.end, offset)
  const params = { start: window.startUtc, end: window.endUtc }
  const pair = await Promise.all([
    whoop.collectAll<WhoopRecovery>("/v2/recovery", params),
    whoop.collectAll<WhoopSleep>("/v2/activity/sleep", params),
    whoop.collectAll<WhoopWorkout>("/v2/activity/workout", params),
  ])
  return {
    offset,
    recoveries: pair[0],
    sleeps: pair[1],
    workouts: pair[2],
  }
}

function listPayload<T>(
  rows: T[],
  truncated: boolean,
  pages: number,
  limit: number | undefined,
): { rows: T[]; truncated: boolean; pages: number } {
  let cap = LIST_DEFAULT
  if (typeof limit === "number") {
    cap = limit
  }
  if (cap > LIST_MAX) {
    cap = LIST_MAX
  }
  let cut = truncated
  let out = rows
  if (out.length > cap) {
    out = out.slice(0, cap)
    cut = true
  }
  return { rows: out, truncated: cut, pages }
}

async function runTool(
  name: string,
  fn: () => Promise<unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const t0 = Date.now()
  try {
    const data = await fn()
    const text = capJson(data)
    console.log(
      JSON.stringify({
        tool: name,
        latency_ms: Date.now() - t0,
        truncated: text.indexOf('"truncated":true') !== -1,
      }),
    )
    return okText(text)
  } catch (err) {
    const mapped = mapError(err)
    console.log(
      JSON.stringify({
        tool: name,
        latency_ms: Date.now() - t0,
        error_code: mapped.code,
      }),
    )
    return fail(mapped.message)
  }
}

function mapError(err: unknown): { message: string; code: string } {
  if (err instanceof InvalidRange) {
    return { message: err.message, code: "bad_range" }
  }
  if (err instanceof WhoopDisconnected) {
    return { message: err.message, code: "disconnected" }
  }
  if (err instanceof WhoopRateLimited) {
    return { message: err.message, code: "rate_limited" }
  }
  if (err instanceof WhoopHttpError && err.status >= 500) {
    return { message: err.message, code: "whoop_http" }
  }
  if (err instanceof WhoopHttpError) {
    return { message: err.message, code: "whoop_http" }
  }
  return { message: "Internal error.", code: "internal" }
}

function capJson(data: unknown): string {
  const text = JSON.stringify(data)
  if (text.length <= JSON_CAP) {
    return text
  }
  if (!data || typeof data !== "object") {
    return text.slice(0, JSON_CAP)
  }
  const rec = data as { rows?: unknown[]; truncated?: boolean }
  if (!Array.isArray(rec.rows)) {
    return text.slice(0, JSON_CAP)
  }
  const copy = Object.assign({}, rec, { truncated: true, rows: rec.rows.slice() })
  while (JSON.stringify(copy).length > JSON_CAP && copy.rows.length > 0) {
    copy.rows.pop()
  }
  return JSON.stringify(copy)
}

function ok(data: unknown): { content: { type: "text"; text: string }[] } {
  return okText(JSON.stringify(data))
}

function okText(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] }
}

function fail(message: string): {
  isError: true
  content: { type: "text"; text: string }[]
} {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  }
}

