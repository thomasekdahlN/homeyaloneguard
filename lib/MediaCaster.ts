'use strict';

import type Homey from 'homey/lib/Homey';
import type EventLog from './EventLog';
import type LightAuthGuard from './LightAuthGuard';

const BLUE_HUE = 0.66;
const RED_HUE = 0.0;
const STROBE_INTERVAL_MS = 600;

interface ZoneTask {
  stop: () => Promise<void>;
}

export default class MediaCaster {

  private active = new Map<string, ZoneTask>();

  constructor(
    private readonly homey: Homey,
    private readonly homeyApi: any,
    private readonly log: EventLog,
    private readonly lightAuth: LightAuthGuard,
  ) { }

  async startBlueLights(zoneId: string, videoUrl?: string | null): Promise<void> {
    await this.stopZone(zoneId);
    const devices = await this.zoneDevices(zoneId);

    const screen = devices.find((d: any) => Array.isArray(d.capabilities)
      && (d.capabilities.includes('speaker_playing') || d.capabilities.includes('cast_url')));

    if (videoUrl && screen && screen.capabilities.includes('cast_url')) {
      try {
        await screen.setCapabilityValue({ capabilityId: 'cast_url', value: videoUrl });
        this.active.set(zoneId, { stop: async () => this.stopScreen(screen) });
        this.log.add('info', `Caster video (${videoUrl}) til skjerm i sone ${zoneId}.`, zoneId);
        return;
      } catch (err) {
        this.log.add('warning', `Cast feilet: ${(err as Error).message}. Faller tilbake til lys.`, zoneId);
      }
    }
    await this.startLightStrobe(zoneId, devices, [BLUE_HUE, RED_HUE]);
  }

  async startSiren(zoneId: string, customUrl: string | null): Promise<void> {
    const url = customUrl ?? '/assets/media/police-siren.ogg';
    const devices = await this.zoneDevices(zoneId);
    const speaker = devices.find((d: any) => Array.isArray(d.capabilities)
      && (d.capabilities.includes('speaker_playing') || d.capabilities.includes('volume_set')));
    if (!speaker) return;
    try {
      if (speaker.capabilities.includes('volume_set')) {
        await speaker.setCapabilityValue({ capabilityId: 'volume_set', value: 1.0 });
      }
      if (speaker.capabilities.includes('speaker_playing')) {
        await speaker.setCapabilityValue({ capabilityId: 'speaker_playing', value: true });
      }
      this.log.add('info', `Spiller sirene (${url}) i sone ${zoneId}.`, zoneId);
    } catch (err) {
      this.log.add('warning', `Sirene feilet: ${(err as Error).message}`, zoneId);
    }
  }

  async stopZone(zoneId: string): Promise<void> {
    const task = this.active.get(zoneId);
    if (task) {
      try {
        await task.stop();
      } catch (err) {
        this.log.add('warning', `Stop zone feilet: ${(err as Error).message}`, zoneId);
      }
      this.active.delete(zoneId);
    }
    const devices = await this.zoneDevices(zoneId);
    for (const device of devices) {
      if (!Array.isArray(device.capabilities)) continue;
      if (device.capabilities.includes('alarm_motion') || device.capabilities.includes('alarm_contact')) continue;
      if (device.capabilities.includes('onoff')) {
        try {
          this.lightAuth.registerOwnCommand(device.id, false);
          await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
        } catch { /* best-effort */ }
      }
      if (device.capabilities.includes('speaker_playing')) {
        try { await device.setCapabilityValue({ capabilityId: 'speaker_playing', value: false }); } catch { /* best-effort */ }
      }
    }
  }

  private async startLightStrobe(zoneId: string, devices: any[], hues: number[]): Promise<void> {
    const lights = devices.filter((d: any) => Array.isArray(d.capabilities)
      && d.capabilities.includes('onoff')
      && !d.capabilities.includes('alarm_motion'));
    let idx = 0;
    const interval = this.homey.setInterval(async () => {
      const hue = hues[idx % hues.length] ?? BLUE_HUE;
      idx += 1;
      for (const light of lights) {
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
      }
    }, STROBE_INTERVAL_MS);
    this.active.set(zoneId, {
      stop: async () => {
        this.homey.clearInterval(interval);
      },
    });
    this.log.add('info', `Starter blinkende lys (fallback) i sone ${zoneId}.`, zoneId);
  }

  private async stopScreen(screen: any): Promise<void> {
    try {
      if (Array.isArray(screen.capabilities) && screen.capabilities.includes('speaker_playing')) {
        await screen.setCapabilityValue({ capabilityId: 'speaker_playing', value: false });
      }
    } catch { /* best-effort */ }
  }

  private async zoneDevices(zoneId: string): Promise<any[]> {
    const devices = await this.homeyApi.devices.getDevices();
    return Object.values(devices).filter((d: any) => d.zone === zoneId);
  }

}
