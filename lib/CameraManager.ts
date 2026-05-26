'use strict';

import type Homey from 'homey/lib/Homey';
import type EventLog from './EventLog';
import {
  ALARM_SNAPSHOT_MAX, CameraMode, GuardSettings, MAX_PUSH_PER_EVENT,
  MOTION_BURST_COUNT, SNAPSHOT_INTERVAL_MS,
} from './types';
import { isCamera } from './Capabilities';

interface ZoneLoop {
  interval: NodeJS.Timeout;
  pushCount: number;
  snapshotCount: number;
  maxSnapshots: number;
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
    private readonly getSettings: () => GuardSettings,
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
      maxSnapshots: ALARM_SNAPSHOT_MAX,
      interval: this.homey.setInterval(() => {
        this.captureZone(zoneId).catch((err) => {
          this.log.add('warning', `Snapshot feilet: ${(err as Error).message}`, zoneId);
        });
      }, SNAPSHOT_INTERVAL_MS),
    };
    this.loops.set(zoneId, loop);
    this.log.add('info', `Snapshot-loop startet i sone ${zoneId} (${cameras.length} kamera, maks ${ALARM_SNAPSHOT_MAX} bilder, hvert ${SNAPSHOT_INTERVAL_MS / 1000}s).`, zoneId);
  }

  /**
   * Take a burst of snapshots from cameras in the zone that have camera_mode === 'motion'.
   * Called on every motion event regardless of arm state.
   */
  async captureMotionBurst(zoneId: string): Promise<void> {
    const settings = this.getSettings();
    const cameras = await this.zoneCameras(zoneId);
    const motionCameras = cameras.filter((c: any) => {
      const mode: CameraMode = settings.camera_mode?.[c.id] ?? 'alarm_only';
      return mode === 'motion';
    });
    if (motionCameras.length === 0) return;

    this.log.add('info', `Bevegelse-burst: ${motionCameras.length} kamera i sone ${zoneId} (${MOTION_BURST_COUNT} bilder).`, zoneId);
    for (let i = 0; i < MOTION_BURST_COUNT; i += 1) {
      await this.captureList(zoneId, motionCameras, false);
      if (i < MOTION_BURST_COUNT - 1) {
        await new Promise<void>((resolve) => { this.homey.setTimeout(resolve, SNAPSHOT_INTERVAL_MS); });
      }
    }
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
    if (loop.snapshotCount >= loop.maxSnapshots) {
      this.stopForZone(zoneId);
      return;
    }
    const cameras = await this.zoneCameras(zoneId);
    await this.captureList(zoneId, cameras, true, loop);
  }

  /** Capture from a list of cameras, optionally tracking a loop's push/snapshot counters. */
  private async captureList(zoneId: string, cameras: any[], trackLoop: boolean, loop?: ZoneLoop): Promise<void> {
    for (const camera of cameras) {
      try {
        const camImage = camera.images && camera.images[0];
        if (!camImage) continue;

        if (loop) loop.snapshotCount += 1;

        // Create a native Homey Image so the flow token can be routed to Telegram / FTP / Dropbox.
        const flowImage = await (this.homey.images as any).createImage();
        flowImage.setStream(async (stream: NodeJS.WritableStream) => {
          try {
            const readable = await camImage.getStream();
            readable.pipe(stream);
          } catch {
            (stream as NodeJS.WritableStream & { end: () => void }).end();
          }
        });

        if (!trackLoop || (loop && loop.pushCount < MAX_PUSH_PER_EVENT)) {
          await this.homey.notifications.createNotification({
            excerpt: `📷 Snapshot fra ${camera.name || zoneId}`,
          });
          if (loop) loop.pushCount += 1;
        }

        for (const listener of this.listeners) {
          try { listener(zoneId, camera.id, camera.name || zoneId, flowImage); } catch { /* best-effort */ }
        }

        // Unregister after 60 s — long enough for any flow action to fetch it.
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
