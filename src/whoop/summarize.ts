import { presentCycle, presentRecovery, presentSleep, presentWorkout, round } from "./present.ts"
import type {
  RangeSummary,
  WhoopCycle,
  WhoopRecovery,
  WhoopSleep,
  WhoopWorkout,
} from "./types.ts"

/** Aggregate recovery, sleep, cycle strain, and workouts for a date range */
export function presentSummary(
  start: string,
  end: string,
  offset: string,
  days: number,
  truncated: boolean,
  recoveries: WhoopRecovery[],
  sleeps: WhoopSleep[],
  cycles: WhoopCycle[],
  workouts: WhoopWorkout[],
): RangeSummary {
  const recRows = recoveries.map(function (r) {
    return presentRecovery(r, offset)
  })
  let recN = 0
  let recUnscored = 0
  let recSum = 0
  let recMin = Infinity
  let recMax = -Infinity
  let hrvSum = 0
  let hrvN = 0
  let rhrSum = 0
  let rhrN = 0
  let red = 0
  let yellow = 0
  let green = 0
  for (let i = 0; i < recRows.length; i++) {
    const r = recRows[i]
    if (r.score_state !== "SCORED" || r.recovery_score === null) {
      recUnscored += 1
      continue
    }
    recN += 1
    recSum += r.recovery_score
    if (r.recovery_score < recMin) {
      recMin = r.recovery_score
    }
    if (r.recovery_score > recMax) {
      recMax = r.recovery_score
    }
    if (r.hrv_rmssd_milli !== null) {
      hrvSum += r.hrv_rmssd_milli
      hrvN += 1
    }
    if (r.resting_heart_rate !== null) {
      rhrSum += r.resting_heart_rate
      rhrN += 1
    }
    if (r.recovery_score < 34) {
      red += 1
    } else if (r.recovery_score >= 67) {
      green += 1
    } else {
      yellow += 1
    }
  }

  const sleepRows = sleeps.map(presentSleep)
  let nights = 0
  let naps = 0
  let nightHours = 0
  let napHours = 0
  let perfSum = 0
  let perfN = 0
  let effSum = 0
  let effN = 0
  let consSum = 0
  let consN = 0
  for (let i = 0; i < sleepRows.length; i++) {
    const s = sleepRows[i]
    if (s.nap) {
      naps += 1
      if (s.hours !== null) {
        napHours += s.hours
      }
      continue
    }
    if (s.score_state !== "SCORED") {
      continue
    }
    nights += 1
    if (s.hours !== null) {
      nightHours += s.hours
    }
    if (s.performance !== null) {
      perfSum += s.performance
      perfN += 1
    }
    if (s.efficiency !== null) {
      effSum += s.efficiency
      effN += 1
    }
    if (s.consistency !== null) {
      consSum += s.consistency
      consN += 1
    }
  }

  const cycleRows = cycles.map(presentCycle)
  let strainN = 0
  let strainSum = 0
  let strainMin = Infinity
  let strainMax = -Infinity
  for (let i = 0; i < cycleRows.length; i++) {
    const c = cycleRows[i]
    if (c.score_state !== "SCORED" || c.strain === null) {
      continue
    }
    strainN += 1
    strainSum += c.strain
    if (c.strain < strainMin) {
      strainMin = c.strain
    }
    if (c.strain > strainMax) {
      strainMax = c.strain
    }
  }

  const workoutRows = workouts.map(presentWorkout)
  const bySport: Record<string, number> = {}
  let totalMin = 0
  let totalKj = 0
  for (let i = 0; i < workoutRows.length; i++) {
    const w = workoutRows[i]
    if (!bySport[w.sport]) {
      bySport[w.sport] = 0
    }
    bySport[w.sport] += 1
    totalMin += w.duration_min
    if (w.kj !== null) {
      totalKj += w.kj
    }
  }

  return {
    start,
    end,
    timezone_offset: offset,
    days,
    truncated,
    recovery: {
      n: recN,
      unscored: recUnscored,
      avg: mean(recSum, recN),
      min: finiteOrNull(recMin),
      max: finiteOrNull(recMax),
      avg_hrv_rmssd_milli: mean(hrvSum, hrvN),
      avg_rhr: mean(rhrSum, rhrN),
      red_days: red,
      yellow_days: yellow,
      green_days: green,
    },
    sleep: {
      nights,
      naps,
      avg_hours: mean(nightHours, nights),
      total_hours: totalOrNull(nightHours, nights),
      avg_performance: mean(perfSum, perfN),
      avg_efficiency: mean(effSum, effN),
      avg_consistency: mean(consSum, consN),
      total_nap_hours: totalOrNull(napHours, naps),
    },
    strain: {
      scored_cycles: strainN,
      avg: mean(strainSum, strainN),
      total: totalOrNull(strainSum, strainN, 1),
      min: finiteOrNull(strainMin),
      max: finiteOrNull(strainMax),
    },
    workouts: {
      count: workoutRows.length,
      by_sport: bySport,
      total_duration_min: round(totalMin, 1),
      total_kj: Math.round(totalKj),
    },
  }
}

function mean(sum: number, n: number): number | null {
  if (n === 0) {
    return null
  }
  return round(sum / n, 2)
}

function totalOrNull(sum: number, n: number, digits = 2): number | null {
  if (n === 0) {
    return null
  }
  return round(sum, digits)
}

function finiteOrNull(n: number): number | null {
  if (!Number.isFinite(n)) {
    return null
  }
  return n
}
