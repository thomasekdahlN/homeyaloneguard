import {
  describe, expect, it,
} from 'vitest';
import EventLog from '../lib/EventLog';
import { EVENT_LOG_MAX, SETTINGS_KEYS } from '../lib/types';
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

  it('begrenser ring-buffer til EVENT_LOG_MAX (150) oppføringer', () => {
    const homey = createMockHomey();
    const log = new EventLog(homey as never);
    for (let i = 0; i < EVENT_LOG_MAX + 25; i += 1) {
      log.add('info', `event-${i}`);
    }

    expect(log.recent()).toHaveLength(EVENT_LOG_MAX);
    expect(log.recent()[0]?.message).toBe(`event-${EVENT_LOG_MAX + 24}`);
    expect(log.recent()[EVENT_LOG_MAX - 1]?.message).toBe('event-25');
  });

  it('laster eksisterende hendelser fra settings', () => {
    const stored = [
      {
        ts: 1, level: 'info', message: 'gammel', zoneId: 'z1',
      },
    ];
    const homey = createMockHomey({ [SETTINGS_KEYS.EVENT_LOG]: stored });
    const log = new EventLog(homey as never);

    expect(log.recent()).toHaveLength(1);
    expect(log.recent()[0]?.message).toBe('gammel');
  });

  it('klipper overskytende ved load (slice -150)', () => {
    const stored = Array.from({ length: 200 }, (_, i) => ({
      ts: i, level: 'info' as const, message: `e${i}`,
    }));
    const homey = createMockHomey({ [SETTINGS_KEYS.EVENT_LOG]: stored });
    const log = new EventLog(homey as never);

    expect(log.recent()).toHaveLength(EVENT_LOG_MAX);
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
