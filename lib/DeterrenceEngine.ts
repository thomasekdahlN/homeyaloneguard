'use strict';

import type Homey from 'homey/lib/Homey';
import type EventLog from './EventLog';
import type MediaCaster from './MediaCaster';
import { GuardSettings } from './types';

export type DeterrenceListener = (reactionZoneId: string, motionZoneId: string) => void;

export default class DeterrenceEngine {

  private activeDeterrenceZone: string | null = null;
  private activeMotionZone: string | null = null;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private listeners: DeterrenceListener[] = [];

  constructor(
    private readonly homey: Homey,
    private readonly log: EventLog,
    private readonly media: MediaCaster,
    private readonly getSettings: () => GuardSettings,
  ) {}

  onDeterrenceStarted(listener: DeterrenceListener): void {
    this.listeners.push(listener);
  }

  getActiveZone(): string | null {
    return this.activeDeterrenceZone;
  }

  getActiveMotionZone(): string | null {
    return this.activeMotionZone;
  }

  async handleMotion(motionZoneId: string): Promise<void> {
    this.activeMotionZone = motionZoneId;
    const settings = this.getSettings();

    if (motionZoneId === this.activeDeterrenceZone) {
      await this.darken(`Tyv beveger seg mot reaksjonssone ${this.activeDeterrenceZone}.`);
      const matrix = settings.zone_matrix;
      this.cooldownTimer = this.homey.setTimeout(() => {
        this.cooldownTimer = null;
        const next = matrix[motionZoneId];
        if (next) {
          this.execute(next, motionZoneId).catch((err) => {
            this.log.add('warning', `Deterrence (post-cooldown) feilet: ${(err as Error).message}`, next);
          });
        }
      }, settings.deterrence_delay * 1000);
      return;
    }

    const reactionZoneId = settings.zone_matrix[motionZoneId];
    if (!reactionZoneId) {
      this.log.add('warning', `Ingen reaksjonssone definert for ${motionZoneId}.`, motionZoneId);
      return;
    }
    await this.execute(reactionZoneId, motionZoneId);
  }

  async abort(reason = 'Avbrutt.'): Promise<void> {
    if (this.cooldownTimer) {
      this.homey.clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    if (this.activeDeterrenceZone) {
      await this.media.stopZone(this.activeDeterrenceZone);
      this.log.add('info', `${reason} Stopper avskrekking i ${this.activeDeterrenceZone}.`, this.activeDeterrenceZone);
      this.activeDeterrenceZone = null;
    }
    this.activeMotionZone = null;
  }

  private async execute(reactionZoneId: string, motionZoneId: string): Promise<void> {
    this.activeDeterrenceZone = reactionZoneId;
    this.log.add('alarm', `Avskrekking startet i sone ${reactionZoneId} (tyv i ${motionZoneId}).`, reactionZoneId);

    const settings = this.getSettings();
    await this.media.startBlueLights(reactionZoneId);
    await this.media.startSiren(reactionZoneId, settings.custom_audio_url);

    for (const listener of this.listeners) {
      try { listener(reactionZoneId, motionZoneId); } catch { /* best-effort */ }
    }
  }

  private async darken(reason: string): Promise<void> {
    if (!this.activeDeterrenceZone) return;
    this.log.add('info', `Mørklegger ${this.activeDeterrenceZone}: ${reason}`, this.activeDeterrenceZone);
    await this.media.stopZone(this.activeDeterrenceZone);
    this.activeDeterrenceZone = null;
  }

}
