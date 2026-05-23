import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import FalseAlarmFilter from '../lib/FalseAlarmFilter';

describe('FalseAlarmFilter', () => {
  let filter: FalseAlarmFilter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    filter = new FalseAlarmFilter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returnerer ikke bekreftet ved enkel bevegelse i én sone', () => {
    expect(filter.registerMotion('zone-1')).toBe(false);
  });

  it('bekrefter alarm ved bevegelse i to ulike soner innen 90s', () => {
    expect(filter.registerMotion('zone-1')).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(filter.registerMotion('zone-2')).toBe(true);
  });

  it('bekrefter ikke når andre bevegelse kommer etter 90s-vinduet', () => {
    expect(filter.registerMotion('zone-1')).toBe(false);
    vi.advanceTimersByTime(91_000);
    expect(filter.registerMotion('zone-2')).toBe(false);
  });

  it('bekrefter alarm ved kontakt + bevegelse innen 90s', () => {
    expect(filter.registerContactOpen()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(filter.registerMotion('zone-1')).toBe(true);
  });

  it('bekrefter alarm ved bevegelse først, så kontakt innen 90s', () => {
    expect(filter.registerMotion('zone-1')).toBe(false);
    vi.advanceTimersByTime(15_000);
    expect(filter.registerContactOpen()).toBe(true);
  });

  it('forblir bekreftet etter første bekreftelse (idempotent)', () => {
    filter.registerMotion('zone-1');
    filter.registerMotion('zone-2');
    expect(filter.isConfirmed()).toBe(true);
    expect(filter.registerMotion('zone-3')).toBe(true);
  });

  it('reset() nullstiller all tilstand', () => {
    filter.registerMotion('zone-1');
    filter.registerMotion('zone-2');
    expect(filter.isConfirmed()).toBe(true);

    filter.reset();
    expect(filter.isConfirmed()).toBe(false);
    expect(filter.registerMotion('zone-1')).toBe(false);
  });

  it('tre bevegelser i samme sone bekrefter ikke alarm', () => {
    expect(filter.registerMotion('zone-1')).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(filter.registerMotion('zone-1')).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(filter.registerMotion('zone-1')).toBe(false);
  });

  it('eldre bevegelser pruges ut av vinduet', () => {
    filter.registerMotion('zone-1');
    vi.advanceTimersByTime(95_000);
    expect(filter.registerMotion('zone-2')).toBe(false);
  });
});
