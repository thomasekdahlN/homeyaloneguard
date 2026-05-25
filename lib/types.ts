'use strict';

export type Mode = 'disarmed' | 'armed_away' | 'armed_stay';

export type EventLevel = 'info' | 'warning' | 'alarm' | 'critical';

export interface EventEntry {
  ts: number;
  level: EventLevel;
  message: string;
  zoneId?: string;
  deviceId?: string;
}

export type ZoneMatrix = Record<string, string>;

export type KevinZones = Record<string, boolean>;

export type ZoneUrlMap = Record<string, string>;

export interface GuardSettings {
  bedtime: string;
  sunset_offset: number;
  random_min: number;
  random_max: number;
  deterrence_delay: number;
  exit_delay: number;
  entry_delay: number;
  escalation_minutes: number;
  custom_audio_url: string | null;
  zone_matrix: ZoneMatrix;
  kevin_zones: KevinZones;
  zone_audio_urls: ZoneUrlMap;
  zone_video_urls: ZoneUrlMap;
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
  custom_audio_url: null,
  zone_matrix: {},
  kevin_zones: {},
  zone_audio_urls: {},
  zone_video_urls: {},
};

export interface UrlSuggestion {
  label: string;
  url: string;
}

export const SUGGESTED_AUDIO_URLS: UrlSuggestion[] = [
  { label: 'Politi-sirene (innebygd)', url: '/assets/media/police-siren.ogg' },
  { label: 'Brann-alarm (innebygd)', url: '/assets/media/fire-alarm.ogg' },
  { label: 'Bjeffende vakthund (innebygd)', url: '/assets/media/guard-dog.ogg' },
  { label: 'Truende stemme (norsk, innebygd)', url: '/assets/media/intruder-voice.m4a' },
  { label: 'Generell alarm-beep (innebygd)', url: '/assets/media/alarm-beep.ogg' },
];

export const SUGGESTED_VIDEO_URLS: UrlSuggestion[] = [];

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
