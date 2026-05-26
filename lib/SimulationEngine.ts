'use strict';

import type Homey from 'homey/lib/Homey';
import type EventLog from './EventLog';
import type LightAuthGuard from './LightAuthGuard';
import { GuardSettings } from './types';
import { isLight } from './Capabilities';

const TICK_INTERVAL_MS = 60_000;

export default class SimulationEngine {

  private tickInterval: NodeJS.Timeout | null = null;
  private cycleTimer: NodeJS.Timeout | null = null;
  private currentZones: string[] = [];
  private running = false;

  constructor(
    private readonly homey: Homey,
    private readonly homeyApi: any,
    private readonly log: EventLog,
    private readonly lightAuth: LightAuthGuard,
    private readonly getSettings: () => GuardSettings,
  ) { }

  start(): void {
    if (this.tickInterval) return;
    this.tick();
    this.tickInterval = this.homey.setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.tickInterval) {
      this.homey.clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.cycleTimer) {
      this.homey.clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }
    if (this.running) {
      this.turnOffCurrent().catch(() => { /* best-effort */ });
    }
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  private tick(): void {
    const within = this.isWithinWindow();
    if (within && !this.running) {
      this.running = true;
      this.log.add('info', 'Kevin-modus startet (tilstedeværelsessimulering).');
      this.scheduleCycle();
    } else if (!within && this.running) {
      this.running = false;
      this.log.add('info', 'Kevin-modus stoppet.');
      if (this.cycleTimer) {
        this.homey.clearTimeout(this.cycleTimer);
        this.cycleTimer = null;
      }
      this.turnOffCurrent().catch(() => { /* best-effort */ });
    }
  }

  private scheduleCycle(): void {
    const settings = this.getSettings();
    this.runCycle(settings).catch((err) => {
      this.log.add('warning', `Kevin-cycle feilet: ${(err as Error).message}`);
    });
    const min = Math.max(1, settings.random_min);
    const max = Math.max(min, settings.random_max);
    const next = (Math.floor(Math.random() * (max - min + 1)) + min) * 60_000;
    this.cycleTimer = this.homey.setTimeout(() => {
      this.cycleTimer = null;
      if (this.running) this.scheduleCycle();
    }, next);
  }

  private async runCycle(settings: GuardSettings): Promise<void> {
    await this.turnOffCurrent();
    const candidates = Object.entries(settings.kevin_zones)
      .filter(([, enabled]) => enabled)
      .map(([zoneId]) => zoneId);
    if (candidates.length === 0) return;

    const count = Math.min(candidates.length, 1 + Math.floor(Math.random() * 3));
    const picked: string[] = [];
    const pool = [...candidates];
    for (let i = 0; i < count && pool.length > 0; i += 1) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0] as string);
    }
    this.currentZones = picked;

    const devices = await this.homeyApi.devices.getDevices();
    const all = Object.values(devices) as any[];

    for (const zoneId of picked) {
      const zoneLights = all.filter((d) => d.zone === zoneId && isLight(d));
      for (const light of zoneLights) {
        try {
          this.lightAuth.registerOwnCommand(light.id, true);
          await light.setCapabilityValue({ capabilityId: 'onoff', value: true });
        } catch { /* best-effort */ }
      }
    }
    this.log.add('info', `Kevin-syklus: lys på i ${picked.length} sone(r).`);
  }

  private async turnOffCurrent(): Promise<void> {
    if (this.currentZones.length === 0) return;
    const devices = await this.homeyApi.devices.getDevices();
    const all = Object.values(devices) as any[];
    for (const zoneId of this.currentZones) {
      const zoneLights = all.filter((d) => d.zone === zoneId && isLight(d));
      for (const light of zoneLights) {
        try {
          this.lightAuth.registerOwnCommand(light.id, false);
          await light.setCapabilityValue({ capabilityId: 'onoff', value: false });
        } catch { /* best-effort */ }
      }
    }
    this.currentZones = [];
  }

  private isWithinWindow(): boolean {
    const settings = this.getSettings();
    const sunset = this.getSunset();
    if (!sunset) return false;
    const start = new Date(sunset.getTime() + settings.sunset_offset * 60_000);
    const end = this.parseBedtime(settings.bedtime);
    const now = new Date();
    return now >= start && now <= end;
  }

  private getSunset(): Date | null {
    const geo: any = this.homey.geolocation;
    try {
      const lat = geo.getLatitude();
      const lng = geo.getLongitude();
      if (typeof lat !== 'number' || typeof lng !== 'number') return null;
      return SimulationEngine.computeSunset(new Date(), lat, lng);
    } catch {
      return null;
    }
  }

  private parseBedtime(bedtime: string): Date {
    const [h, m] = bedtime.split(':').map((n) => parseInt(n, 10));
    const d = new Date();
    d.setHours(h ?? 23, m ?? 30, 0, 0);
    return d;
  }

  private static computeSunset(date: Date, lat: number, lng: number): Date {
    const rad = Math.PI / 180;
    const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86_400_000);
    const declination = -23.44 * rad * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
    const cosH = (Math.sin(-0.83 * rad) - Math.sin(lat * rad) * Math.sin(declination))
      / (Math.cos(lat * rad) * Math.cos(declination));
    const clamped = Math.max(-1, Math.min(1, cosH));
    const hourAngle = Math.acos(clamped) / rad;
    const solarNoonUTC = 12 - lng / 15;
    const sunsetUTC = solarNoonUTC + hourAngle / 15;
    const result = new Date(date);
    result.setUTCHours(Math.floor(sunsetUTC), Math.floor((sunsetUTC % 1) * 60), 0, 0);
    return result;
  }

}
