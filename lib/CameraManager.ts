'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type Homey from 'homey/lib/Homey';
import type EventLog from './EventLog';
import {
  CAMERA_ALARM_BURST_DEFAULT, CAMERA_MOTION_BURST_DEFAULT,
  CAMERA_FLASH_DELAY_MS,
  GuardSettings, SNAPSHOT_BURST_INTERVAL_MS,
  SNAPSHOT_DIR_ALARM, SNAPSHOT_DIR_MOTION, SNAPSHOT_MAX_COUNT_DEFAULT,
} from './types';
import { isCamera } from './Capabilities';

/** Called when a camera successfully captures a snapshot. */
export type SnapshotListener = (zoneId: string, cameraId: string, cameraName: string, image: any) => void;

/**
 * Called before an alarm-burst so the caller can illuminate the zone.
 * Must resolve (or reject) before the first snapshot is taken.
 */
export type FlashCallback = (zoneId: string) => Promise<void>;

/** Lightweight camera descriptor kept in the zone cache. */
interface ZoneCameraEntry {
  id: string;
  name: string;
  /** Relative or absolute URL to the camera's live image, e.g. "/api/manager/images/image/{id}". */
  imageUrl: string | null;
}

export default class CameraManager {

  private listeners: SnapshotListener[] = [];
  private flashCallback: FlashCallback | null = null;
  /** zoneId → cameras present in that zone. Built once at startup, refreshed on zone saves. */
  private zoneCameraCache = new Map<string, ZoneCameraEntry[]>();
  /** Cached Homey local base URL (e.g. "http://192.168.x.x"). Resolved once on first use. */
  private cachedBaseUrl: string | null = null;
  /** Cached owner API token. Resolved once on first use. */
  private cachedToken: string | null = null;

  constructor(
    private readonly homey: Homey,
    private readonly homeyApi: any,
    private readonly log: EventLog,
    private readonly getSettings: () => GuardSettings,
  ) {
    this.ensureSnapshotDirs();
    this.refreshZoneCache().catch(() => { /* best-effort — cache starts empty, populated async */ });
  }

  /**
   * Rebuild the zone→camera mapping from the current device list.
   * Call this at startup and after zone configuration is saved.
   *
   * Image URL resolution priority (highest first):
   *  0. settings.camera_snapshot_urls[deviceId] — manually entered by the user in the settings UI.
   *     Use this when the camera driver does not implement device.setCameraImage().
   *  1. homeyApi.images.getImages() ownerUri matching — standard Homey camera images registered
   *     via device.setCameraImage(). Works for cameras whose driver follows the Homey standard.
   *  2. device.images[0].url — legacy fallback for older drivers.
   *  3. null — no URL found; camera is skipped silently during capture.
   *
   * Note: HomeyAPIV3Local.ManagerImages has NO getImage() method (only getImages() plural),
   * and device.images objects are empty stubs (additionalProperties: false). See README for details.
   */
  async refreshZoneCache(): Promise<void> {
    try {
      // Step 0: manual URL overrides from settings (highest priority).
      const manualUrls: Record<string, string> = this.getSettings().camera_snapshot_urls ?? {};

      // Step 1: fetch all registered Homey images and build a deviceId → url map.
      const deviceImageUrl = new Map<string, string>();
      try {
        const allImages = await (this.homeyApi.images as any).getImages() as Record<string, any>;
        for (const img of Object.values(allImages)) {
          if (!img?.url) continue;
          // ownerUri format: "homey:device:{deviceId}"
          const ownerUri: string = String(img.ownerUri ?? '');
          const match = ownerUri.match(/^homey:device:(.+)$/);
          if (match && !deviceImageUrl.has(match[1])) {
            deviceImageUrl.set(match[1], String(img.url));
          }
        }
      } catch {
        // Non-fatal: fall through to device.images fallback below.
      }

      // Step 2: build zone → camera entries.
      const devices = await this.homeyApi.devices.getDevices();
      const next = new Map<string, ZoneCameraEntry[]>();
      for (const d of Object.values(devices) as any[]) {
        if (!d.zone || !isCamera(d)) continue;

        const deviceId = String(d.id);

        // Priority 0: manually configured URL (beats all automatic resolution).
        let imageUrl: string | null = manualUrls[deviceId] ? String(manualUrls[deviceId]) : null;

        // Priority 1: image registered via device.setCameraImage() in ManagerImages.
        if (!imageUrl) {
          imageUrl = deviceImageUrl.get(deviceId) ?? null;
        }

        // Priority 2: device.images[0].url (legacy drivers).
        if (!imageUrl) {
          const rawImages = Array.isArray(d.images) ? d.images : [];
          const rawImage = rawImages[0];
          if (rawImage) {
            imageUrl = typeof rawImage === 'string' ? rawImage : (rawImage.url ?? null);
          }
        }

        // No imageUrl found — camera will be skipped silently during capture.

        const entry: ZoneCameraEntry = {
          id: deviceId,
          name: String(d.name ?? d.id),
          imageUrl,
        };
        const list = next.get(d.zone) ?? [];
        list.push(entry);
        next.set(d.zone, list);
      }
      this.zoneCameraCache = next;
    } catch (err) {
      this.log.add('warning', `Kamera-sone-cache oppdatering feilet: ${(err as Error).message}`);
    }
  }

  /** Register a listener that fires each time a snapshot is successfully captured. */
  onSnapshot(listener: SnapshotListener): void {
    this.listeners.push(listener);
  }

  /**
   * Register a callback that is invoked (and awaited) before the first snapshot of an
   * alarm-burst. Use this to turn on zone lights so the camera captures a lit scene.
   * Only called when isAlarm = true.
   */
  setFlashCallback(cb: FlashCallback): void {
    this.flashCallback = cb;
  }

  /**
   * Capture a burst of snapshots when motion is detected.
   * @param zoneId  The zone where motion was detected.
   * @param isAlarm true when an alarm is currently active (uses camera_alarm_burst, default 10).
   *                false otherwise (uses camera_motion_burst, default 1; master switch must be on).
   */
  async captureMotionBurst(zoneId: string, isAlarm: boolean): Promise<void> {
    // Use the pre-built cache — no API call on every motion event.
    const cameras = this.zoneCameraCache.get(zoneId) ?? [];
    if (cameras.length === 0) return;

    const settings = this.getSettings();

    // Global master switch for motion snapshots (only relevant when alarm is not active).
    if (!isAlarm && settings.camera_motion_enabled === false) return;

    // Global burst count.
    const burstCount = isAlarm
      ? (settings.camera_alarm_burst ?? CAMERA_ALARM_BURST_DEFAULT)
      : (settings.camera_motion_burst ?? CAMERA_MOTION_BURST_DEFAULT);

    if (burstCount <= 0) return;

    // When alarm is active: illuminate the zone before capturing so the camera gets a lit scene.
    if (isAlarm && this.flashCallback) {
      try {
        this.log.add('info', `Slår på lys i sone ${zoneId} for kamera-opptak.`, zoneId);
        await this.flashCallback(zoneId);
        // Brief pause so the camera feed has time to reflect the new light level.
        await new Promise<void>((resolve) => { this.homey.setTimeout(resolve, CAMERA_FLASH_DELAY_MS); });
      } catch (err) {
        this.log.add('warning', `Lys-flash feilet i sone ${zoneId}: ${(err as Error).message}`, zoneId);
      }
    }

    for (const camera of cameras) {
      // Per-camera enabled flags — absent means enabled (default on). Skip silently if disabled.
      const camEnabled = isAlarm
        ? (settings.camera_alarm_cams?.[camera.id] !== false)
        : (settings.camera_motion_cams?.[camera.id] !== false);
      if (!camEnabled) continue;

      for (let i = 0; i < burstCount; i += 1) {
        await this.captureOne(zoneId, camera, isAlarm);
        if (i < burstCount - 1) {
          await new Promise<void>((resolve) => { this.homey.setTimeout(resolve, SNAPSHOT_BURST_INTERVAL_MS); });
        }
      }
    }
  }

  /**
   * Capture a single snapshot from the camera, persist it to the appropriate
   * /userdata/snapshots/{alarm|motion}/ directory, and notify listeners.
   */
  private async captureOne(zoneId: string, camera: ZoneCameraEntry, isAlarm: boolean): Promise<void> {
    try {
      // camera.imageUrl is extracted from device.images[0].url in refreshZoneCache().
      // HomeyAPIV3Local.ManagerImages only has getImages() (plural) and Image objects are plain
      // JSON stubs without getStream(). We therefore fetch the JPEG directly via the Homey
      // local HTTP API using the owner token.
      const { imageUrl } = camera;
      if (!imageUrl) return;

      const { baseUrl, token } = await this.getApiCredentials();
      const fullUrl = imageUrl.startsWith('http') ? imageUrl : `${baseUrl}${imageUrl}`;

      const response = await fetch(fullUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        this.log.add('warning', `Snapshot: HTTP ${response.status} fra kamera ${camera.name} (${fullUrl}).`, zoneId);
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        this.log.add('warning', `Snapshot: tom buffer fra ${camera.name} — ingen data fra kamera.`, zoneId);
        return;
      }

      // Route to alarm or motion directory.
      const dir = isAlarm ? SNAPSHOT_DIR_ALARM : SNAPSHOT_DIR_MOTION;

      // Build a filename: <timestamp>-<8-byte-hex>.jpg
      // The timestamp prefix enables chronological sorting; the hex suffix prevents guessing.
      const timestamp = Date.now();
      const hex = crypto.randomBytes(8).toString('hex');
      const filename = `${timestamp}-${hex}.jpg`;
      const filepath = path.join(dir, filename);

      // Write to disk (sync — file is small, keeps error handling simple).
      fs.writeFileSync(filepath, buffer);
      this.log.add('info', `Snapshot lagret: ${camera.name} i sone ${zoneId} (${isAlarm ? 'alarm' : 'bevegelse'}, ${buffer.length} B).`, zoneId);

      // FIFO cleanup: remove oldest files if we exceed the per-category limit.
      const maxCount = this.getSettings().snapshot_max_count ?? SNAPSHOT_MAX_COUNT_DEFAULT;
      this.cleanupSnapshots(dir, maxCount);

      // Create a native Homey Image that points to the persisted file.
      // This allows flow actions (Telegram, Dropbox, etc.) to fetch it even after capture.
      const flowImage = await (this.homey.images as any).createImage();
      flowImage.setPath(filepath);

      for (const listener of this.listeners) {
        try { listener(zoneId, camera.id, camera.name || zoneId, flowImage); } catch { /* best-effort */ }
      }

      // Unregister the in-memory Image object after 60 s.
      // The file itself stays on disk until FIFO cleanup removes it.
      this.homey.setTimeout(() => {
        (this.homey.images as any).unregisterImage(flowImage).catch(() => { /* best-effort */ });
      }, 60_000);
    } catch (err) {
      this.log.add('warning', `Snapshot-kall feilet for ${camera.name || camera.id}: ${(err as Error).message}`, zoneId);
    }
  }

  /**
   * Resolve and cache the Homey local base URL and owner API token.
   * Both values are stable for the lifetime of the app process.
   */
  private async getApiCredentials(): Promise<{ baseUrl: string; token: string }> {
    if (!this.cachedBaseUrl) {
      const raw: string = await (this.homey as any).api.getLocalUrl();
      this.cachedBaseUrl = raw.replace(/\/$/, '');
    }
    if (!this.cachedToken) {
      this.cachedToken = await (this.homey as any).api.getOwnerApiToken() as string;
    }
    return { baseUrl: this.cachedBaseUrl, token: this.cachedToken };
  }

  /**
   * Remove the oldest snapshot files from `dir` so that no more than `maxCount` remain.
   * Files are sorted by filename (timestamp prefix guarantees chronological order).
   */
  private cleanupSnapshots(dir: string, maxCount: number): void {
    try {
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jpg'))
        .sort(); // timestamp prefix → oldest first

      const excess = files.length - maxCount;
      for (let i = 0; i < excess; i += 1) {
        try { fs.unlinkSync(path.join(dir, files[i])); } catch { /* best-effort */ }
      }
    } catch (err) {
      this.log.add('warning', `Snapshot-opprydding feilet (${dir}): ${(err as Error).message}`);
    }
  }

  /** Ensure both snapshot directories exist on the Homey Pro filesystem. */
  private ensureSnapshotDirs(): void {
    for (const dir of [SNAPSHOT_DIR_ALARM, SNAPSHOT_DIR_MOTION]) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      } catch (err) {
        this.log.add('warning', `Kunne ikke opprette snapshot-katalog ${dir}: ${(err as Error).message}`);
      }
    }
  }

}
