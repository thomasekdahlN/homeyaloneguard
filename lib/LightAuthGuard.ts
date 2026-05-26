'use strict';

import type EventLog from './EventLog';
import { CMD_BUFFER_TTL_MS } from './types';
import { isLight } from './Capabilities';

interface OwnCommand {
  deviceId: string;
  value: boolean;
  ts: number;
}

export type GuardActivePredicate = () => boolean;

export default class LightAuthGuard {

  private ownCommands: OwnCommand[] = [];
  private isActive: GuardActivePredicate = () => false;

  constructor(
    private readonly homeyApi: any,
    private readonly log: EventLog,
  ) { }

  setActivePredicate(predicate: GuardActivePredicate): void {
    this.isActive = predicate;
  }

  registerOwnCommand(deviceId: string, value: boolean): void {
    this.prune();
    this.ownCommands.push({ deviceId, value, ts: Date.now() });
  }

  isOwnCommand(deviceId: string, value: boolean): boolean {
    this.prune();
    const idx = this.ownCommands.findIndex((c) => c.deviceId === deviceId && c.value === value);
    if (idx >= 0) {
      this.ownCommands.splice(idx, 1);
      return true;
    }
    return false;
  }

  async handleOnOffChange(deviceId: string, value: boolean): Promise<void> {
    if (value !== true) return;
    if (!this.isActive()) return;
    if (this.isOwnCommand(deviceId, value)) return;

    let zoneId: string | undefined;
    let zoneName = 'ukjent sone';
    let deviceName = deviceId;

    try {
      const device = await this.homeyApi.devices.getDevice({ id: deviceId });
      if (!device || !isLight(device)) return;
      zoneId = device.zone;
      deviceName = device.name || deviceId;
      if (zoneId) {
        try {
          const zone = await this.homeyApi.zones.getZone({ id: zoneId });
          if (zone && zone.name) zoneName = zone.name;
        } catch {
          // best-effort zone lookup
        }
      }
      this.log.add('warning', `Uautorisert lys-på: ${deviceName} i sone ${zoneName} — slår av.`, zoneId, deviceId);
      this.registerOwnCommand(deviceId, false);
      await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
    } catch (err) {
      this.log.add('warning', `Kunne ikke slå av uautorisert lys (${deviceName}): ${(err as Error).message}`, zoneId, deviceId);
    }
  }

  private prune(): void {
    const cutoff = Date.now() - CMD_BUFFER_TTL_MS;
    this.ownCommands = this.ownCommands.filter((c) => c.ts >= cutoff);
  }

}
