'use strict';

import type Homey from 'homey/lib/Homey';
import {
  EVENT_LOG_MAX, EventEntry, EventLevel, SETTINGS_KEYS,
} from './types';

export default class EventLog {

  private buffer: EventEntry[];

  constructor(private readonly homey: Homey) {
    const stored = this.homey.settings.get(SETTINGS_KEYS.EVENT_LOG);
    this.buffer = Array.isArray(stored) ? stored.slice(-EVENT_LOG_MAX) : [];
  }

  add(level: EventLevel, message: string, zoneId?: string, deviceId?: string): EventEntry {
    const entry: EventEntry = {
      ts: Date.now(), level, message, zoneId, deviceId,
    };
    this.buffer.push(entry);
    if (this.buffer.length > EVENT_LOG_MAX) {
      this.buffer.splice(0, this.buffer.length - EVENT_LOG_MAX);
    }
    this.homey.settings.set(SETTINGS_KEYS.EVENT_LOG, this.buffer);
    return entry;
  }

  recent(limit = EVENT_LOG_MAX): EventEntry[] {
    return this.buffer.slice(-limit).reverse();
  }

  clear(): void {
    this.buffer = [];
    this.homey.settings.set(SETTINGS_KEYS.EVENT_LOG, this.buffer);
  }

}
