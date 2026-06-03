'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { GuardSettings, Mode } from './lib/types';
import { SNAPSHOT_DIR_ALARM, SNAPSHOT_DIR_MOTION } from './lib/types';
import { classify, isCamera, sensorType } from './lib/Capabilities';
import type { SensorType } from './lib/Capabilities';

/** Snapshot metadata returned by getSnapshotList. */
interface SnapshotMeta {
  filename: string;
  timestamp: number;
  size: number;
}

/** Builds a sorted (newest-first) list of snapshot metadata from a directory. */
function listSnapshotDir(dir: string): SnapshotMeta[] {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^[0-9]+-[0-9a-f]+\.jpg$/i.test(f))
      .map((filename) => {
        const timestamp = parseInt(filename.split('-')[0], 10);
        let size = 0;
        try { size = fs.statSync(path.join(dir, filename)).size; } catch { /* best-effort */ }
        return { filename, timestamp, size };
      })
      .sort((a, b) => b.timestamp - a.timestamp); // newest first
  } catch {
    return [];
  }
}

interface AppRef {
  getSettings(): GuardSettings;
  saveSettings(settings: Partial<GuardSettings>): GuardSettings;
  setMode(mode: Mode, options?: { force?: boolean }): Promise<void>;
  testDeterrence(zoneId: string): Promise<void>;
  testAlarm(): Promise<void>;
  stopAlarm(): Promise<void>;
  setCameraMotionEnabled(enabled: boolean): void;
  bypassPerimeter(seconds: number): void;
  isPerimeterBypassed(): boolean;
  getPerimeterBypassEndsAt(): number | null;
  isTestActive(): boolean;
  isAlarmActive(): boolean;
  getRecentMotionZones(): string[];
  homeyApi: any;
  stateMachine: {
    getMode(): Mode;
    getModeChangedAt(): number;
    isExitDelayActive(): boolean;
    isEntryDelayActive(): boolean;
    getExitDelayEndsAt(): number | null;
    getExitDelayTarget(): Mode | null;
    getEntryDelayEndsAt(): number | null;
  };
  deterrence: { getActiveZone(): string | null; getActiveMotionZone(): string | null };
  eventLog: { recent(limit?: number): unknown[]; clear(): void };
  escalation: { isInCrisis(): boolean; isPending(): boolean };
  simulation: { isRunning(): boolean };
}

interface Ctx { homey: { app: AppRef } }
interface BodyCtx<T> extends Ctx { body: T }

module.exports = {

  async getStatus({ homey }: Ctx) {
    const { app } = homey;
    return {
      mode: app.stateMachine.getMode(),
      modeChangedAt: app.stateMachine.getModeChangedAt(),
      exitDelayActive: app.stateMachine.isExitDelayActive(),
      exitDelayEndsAt: app.stateMachine.getExitDelayEndsAt(),
      exitDelayTarget: app.stateMachine.getExitDelayTarget(),
      entryDelayActive: app.stateMachine.isEntryDelayActive(),
      entryDelayEndsAt: app.stateMachine.getEntryDelayEndsAt(),
      activeDeterrenceZone: app.deterrence.getActiveZone(),
      activeMotionZone: app.deterrence.getActiveMotionZone(),
      simulationRunning: app.simulation.isRunning(),
      escalationPending: app.stateMachine.getMode() === 'deterrence',
      inCrisis: app.escalation.isInCrisis(),
      testActive: app.isTestActive(),
      alarmActive: app.isAlarmActive(),
      recentMotionZones: app.getRecentMotionZones(),
      cameraMotionEnabled: app.getSettings().camera_motion_enabled !== false,
      perimeterBypassed: app.isPerimeterBypassed(),
      perimeterBypassEndsAt: app.getPerimeterBypassEndsAt(),
    };
  },

  async getEventLog({ homey }: Ctx) {
    return homey.app.eventLog.recent();
  },

  async clearEventLog({ homey }: Ctx) {
    homey.app.eventLog.clear();
    return { success: true };
  },

  async getZones({ homey }: Ctx) {
    const [zones, devices] = await Promise.all([
      homey.app.homeyApi.zones.getZones(),
      homey.app.homeyApi.devices.getDevices(),
    ]);
    type ZoneSensor = { id: string; name: string; type: SensorType };
    type ZoneCamera = { id: string; name: string };
    type ZoneCaps = {
      hasAudio: boolean; hasVideo: boolean; hasLights: boolean; hasCameras: boolean;
      audioDevices: string[]; videoDevices: string[]; lightDevices: string[];
      cameras: ZoneCamera[];
      sensors: ZoneSensor[];
    };
    const caps: Record<string, ZoneCaps> = {};
    for (const d of Object.values(devices) as any[]) {
      if (!d.zone) continue;
      const c = caps[d.zone] ?? (caps[d.zone] = {
        hasAudio: false,
        hasVideo: false,
        hasLights: false,
        hasCameras: false,
        audioDevices: [],
        videoDevices: [],
        lightDevices: [],
        cameras: [],
        sensors: [],
      });
      const k = classify(d);
      const name = String(d.name ?? d.id ?? '');
      if (k.isAudio) { c.hasAudio = true; c.audioDevices.push(name); }
      if (k.isVideo) { c.hasVideo = true; c.videoDevices.push(name); }
      if (k.isLight) { c.hasLights = true; c.lightDevices.push(name); }
      if (isCamera(d)) { c.hasCameras = true; c.cameras.push({ id: String(d.id), name }); }
      const st = sensorType(d);
      if (st) c.sensors.push({ id: String(d.id), name, type: st });
    }
    return Object.values(zones).map((z: any) => {
      const c = caps[z.id];
      return {
        id: z.id,
        name: z.name,
        parent: z.parent ?? null,
        hasAudio: c?.hasAudio ?? false,
        hasVideo: c?.hasVideo ?? false,
        hasLights: c?.hasLights ?? false,
        hasCameras: c?.hasCameras ?? false,
        audioDevices: c?.audioDevices ?? [],
        videoDevices: c?.videoDevices ?? [],
        lightDevices: c?.lightDevices ?? [],
        cameras: c?.cameras ?? [],
        sensors: c?.sensors ?? [],
      };
    });
  },

  async getSettings({ homey }: Ctx) {
    return homey.app.getSettings();
  },

  async setSettings({ homey, body }: BodyCtx<Partial<GuardSettings>>) {
    return homey.app.saveSettings(body);
  },

  async setMode({ homey, body }: BodyCtx<{ mode: Mode }>) {
    try {
      // Dashboard actions are explicit user intent — always bypass guards (force=true).
      await homey.app.setMode(body.mode, { force: true });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  async testDeterrence({ homey, body }: BodyCtx<{ zoneId: string }>) {
    await homey.app.testDeterrence(body.zoneId);
    return { success: true };
  },

  async testAlarm({ homey }: Ctx) {
    await homey.app.testAlarm();
    return { success: true };
  },

  async stopAlarm({ homey }: Ctx) {
    await homey.app.stopAlarm();
    return { success: true };
  },

  async setCameraMotion({ homey, body }: BodyCtx<{ enabled: boolean }>) {
    homey.app.setCameraMotionEnabled(body.enabled);
    return { success: true };
  },

  async bypassPerimeter({ homey, body }: BodyCtx<{ duration: number }>) {
    homey.app.bypassPerimeter(Math.max(5, Math.round(body.duration ?? 60)));
    return { success: true };
  },

  /** GET /snapshot-list — returns metadata for all stored snapshots, split by type. */
  async getSnapshotList(_ctx: Ctx) {
    return {
      alarm: listSnapshotDir(SNAPSHOT_DIR_ALARM),
      motion: listSnapshotDir(SNAPSHOT_DIR_MOTION),
    };
  },

  /**
   * GET /snapshot-image — returns the raw JPEG as a base64 string.
   * Body/query params: { type: 'alarm' | 'motion', filename: string }
   */
  async getSnapshotImage(_ctx: Ctx & { query: { type?: string; filename?: string } }) {
    const { type, filename } = (_ctx as any).query ?? {};
    if ((type !== 'alarm' && type !== 'motion') || !filename) {
      throw new Error('Ugyldig type eller filnavn.');
    }
    // Prevent path traversal: filename must be a plain basename.
    if (path.basename(filename) !== filename || !/^[0-9]+-[0-9a-f]+\.jpg$/i.test(filename)) {
      throw new Error('Ugyldig filnavn.');
    }
    const dir = type === 'alarm' ? SNAPSHOT_DIR_ALARM : SNAPSHOT_DIR_MOTION;
    const filepath = path.join(dir, filename);
    const buffer = fs.readFileSync(filepath);
    return { data: buffer.toString('base64') };
  },

  /**
   * DELETE /snapshots — deletes snapshot files.
   * Body: { type: 'alarm' | 'motion' | 'all' }
   */
  async deleteSnapshots(_ctx: Ctx & { body: { type?: string } }) {
    const { type } = (_ctx as any).body ?? {};
    const dirs: string[] = [];
    if (type === 'alarm' || type === 'all') dirs.push(SNAPSHOT_DIR_ALARM);
    if (type === 'motion' || type === 'all') dirs.push(SNAPSHOT_DIR_MOTION);
    if (dirs.length === 0) throw new Error('Ugyldig type. Bruk alarm, motion eller all.');

    let deleted = 0;
    for (const dir of dirs) {
      try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg'));
        for (const f of files) {
          try { fs.unlinkSync(path.join(dir, f)); deleted += 1; } catch { /* best-effort */ }
        }
      } catch { /* dir may not exist */ }
    }
    return { success: true, deleted };
  },

};
