'use strict';

import type Homey from 'homey/lib/Homey';
import type EventLog from './EventLog';
import type LightAuthGuard from './LightAuthGuard';

const STROBE_INTERVAL_MS = 400;

export type EscalationListener = () => void;

export default class EscalationManager {

  private strobeInterval: NodeJS.Timeout | null = null;
  private inCrisis = false;
  private listeners: EscalationListener[] = [];

  constructor(
    private readonly homey: Homey,
    private readonly homeyApi: any,
    private readonly log: EventLog,
    private readonly lightAuth: LightAuthGuard,
  ) { }

  /**
   * Immediately trigger the full alarm crisis (sirens + strobe).
   * The deterrence → alarm timer lives in app.ts; this method is called
   * when the system enters alarm mode.
   */
  async triggerCrisis(): Promise<void> {
    if (this.inCrisis) return;
    this.inCrisis = true;
    this.log.add('critical', 'ALARM: Full eskalering — sirener og strobe aktiv.');
    for (const listener of this.listeners) {
      try { listener(); } catch { /* best-effort */ }
    }

    const devices = await this.homeyApi.devices.getDevices();
    const all = Object.values(devices) as any[];

    for (const dev of all) {
      if (!Array.isArray(dev.capabilities)) continue;
      if (dev.capabilities.includes('volume_set')) {
        try { await dev.setCapabilityValue({ capabilityId: 'volume_set', value: 1.0 }); } catch { /* best-effort */ }
      }
      if (dev.capabilities.includes('speaker_playing')) {
        try { await dev.setCapabilityValue({ capabilityId: 'speaker_playing', value: true }); } catch { /* best-effort */ }
      }
    }

    const lights = all.filter((d) => Array.isArray(d.capabilities)
      && d.capabilities.includes('onoff')
      && !d.capabilities.includes('alarm_motion')
      && !d.capabilities.includes('alarm_contact'));

    let toggle = false;
    this.strobeInterval = this.homey.setInterval(async () => {
      toggle = !toggle;
      for (const light of lights) {
        try {
          this.lightAuth.registerOwnCommand(light.id, true);
          await light.setCapabilityValue({ capabilityId: 'onoff', value: true });
          if (light.capabilities.includes('light_hue')) {
            await light.setCapabilityValue({ capabilityId: 'light_hue', value: toggle ? 0 : 0.66 });
          }
          if (light.capabilities.includes('light_saturation')) {
            await light.setCapabilityValue({ capabilityId: 'light_saturation', value: 1 });
          }
          if (light.capabilities.includes('dim')) {
            await light.setCapabilityValue({ capabilityId: 'dim', value: 1 });
          }
        } catch { /* best-effort */ }
      }
    }, STROBE_INTERVAL_MS);
  }

  cancel(): void {
    if (this.strobeInterval) {
      this.homey.clearInterval(this.strobeInterval);
      this.strobeInterval = null;
    }
    this.inCrisis = false;
  }

  onCrisis(listener: EscalationListener): void {
    this.listeners.push(listener);
  }

  isInCrisis(): boolean {
    return this.inCrisis;
  }

}
