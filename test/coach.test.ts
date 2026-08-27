import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseBearer } from "../src/auth.ts"
import { presentDay } from "../src/whoop/day.ts"
import {
  InvalidRange,
  expandDateRange,
  presentLatest,
  presentProfile,
  presentSleep,
} from "../src/whoop/present.ts"
import { presentSummary } from "../src/whoop/summarize.ts"
import type { WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from "../src/whoop/types.ts"

describe("parseBearer", function () {
  it("strips Bearer and accepts a raw token", function () {
    assert.equal(parseBearer("Bearer abc"), "abc")
    assert.equal(parseBearer("bearer xyz"), "xyz")
    assert.equal(parseBearer("raw-token"), "raw-token")
    assert.equal(parseBearer(null), null)
    assert.equal(parseBearer("Bearer "), null)
    assert.equal(parseBearer("Bearer Bearer abc"), "abc")
    assert.equal(parseBearer('"abc"'), "abc")
  })
})

describe("expandDateRange", function () {
  it("expands an inclusive local day at -05:00", function () {
    const w = expandDateRange("2026-08-20", "2026-08-20", "-05:00")
    assert.equal(w.days, 1)
    assert.equal(w.startUtc, "2026-08-20T05:00:00.000Z")
    assert.equal(w.endUtc, "2026-08-21T05:00:00.000Z")
  })

  it("rejects more than 90 inclusive days", function () {
    assert.throws(function () {
      expandDateRange("2026-01-01", "2026-04-02", "Z")
    }, InvalidRange)
  })
})

describe("presentLatest", function () {
  it("keeps a pending current_cycle and adds latest_scored_cycle", function () {
    const cycles: WhoopCycle[] = [
      {
        id: 2,
        user_id: 1,
        start: "2026-08-25T07:00:00.000Z",
        end: null,
        timezone_offset: "-05:00",
        score_state: "PENDING_SCORE",
      },
      {
        id: 1,
        user_id: 1,
        start: "2026-08-24T07:00:00.000Z",
        end: "2026-08-25T07:00:00.000Z",
        timezone_offset: "-05:00",
        score_state: "SCORED",
        score: {
          strain: 12.3,
          kilojoule: 1000,
          average_heart_rate: 70,
          max_heart_rate: 150,
        },
      },
    ]
    const recoveries: WhoopRecovery[] = [
      {
        cycle_id: 2,
        user_id: 1,
        created_at: "2026-08-25T11:00:00.000Z",
        score_state: "PENDING_SCORE",
      },
      {
        cycle_id: 1,
        user_id: 1,
        created_at: "2026-08-24T11:00:00.000Z",
        score_state: "SCORED",
        score: {
          user_calibrating: false,
          recovery_score: 44,
          resting_heart_rate: 54,
          hrv_rmssd_milli: 80.1,
          spo2_percentage: 97,
          skin_temp_celsius: 33.1,
        },
      },
    ]
    const sleeps: WhoopSleep[] = [
      {
        id: "s1",
        cycle_id: 2,
        start: "2026-08-25T04:00:00.000Z",
        end: "2026-08-25T11:00:00.000Z",
        timezone_offset: "-05:00",
        nap: false,
        score_state: "SCORED",
        score: {
          stage_summary: {
            total_in_bed_time_milli: 7 * 3_600_000,
            total_awake_time_milli: 0.5 * 3_600_000,
            total_no_data_time_milli: 0,
            total_light_sleep_time_milli: 3 * 3_600_000,
            total_slow_wave_sleep_time_milli: 1.5 * 3_600_000,
            total_rem_sleep_time_milli: 2 * 3_600_000,
            sleep_cycle_count: 4,
            disturbance_count: 8,
          },
          sleep_needed: {
            baseline_milli: 8 * 3_600_000,
            need_from_sleep_debt_milli: 0,
            need_from_recent_strain_milli: 0,
            need_from_recent_nap_milli: 0,
          },
          respiratory_rate: 15.2,
          sleep_performance_percentage: 90,
          sleep_consistency_percentage: 80,
          sleep_efficiency_percentage: 91.5,
        },
      },
    ]
    const view = presentLatest(recoveries, sleeps, cycles, "2026-08-25T15:00:00.000Z")
    assert.equal(view.current_cycle && view.current_cycle.id, 2)
    assert.equal(view.current_cycle && view.current_cycle.score_state, "PENDING_SCORE")
    assert.equal(view.latest_scored_cycle && view.latest_scored_cycle.id, 1)
    assert.equal(view.recovery && view.recovery.score_state, "PENDING_SCORE")
    assert.equal(view.latest_scored_recovery && view.latest_scored_recovery.recovery_score, 44)
    assert.equal(view.last_night_sleep && view.last_night_sleep.hours, 6.5)
    assert.equal(view.last_night_sleep && view.last_night_sleep.date, "2026-08-25")
  })
})

describe("recovery bands", function () {
  it("counts score 33 as red", function () {
    const recs: WhoopRecovery[] = [
      scoredRecovery(1, 33),
      scoredRecovery(2, 34),
      scoredRecovery(3, 67),
    ]
    const sum = presentSummary("2026-08-01", "2026-08-03", "Z", 3, false, recs, [], [], [])
    assert.equal(sum.recovery.red_days, 1)
    assert.equal(sum.recovery.yellow_days, 1)
    assert.equal(sum.recovery.green_days, 1)
  })
})

describe("presentSleep", function () {
  it("uses wake date for nights and start date for naps", function () {
    const night: WhoopSleep = {
      id: "n",
      cycle_id: 1,
      start: "2026-08-19T04:30:00.000Z",
      end: "2026-08-19T11:00:00.000Z",
      timezone_offset: "-05:00",
      nap: false,
      score_state: "PENDING_SCORE",
    }
    const nap: WhoopSleep = {
      id: "p",
      cycle_id: 1,
      start: "2026-08-19T18:00:00.000Z",
      end: "2026-08-19T18:40:00.000Z",
      timezone_offset: "-05:00",
      nap: true,
      score_state: "PENDING_SCORE",
    }
    assert.equal(presentSleep(night).date, "2026-08-19")
    assert.equal(presentSleep(nap).date, "2026-08-19")
    assert.equal(presentSleep(nap).nap, true)
  })
})

describe("presentProfile", function () {
  it("drops email and always includes body", function () {
    const view = presentProfile(
      { user_id: 1, email: "hidden@whoop.com", first_name: "A", last_name: "B" },
      { height_meter: 1.8, weight_kilogram: 80.12, max_heart_rate: 190 },
    )
    assert.equal("email" in view, false)
    assert.equal(view.body && view.body.weight_kg, 80.12)
  })
})

describe("presentDay", function () {
  it("keeps a cycle that overlaps midnight and a workout on that local date", function () {
    const cycles: WhoopCycle[] = [
      {
        id: 9,
        user_id: 1,
        start: "2026-08-20T03:00:00.000Z",
        end: "2026-08-21T03:00:00.000Z",
        timezone_offset: "-05:00",
        score_state: "SCORED",
        score: { strain: 8, kilojoule: 500, average_heart_rate: 80, max_heart_rate: 140 },
      },
    ]
    const workouts: WhoopWorkout[] = [
      {
        id: "w1",
        start: "2026-08-20T16:00:00.000Z",
        end: "2026-08-20T17:00:00.000Z",
        timezone_offset: "-05:00",
        sport_name: "running",
        score_state: "SCORED",
        score: {
          strain: 8.2,
          average_heart_rate: 140,
          max_heart_rate: 170,
          kilojoule: 900,
          percent_recorded: 100,
          distance_meter: 5000,
          altitude_gain_meter: 10,
          altitude_change_meter: 0,
          zone_durations: {
            zone_zero_milli: 0,
            zone_one_milli: 0,
            zone_two_milli: 600000,
            zone_three_milli: 0,
            zone_four_milli: 0,
            zone_five_milli: 0,
          },
        },
      },
    ]
    const recs: WhoopRecovery[] = [scoredRecovery(9, 50)]
    const day = presentDay("2026-08-20", "-05:00", cycles, recs, [], workouts)
    assert.equal(day.cycles.length, 1)
    assert.equal(day.workouts.length, 1)
    assert.equal(day.workouts[0].distance_km, 5)
    assert.equal(day.recoveries.length, 1)
  })
})

function scoredRecovery(cycleId: number, score: number): WhoopRecovery {
  return {
    cycle_id: cycleId,
    user_id: 1,
    created_at: "2026-08-20T12:00:00.000Z",
    score_state: "SCORED",
    score: {
      user_calibrating: false,
      recovery_score: score,
      resting_heart_rate: 50,
      hrv_rmssd_milli: 70,
      spo2_percentage: 97,
      skin_temp_celsius: 33,
    },
  }
}
