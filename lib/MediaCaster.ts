'use strict';

import type Homey from 'homey/lib/Homey';
import type EventLog from './EventLog';
import type LightAuthGuard from './LightAuthGuard';
import { isLight } from './Capabilities';
import { DEFAULT_BLINK_SECONDS, GuardSettings } from './types';

const BLUE_HUE = 0.66;
const RED_HUE = 0.0;

interface ZoneTask {
  /** Light devices managed by this task — reused on stop to avoid a second getDevices() call. */
  lights: any[];
  stop: () => Promise<void>;
}

export default class MediaCaster {

  private active = new Map<string, ZoneTask>();

  constructor(
    private readonly homey: Homey,
    private readonly homeyApi: any,
    private readonly log: EventLog,
    private readonly lightAuth: LightAuthGuard,
    private readonly getSettings: () => GuardSettings,
  ) { }

  /** Start a slow blink on lights in the given zone (deterrence reaction zone). */
  async startBlink(zoneId: string): Promise<void> {
    await this.stopZone(zoneId);
    const devices = await this.zoneDevices(zoneId);
    await this.startLightStrobe(zoneId, devices, [BLUE_HUE, RED_HUE]);
  }

  /**
   * Stop all active blink tasks and turn off their lights.
   * Call this unconditionally when disarming or stopping an alarm — no guard needed.
   */
  async stopAll(): Promise<void> {
    const entries = Array.from(this.active.entries());
    this.active.clear();
    for (const [, task] of entries) {
      try { await task.stop(); } catch { /* best-effort */ }
      for (const light of task.lights) {
        try {
          this.lightAuth.registerOwnCommand(light.id, false);
          await light.setCapabilityValue({ capabilityId: 'onoff', value: false });
        } catch { /* best-effort */ }
      }
    }
    if (entries.length > 0) {
      this.log.add('info', `stopAll: ${entries.length} lys-oppgave(r) avsluttet og lys slukket.`);
    }
  }

  /**
   * Stop the blink task for a single zone and turn off its lights.
   * Uses the device list cached in the task — no extra getDevices() call.
   */
  async stopZone(zoneId: string): Promise<void> {
    const task = this.active.get(zoneId);
    if (!task) return;
    this.active.delete(zoneId);
    try {
      await task.stop();
    } catch (err) {
      this.log.add('warning', `Stop zone feilet: ${(err as Error).message}`, zoneId);
    }
    for (const light of task.lights) {
      try {
        this.lightAuth.registerOwnCommand(light.id, false);
        await light.setCapabilityValue({ capabilityId: 'onoff', value: false });
      } catch { /* best-effort */ }
    }
  }

  private async startLightStrobe(zoneId: string, devices: any[], hues: number[]): Promise<void> {
    const settings = this.getSettings();
    const onSec = Math.max(1, settings.blink_on?.[zoneId] ?? DEFAULT_BLINK_SECONDS);
    const offSec = Math.max(1, settings.blink_off?.[zoneId] ?? DEFAULT_BLINK_SECONDS);
    await this.startLightStrobeWithTiming(zoneId, devices, hues, onSec, offSec);
  }

  private async startLightStrobeWithTiming(key: string, devices: any[], hues: number[], onSec: number, offSec: number): Promise<void> {
    const lights = devices.filter((d: any) => isLight(d));
    if (lights.length === 0) {
      this.log.add('warning', `Ingen lys å blinke i sone ${key}.`, key);
      return;
    }
    const onMs = onSec * 1000;
    const offMs = offSec * 1000;

    let idx = 0;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const turnOn = async (): Promise<void> => {
      const hue = hues[idx % hues.length] ?? BLUE_HUE;
      idx += 1;
      // Fire all lights in parallel to reduce latency and CPU time.
      await Promise.all(lights.map(async (light) => {
        try {
          this.lightAuth.registerOwnCommand(light.id, true);
          await light.setCapabilityValue({ capabilityId: 'onoff', value: true });
          if (light.capabilities.includes('light_hue')) {
            await light.setCapabilityValue({ capabilityId: 'light_hue', value: hue });
          }
          if (light.capabilities.includes('light_saturation')) {
            await light.setCapabilityValue({ capabilityId: 'light_saturation', value: 1 });
          }
          if (light.capabilities.includes('dim')) {
            await light.setCapabilityValue({ capabilityId: 'dim', value: 1 });
          }
        } catch { /* best-effort */ }
      }));
    };

    const turnOff = async (): Promise<void> => {
      await Promise.all(lights.map(async (light) => {
        try {
          this.lightAuth.registerOwnCommand(light.id, false);
          await light.setCapabilityValue({ capabilityId: 'onoff', value: false });
        } catch { /* best-effort */ }
      }));
    };

    const cycle = async (): Promise<void> => {
      if (stopped) return;
      await turnOn();
      timer = this.homey.setTimeout(async () => {
        if (stopped) return;
        await turnOff();
        timer = this.homey.setTimeout(cycle, offMs);
      }, onMs);
    };

    cycle().catch(() => { /* best-effort */ });

    // Store lights reference in the task so stopZone/stopAll can turn them off
    // without making another getDevices() API call.
    this.active.set(key, {
      lights,
      stop: async () => {
        stopped = true;
        if (timer) this.homey.clearTimeout(timer);
      },
    });
    this.log.add('info', `Starter blinkende lys i sone ${key}: ${lights.length} lys, ${onSec}s på / ${offSec}s av.`, key);
  }

  private async zoneDevices(zoneId: string): Promise<any[]> {
    const devices = await this.homeyApi.devices.getDevices();
    return Object.values(devices).filter((d: any) => d.zone === zoneId);
  }

}
