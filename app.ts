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
import { isLight } from './lib/Capabilities';
import {
  AlarmType, DEFAULT_SETTINGS, GuardSettings, Mode, SETTINGS_KEYS,
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
  private armedStaySchedulerTimer: NodeJS.Timeout | null = null;
  private lastArmedStayWindowState: boolean | null = null;
  private deterrenceTimer: NodeJS.Timeout | null = null;
  private previousArmedMode: 'armed_stay' | 'armed_away' | null = null;
  private motionLastSeen = new Map<string, number>();
  private perimeterBypassEndsAt: number | null = null;
  private perimeterBypassTimer: NodeJS.Timeout | null = null;
  private alarmContext: { zoneId: string; zoneName: string; deviceId: string; deviceName: string; sensorType: string; alarmType: AlarmType } | null = null;
  private zoneNameCache = new Map<string, string>();
  private zoneCacheTimer: NodeJS.Timeout | null = null;
  private static readonly TEST_DURATION_MS = 15_000;
  private static readonly MOTION_RECENT_MS = 60_000;
  private static readonly ZONE_CACHE_REFRESH_MS = 60_000;
  async onInit(): Promise<void> {
    this.log('McCallister Guard starter opp…');

    this.homeyApi = await (HomeyAPI as any).createAppAPI({ homey: this.homey });

    this.eventLog = new EventLog(this.homey);
    this.eventLog.setZoneNameResolver((id) => this.zoneNameCache.get(id));
    await this.refreshZoneNameCache();
    this.zoneCacheTimer = this.homey.setInterval(
      () => { this.refreshZoneNameCache().catch(() => { /* best-effort */ }); },
      McCallisterGuardApp.ZONE_CACHE_REFRESH_MS,
    );
    this.stateMachine = new StateMachine(this.homey, this.eventLog);
    this.lightAuth = new LightAuthGuard(this.homeyApi, this.eventLog);
    this.media = new MediaCaster(this.homey, this.homeyApi, this.eventLog, this.lightAuth, () => this.getSettings());
    this.deterrence = new DeterrenceEngine(this.homey, this.eventLog, this.media, () => this.getSettings());
    this.falseAlarm = new FalseAlarmFilter();
    this.escalation = new EscalationManager(this.homey, this.homeyApi, this.eventLog, this.lightAuth);
    this.simulation = new SimulationEngine(this.homey, this.homeyApi, this.eventLog, this.lightAuth, () => this.getSettings());
    this.cameras = new CameraManager(this.homey, this.homeyApi, this.eventLog, () => this.getSettings());

    // Before an alarm-burst, turn on all lights in the motion zone so the camera captures a lit scene.
    this.cameras.setFlashCallback(async (zoneId: string) => {
      const devices = await this.homeyApi.devices.getDevices();
      const lights = (Object.values(devices) as any[]).filter((d) => d.zone === zoneId && isLight(d));
      for (const light of lights) {
        try {
          this.lightAuth.registerOwnCommand(light.id, true);
          await light.setCapabilityValue({ capabilityId: 'onoff', value: true });
        } catch { /* best-effort */ }
      }
    });

    this.lightAuth.setActivePredicate(() => {
      // Guard lights only while armed (not during deterrence/alarm — app controls lights then)
      const m = this.stateMachine.getMode();
      return m === 'armed_stay' || m === 'armed_away';
    });

    this.stateMachine.onModeChange((next, previous) => this.handleModeChange(next, previous));
    this.deterrence.onDeterrenceStarted((reactionZoneId, motionZoneId) => {
      const reactionName = this.zoneNameCache.get(reactionZoneId) ?? reactionZoneId;
      const motionName = this.zoneNameCache.get(motionZoneId) ?? motionZoneId;
      this.pushTimeline(`Avskrekking startet i ${reactionName} (bevegelse i ${motionName}).`);
    });
    this.cameras.onSnapshot((zoneId, _cameraId, cameraName, snapshotImage) => {
      const zoneName = this.zoneNameCache.get(zoneId) ?? zoneId;
      const tokens = {
        zone: zoneName,
        sensor: cameraName,
        sensor_type: 'camera',
        mode: this.stateMachine.getMode(),
        timestamp: new Date().toISOString(),
        snapshot: snapshotImage,
      };
      this.homey.flow.getTriggerCard('snapshot_taken').trigger(tokens)
        .then(() => {
          this.eventLog.add('info', `Flow-trigger «snapshot_taken» fyrt for ${cameraName} i sone ${zoneName}.`, zoneId);
        })
        .catch((err) => {
          this.eventLog.add('warning', `Flow-trigger «snapshot_taken» feilet: ${(err as Error).message}`, zoneId);
        });
    });

    await this.registerFlowActions();
    await this.initListeners();

    if (this.stateMachine.getMode() === 'armed_away') this.simulation.start();
    this.startArmedStayScheduler();
    this.log('McCallister Guard initialisert.');
  }

  getSettings(): GuardSettings {
    const stored = this.homey.settings.get(SETTINGS_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  saveSettings(settings: Partial<GuardSettings>): GuardSettings {
    const merged: GuardSettings = { ...this.getSettings(), ...settings };
    this.homey.settings.set(SETTINGS_KEYS.SETTINGS, merged);
    // Refresh the camera-zone cache so added/removed cameras are reflected immediately.
    this.cameras?.refreshZoneCache().catch(() => { /* best-effort */ });
    return merged;
  }

  async setMode(mode: Mode): Promise<void> {
    if (this.stateMachine.getMode() === mode && !this.stateMachine.isExitDelayActive()) return;
    const settings = this.getSettings();
    if (mode === 'disarmed') {
      this.clearTestStopTimer();
      this.clearDeterrenceTimer();
      this.stateMachine.cancelEntryDelay();
      this.falseAlarm.reset();
      this.escalation.cancel();
      this.simulation.stop();
      await this.deterrence.abort('Bruker deaktiverte systemet.');
      await this.media.stopAll();
      this.previousArmedMode = null;
      this.alarmContext = null;
    }
    await this.stateMachine.setMode(mode, mode === 'armed_away' ? settings.exit_delay : 0);
  }

  async testDeterrence(zoneId: string): Promise<void> {
    this.clearTestStopTimer();
    this.clearDeterrenceTimer();
    const seconds = Math.round(McCallisterGuardApp.TEST_DURATION_MS / 1000);
    this.eventLog.add('info', `Test: avskrekking i sone ${zoneId} — auto-stopp om ${seconds}s.`, zoneId);
    const currentMode = this.stateMachine.getMode();
    if (currentMode !== 'deterrence' && currentMode !== 'alarm') {
      this.previousArmedMode = currentMode !== 'disarmed' ? currentMode as 'armed_stay' | 'armed_away' : null;
    }
    if (this.stateMachine.getMode() !== 'deterrence') {
      await this.stateMachine.setMode('deterrence');
    }
    await this.deterrence.runDirect(zoneId);
    this.testStopTimer = this.homey.setTimeout(async () => {
      this.testStopTimer = null;
      await this.deterrence.abort('Test ferdig (auto-stopp).');
      await this.media.stopAll();
      const returnMode = this.previousArmedMode ?? 'disarmed';
      this.previousArmedMode = null;
      await this.stateMachine.setMode(returnMode);
    }, McCallisterGuardApp.TEST_DURATION_MS);
  }

  async testAlarm(): Promise<void> {
    this.clearTestStopTimer();
    this.clearDeterrenceTimer();
    const seconds = Math.round(McCallisterGuardApp.TEST_DURATION_MS / 1000);
    this.eventLog.add('info', `Test: full alarm (modus=alarm) — auto-stopp om ${seconds}s.`);
    const currentMode = this.stateMachine.getMode();
    if (currentMode !== 'deterrence' && currentMode !== 'alarm') {
      this.previousArmedMode = currentMode !== 'disarmed' ? currentMode as 'armed_stay' | 'armed_away' : null;
    }
    await this.deterrence.abort('Test alarm — avskrekking avbrutt.');
    await this.stateMachine.setMode('alarm');
    await this.escalation.triggerCrisis();
    this.testStopTimer = this.homey.setTimeout(async () => {
      this.testStopTimer = null;
      this.escalation.cancel();
      await this.media.stopAll();
      this.alarmStopped('Test alarm ferdig (auto-stopp).');
      const returnMode = this.previousArmedMode ?? 'disarmed';
      this.previousArmedMode = null;
      this.alarmContext = null;
      await this.stateMachine.setMode(returnMode);
    }, McCallisterGuardApp.TEST_DURATION_MS);
  }

  isTestActive(): boolean {
    return this.testStopTimer !== null;
  }

  isAlarmActive(): boolean {
    return this.stateMachine.getMode() === 'alarm';
  }

  setCameraMotionEnabled(enabled: boolean): void {
    this.saveSettings({ camera_motion_enabled: enabled });
    this.eventLog.add('info', `Bevegelsesbilder ${enabled ? 'aktivert' : 'deaktivert'}.`);
  }

  isPerimeterBypassed(): boolean {
    return this.perimeterBypassEndsAt !== null && Date.now() < this.perimeterBypassEndsAt;
  }

  getPerimeterBypassEndsAt(): number | null {
    return this.isPerimeterBypassed() ? this.perimeterBypassEndsAt : null;
  }

  bypassPerimeter(seconds: number): void {
    if (this.perimeterBypassTimer) {
      this.homey.clearTimeout(this.perimeterBypassTimer);
      this.perimeterBypassTimer = null;
    }
    this.perimeterBypassEndsAt = Date.now() + seconds * 1000;
    this.eventLog.add('info', `Perimeter-bypass aktivert i ${seconds}s — perimetersensorer ignoreres.`);
    this.perimeterBypassTimer = this.homey.setTimeout(() => {
      this.perimeterBypassTimer = null;
      this.perimeterBypassEndsAt = null;
      this.eventLog.add('info', 'Perimeter-bypass utløpt — perimetersensorer aktive igjen.');
    }, seconds * 1000);
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
    this.clearDeterrenceTimer();
    this.stateMachine.cancelEntryDelay();
    this.escalation.cancel();
    this.falseAlarm.reset();
    await this.deterrence.abort('Bruker stoppet alarmen.');
    await this.media.stopAll();
    this.alarmStopped('Bruker stoppet alarm.');
    const returnMode = this.previousArmedMode ?? 'disarmed';
    this.previousArmedMode = null;
    this.alarmContext = null;
    await this.stateMachine.setMode(returnMode);
  }

  /**
   * Enter deterrence mode: blink lights in the reaction zone and start the escalation timer.
   * If already in deterrence, just update the active reaction zone (intruder moved).
   * If already in alarm, ignore (already at full alert).
   */
  private async enterDeterrence(zoneId: string, deviceId: string, sensorType: 'motion' | 'contact', alarmType: AlarmType): Promise<void> {
    const mode = this.stateMachine.getMode();
    if (mode === 'deterrence') {
      // Intruder moved — update reaction zone without restarting the escalation timer.
      await this.deterrence.handleMotion(zoneId);
      return;
    }
    if (mode === 'alarm') return;

    this.previousArmedMode = mode as 'armed_stay' | 'armed_away';
    const { zoneName, deviceName } = await this.resolveNames(zoneId, deviceId);
    this.alarmContext = {
      zoneId, zoneName, deviceId, deviceName, sensorType, alarmType,
    };
    const alarmLabel = alarmType === 'perimeter' ? '**Perimeter**' : '**Alarm**';
    this.eventLog.add('alarm', `${alarmLabel} Avskrekking i ${zoneName} — ${deviceName}.`, zoneId, deviceId);

    await this.stateMachine.setMode('deterrence');

    const baseTokens = {
      zone: zoneName,
      sensor: deviceName,
      sensor_type: sensorType,
      mode,
      timestamp: new Date().toISOString(),
    };
    try { await this.homey.flow.getTriggerCard('alarm_triggered').trigger(baseTokens); } catch { /* best-effort */ }
    const perTypeCard = McCallisterGuardApp.ALARM_TYPE_TRIGGER_CARD[alarmType];
    if (perTypeCard) {
      try { await this.homey.flow.getTriggerCard(perTypeCard).trigger(baseTokens); } catch { /* best-effort */ }
    }

    await this.deterrence.handleMotion(zoneId);

    // After escalation_minutes, auto-escalate from deterrence to alarm.
    const escalationMs = this.getSettings().escalation_minutes * 60_000;
    this.deterrenceTimer = this.homey.setTimeout(async () => {
      this.deterrenceTimer = null;
      if (this.stateMachine.getMode() === 'deterrence') await this.enterAlarm();
    }, escalationMs);
  }

  /**
   * Escalate from deterrence to full alarm: stop blinking, strobe all lights + sirens.
   */
  private async enterAlarm(): Promise<void> {
    const mode = this.stateMachine.getMode();
    if (mode === 'disarmed' || mode === 'alarm') return;
    await this.deterrence.abort('Avskrekking eskalert til full alarm.');
    await this.stateMachine.setMode('alarm');
    await this.escalation.triggerCrisis();
  }

  private static readonly ALARM_TYPE_TRIGGER_CARD: Partial<Record<AlarmType, string>> = {
    intrusion: 'alarm_triggered_intrusion',
    entry_delay_timeout: 'alarm_triggered_entry_delay',
  };

  private alarmStopped(reason: string): void {
    const ctx = this.alarmContext;
    this.pushTimeline(`Alarm stoppet${ctx?.zoneName ? ` (sone: ${ctx.zoneName})` : ''} — ${reason}`);

    const alarmType = ctx?.alarmType ?? 'intrusion';
    const baseTokens = {
      zone: ctx?.zoneName ?? '',
      sensor: ctx?.deviceName ?? '',
      reason,
    };
    try { this.homey.flow.getTriggerCard('alarm_stopped').trigger(baseTokens).catch(() => { /* best-effort */ }); } catch { /* best-effort */ }
    const perTypeCard = McCallisterGuardApp.ALARM_TYPE_STOPPED_CARD[alarmType];
    if (perTypeCard) {
      try { this.homey.flow.getTriggerCard(perTypeCard).trigger(baseTokens).catch(() => { /* best-effort */ }); } catch { /* best-effort */ }
    }
  }

  private static readonly ALARM_TYPE_STOPPED_CARD: Partial<Record<AlarmType, string>> = {
    intrusion: 'alarm_stopped_intrusion',
    entry_delay_timeout: 'alarm_stopped_entry_delay',
  };

  private pushTimeline(excerpt: string): void {
    this.homey.notifications.createNotification({ excerpt }).catch(() => { /* best-effort */ });
  }

  private modeLabel(mode: Mode): string {
    if (mode === 'disarmed') return 'Hjemme (av)';
    if (mode === 'armed_away') return 'Borte (aktiv)';
    if (mode === 'armed_stay') return 'Skallsikring';
    if (mode === 'deterrence') return 'Avskrekking aktiv';
    if (mode === 'alarm') return 'ALARM';
    return String(mode);
  }

  private async resolveNames(zoneId: string, deviceId: string): Promise<{ zoneName: string; deviceName: string }> {
    let zoneName = this.zoneNameCache.get(zoneId) ?? zoneId;
    let deviceName = deviceId;
    try {
      const zones = await this.homeyApi.zones.getZones();
      const name = (zones as any)[zoneId]?.name;
      if (name) {
        zoneName = name;
        this.zoneNameCache.set(zoneId, name);
      }
    } catch { /* best-effort */ }
    try {
      const device = await this.homeyApi.devices.getDevice({ id: deviceId });
      deviceName = (device as any)?.name ?? deviceId;
    } catch { /* best-effort */ }
    return { zoneName, deviceName };
  }

  private async refreshZoneNameCache(): Promise<void> {
    try {
      const zones = await this.homeyApi.zones.getZones();
      const next = new Map<string, string>();
      for (const [id, z] of Object.entries(zones as Record<string, { name?: string }>)) {
        if (z?.name) next.set(id, z.name);
      }
      this.zoneNameCache = next;
    } catch { /* best-effort */ }
  }

  private clearTestStopTimer(): void {
    if (this.testStopTimer) {
      this.homey.clearTimeout(this.testStopTimer);
      this.testStopTimer = null;
    }
  }

  private clearDeterrenceTimer(): void {
    if (this.deterrenceTimer) {
      this.homey.clearTimeout(this.deterrenceTimer);
      this.deterrenceTimer = null;
    }
  }

  /**
   * Start the armed_stay scheduler. Checks every 60 s whether auto-arming should fire.
   * Also runs immediately on startup so an overnight window is respected when the app restarts.
   */
  private startArmedStayScheduler(): void {
    this.checkArmedStaySchedule(true);
    this.armedStaySchedulerTimer = this.homey.setInterval(() => {
      this.checkArmedStaySchedule(false);
    }, 60_000);
  }

  /**
   * Evaluate the armed_stay auto-schedule against the current time.
   *
   * @param startup - When true, also activate if we are already inside the armed_stay window
   *                  (handles app restarts in the middle of the night).
   */
  private checkArmedStaySchedule(startup: boolean): void {
    const settings = this.getSettings();
    if (!settings.armed_stay_auto) return;

    const on = settings.armed_stay_on || '22:00';
    const off = settings.armed_stay_off || '06:00';
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const mode = this.stateMachine.getMode();

    // Determine whether we are currently inside the armed_stay window.
    // Overnight windows (e.g. 22:00 – 06:00) cross midnight, so the comparison
    // is: inside when now >= on OR now < off.
    const overnight = on > off;
    const inWindow = overnight ? (hhmm >= on || hhmm < off) : (hhmm >= on && hhmm < off);

    if (startup) {
      // On startup: remember current window state so the first tick can detect transitions.
      this.lastArmedStayWindowState = inWindow;
      // Activate immediately if inside window and currently disarmed.
      if (inWindow && mode === 'disarmed') {
        this.eventLog.add('info', `Automatisk skallsikring aktivert ved oppstart (kl. ${hhmm}, vindu ${on}–${off}).`);
        this.setMode('armed_stay').catch(() => { /* best-effort */ });
      }
      // Deactivate if outside window and still in armed_stay (edge case: schedule changed while app was down).
      if (!inWindow && mode === 'armed_stay') {
        this.eventLog.add('info', `Automatisk skallsikring deaktivert ved oppstart — utenfor tidsvindu (kl. ${hhmm}, vindu ${on}–${off}).`);
        this.setMode('disarmed').catch(() => { /* best-effort */ });
      }
      return;
    }

    // Normal minute-tick: act only when the window state changes.
    // This is robust against timer drift — no exact minute-matching required.
    if (this.lastArmedStayWindowState === inWindow) return;
    this.lastArmedStayWindowState = inWindow;

    if (inWindow && mode === 'disarmed') {
      this.eventLog.add('info', `Automatisk skallsikring aktivert (kl. ${hhmm}, vindu ${on}–${off}).`);
      this.setMode('armed_stay').catch(() => { /* best-effort */ });
    } else if (!inWindow && mode === 'armed_stay') {
      this.eventLog.add('info', `Automatisk skallsikring deaktivert (kl. ${hhmm}, vindu ${on}–${off}).`);
      this.setMode('disarmed').catch(() => { /* best-effort */ });
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
    this.pushTimeline(`McCallister Guard: ${this.modeLabel(next)}`);
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
    this.homey.flow.getActionCard('set_camera_motion')
      .registerRunListener(async (args: { enabled: 'enable' | 'disable' }) => {
        this.setCameraMotionEnabled(args.enabled === 'enable');
        return true;
      });
    this.homey.flow.getActionCard('bypass_perimeter')
      .registerRunListener(async (args: { duration: number }) => {
        this.bypassPerimeter(Math.max(5, Math.round(args.duration)));
        return true;
      });
    const deterrenceCard = this.homey.flow.getActionCard('trigger_deterrence');
    deterrenceCard.registerRunListener(async (args: { zone: { id: string; name: string } }) => {
      await this.testDeterrence(args.zone.id);
      return true;
    });
    deterrenceCard.registerArgumentAutocompleteListener('zone', async (query: string) => {
      const results: { id: string; name: string }[] = [];
      for (const [id, name] of this.zoneNameCache) {
        if (!query || name.toLowerCase().includes(query.toLowerCase())) {
          results.push({ id, name });
        }
      }
      return results;
    });
    this.homey.flow.getActionCard('trigger_alarm')
      .registerRunListener(async () => {
        await this.testAlarm();
        return true;
      });
    this.homey.flow.getConditionCard('is_armed')
      .registerRunListener(async (args: { mode: Mode }) => this.stateMachine.getMode() === args.mode);
    this.homey.flow.getConditionCard('deterrence_active')
      .registerRunListener(async () => this.deterrence.getActiveZone() !== null);
    this.homey.flow.getConditionCard('alarm_active')
      .registerRunListener(async () => this.stateMachine.getMode() === 'alarm');
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
      if (isLight(device)) {
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

  private isEntryDelaySensor(deviceId: string): boolean {
    const list = this.getSettings().entry_delay_sensors ?? [];
    return list.includes(deviceId);
  }

  private async onMotion(zoneId: string, deviceId: string): Promise<void> {
    this.motionLastSeen.set(zoneId, Date.now());
    const mode = this.stateMachine.getMode();
    // Motion burst: use alarm-count when in deterrence or alarm mode.
    const isAlertMode = mode === 'deterrence' || mode === 'alarm';
    this.cameras.captureMotionBurst(zoneId, isAlertMode).catch(() => { /* best-effort */ });
    if (mode === 'disarmed') return;
    if (this.stateMachine.isExitDelayActive()) return;
    this.eventLog.add('info', `Bevegelse i sone ${zoneId}.`, zoneId, deviceId);

    if (mode === 'armed_stay') {
      if (!this.isPerimeterSensor(deviceId)) return;
      if (this.isPerimeterBypassed()) {
        this.eventLog.add('info', 'Bevegelse i perimetersensor ignorert (bypass aktiv).', zoneId, deviceId);
        return;
      }
      await this.enterDeterrence(zoneId, deviceId, 'motion', 'perimeter');
      return;
    }

    if (mode === 'deterrence' || mode === 'alarm') {
      // Already in deterrence/alarm — update reaction zone without resetting the escalation timer.
      await this.deterrence.handleMotion(zoneId);
      return;
    }

    // armed_away: start entry delay (first trigger) or confirm immediately (already counting).
    if (!this.stateMachine.isEntryDelayActive()) {
      const settings = this.getSettings();
      this.eventLog.add('info', `Inngangsforsinkelse startet (${settings.entry_delay}s) — deaktiver for å avbryte.`, zoneId);
      this.stateMachine.startEntryDelay(settings.entry_delay, () => {
        if (this.stateMachine.getMode() === 'disarmed') return;
        this.handleConfirmedMotion(zoneId, deviceId, 'motion', 'intrusion').catch(() => { /* best-effort */ });
      });
    } else {
      await this.handleConfirmedMotion(zoneId, deviceId, 'motion', 'intrusion');
    }
  }

  private async onContact(zoneId: string, deviceId: string): Promise<void> {
    const mode = this.stateMachine.getMode();
    if (mode === 'disarmed' || mode === 'deterrence' || mode === 'alarm') return;
    if (this.stateMachine.isExitDelayActive()) return;
    this.eventLog.add('warning', `Dør/vindu åpnet i sone ${zoneId}.`, zoneId, deviceId);

    if (mode === 'armed_stay' && !this.isPerimeterSensor(deviceId)) return;

    if (mode === 'armed_stay' && this.isPerimeterBypassed()) {
      this.eventLog.add('info', 'Dør/vindu i perimetersensor ignorert (bypass aktiv).', zoneId, deviceId);
      return;
    }

    if (this.isEntryDelaySensor(deviceId)) {
      this.falseAlarm.registerContactOpen();
      if (this.stateMachine.isEntryDelayActive()) return;
      const settings = this.getSettings();
      this.eventLog.add('info', `Inngangsforsinkelse startet (${settings.entry_delay}s) — deaktiver for å avbryte.`, zoneId, deviceId);
      this.stateMachine.startEntryDelay(settings.entry_delay, () => {
        if (this.stateMachine.getMode() === 'disarmed') return;
        this.handleConfirmedContact(zoneId, deviceId, mode).catch(() => { /* best-effort */ });
      });
      return;
    }

    if (mode === 'armed_stay') {
      await this.enterDeterrence(zoneId, deviceId, 'contact', 'perimeter');
      return;
    }
    this.falseAlarm.registerContactOpen();
    await this.handleConfirmedMotion(zoneId, deviceId, 'contact', 'intrusion');
  }

  private async handleConfirmedContact(zoneId: string, deviceId: string, mode: Mode): Promise<void> {
    if (this.stateMachine.getMode() === 'disarmed') return;
    const alarmType: AlarmType = mode === 'armed_stay' ? 'perimeter' : 'entry_delay_timeout';
    if (mode === 'armed_stay') {
      await this.enterDeterrence(zoneId, deviceId, 'contact', alarmType);
      return;
    }
    await this.handleConfirmedMotion(zoneId, deviceId, 'contact', alarmType);
  }

  private async handleConfirmedMotion(zoneId: string, deviceId: string, sensorType: 'motion' | 'contact', alarmType: AlarmType): Promise<void> {
    if (this.stateMachine.getMode() === 'disarmed') return;
    this.falseAlarm.registerMotion(zoneId);
    await this.enterDeterrence(zoneId, deviceId, sensorType, alarmType);
  }

}

module.exports = McCallisterGuardApp;
