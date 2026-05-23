'use strict';

import type EventLog from './EventLog';
import { CMD_BUFFER_TTL_MS } from './types';

interface OwnCommand {
  deviceId: string;
  value: boolean;
  ts: number;
}

export default class LightAuthGuard {

  private ownCommands: OwnCommand[] = [];

  constructor(
    private readonly homeyApi: any,
    private readonly log: EventLog,
  ) {}

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
    if (this.isOwnCommand(deviceId, value)) return;

    this.log.add('warning', 'Uautorisert lys-på oppdaget — slår av.', undefined, deviceId);

    try {
      const device = await this.homeyApi.devices.getDevice({ id: deviceId });
      if (!device || !Array.isArray(device.capabilities) || !device.capabilities.includes('onoff')) return;
      this.registerOwnCommand(deviceId, false);
      await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
    } catch (err) {
      this.log.add('warning', `Kunne ikke slå av uautorisert lys: ${(err as Error).message}`, undefined, deviceId);
    }
  }

  private prune(): void {
    const cutoff = Date.now() - CMD_BUFFER_TTL_MS;
    this.ownCommands = this.ownCommands.filter((c) => c.ts >= cutoff);
  }

}
