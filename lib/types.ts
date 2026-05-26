'use strict';

export type Mode = 'disarmed' | 'armed_away' | 'armed_stay';

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
  deterrent_flows: Record<string, boolean>;
}

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
  deterrent_flows: {},
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
