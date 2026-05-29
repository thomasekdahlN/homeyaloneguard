import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import StateMachine from '../lib/StateMachine';
import EventLog from '../lib/EventLog';
import { SETTINGS_KEYS } from '../lib/types';
import { createMockHomey } from './helpers/mockHomey';

describe('StateMachine', () => {
  let homey: ReturnType<typeof createMockHomey>;
  let log: EventLog;

  beforeEach(() => {
    vi.useFakeTimers();
    homey = createMockHomey();
    log = new EventLog(homey as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starter i disarmed når ingen lagret modus finnes', () => {
    const sm = new StateMachine(homey as never, log);
    expect(sm.getMode()).toBe('disarmed');
  });

  it('laster modus fra settings', () => {
    homey.settings._store[SETTINGS_KEYS.MODE] = 'armed_stay';
    const sm = new StateMachine(homey as never, log);
    expect(sm.getMode()).toBe('armed_stay');
  });

  it('endrer modus umiddelbart uten exit-delay', async () => {
    const sm = new StateMachine(homey as never, log);
    await sm.setMode('armed_stay');
    expect(sm.getMode()).toBe('armed_stay');
    expect(homey.settings._store[SETTINGS_KEYS.MODE]).toBe('armed_stay');
  });

  it('lagrer og leser tidspunkt for siste modus-endring', async () => {
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'));
    const sm = new StateMachine(homey as never, log);
    await sm.setMode('armed_stay');
    const ts = sm.getModeChangedAt();
    expect(ts).toBe(new Date('2025-06-01T12:00:00Z').getTime());
    expect(homey.settings._store[SETTINGS_KEYS.MODE_CHANGED_AT]).toBe(ts);
  });

  it('utsetter armed_away med exit-delay', async () => {
    const sm = new StateMachine(homey as never, log);
    await sm.setMode('armed_away', 30);

    expect(sm.getMode()).toBe('disarmed');
    expect(sm.isExitDelayActive()).toBe(true);

    vi.advanceTimersByTime(30_000);
    expect(sm.getMode()).toBe('armed_away');
    expect(sm.isExitDelayActive()).toBe(false);
  });

  it('kaller listeners ved modus-endring', async () => {
    const sm = new StateMachine(homey as never, log);
    const listener = vi.fn();
    sm.onModeChange(listener);

    await sm.setMode('armed_stay');
    expect(listener).toHaveBeenCalledWith('armed_stay', 'disarmed');
  });

  it('ignorerer setMode når modus er uendret', async () => {
    const sm = new StateMachine(homey as never, log);
    const listener = vi.fn();
    sm.onModeChange(listener);

    await sm.setMode('disarmed');
    expect(listener).not.toHaveBeenCalled();
  });

  it('startEntryDelay kaller callback etter angitt tid', () => {
    const sm = new StateMachine(homey as never, log);
    const cb = vi.fn();

    sm.startEntryDelay(20, cb);
    expect(sm.isEntryDelayActive()).toBe(true);

    vi.advanceTimersByTime(20_000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(sm.isEntryDelayActive()).toBe(false);
  });

  it('startEntryDelay ignoreres når timer allerede løper', () => {
    const sm = new StateMachine(homey as never, log);
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    sm.startEntryDelay(20, cb1);
    sm.startEntryDelay(20, cb2);

    vi.advanceTimersByTime(20_000);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).not.toHaveBeenCalled();
  });

  it('cancelEntryDelay stopper pågående nedtelling', () => {
    const sm = new StateMachine(homey as never, log);
    const cb = vi.fn();

    sm.startEntryDelay(20, cb);
    sm.cancelEntryDelay();
    vi.advanceTimersByTime(20_000);

    expect(cb).not.toHaveBeenCalled();
    expect(sm.isEntryDelayActive()).toBe(false);
  });

  it('setMode rydder eksisterende exit/entry-timere', async () => {
    const sm = new StateMachine(homey as never, log);
    const cb = vi.fn();
    sm.startEntryDelay(20, cb);

    await sm.setMode('armed_stay');
    expect(sm.isEntryDelayActive()).toBe(false);

    vi.advanceTimersByTime(20_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('feilende listener stopper ikke øvrige listeners', async () => {
    const sm = new StateMachine(homey as never, log);
    const broken = vi.fn(() => { throw new Error('boom'); });
    const ok = vi.fn();
    sm.onModeChange(broken);
    sm.onModeChange(ok);

    await sm.setMode('armed_stay');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  describe('ulovlige modusoverganger', () => {
    it('kaster feil ved armed_away → armed_stay', async () => {
      const sm = new StateMachine(homey as never, log);
      await sm.setMode('armed_away');
      await expect(sm.setMode('armed_stay')).rejects.toThrow('Ugyldig modusovergang');
      expect(sm.getMode()).toBe('armed_away');
    });

    it('tillater armed_stay → armed_away', async () => {
      const sm = new StateMachine(homey as never, log);
      await sm.setMode('armed_stay');
      await sm.setMode('armed_away');
      expect(sm.getMode()).toBe('armed_away');
    });

    it('modus er uendret etter avvist overgang', async () => {
      const sm = new StateMachine(homey as never, log);
      const listener = vi.fn();
      sm.onModeChange(listener);
      await sm.setMode('armed_away');
      listener.mockClear();

      await sm.setMode('armed_stay').catch(() => { /* expected */ });
      expect(sm.getMode()).toBe('armed_away');
      expect(listener).not.toHaveBeenCalled();
    });

    it('tillater disarmed → armed_away → armed_stay → armed_away → disarmed', async () => {
      const sm = new StateMachine(homey as never, log);
      await sm.setMode('armed_away');
      expect(sm.getMode()).toBe('armed_away');
      await sm.setMode('disarmed');
      expect(sm.getMode()).toBe('disarmed');
      await sm.setMode('armed_stay');
      expect(sm.getMode()).toBe('armed_stay');
      await sm.setMode('armed_away');
      expect(sm.getMode()).toBe('armed_away');
      await sm.setMode('disarmed');
      expect(sm.getMode()).toBe('disarmed');
    });
  });

  describe('deterrence og alarm-modus', () => {
    it('tillater armed_stay → deterrence → alarm → disarmed', async () => {
      const sm = new StateMachine(homey as never, log);
      await sm.setMode('armed_stay');
      await sm.setMode('deterrence');
      expect(sm.getMode()).toBe('deterrence');
      await sm.setMode('alarm');
      expect(sm.getMode()).toBe('alarm');
      await sm.setMode('disarmed');
      expect(sm.getMode()).toBe('disarmed');
    });

    it('tillater armed_away → deterrence → alarm → armed_away', async () => {
      const sm = new StateMachine(homey as never, log);
      await sm.setMode('armed_away');
      vi.advanceTimersByTime(0); // flush any pending timers
      await sm.setMode('deterrence');
      await sm.setMode('alarm');
      await sm.setMode('armed_away');
      expect(sm.getMode()).toBe('armed_away');
    });

    it('tillater deterrence → armed_stay (stopp alarm uten å gå via disarmed)', async () => {
      const sm = new StateMachine(homey as never, log);
      await sm.setMode('armed_stay');
      await sm.setMode('deterrence');
      await sm.setMode('armed_stay');
      expect(sm.getMode()).toBe('armed_stay');
    });

    it('tillater disarmed → deterrence (test-modus)', async () => {
      const sm = new StateMachine(homey as never, log);
      await sm.setMode('deterrence');
      expect(sm.getMode()).toBe('deterrence');
    });

    it('tillater disarmed → alarm (test-modus)', async () => {
      const sm = new StateMachine(homey as never, log);
      await sm.setMode('alarm');
      expect(sm.getMode()).toBe('alarm');
    });

    it('kaster feil ved alarm → deterrence (ugyldig overgang)', async () => {
      const sm = new StateMachine(homey as never, log);
      await sm.setMode('alarm');
      await expect(sm.setMode('deterrence')).rejects.toThrow('Ugyldig modusovergang');
      expect(sm.getMode()).toBe('alarm');
    });

    it('kaller listener ved deterrence- og alarm-overganger', async () => {
      const sm = new StateMachine(homey as never, log);
      const listener = vi.fn();
      sm.onModeChange(listener);
      await sm.setMode('armed_stay');
      await sm.setMode('deterrence');
      await sm.setMode('alarm');
      expect(listener).toHaveBeenNthCalledWith(1, 'armed_stay', 'disarmed');
      expect(listener).toHaveBeenNthCalledWith(2, 'deterrence', 'armed_stay');
      expect(listener).toHaveBeenNthCalledWith(3, 'alarm', 'deterrence');
    });
  });
});
