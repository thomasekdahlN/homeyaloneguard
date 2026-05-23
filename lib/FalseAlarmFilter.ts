'use strict';

import { FALSE_ALARM_WINDOW_MS } from './types';

interface MotionEvent {
  zoneId: string;
  ts: number;
}

export default class FalseAlarmFilter {

  private motions: MotionEvent[] = [];
  private contactBroken = false;
  private contactBrokenAt = 0;
  private confirmed = false;

  registerMotion(zoneId: string): boolean {
    this.prune();
    this.motions.push({ zoneId, ts: Date.now() });
    this.evaluate();
    return this.confirmed;
  }

  registerContactOpen(): boolean {
    this.contactBroken = true;
    this.contactBrokenAt = Date.now();
    this.evaluate();
    return this.confirmed;
  }

  isConfirmed(): boolean {
    this.prune();
    this.evaluate();
    return this.confirmed;
  }

  reset(): void {
    this.motions = [];
    this.contactBroken = false;
    this.contactBrokenAt = 0;
    this.confirmed = false;
  }

  private evaluate(): void {
    if (this.confirmed) return;

    if (this.contactBroken && this.motions.length > 0) {
      const window = Date.now() - FALSE_ALARM_WINDOW_MS;
      const hasMotionAfterContact = this.motions.some((m) => m.ts >= Math.max(this.contactBrokenAt - FALSE_ALARM_WINDOW_MS, window));
      if (hasMotionAfterContact) {
        this.confirmed = true;
        return;
      }
    }

    const uniqueZones = new Set(this.motions.map((m) => m.zoneId));
    if (uniqueZones.size >= 2) {
      this.confirmed = true;
    }
  }

  private prune(): void {
    const cutoff = Date.now() - FALSE_ALARM_WINDOW_MS;
    this.motions = this.motions.filter((m) => m.ts >= cutoff);
    if (this.contactBroken && this.contactBrokenAt < cutoff) {
      this.contactBroken = false;
      this.contactBrokenAt = 0;
    }
  }

}
