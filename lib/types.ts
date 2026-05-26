'use strict';

export type Mode = 'disarmed' | 'armed_away' | 'armed_stay';

export type AlarmType = 'perimeter' | 'intrusion' | 'entry_delay_timeout' | 'panic';

export type EventLevel = 'info' | 'warning' | 'alarm' | 'critical';

export interface EventEntry {
  ts: number;
  level: EventLevel;
  message: string;
  zoneId?: string;
  zoneName?: string;
  deviceId?: string;
}

export type ZoneMatrix = Record<string, string>;

export type KevinZones = Record<string, boolean>;

export type ZoneSeconds = Record<string, number>;

/** Per-camera snapshot mode: alarm_only = only during alarm/deterrence, motion = also on every motion event. */
export type CameraMode = 'alarm_only' | 'motion';

export interface GuardSettings {
  bedtime: string;
  sunset_offset: number;
  random_min: number;
  random_max: number;
  deterrence_delay: number;
  exit_delay: number;
  entry_delay: number;
  escalation_minutes: number;
  zone_matrix: ZoneMatrix;
  kevin_zones: KevinZones;
  perimeter_sensors: string[];
  entry_delay_sensors: string[];
  blink_on: ZoneSeconds;
  blink_off: ZoneSeconds;
  alarm_blink_on: number;
  alarm_blink_off: number;
  camera_mode: Record<string, CameraMode>;
}

export const DEFAULT_BLINK_SECONDS = 15;
export const DEFAULT_ALARM_BLINK_ON = 1;
export const DEFAULT_ALARM_BLINK_OFF = 1;
/** Max snapshots per alarm/deterrence loop before auto-stopping. */
export const ALARM_SNAPSHOT_MAX = 10;
/** Number of snapshots to take on a motion-triggered burst (non-alarm). */
export const MOTION_BURST_COUNT = 3;

export const DEFAULT_SETTINGS: GuardSettings = {
  bedtime: '23:30',
  sunset_offset: -30,
  random_min: 10,
  random_max: 45,
  deterrence_delay: 15,
  exit_delay: 60,
  entry_delay: 30,
  escalation_minutes: 5,
  zone_matrix: {},
  kevin_zones: {},
  perimeter_sensors: [],
  entry_delay_sensors: [],
  blink_on: {},
  blink_off: {},
  alarm_blink_on: DEFAULT_ALARM_BLINK_ON,
  alarm_blink_off: DEFAULT_ALARM_BLINK_OFF,
  camera_mode: {},
};

export const SETTINGS_KEYS = {
  MODE: 'mode',
  MODE_CHANGED_AT: 'mode_changed_at',
  EVENT_LOG: 'event_log',
  SETTINGS: 'guard_settings',
} as const;

export const EVENT_LOG_MAX = 150;
export const CMD_BUFFER_TTL_MS = 2_000;
export const FALSE_ALARM_WINDOW_MS = 90_000;
export const SNAPSHOT_INTERVAL_MS = 5_000;
export const MAX_PUSH_PER_EVENT = 3;
