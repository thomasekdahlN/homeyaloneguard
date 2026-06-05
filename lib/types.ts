'use strict';

export type Mode = 'disarmed' | 'armed' | 'armed_perimeter' | 'perimeter_alarm' | 'deterrence' | 'alarm';

export type AlarmType = 'perimeter' | 'intrusion' | 'entry_delay_timeout';

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
  /**
   * Tracks all sensor IDs that have been shown in the zones UI at least once.
   * Used to distinguish "new sensor (never configured)" from "explicitly unchecked".
   * New contact sensors default to perimeter=true; new motion sensors default to false.
   */
  perimeter_sensors_seen: string[];
  entry_delay_sensors: string[];
  /** Global deterrence blink-on time in seconds (default 15). */
  blink_on: number;
  /** Global deterrence blink-off time in seconds (default 15). */
  blink_off: number;
  alarm_blink_on: number;
  alarm_blink_off: number;
  /** Global: number of snapshots per camera when alarm is active and motion is detected. Default: 10. */
  camera_alarm_burst: number;
  /** Global: number of snapshots per camera when motion is detected without an active alarm. Default: 1. */
  camera_motion_burst: number;
  /** Per-camera enabled flag for alarm snapshots. Absent = enabled by default. */
  camera_alarm_cams: Record<string, boolean>;
  /** Per-camera enabled flag for motion snapshots. Absent = enabled by default. */
  camera_motion_cams: Record<string, boolean>;
  /** Global master switch: whether to take motion snapshots when no alarm is active. Default: true. */
  camera_motion_enabled: boolean;
  /** Maximum number of snapshots to retain per category (alarm / motion). Oldest are deleted first. Default: 250. */
  snapshot_max_count: number;
  /** Whether armed_perimeter should activate and deactivate automatically on a daily schedule. Default: false. */
  armed_perimeter_auto: boolean;
  /** Time to automatically enable armed_perimeter (HH:MM, 24h). Default: '22:00'. */
  armed_perimeter_on: string;
  /** Time to automatically disable armed_perimeter (HH:MM, 24h). Default: '06:00'. */
  armed_perimeter_off: string;
  /**
   * Per-camera manual snapshot URL override.
   * Key = device ID, value = full HTTP URL to a JPEG snapshot endpoint.
   * Use this when the camera driver does not implement device.setCameraImage().
   * Example: "http://192.168.1.100/snapshot.jpg" or an ONVIF snapshot URL.
   * Takes precedence over all automatic URL resolution strategies.
   */
  camera_snapshot_urls: Record<string, string>;
}

export const DEFAULT_BLINK_SECONDS = 15;
export const DEFAULT_ALARM_BLINK_ON = 1;
export const DEFAULT_ALARM_BLINK_OFF = 1;
/** Default global burst size when alarm is active and motion is detected. */
export const CAMERA_ALARM_BURST_DEFAULT = 10;
/** Default global burst size when motion is detected without an active alarm. */
export const CAMERA_MOTION_BURST_DEFAULT = 1;
/** Interval in ms between snapshots in a burst. */
export const SNAPSHOT_BURST_INTERVAL_MS = 1_000;
/** How long (ms) to wait after turning on zone lights before taking the first alarm snapshot. */
export const CAMERA_FLASH_DELAY_MS = 500;

/** Persistent directories for camera snapshots on Homey Pro's /userdata/ partition. */
export const SNAPSHOT_DIR_ALARM = '/userdata/snapshots/alarm';
export const SNAPSHOT_DIR_MOTION = '/userdata/snapshots/motion';

/** Default maximum snapshots retained per category before FIFO cleanup. */
export const SNAPSHOT_MAX_COUNT_DEFAULT = 250;

export const DEFAULT_SETTINGS: GuardSettings = {
  bedtime: '23:30',
  sunset_offset: -30,
  random_min: 10,
  random_max: 45,
  deterrence_delay: 15,
  exit_delay: 60,
  entry_delay: 60,
  escalation_minutes: 5,
  zone_matrix: {},
  kevin_zones: {},
  perimeter_sensors: [],
  perimeter_sensors_seen: [],
  entry_delay_sensors: [],
  blink_on: DEFAULT_BLINK_SECONDS,
  blink_off: DEFAULT_BLINK_SECONDS,
  alarm_blink_on: DEFAULT_ALARM_BLINK_ON,
  alarm_blink_off: DEFAULT_ALARM_BLINK_OFF,
  camera_alarm_burst: CAMERA_ALARM_BURST_DEFAULT,
  camera_motion_burst: CAMERA_MOTION_BURST_DEFAULT,
  camera_alarm_cams: {},
  camera_motion_cams: {},
  camera_motion_enabled: true,
  snapshot_max_count: SNAPSHOT_MAX_COUNT_DEFAULT,
  armed_perimeter_auto: false,
  armed_perimeter_on: '22:00',
  armed_perimeter_off: '06:00',
  camera_snapshot_urls: {},
};

/**
 * Allowed mode transitions.
 *
 * User-initiated (dashboard / flow):
 *   disarmed        → armed | armed_perimeter
 *   armed           → disarmed  (must disarm before switching to armed_perimeter)
 *   armed_perimeter → disarmed | armed
 *
 * System-initiated (sensor trigger):
 *   armed_perimeter → perimeter_alarm    (perimeter sensor fires — notify only, no lights)
 *   armed           → deterrence         (sensor triggers deterrence mode)
 *   deterrence      → alarm              (escalation timer fires)
 *   deterrence | alarm → armed_perimeter | armed | disarmed
 *                        (stopAlarm returns to previous armed state)
 *   perimeter_alarm → armed_perimeter | disarmed
 *                     (user dismisses or disarms the perimeter alert)
 *
 * Test-initiated (from disarmed or armed):
 *   disarmed | armed_* → deterrence | alarm  (testDeterrence / testAlarm)
 */
export const VALID_TRANSITIONS: Readonly<Record<Mode, readonly Mode[]>> = {
  disarmed: ['armed', 'armed_perimeter', 'deterrence', 'alarm'],
  armed: ['disarmed', 'deterrence', 'alarm'],
  armed_perimeter: ['disarmed', 'armed', 'perimeter_alarm', 'deterrence', 'alarm'],
  perimeter_alarm: ['disarmed', 'armed_perimeter'],
  deterrence: ['alarm', 'armed_perimeter', 'armed', 'disarmed'],
  alarm: ['armed_perimeter', 'armed', 'disarmed'],
};

export function isValidTransition(from: Mode, to: Mode): boolean {
  return (VALID_TRANSITIONS[from] as readonly Mode[]).includes(to);
}

export const SETTINGS_KEYS = {
  MODE: 'mode',
  MODE_CHANGED_AT: 'mode_changed_at',
  EVENT_LOG: 'event_log',
  SETTINGS: 'guard_settings',
} as const;

export const EVENT_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days rolling window
export const FALSE_ALARM_WINDOW_MS = 90_000;
export const MAX_PUSH_PER_EVENT = 3;
