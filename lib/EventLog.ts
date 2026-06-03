'use strict';

import type Homey from 'homey/lib/Homey';
import {
  EVENT_LOG_MAX_AGE_MS, EventEntry, EventLevel, SETTINGS_KEYS,
} from './types';

export type ZoneNameResolver = (zoneId: string) => string | undefined;

export default class EventLog {

  private buffer: EventEntry[];
  private zoneNameResolver: ZoneNameResolver | null = null;

  constructor(private readonly homey: Homey) {
    const stored = this.homey.settings.get(SETTINGS_KEYS.EVENT_LOG);
    const raw: EventEntry[] = Array.isArray(stored) ? stored : [];
    this.buffer = this.pruneOld(raw);
  }

  setZoneNameResolver(resolver: ZoneNameResolver): void {
    this.zoneNameResolver = resolver;
  }

  add(level: EventLevel, message: string, zoneId?: string, deviceId?: string): EventEntry {
    const zoneName = zoneId ? this.resolveZoneName(zoneId) : undefined;
    const humanMessage = this.humanizeMessage(message, zoneId, zoneName);
    const entry: EventEntry = {
      ts: Date.now(), level, message: humanMessage, zoneId, zoneName, deviceId,
    };
    this.buffer.push(entry);
    // Prune entries older than 14 days (pure time-based rolling window).
    this.buffer = this.pruneOld(this.buffer);
    this.homey.settings.set(SETTINGS_KEYS.EVENT_LOG, this.buffer);
    return entry;
  }

  recent(limit?: number): EventEntry[] {
    const entries = limit ? this.buffer.slice(-limit) : this.buffer.slice();
    return entries.reverse().map((e) => this.humanizeEntry(e));
  }

  clear(): void {
    this.buffer = [];
    this.homey.settings.set(SETTINGS_KEYS.EVENT_LOG, this.buffer);
  }

  private pruneOld(entries: EventEntry[]): EventEntry[] {
    const cutoff = Date.now() - EVENT_LOG_MAX_AGE_MS;
    return entries.filter((e) => e.ts >= cutoff);
  }

  private resolveZoneName(zoneId: string): string | undefined {
    if (!this.zoneNameResolver) return undefined;
    try {
      return this.zoneNameResolver(zoneId) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private humanizeMessage(message: string, zoneId?: string, zoneName?: string): string {
    if (!zoneId || !zoneName || zoneName === zoneId) return message;
    return message.split(zoneId).join(zoneName);
  }

  private humanizeEntry(entry: EventEntry): EventEntry {
    if (!entry.zoneId) return entry;
    const name = entry.zoneName ?? this.resolveZoneName(entry.zoneId);
    if (!name || name === entry.zoneId) return entry;
    return { ...entry, zoneName: name, message: this.humanizeMessage(entry.message, entry.zoneId, name) };
  }

}
