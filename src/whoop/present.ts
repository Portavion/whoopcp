import type {
  CycleRow,
  LatestView,
  ProfileView,
  RecoveryRow,
  SleepRow,
  WhoopBody,
  WhoopCycle,
  WhoopProfile,
  WhoopRecovery,
  WhoopSleep,
  WhoopWorkout,
  WorkoutRow,
} from "./types.ts"

const LATEST_NOTE =
  "WHOOP recovery and strain are for the current physiological cycle (sleep-to-sleep), not midnight-to-midnight. current_cycle is that in-progress cycle even if score_state is PENDING_SCORE (strain often lands when the cycle ends). latest_scored_cycle is the previous scored cycle, a different day — do not treat it as today’s strain. last_night_sleep is the latest non-nap sleep."

const YMD = /^\d{4}-\d{2}-\d{2}$/
const OFFSET = /^([+-])(\d{2}):(\d{2})$/

/** Parse WHOOP timezone_offset into minutes east of UTC */
export function offsetMinutes(offset: string): number {
  if (offset === "Z" || offset === "z") {
    return 0
  }
  const m = offset.match(OFFSET)
  if (!m) {
    throw new InvalidRange("Invalid timezone_offset. Use +hh:mm, -hh:mm, or Z.")
  }
  let sign = 1
  if (m[1] === "-") {
    sign = -1
  }
  return sign * (Number(m[2]) * 60 + Number(m[3]))
}

/** Inclusive YYYY-MM-DD window converted to WHOOP start/end UTC instants */
export function expandDateRange(
  start: string,
  end: string,
  offset: string,
): { startUtc: string; endUtc: string; days: number } {
  if (!YMD.test(start) || !YMD.test(end)) {
    throw new InvalidRange("Invalid range. Use inclusive YYYY-MM-DD spanning at most 90 days.")
  }
  const startParts = ymdParts(start)
  const endParts = ymdParts(end)
  const startMs = localMidnightUtcMs(startParts, offset)
  const endExclusiveMs = localMidnightUtcMs(addDays(endParts, 1), offset)
  if (endExclusiveMs <= startMs) {
    throw new InvalidRange("Invalid range. Use inclusive YYYY-MM-DD spanning at most 90 days.")
  }
  const days = Math.round((endExclusiveMs - startMs) / 86400000)
  if (days > 90) {
    throw new InvalidRange("Invalid range. Use inclusive YYYY-MM-DD spanning at most 90 days.")
  }
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endExclusiveMs).toISOString(),
    days,
  }
}

export class InvalidRange extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidRange"
  }
}

/** Compact profile; email is never included */
export function presentProfile(profile: WhoopProfile, body: WhoopBody | null): ProfileView {
  let bodyView = null
  if (body) {
    bodyView = {
      height_m: round(body.height_meter, 4),
      weight_kg: round(body.weight_kilogram, 2),
      max_heart_rate: body.max_heart_rate,
    }
  }
  return {
    user_id: profile.user_id,
    first_name: profile.first_name,
    last_name: profile.last_name,
    body: bodyView,
  }
}

/** Compact recovery row using created_at local date */
export function presentRecovery(row: WhoopRecovery, offset: string): RecoveryRow {
  const scored = row.score_state === "SCORED" && row.score
  return {
    date: localDate(row.created_at, offset),
    cycle_id: row.cycle_id,
    recovery_score: scored ? round(row.score!.recovery_score, 0) : null,
    hrv_rmssd_milli: scored ? round(row.score!.hrv_rmssd_milli, 1) : null,
    resting_heart_rate: scored ? row.score!.resting_heart_rate : null,
    spo2_percentage: scored ? round(row.score!.spo2_percentage, 0) : null,
    skin_temp_celsius: scored ? round(row.score!.skin_temp_celsius, 1) : null,
    user_calibrating: scored ? row.score!.user_calibrating : null,
    score_state: row.score_state,
  }
}

/** Compact sleep row; date is local wake date unless nap */
export function presentSleep(row: WhoopSleep): SleepRow {
  const offset = row.timezone_offset
  const scored = row.score_state === "SCORED" && row.score
  const stages = scored ? row.score!.stage_summary : null
  const needed = scored ? row.score!.sleep_needed : null
  let hours: number | null = null
  let inBed: number | null = null
  if (stages) {
    inBed = hoursFromMilli(stages.total_in_bed_time_milli)
    hours = hoursFromMilli(stages.total_in_bed_time_milli - stages.total_awake_time_milli)
  } else {
    hours = hoursFromMilli(Date.parse(row.end) - Date.parse(row.start))
  }
  let sleepNeeded: number | null = null
  if (needed) {
    sleepNeeded = hoursFromMilli(
      needed.baseline_milli +
        needed.need_from_sleep_debt_milli +
        needed.need_from_recent_strain_milli +
        needed.need_from_recent_nap_milli,
    )
  }
  let date = localDate(row.end, offset)
  if (row.nap) {
    date = localDate(row.start, offset)
  }
  return {
    id: row.id,
    cycle_id: row.cycle_id,
    date,
    start_local: localDateTime(row.start, offset),
    end_local: localDateTime(row.end, offset),
    hours,
    in_bed_hours: inBed,
    performance: scored ? round(row.score!.sleep_performance_percentage, 0) : null,
    efficiency: scored ? round(row.score!.sleep_efficiency_percentage, 1) : null,
    consistency: scored ? round(row.score!.sleep_consistency_percentage, 0) : null,
    light_h: stages ? hoursFromMilli(stages.total_light_sleep_time_milli) : null,
    sws_h: stages ? hoursFromMilli(stages.total_slow_wave_sleep_time_milli) : null,
    rem_h: stages ? hoursFromMilli(stages.total_rem_sleep_time_milli) : null,
    awake_h: stages ? hoursFromMilli(stages.total_awake_time_milli) : null,
    disturbances: stages ? stages.disturbance_count : null,
    nap: row.nap,
    respiratory_rate: scored ? round(row.score!.respiratory_rate, 2) : null,
    sleep_needed_h: sleepNeeded,
    score_state: row.score_state,
  }
}

/** Compact workout row; date is local start date */
export function presentWorkout(row: WhoopWorkout): WorkoutRow {
  const offset = row.timezone_offset
  const scored = row.score_state === "SCORED" && row.score
  const durationMin = minutesFromMilli(Date.parse(row.end) - Date.parse(row.start))
  let sport = row.sport_name
  if (!sport) {
    sport = "unknown"
  }
  let zones = null
  if (scored && row.score!.zone_durations) {
    const z = row.score!.zone_durations
    zones = {
      z0: minutesFromMilli(z.zone_zero_milli),
      z1: minutesFromMilli(z.zone_one_milli),
      z2: minutesFromMilli(z.zone_two_milli),
      z3: minutesFromMilli(z.zone_three_milli),
      z4: minutesFromMilli(z.zone_four_milli),
      z5: minutesFromMilli(z.zone_five_milli),
    }
  }
  let distance = null
  let altitude = null
  let strain = null
  let avgHr = null
  let maxHr = null
  let kj = null
  if (scored) {
    strain = round(row.score!.strain, 1)
    avgHr = row.score!.average_heart_rate
    maxHr = row.score!.max_heart_rate
    kj = Math.round(row.score!.kilojoule)
    if (typeof row.score!.distance_meter === "number") {
      distance = round(row.score!.distance_meter / 1000, 2)
    }
    if (typeof row.score!.altitude_gain_meter === "number") {
      altitude = round(row.score!.altitude_gain_meter, 1)
    }
  }
  return {
    id: row.id,
    start_local: localDateTime(row.start, offset),
    date: localDate(row.start, offset),
    sport,
    duration_min: durationMin,
    strain,
    avg_hr: avgHr,
    max_hr: maxHr,
    kj,
    distance_km: distance,
    altitude_gain_m: altitude,
    zones_min: zones,
    score_state: row.score_state,
  }
}

/** Compact cycle row; end_local is null while the cycle is open */
export function presentCycle(row: WhoopCycle): CycleRow {
  const scored = row.score_state === "SCORED" && row.score
  let endLocal: string | null = null
  if (row.end) {
    endLocal = localDateTime(row.end, row.timezone_offset)
  }
  return {
    id: row.id,
    start_local: localDateTime(row.start, row.timezone_offset),
    end_local: endLocal,
    timezone_offset: row.timezone_offset,
    strain: scored ? round(row.score!.strain, 1) : null,
    kj: scored ? Math.round(row.score!.kilojoule) : null,
    avg_hr: scored ? row.score!.average_heart_rate : null,
    max_hr: scored ? row.score!.max_heart_rate : null,
    score_state: row.score_state,
  }
}

/** Assemble get_latest without overwriting current_cycle with a previous scored cycle */
export function presentLatest(
  recoveries: WhoopRecovery[],
  sleeps: WhoopSleep[],
  cycles: WhoopCycle[],
  asOf: string,
): LatestView {
  let offset = "+00:00"
  if (cycles[0]) {
    offset = cycles[0].timezone_offset
  } else if (sleeps[0]) {
    offset = sleeps[0].timezone_offset
  }
  const recoveryRows = recoveries.map(function (r) {
    return presentRecovery(r, offset)
  })
  let recovery: RecoveryRow | null = null
  if (recoveryRows[0]) {
    recovery = recoveryRows[0]
  }
  let latestScoredRecovery: RecoveryRow | null = null
  for (let i = 0; i < recoveryRows.length; i++) {
    if (recoveryRows[i].score_state === "SCORED") {
      latestScoredRecovery = recoveryRows[i]
      break
    }
  }
  if (recovery && latestScoredRecovery && recovery.cycle_id === latestScoredRecovery.cycle_id) {
    latestScoredRecovery = null
  }
  let lastNight: SleepRow | null = null
  for (let i = 0; i < sleeps.length; i++) {
    if (!sleeps[i].nap) {
      lastNight = presentSleep(sleeps[i])
      break
    }
  }
  const cycleRows = cycles.map(presentCycle)
  let currentCycle: CycleRow | null = null
  if (cycleRows[0]) {
    currentCycle = cycleRows[0]
  }
  let latestScoredCycle: CycleRow | null = null
  if (currentCycle && currentCycle.score_state !== "SCORED") {
    for (let i = 0; i < cycleRows.length; i++) {
      if (cycleRows[i].score_state === "SCORED") {
        latestScoredCycle = cycleRows[i]
        break
      }
    }
  }
  return {
    as_of: asOf,
    timezone_offset: offset,
    note: LATEST_NOTE,
    recovery,
    latest_scored_recovery: latestScoredRecovery,
    last_night_sleep: lastNight,
    current_cycle: currentCycle,
    latest_scored_cycle: latestScoredCycle,
  }
}

/** Local calendar date of an instant at a WHOOP offset */
export function localDate(iso: string, offset: string): string {
  return localDateTime(iso, offset).slice(0, 10)
}

/** Local datetime YYYY-MM-DDTHH:mm:ss±hh:mm */
export function localDateTime(iso: string, offset: string): string {
  const minutes = offsetMinutes(offset)
  const ms = Date.parse(iso) + minutes * 60_000
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const mo = pad(d.getUTCMonth() + 1)
  const da = pad(d.getUTCDate())
  const h = pad(d.getUTCHours())
  const mi = pad(d.getUTCMinutes())
  const s = pad(d.getUTCSeconds())
  let tzd = "Z"
  if (offset !== "Z" && offset !== "z") {
    tzd = offset
  }
  return y + "-" + mo + "-" + da + "T" + h + ":" + mi + ":" + s + tzd
}

export function hoursFromMilli(ms: number): number {
  return round(ms / 3_600_000, 2)
}

export function minutesFromMilli(ms: number): number {
  return round(ms / 60_000, 1)
}

export function round(n: number, digits: number): number {
  const p = 10 ** digits
  return Math.round(n * p) / p
}

function ymdParts(s: string): { y: number; m: number; d: number } {
  return {
    y: Number(s.slice(0, 4)),
    m: Number(s.slice(5, 7)),
    d: Number(s.slice(8, 10)),
  }
}

function addDays(p: { y: number; m: number; d: number }, n: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n))
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

function localMidnightUtcMs(p: { y: number; m: number; d: number }, offset: string): number {
  return Date.UTC(p.y, p.m - 1, p.d) - offsetMinutes(offset) * 60_000
}

function pad(n: number): string {
  if (n < 10) {
    return "0" + String(n)
  }
  return String(n)
}
