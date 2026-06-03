import {
  describe, expect, it,
} from 'vitest';
import EventLog from '../lib/EventLog';
import { SETTINGS_KEYS } from '../lib/types';
import { createMockHomey } from './helpers/mockHomey';

describe('EventLog', () => {
  it('starter tomt når ingen lagrede hendelser finnes', () => {
    const homey = createMockHomey();
    const log = new EventLog(homey as never);
    expect(log.recent()).toEqual([]);
  });

  it('legger til en hendelse og lagrer i settings', () => {
    const homey = createMockHomey();
    const log = new EventLog(homey as never);
    const entry = log.add('info', 'test');

    expect(entry.message).toBe('test');
    expect(entry.level).toBe('info');
    expect(typeof entry.ts).toBe('number');
    expect(homey.settings._store[SETTINGS_KEYS.EVENT_LOG]).toHaveLength(1);
  });

  it('returnerer hendelser i omvendt rekkefølge (nyeste først)', () => {
    const homey = createMockHomey();
    const log = new EventLog(homey as never);
    log.add('info', 'første');
    log.add('warning', 'andre');
    log.add('alarm', 'tredje');

    const recent = log.recent();
    expect(recent.map((e) => e.message)).toEqual(['tredje', 'andre', 'første']);
  });

  it('laster eksisterende hendelser fra settings', () => {
    const stored = [
      {
        ts: Date.now(), level: 'info', message: 'gammel', zoneId: 'z1',
      },
    ];
    const homey = createMockHomey({ [SETTINGS_KEYS.EVENT_LOG]: stored });
    const log = new EventLog(homey as never);

    expect(log.recent()).toHaveLength(1);
    expect(log.recent()[0]?.message).toBe('gammel');
  });

  it('laster alle entries innenfor 14-dagers vindu fra settings', () => {
    const now = Date.now();
    const stored = Array.from({ length: 200 }, (_, i) => ({
      ts: now - (200 - i), level: 'info' as const, message: `e${i}`,
    }));
    const homey = createMockHomey({ [SETTINGS_KEYS.EVENT_LOG]: stored });
    const log = new EventLog(homey as never);

    expect(log.recent()).toHaveLength(200);
    expect(log.recent()[0]?.message).toBe('e199');
  });

  it('clear() nullstiller bufferet', () => {
    const homey = createMockHomey();
    const log = new EventLog(homey as never);
    log.add('info', 'x');
    log.clear();

    expect(log.recent()).toEqual([]);
    expect(homey.settings._store[SETTINGS_KEYS.EVENT_LOG]).toEqual([]);
  });

  it('recent(N) returnerer maksimalt N hendelser', () => {
    const homey = createMockHomey();
    const log = new EventLog(homey as never);
    for (let i = 0; i < 10; i += 1) log.add('info', `e${i}`);

    expect(log.recent(3)).toHaveLength(3);
    expect(log.recent(3).map((e) => e.message)).toEqual(['e9', 'e8', 'e7']);
  });
});
