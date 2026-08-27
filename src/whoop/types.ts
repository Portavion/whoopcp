export type ScoreState = "SCORED" | "PENDING_SCORE" | "UNSCORABLE"

export interface StoredTokens {
  version: 1
  access_token: string
  refresh_token: string
  expires_at: number
  scope: string
  token_type: "bearer"
  connected_at: number
  user_id?: number
}

export interface WhoopProfile {
  user_id: number
  email?: string
  first_name: string
  last_name: string
}

export interface WhoopBody {
  height_meter: number
  weight_kilogram: number
  max_heart_rate: number
}

export interface WhoopCycleScore {
  strain: number
  kilojoule: number
  average_heart_rate: number
  max_heart_rate: number
}

export interface WhoopCycle {
  id: number
  user_id: number
  start: string
  end?: string | null
  timezone_offset: string
  score_state: ScoreState
  score?: WhoopCycleScore
}

export interface WhoopRecoveryScore {
  user_calibrating: boolean
  recovery_score: number
  resting_heart_rate: number
  hrv_rmssd_milli: number
  spo2_percentage: number
  skin_temp_celsius: number
}

export interface WhoopRecovery {
  cycle_id: number
  sleep_id?: string
  user_id: number
  created_at: string
  score_state: ScoreState
  score?: WhoopRecoveryScore
}

export interface WhoopStageSummary {
  total_in_bed_time_milli: number
  total_awake_time_milli: number
  total_no_data_time_milli: number
  total_light_sleep_time_milli: number
  total_slow_wave_sleep_time_milli: number
  total_rem_sleep_time_milli: number
  sleep_cycle_count: number
  disturbance_count: number
}

export interface WhoopSleepNeeded {
  baseline_milli: number
  need_from_sleep_debt_milli: number
  need_from_recent_strain_milli: number
  need_from_recent_nap_milli: number
}

export interface WhoopSleepScore {
  stage_summary: WhoopStageSummary
  sleep_needed: WhoopSleepNeeded
  respiratory_rate: number
  sleep_performance_percentage: number
  sleep_consistency_percentage: number
  sleep_efficiency_percentage: number
}

export interface WhoopSleep {
  id: string
  cycle_id: number
  start: string
  end: string
  timezone_offset: string
  nap: boolean
  score_state: ScoreState
  score?: WhoopSleepScore
}

export interface WhoopZoneDurations {
  zone_zero_milli: number
  zone_one_milli: number
  zone_two_milli: number
  zone_three_milli: number
  zone_four_milli: number
  zone_five_milli: number
}

export interface WhoopWorkoutScore {
  strain: number
  average_heart_rate: number
  max_heart_rate: number
  kilojoule: number
  percent_recorded: number
  distance_meter: number
  altitude_gain_meter: number
  altitude_change_meter: number
  zone_durations: WhoopZoneDurations
}

export interface WhoopWorkout {
  id: string
  start: string
  end: string
  timezone_offset: string
  sport_name?: string
  score_state: ScoreState
  score?: WhoopWorkoutScore
}

export interface WhoopCollection<T> {
  records: T[]
  next_token: string | null
}

export interface ProfileView {
  user_id: number
  first_name: string
  last_name: string
  body: {
    height_m: number
    weight_kg: number
    max_heart_rate: number
  } | null
}

export interface RecoveryRow {
  date: string
  cycle_id: number
  recovery_score: number | null
  hrv_rmssd_milli: number | null
  resting_heart_rate: number | null
  spo2_percentage: number | null
  skin_temp_celsius: number | null
  user_calibrating: boolean | null
  score_state: ScoreState
}

export interface SleepRow {
  id: string
  cycle_id: number
  date: string
  start_local: string
  end_local: string
  hours: number | null
  in_bed_hours: number | null
  performance: number | null
  efficiency: number | null
  consistency: number | null
  light_h: number | null
  sws_h: number | null
  rem_h: number | null
  awake_h: number | null
  disturbances: number | null
  nap: boolean
  respiratory_rate: number | null
  sleep_needed_h: number | null
  score_state: ScoreState
}

export interface WorkoutRow {
  id: string
  start_local: string
  date: string
  sport: string
  duration_min: number
  strain: number | null
  avg_hr: number | null
  max_hr: number | null
  kj: number | null
  distance_km: number | null
  altitude_gain_m: number | null
  zones_min: {
    z0: number
    z1: number
    z2: number
    z3: number
    z4: number
    z5: number
  } | null
  score_state: ScoreState
}

export interface CycleRow {
  id: number
  start_local: string
  end_local: string | null
  timezone_offset: string
  strain: number | null
  kj: number | null
  avg_hr: number | null
  max_hr: number | null
  score_state: ScoreState
}

export interface LatestView {
  as_of: string
  timezone_offset: string
  note: string
  recovery: RecoveryRow | null
  latest_scored_recovery: RecoveryRow | null
  last_night_sleep: SleepRow | null
  current_cycle: CycleRow | null
  latest_scored_cycle: CycleRow | null
}

export interface DayView {
  date: string
  timezone_offset: string
  note: string
  cycles: CycleRow[]
  recoveries: RecoveryRow[]
  sleeps: SleepRow[]
  workouts: WorkoutRow[]
}

export interface RangeSummary {
  start: string
  end: string
  timezone_offset: string
  days: number
  truncated: boolean
  recovery: {
    n: number
    unscored: number
    avg: number | null
    min: number | null
    max: number | null
    avg_hrv_rmssd_milli: number | null
    avg_rhr: number | null
    red_days: number
    yellow_days: number
    green_days: number
  }
  sleep: {
    nights: number
    naps: number
    avg_hours: number | null
    total_hours: number | null
    avg_performance: number | null
    avg_efficiency: number | null
    avg_consistency: number | null
    total_nap_hours: number | null
  }
  strain: {
    scored_cycles: number
    avg: number | null
    total: number | null
    min: number | null
    max: number | null
  }
  workouts: {
    count: number
    by_sport: Record<string, number>
    total_duration_min: number
    total_kj: number
  }
}

export interface ListResult<T> {
  rows: T[]
  truncated: boolean
  pages: number
}
