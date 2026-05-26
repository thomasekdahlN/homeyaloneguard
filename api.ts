'use strict';

import type { GuardSettings, Mode } from './lib/types';
import { classify, sensorType } from './lib/Capabilities';
import type { SensorType } from './lib/Capabilities';

interface AppRef {
  getSettings(): GuardSettings;
  saveSettings(settings: Partial<GuardSettings>): GuardSettings;
  setMode(mode: Mode): Promise<void>;
  triggerPanic(): Promise<void>;
  testDeterrence(zoneId: string): Promise<void>;
  stopAlarm(): Promise<void>;
  isTestActive(): boolean;
  isAlarmActive(): boolean;
  getRecentMotionZones(): string[];
  homeyApi: any;
  stateMachine: { getMode(): Mode; getModeChangedAt(): number };
  deterrence: { getActiveZone(): string | null; getActiveMotionZone(): string | null };
  eventLog: { recent(limit?: number): unknown[] };
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
      activeDeterrenceZone: app.deterrence.getActiveZone(),
      activeMotionZone: app.deterrence.getActiveMotionZone(),
      simulationRunning: app.simulation.isRunning(),
      escalationPending: app.escalation.isPending(),
      inCrisis: app.escalation.isInCrisis(),
      testActive: app.isTestActive(),
      alarmActive: app.isAlarmActive(),
      recentMotionZones: app.getRecentMotionZones(),
    };
  },

  async getEventLog({ homey }: Ctx) {
    return homey.app.eventLog.recent();
  },

  async getZones({ homey }: Ctx) {
    const [zones, devices] = await Promise.all([
      homey.app.homeyApi.zones.getZones(),
      homey.app.homeyApi.devices.getDevices(),
    ]);
    type ZoneSensor = { id: string; name: string; type: SensorType };
    type ZoneCaps = {
      hasAudio: boolean; hasVideo: boolean; hasLights: boolean;
      audioDevices: string[]; videoDevices: string[]; lightDevices: string[];
      sensors: ZoneSensor[];
    };
    const caps: Record<string, ZoneCaps> = {};
    for (const d of Object.values(devices) as any[]) {
      if (!d.zone) continue;
      const c = caps[d.zone] ?? (caps[d.zone] = {
        hasAudio: false,
        hasVideo: false,
        hasLights: false,
        audioDevices: [],
        videoDevices: [],
        lightDevices: [],
        sensors: [],
      });
      const k = classify(d);
      const name = String(d.name ?? d.id ?? '');
      if (k.isAudio) { c.hasAudio = true; c.audioDevices.push(name); }
      if (k.isVideo) { c.hasVideo = true; c.videoDevices.push(name); }
      if (k.isLight) { c.hasLights = true; c.lightDevices.push(name); }
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
        audioDevices: c?.audioDevices ?? [],
        videoDevices: c?.videoDevices ?? [],
        lightDevices: c?.lightDevices ?? [],
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
    await homey.app.setMode(body.mode);
    return { success: true };
  },

  async triggerPanic({ homey }: Ctx) {
    await homey.app.triggerPanic();
    return { success: true };
  },

  async testDeterrence({ homey, body }: BodyCtx<{ zoneId: string }>) {
    await homey.app.testDeterrence(body.zoneId);
    return { success: true };
  },

  async stopAlarm({ homey }: Ctx) {
    await homey.app.stopAlarm();
    return { success: true };
  },

};
