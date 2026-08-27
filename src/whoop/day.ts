import {
  expandDateRange,
  localDate,
  presentCycle,
  presentRecovery,
  presentSleep,
  presentWorkout,
} from "./present.ts"
import type {
  CycleRow,
  DayView,
  RecoveryRow,
  SleepRow,
  WhoopCycle,
  WhoopRecovery,
  WhoopSleep,
  WhoopWorkout,
  WorkoutRow,
} from "./types.ts"

const DAY_NOTE =
  "A WHOOP cycle is sleep-to-sleep, not a calendar day. This object is assembled for the local calendar date. A date can overlap two cycles if sleep starts after midnight."

const PAD_MS = 18 * 60 * 60 * 1000

/** Padded WHOOP query window around one local calendar date */
export function dayQueryWindow(
  date: string,
  offset: string,
): { startUtc: string; endUtc: string } {
  const w = expandDateRange(date, date, offset)
  const start = Date.parse(w.startUtc) - PAD_MS
  const end = Date.parse(w.endUtc) + PAD_MS
  return {
    startUtc: new Date(start).toISOString(),
    endUtc: new Date(end).toISOString(),
  }
}

/** Filter WHOOP records into a calendar-day view */
export function presentDay(
  date: string,
  offset: string,
  cycles: WhoopCycle[],
  recoveries: WhoopRecovery[],
  sleeps: WhoopSleep[],
  workouts: WhoopWorkout[],
): DayView {
  const w = expandDateRange(date, date, offset)
  const wStart = Date.parse(w.startUtc)
  const wEnd = Date.parse(w.endUtc)

  const cycleRows: CycleRow[] = []
  const cycleIds: Record<number, true> = {}
  for (let i = 0; i < cycles.length; i++) {
    const c = cycles[i]
    if (intervalOverlapsWindow(c.start, c.end, wStart, wEnd)) {
      cycleRows.push(presentCycle(c))
      cycleIds[c.id] = true
    }
  }

  const sleepRows: SleepRow[] = []
  for (let i = 0; i < sleeps.length; i++) {
    const s = sleeps[i]
    const overlaps = intervalOverlapsWindow(s.start, s.end, wStart, wEnd)
    const wakeDate = localDate(s.end, s.timezone_offset)
    let keep = overlaps
    if (!s.nap && wakeDate === date) {
      keep = true
    }
    if (keep) {
      sleepRows.push(presentSleep(s))
    }
  }

  const workoutRows: WorkoutRow[] = []
  for (let i = 0; i < workouts.length; i++) {
    const wo = workouts[i]
    if (localDate(wo.start, wo.timezone_offset) === date) {
      workoutRows.push(presentWorkout(wo))
    }
  }

  const recoveryRows: RecoveryRow[] = []
  for (let i = 0; i < recoveries.length; i++) {
    const r = recoveries[i]
    if (cycleIds[r.cycle_id]) {
      recoveryRows.push(presentRecovery(r, offset))
    }
  }

  return {
    date,
    timezone_offset: offset,
    note: DAY_NOTE,
    cycles: cycleRows,
    recoveries: recoveryRows,
    sleeps: sleepRows,
    workouts: workoutRows,
  }
}

function intervalOverlapsWindow(
  startIso: string,
  endIso: string | null | undefined,
  wStart: number,
  wEnd: number,
): boolean {
  const start = Date.parse(startIso)
  if (endIso) {
    const end = Date.parse(endIso)
    return start < wEnd && end > wStart
  }
  return start < wEnd
}
