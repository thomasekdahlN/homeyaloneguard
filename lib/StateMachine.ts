'use strict';

import type Homey from 'homey/lib/Homey';
import type EventLog from './EventLog';
import { isValidTransition, Mode, SETTINGS_KEYS } from './types';

export type ModeChangeListener = (mode: Mode, previous: Mode) => void;

export default class StateMachine {

  private mode: Mode;
  private modeChangedAt: number;
  private exitTimer: NodeJS.Timeout | null = null;
  private exitDelayEndsAt: number | null = null;
  private exitDelayTarget: Mode | null = null;
  private entryTimer: NodeJS.Timeout | null = null;
  private entryDelayEndsAt: number | null = null;
  private listeners: ModeChangeListener[] = [];

  constructor(
    private readonly homey: Homey,
    private readonly log: EventLog,
  ) {
    const stored = this.homey.settings.get(SETTINGS_KEYS.MODE) as Mode | null;
    this.mode = stored ?? 'disarmed';
    const storedTs = this.homey.settings.get(SETTINGS_KEYS.MODE_CHANGED_AT) as number | null;
    this.modeChangedAt = typeof storedTs === 'number' ? storedTs : Date.now();
  }

  getMode(): Mode {
    return this.mode;
  }

  getModeChangedAt(): number {
    return this.modeChangedAt;
  }

  onModeChange(listener: ModeChangeListener): void {
    this.listeners.push(listener);
  }

  async setMode(next: Mode, exitDelaySeconds?: number): Promise<void> {
    if (this.mode === next && !this.isExitDelayActive()) return;

    if (!isValidTransition(this.mode, next)) {
      const msg = `Ugyldig modusovergang: kan ikke gå fra ${this.mode} til ${next}. Deaktiver systemet først.`;
      this.log.add('warning', msg);
      throw new Error(msg);
    }

    const wasExitDelay = this.isExitDelayActive();
    this.clearTimers();

    if (next === 'armed' && exitDelaySeconds && exitDelaySeconds > 0) {
      this.log.add('info', `Aktiverer Borte-modus om ${exitDelaySeconds}s (Exit Delay).`);
      this.exitDelayTarget = 'armed';
      this.exitDelayEndsAt = Date.now() + exitDelaySeconds * 1000;
      this.exitTimer = this.homey.setTimeout(() => {
        this.exitTimer = null;
        this.exitDelayEndsAt = null;
        this.exitDelayTarget = null;
        this.applyMode('armed');
      }, exitDelaySeconds * 1000);
      return;
    }

    if (wasExitDelay && this.mode === next) {
      this.log.add('info', `Exit Delay avbrutt — modus forblir ${next}.`);
      return;
    }

    this.applyMode(next);
  }

  startEntryDelay(entryDelaySeconds: number, onTimeout: () => void): void {
    if (this.entryTimer) return;
    this.log.add('warning', `Innpassering oppdaget. Nedtelling ${entryDelaySeconds}s.`);
    this.entryDelayEndsAt = Date.now() + entryDelaySeconds * 1000;
    this.entryTimer = this.homey.setTimeout(() => {
      this.entryTimer = null;
      this.entryDelayEndsAt = null;
      onTimeout();
    }, entryDelaySeconds * 1000);
  }

  cancelEntryDelay(): void {
    if (!this.entryTimer) return;
    this.homey.clearTimeout(this.entryTimer);
    this.entryTimer = null;
    this.entryDelayEndsAt = null;
  }

  isEntryDelayActive(): boolean {
    return this.entryTimer !== null;
  }

  isExitDelayActive(): boolean {
    return this.exitTimer !== null;
  }

  getExitDelayEndsAt(): number | null {
    return this.exitDelayEndsAt;
  }

  getExitDelayTarget(): Mode | null {
    return this.exitDelayTarget;
  }

  getEntryDelayEndsAt(): number | null {
    return this.entryDelayEndsAt;
  }

  private applyMode(next: Mode): void {
    const previous = this.mode;
    this.mode = next;
    this.modeChangedAt = Date.now();
    this.homey.settings.set(SETTINGS_KEYS.MODE, next);
    this.homey.settings.set(SETTINGS_KEYS.MODE_CHANGED_AT, this.modeChangedAt);
    this.log.add('info', `Modus: ${next}.`);
    for (const listener of this.listeners) {
      try {
        listener(next, previous);
      } catch (err) {
        this.log.add('warning', `Mode listener feilet: ${(err as Error).message}`);
      }
    }
  }

  private clearTimers(): void {
    if (this.exitTimer) {
      this.homey.clearTimeout(this.exitTimer);
      this.exitTimer = null;
      this.exitDelayEndsAt = null;
      this.exitDelayTarget = null;
    }
    if (this.entryTimer) {
      this.homey.clearTimeout(this.entryTimer);
      this.entryTimer = null;
      this.entryDelayEndsAt = null;
    }
  }

}
