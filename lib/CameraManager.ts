'use strict';

import type Homey from 'homey/lib/Homey';
import type EventLog from './EventLog';
import { MAX_PUSH_PER_EVENT, SNAPSHOT_INTERVAL_MS } from './types';
import { isCamera } from './Capabilities';

interface ZoneLoop {
  interval: NodeJS.Timeout;
  pushCount: number;
  snapshotCount: number;
}

/** Called when a camera successfully captures a snapshot. */
export type SnapshotListener = (zoneId: string, cameraId: string, cameraName: string, image: any) => void;

export default class CameraManager {

  private loops = new Map<string, ZoneLoop>();
  private listeners: SnapshotListener[] = [];

  constructor(
    private readonly homey: Homey,
    private readonly homeyApi: any,
    private readonly log: EventLog,
  ) { }

  /** Register a listener that fires each time a snapshot is successfully captured. */
  onSnapshot(listener: SnapshotListener): void {
    this.listeners.push(listener);
  }

  async startForZone(zoneId: string): Promise<void> {
    if (this.loops.has(zoneId)) return;
    const cameras = await this.zoneCameras(zoneId);
    if (cameras.length === 0) {
      this.log.add('info', `Snapshot-loop hoppes over: ingen kameraer i sone ${zoneId}.`, zoneId);
      return;
    }
    const loop: ZoneLoop = {
      pushCount: 0,
      snapshotCount: 0,
      interval: this.homey.setInterval(() => {
        this.captureZone(zoneId).catch((err) => {
          this.log.add('warning', `Snapshot feilet: ${(err as Error).message}`, zoneId);
        });
      }, SNAPSHOT_INTERVAL_MS),
    };
    this.loops.set(zoneId, loop);
    this.log.add('info', `Snapshot-loop startet i sone ${zoneId} (${cameras.length} kamera, hvert ${SNAPSHOT_INTERVAL_MS / 1000}s).`, zoneId);
  }

  stopForZone(zoneId: string): void {
    const loop = this.loops.get(zoneId);
    if (!loop) return;
    this.homey.clearInterval(loop.interval);
    this.loops.delete(zoneId);
    this.log.add('info', `Snapshot-loop stoppet i sone ${zoneId} (${loop.snapshotCount} bilder, ${loop.pushCount} push).`, zoneId);
  }

  stopAll(): void {
    for (const zoneId of Array.from(this.loops.keys())) {
      this.stopForZone(zoneId);
    }
  }

  private async captureZone(zoneId: string): Promise<void> {
    const loop = this.loops.get(zoneId);
    if (!loop) return;

    const cameras = await this.zoneCameras(zoneId);
    for (const camera of cameras) {
      try {
        const camImage = camera.images && camera.images[0];
        if (!camImage) continue;
        loop.snapshotCount += 1;

        // Create a native Homey Image for the flow token so it can be routed
        // to Telegram, FTP, Dropbox etc. by the user's flow.
        const flowImage = await (this.homey.images as any).createImage();
        flowImage.setStream(async (stream: NodeJS.WritableStream) => {
          try {
            const readable = await camImage.getStream();
            readable.pipe(stream);
          } catch {
            (stream as NodeJS.WritableStream & { end: () => void }).end();
          }
        });

        if (loop.pushCount < MAX_PUSH_PER_EVENT) {
          await this.homey.notifications.createNotification({
            excerpt: `📷 Snapshot fra ${camera.name || zoneId}`,
          });
          loop.pushCount += 1;
        }

        for (const listener of this.listeners) {
          try { listener(zoneId, camera.id, camera.name || zoneId, flowImage); } catch { /* best-effort */ }
        }

        // Unregister the image after 60s — long enough for any flow action to fetch it.
        this.homey.setTimeout(() => {
          (this.homey.images as any).unregisterImage(flowImage).catch(() => { /* best-effort */ });
        }, 60_000);
      } catch (err) {
        this.log.add('warning', `Snapshot-kall feilet: ${(err as Error).message}`, zoneId);
      }
    }
  }

  private async zoneCameras(zoneId: string): Promise<any[]> {
    const devices = await this.homeyApi.devices.getDevices();
    return Object.values(devices).filter((d: any) => d.zone === zoneId && isCamera(d));
  }

}
