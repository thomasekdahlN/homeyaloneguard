'use strict';

import Homey from 'homey';
import { HomeyAPI } from 'homey-api';
import EventLog from './lib/EventLog';
import StateMachine from './lib/StateMachine';
import LightAuthGuard from './lib/LightAuthGuard';
import MediaCaster from './lib/MediaCaster';
import DeterrenceEngine from './lib/DeterrenceEngine';
import FalseAlarmFilter from './lib/FalseAlarmFilter';
import EscalationManager from './lib/EscalationManager';
import SimulationEngine from './lib/SimulationEngine';
import CameraManager from './lib/CameraManager';
import {
  DEFAULT_SETTINGS, GuardSettings, Mode, SETTINGS_KEYS,
} from './lib/types';

class McCallisterGuardApp extends Homey.App {

  public homeyApi!: any;
  public eventLog!: EventLog;
  public stateMachine!: StateMachine;
  public lightAuth!: LightAuthGuard;
  public media!: MediaCaster;
  public deterrence!: DeterrenceEngine;
  public falseAlarm!: FalseAlarmFilter;
  public escalation!: EscalationManager;
  public simulation!: SimulationEngine;
  public cameras!: CameraManager;

  private testStopTimer: NodeJS.Timeout | null = null;
  private motionLastSeen = new Map<string, number>();
  private alarmActive = false;
  private alarmContext: { zoneId: string; zoneName: string; deviceId: string; deviceName: string; sensorType: string } | null = null;
  private static readonly TEST_DURATION_MS = 15_000;
  private static readonly MOTION_RECENT_MS = 60_000;

  async onInit(): Promise<void> {
    this.log('McCallister Guard starter opp…');

    this.homeyApi = await (HomeyAPI as any).createAppAPI({ homey: this.homey });

    this.eventLog = new EventLog(this.homey);
    this.stateMachine = new StateMachine(this.homey, this.eventLog);
    this.lightAuth = new LightAuthGuard(this.homeyApi, this.eventLog);
    this.media = new MediaCaster(this.homey, this.homeyApi, this.eventLog, this.lightAuth);
    this.deterrence = new DeterrenceEngine(this.homey, this.eventLog, this.media, () => this.getSettings());
    this.falseAlarm = new FalseAlarmFilter();
    this.escalation = new EscalationManager(this.homey, this.homeyApi, this.eventLog, this.lightAuth);
    this.simulation = new SimulationEngine(this.homey, this.homeyApi, this.eventLog, this.lightAuth, () => this.getSettings());
    this.cameras = new CameraManager(this.homey, this.homeyApi, this.eventLog);

    this.lightAuth.setActivePredicate(() => {
      if (this.stateMachine.getMode() === 'disarmed') return false;
      if (this.isTestActive()) return false;
      return this.deterrence.getActiveZone() !== null;
    });

    this.stateMachine.onModeChange((next, previous) => this.handleModeChange(next, previous));
    this.deterrence.onDeterrenceStarted((reactionZoneId, motionZoneId) => {
      this.cameras.startForZone(motionZoneId);
      const card = this.homey.flow.getTriggerCard('deterrence_started');
      card.trigger({ zone: reactionZoneId }).catch(() => { /* best-effort */ });
    });
    this.escalation.onCrisis(() => {
      const card = this.homey.flow.getTriggerCard('alarm_escalated');
      card.trigger({}).catch(() => { /* best-effort */ });
    });

    await this.registerFlowActions();
    await this.initListeners();

    if (this.stateMachine.getMode() === 'armed_away') this.simulation.start();
    this.log('McCallister Guard initialisert.');
  }

  getSettings(): GuardSettings {
    const stored = this.homey.settings.get(SETTINGS_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  saveSettings(settings: Partial<GuardSettings>): GuardSettings {
    const merged: GuardSettings = { ...this.getSettings(), ...settings };
    this.homey.settings.set(SETTINGS_KEYS.SETTINGS, merged);
    return merged;
  }

  async setMode(mode: Mode): Promise<void> {
    const settings = this.getSettings();
    if (mode === 'disarmed') {
      this.clearTestStopTimer();
      this.stateMachine.cancelEntryDelay();
      this.falseAlarm.reset();
      this.escalation.cancel();
      this.simulation.stop();
      this.cameras.stopAll();
      await this.deterrence.abort('Bruker deaktiverte systemet.');
      this.fireAlarmStopped('System deaktivert.');
    }
    await this.stateMachine.setMode(mode, mode === 'armed_away' ? settings.exit_delay : 0);
  }

  async triggerPanic(): Promise<void> {
    this.eventLog.add('critical', 'PANIKK utløst manuelt.');
    const settings = this.getSettings();
    await this.fireAlarmTriggered('__all__', '__panic__', 'panic');
    this.escalation.start(0);
    await this.media.startSiren('__all__', settings.custom_audio_url);
  }

  async testDeterrence(zoneId: string): Promise<void> {
    this.clearTestStopTimer();
    const seconds = Math.round(McCallisterGuardApp.TEST_DURATION_MS / 1000);
    this.eventLog.add('info', `Test: kjører avskrekking direkte i sone ${zoneId} (auto-stopp om ${seconds}s).`, zoneId);
    await this.deterrence.runDirect(zoneId);
    this.testStopTimer = this.homey.setTimeout(() => {
      this.testStopTimer = null;
      this.deterrence.abort('Test ferdig (auto-stopp).').catch(() => { /* best-effort */ });
    }, McCallisterGuardApp.TEST_DURATION_MS);
  }

  isTestActive(): boolean {
    return this.testStopTimer !== null;
  }

  isAlarmActive(): boolean {
    return this.alarmActive;
  }

  getRecentMotionZones(): string[] {
    const cutoff = Date.now() - McCallisterGuardApp.MOTION_RECENT_MS;
    const result: string[] = [];
    for (const [zoneId, ts] of this.motionLastSeen) {
      if (ts >= cutoff) result.push(zoneId);
    }
    return result;
  }

  async stopAlarm(): Promise<void> {
    this.eventLog.add('info', 'Bruker stoppet alarm manuelt.');
    this.clearTestStopTimer();
    this.stateMachine.cancelEntryDelay();
    this.escalation.cancel();
    this.falseAlarm.reset();
    this.cameras.stopAll();
    await this.deterrence.abort('Bruker stoppet alarmen.');
    this.fireAlarmStopped('Bruker stoppet alarm.');
  }

  private async fireAlarmTriggered(zoneId: string, deviceId: string, sensorType: 'motion' | 'contact' | 'panic'): Promise<void> {
    if (this.alarmActive) return;
    const { zoneName, deviceName } = await this.resolveNames(zoneId, deviceId);
    this.alarmActive = true;
    this.alarmContext = {
      zoneId, zoneName, deviceId, deviceName, sensorType,
    };
    this.eventLog.add('alarm', `ALARM utløst i ${zoneName} (sensor: ${deviceName}, type: ${sensorType}).`, zoneId, deviceId);
    try {
      await this.homey.flow.getTriggerCard('alarm_triggered').trigger({
        zone: zoneName,
        sensor: deviceName,
        sensor_type: sensorType,
        mode: this.stateMachine.getMode(),
        timestamp: new Date().toISOString(),
      });
    } catch { /* best-effort */ }
  }

  private fireAlarmStopped(reason: string): void {
    if (!this.alarmActive) return;
    const ctx = this.alarmContext;
    this.alarmActive = false;
    this.alarmContext = null;
    try {
      this.homey.flow.getTriggerCard('alarm_stopped').trigger({
        zone: ctx?.zoneName ?? '',
        sensor: ctx?.deviceName ?? '',
        reason,
      }).catch(() => { /* best-effort */ });
    } catch { /* best-effort */ }
  }

  private async resolveNames(zoneId: string, deviceId: string): Promise<{ zoneName: string; deviceName: string }> {
    let zoneName = zoneId;
    let deviceName = deviceId;
    try {
      const zones = await this.homeyApi.zones.getZones();
      zoneName = (zones as any)[zoneId]?.name ?? zoneId;
    } catch { /* best-effort */ }
    try {
      const device = await this.homeyApi.devices.getDevice({ id: deviceId });
      deviceName = (device as any)?.name ?? deviceId;
    } catch { /* best-effort */ }
    return { zoneName, deviceName };
  }

  private clearTestStopTimer(): void {
    if (this.testStopTimer) {
      this.homey.clearTimeout(this.testStopTimer);
      this.testStopTimer = null;
    }
  }

  private handleModeChange(next: Mode, previous: Mode): void {
    if (next === 'armed_away') {
      this.simulation.start();
    } else {
      this.simulation.stop();
    }
    if (next !== 'disarmed' && previous === 'disarmed') {
      this.runHealthCheck().catch(() => { /* best-effort */ });
    }
    try {
      this.homey.flow.getTriggerCard('mode_changed').trigger({
        mode_new: next,
        mode_previous: previous,
      }).catch(() => { /* best-effort */ });
    } catch { /* best-effort */ }
  }

  private async runHealthCheck(): Promise<void> {
    try {
      const devices = await this.homeyApi.devices.getDevices();
      const sensors = Object.values(devices).filter((d: any) => Array.isArray(d.capabilities)
        && (d.capabilities.includes('alarm_motion') || d.capabilities.includes('alarm_contact')));
      const offline: string[] = [];
      for (const s of sensors as any[]) {
        if (s.available === false) offline.push(s.name || s.id);
      }
      if (offline.length > 0) {
        const msg = `Aktivert, men ${offline.length} sensor(er) rapporterer ikke: ${offline.join(', ')}`;
        this.eventLog.add('warning', msg);
        await this.homey.notifications.createNotification({ excerpt: `⚠️ ${msg}` });
        const card = this.homey.flow.getTriggerCard('health_check_failed');
        card.trigger({ offline_count: offline.length }).catch(() => { /* best-effort */ });
      }
    } catch (err) {
      this.eventLog.add('warning', `Helsesjekk feilet: ${(err as Error).message}`);
    }
  }

  private async registerFlowActions(): Promise<void> {
    this.homey.flow.getActionCard('set_mode')
      .registerRunListener(async (args: { mode: Mode }) => {
        await this.setMode(args.mode);
        return true;
      });
    this.homey.flow.getActionCard('trigger_panic')
      .registerRunListener(async () => {
        await this.triggerPanic();
        return true;
      });
    this.homey.flow.getConditionCard('is_armed')
      .registerRunListener(async (args: { mode: Mode }) => this.stateMachine.getMode() === args.mode);
    this.homey.flow.getConditionCard('deterrence_active')
      .registerRunListener(async () => this.deterrence.getActiveZone() !== null);
    this.homey.flow.getConditionCard('alarm_active')
      .registerRunListener(async () => this.alarmActive);
  }

  private async initListeners(): Promise<void> {
    const devices = await this.homeyApi.devices.getDevices();
    for (const device of Object.values(devices) as any[]) {
      if (!Array.isArray(device.capabilities)) continue;
      if (device.capabilities.includes('alarm_motion')) {
        device.makeCapabilityInstance('alarm_motion', (value: unknown) => {
          if (value === true) this.onMotion(device.zone, device.id).catch(() => { /* best-effort */ });
        });
      }
      if (device.capabilities.includes('alarm_contact')) {
        device.makeCapabilityInstance('alarm_contact', (value: unknown) => {
          if (value === true) this.onContact(device.zone, device.id).catch(() => { /* best-effort */ });
        });
      }
      if (device.capabilities.includes('onoff') && !device.capabilities.includes('alarm_motion')) {
        device.makeCapabilityInstance('onoff', (value: unknown) => {
          if (typeof value === 'boolean') {
            this.lightAuth.handleOnOffChange(device.id, value).catch(() => { /* best-effort */ });
          }
        });
      }
    }
  }

  private isPerimeterSensor(deviceId: string): boolean {
    const list = this.getSettings().perimeter_sensors ?? [];
    if (list.length === 0) return true;
    return list.includes(deviceId);
  }

  private async onMotion(zoneId: string, deviceId: string): Promise<void> {
    this.motionLastSeen.set(zoneId, Date.now());
    const mode = this.stateMachine.getMode();
    if (mode === 'disarmed') return;
    if (this.stateMachine.isExitDelayActive()) return;
    this.eventLog.add('info', `Bevegelse i sone ${zoneId}.`, zoneId, deviceId);

    if (mode === 'armed_stay') {
      if (!this.isPerimeterSensor(deviceId)) return;
      await this.fireAlarmTriggered(zoneId, deviceId, 'motion');
      await this.deterrence.handleMotion(zoneId);
      this.escalation.start(0);
      return;
    }

    if (!this.stateMachine.isEntryDelayActive()) {
      const settings = this.getSettings();
      this.eventLog.add('info', `Inngangsforsinkelse startet (${settings.entry_delay}s) — deaktiver for å avbryte.`, zoneId);
      this.stateMachine.startEntryDelay(settings.entry_delay, () => {
        if (this.stateMachine.getMode() === 'disarmed') return;
        this.handleConfirmedMotion(zoneId, deviceId, 'motion').catch(() => { /* best-effort */ });
      });
    } else {
      await this.handleConfirmedMotion(zoneId, deviceId, 'motion');
    }
  }

  private async onContact(zoneId: string, deviceId: string): Promise<void> {
    const mode = this.stateMachine.getMode();
    if (mode === 'disarmed') return;
    this.eventLog.add('warning', `Dør/vindu åpnet i sone ${zoneId}.`, zoneId, deviceId);

    if (mode === 'armed_stay') {
      if (!this.isPerimeterSensor(deviceId)) return;
      await this.fireAlarmTriggered(zoneId, deviceId, 'contact');
      this.escalation.start(0);
      return;
    }
    this.falseAlarm.registerContactOpen();
    await this.handleConfirmedMotion(zoneId, deviceId, 'contact');
  }

  private async handleConfirmedMotion(zoneId: string, deviceId: string, sensorType: 'motion' | 'contact'): Promise<void> {
    if (this.stateMachine.getMode() === 'disarmed') return;
    await this.fireAlarmTriggered(zoneId, deviceId, sensorType);
    await this.deterrence.handleMotion(zoneId);
    const confirmed = this.falseAlarm.registerMotion(zoneId);
    if (confirmed && !this.escalation.isPending() && !this.escalation.isInCrisis()) {
      this.escalation.start(this.getSettings().escalation_minutes);
    }
  }

}

module.exports = McCallisterGuardApp;
