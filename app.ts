'use strict';

import Homey from 'homey';
import { HomeyAPI } from 'homey-api';
import EventLog from './lib/EventLog';
import StateMachine from './lib/StateMachine';
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
  private previousArmedMode: 'armed_perimeter' | 'armed' | null = null;
  private openSensorsAtPerimeterStart = new Set<string>();
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
    this.media = new MediaCaster(this.homey, this.homeyApi, this.eventLog, () => this.getSettings());
    this.deterrence = new DeterrenceEngine(this.homey, this.eventLog, this.media, () => this.getSettings());
    this.falseAlarm = new FalseAlarmFilter();
    this.escalation = new EscalationManager(this.homey, this.homeyApi, this.eventLog);
    this.simulation = new SimulationEngine(this.homey, this.homeyApi, this.eventLog, () => this.getSettings());
    this.cameras = new CameraManager(this.homey, this.homeyApi, this.eventLog, () => this.getSettings());

    // Before an alarm-burst, turn on all lights in the motion zone so the camera captures a lit scene.
    this.cameras.setFlashCallback(async (zoneId: string) => {
      const devices = await this.homeyApi.devices.getDevices();
      const lights = (Object.values(devices) as any[]).filter((d) => d.zone === zoneId && isLight(d));
      for (const light of lights) {
        try {
          await light.setCapabilityValue({ capabilityId: 'onoff', value: true });
        } catch { /* best-effort */ }
      }
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

    if (this.stateMachine.getMode() === 'armed') this.simulation.start();

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

  async setMode(mode: Mode, { force = false }: { force?: boolean } = {}): Promise<void> {
    const current = this.stateMachine.getMode();
    if (current === mode && !this.stateMachine.isExitDelayActive()) return;

    // Guard: disarmed from armed_perimeter is silently ignored for external callers.
    // A smart-lock "authorised unlock" flow must not automatically disable perimeter mode —
    // residents can come home late without disarming the night guard.
    // The auto-scheduler bypasses this guard via { force: true }.
    if (mode === 'disarmed' && current === 'armed_perimeter' && !force) {
      this.eventLog.add('info', 'Skallsikring forblir aktiv — deaktivering ignorert.');
      return;
    }

    // Auto-redirect: disarming from armed during the perimeter scheduler window activates
    // perimeter mode instead of fully disarming. This covers the case where a resident comes
    // home at night and their smart-lock flow sends set_mode=disarmed — the house switches to
    // night guard rather than going fully unarmed. Scheduler and force=true bypass this.
    if (mode === 'disarmed' && current === 'armed' && !force && this.isInArmedPerimeterWindow()) {
      this.eventLog.add('info', 'Borte-modus deaktivert i skalltidsvindu — bytter til Skallsikring i stedet.');
      await this.setMode('armed_perimeter');
      return;
    }

    const settings = this.getSettings();
    if (mode === 'disarmed') {
      // Coming from alarm: fire alarm_stopped flow cards before tearing down.
      if (current === 'alarm') {
        this.alarmStopped('Stoppet av bruker.');
      }
      this.clearTestStopTimer();
      this.clearDeterrenceTimer();
      this.stateMachine.cancelEntryDelay();
      this.falseAlarm.reset();
      this.escalation.cancel();
      this.simulation.stop();
      await this.deterrence.abort();
      await this.media.stopAll();
      this.previousArmedMode = null;
      this.alarmContext = null;
    }

    // Clear perimeter snapshot when leaving armed_perimeter.
    if (current === 'armed_perimeter' && mode !== 'armed_perimeter') {
      this.openSensorsAtPerimeterStart.clear();
    }

    // Snapshot open contact sensors before armed_perimeter activates so they can be ignored.
    if (mode === 'armed_perimeter') {
      await this.snapshotOpenPerimeterSensors();
    }

    await this.stateMachine.setMode(mode, mode === 'armed' ? settings.exit_delay : 0);

    // Warn about open door/window sensors when arming in away mode.
    if (mode === 'armed') {
      this.checkOpenContactSensors().catch(() => { /* best-effort */ });
    }
  }

  async testDeterrence(zoneId: string): Promise<void> {
    this.clearTestStopTimer();
    this.clearDeterrenceTimer();
    const seconds = Math.round(McCallisterGuardApp.TEST_DURATION_MS / 1000);
    this.eventLog.add('info', `Test: avskrekking i sone ${zoneId} — auto-stopp om ${seconds}s.`, zoneId);
    const currentMode = this.stateMachine.getMode();
    if (currentMode !== 'deterrence' && currentMode !== 'alarm') {
      this.previousArmedMode = currentMode !== 'disarmed' ? currentMode as 'armed_perimeter' | 'armed' : null;
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
      this.previousArmedMode = currentMode !== 'disarmed' ? currentMode as 'armed_perimeter' | 'armed' : null;
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
    this.eventLog.add('info', 'Alarm stoppet.');
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

    this.previousArmedMode = mode as 'armed_perimeter' | 'armed';
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
    // Fire type-specific trigger: perimeter alarms → alarm_perimeter_triggered, away alarms → alarm_triggered.
    if (alarmType === 'perimeter') {
      try { await this.homey.flow.getTriggerCard('alarm_perimeter_triggered').trigger(baseTokens); } catch { /* best-effort */ }
    } else {
      try { await this.homey.flow.getTriggerCard('alarm_triggered').trigger(baseTokens); } catch { /* best-effort */ }
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
   * Triggered by a perimeter sensor in armed_perimeter mode.
   * Skips the deterrence phase and escalates directly to full alarm.
   */
  private async enterPerimeterAlarm(zoneId: string, deviceId: string, sensorType: 'motion' | 'contact'): Promise<void> {
    const mode = this.stateMachine.getMode();
    if (mode === 'alarm') return;
    this.previousArmedMode = 'armed_perimeter';
    const { zoneName, deviceName } = await this.resolveNames(zoneId, deviceId);
    this.alarmContext = { zoneId, zoneName, deviceId, deviceName, sensorType, alarmType: 'perimeter' };
    this.eventLog.add('alarm', `**Perimeter** Alarm: ${deviceName} i ${zoneName}.`, zoneId, deviceId);
    const baseTokens = {
      zone: zoneName,
      sensor: deviceName,
      sensor_type: sensorType,
      mode,
      timestamp: new Date().toISOString(),
    };
    try { await this.homey.flow.getTriggerCard('alarm_perimeter_triggered').trigger(baseTokens); } catch { /* best-effort */ }
    await this.enterAlarm();
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

  private alarmStopped(reason: string): void {
    const ctx = this.alarmContext;
    this.pushTimeline(`Alarm stoppet${ctx?.zoneName ? ` (sone: ${ctx.zoneName})` : ''} — ${reason}`);

    const alarmType = ctx?.alarmType ?? 'intrusion';
    const baseTokens = {
      zone: ctx?.zoneName ?? '',
      sensor: ctx?.deviceName ?? '',
      reason,
    };
    // Fire type-specific stopped trigger: perimeter alarms → alarm_perimeter_stopped, away alarms → alarm_stopped.
    if (alarmType === 'perimeter') {
      try { this.homey.flow.getTriggerCard('alarm_perimeter_stopped').trigger(baseTokens).catch(() => { /* best-effort */ }); } catch { /* best-effort */ }
    } else {
      try { this.homey.flow.getTriggerCard('alarm_stopped').trigger(baseTokens).catch(() => { /* best-effort */ }); } catch { /* best-effort */ }
    }
  }

  private pushTimeline(excerpt: string): void {
    this.homey.notifications.createNotification({ excerpt }).catch(() => { /* best-effort */ });
  }

  private modeLabel(mode: Mode): string {
    if (mode === 'disarmed') return 'Hjemme (av)';
    if (mode === 'armed') return 'Borte (aktiv)';
    if (mode === 'armed_perimeter') return 'Skallsikring';
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
   * Start the armed_perimeter scheduler. Checks every 60 s whether auto-arming should fire.
   * Also runs immediately on startup so an overnight window is respected when the app restarts.
   */
  private startArmedStayScheduler(): void {
    this.checkArmedStaySchedule(true);
    this.armedStaySchedulerTimer = this.homey.setInterval(() => {
      this.checkArmedStaySchedule(false);
    }, 60_000);
  }

  /**
   * Evaluate the armed_perimeter auto-schedule against the current time.
   *
   * Only fires on window transitions (open→closed, closed→open) detected by comparing
   * the current window state to the last known state. At startup we record the current
   * state so the first tick never produces a false transition — the stored mode already
   * reflects what was active before the restart, so no forced activation/deactivation is needed.
   *
   * @param startup - When true, initialise lastArmedStayWindowState without triggering any action.
   */
  private checkArmedStaySchedule(startup: boolean): void {
    const settings = this.getSettings();
    if (!settings.armed_perimeter_auto) return;

    const on = settings.armed_perimeter_on || '22:00';
    const off = settings.armed_perimeter_off || '06:00';
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Determine whether we are currently inside the armed_perimeter window.
    // Overnight windows (e.g. 22:00–06:00) cross midnight: inside when now >= on OR now < off.
    const overnight = on > off;
    const inWindow = overnight ? (hhmm >= on || hhmm < off) : (hhmm >= on && hhmm < off);

    if (startup) {
      // Seed the window state so the first minute-tick can detect real transitions.
      // Do NOT auto-activate or auto-deactivate here — the persisted mode is already correct.
      this.lastArmedStayWindowState = inWindow;
      return;
    }

    // Normal minute-tick: act only when the window state changes.
    // This is robust against timer drift — no exact minute-matching required.
    if (this.lastArmedStayWindowState === inWindow) return;
    this.lastArmedStayWindowState = inWindow;

    const mode = this.stateMachine.getMode();
    // Only activate from disarmed; never interrupt armed/alarm/deterrence.
    if (inWindow && mode === 'disarmed') {
      this.eventLog.add('info', 'Skallsikring aktivert.');
      this.setMode('armed_perimeter').catch(() => { /* best-effort */ });
    } else if (!inWindow && mode === 'armed_perimeter') {
      this.eventLog.add('info', 'Skallsikring deaktivert.');
      this.setMode('disarmed', { force: true }).catch(() => { /* best-effort */ });
    }
  }

  private handleModeChange(next: Mode, previous: Mode): void {
    if (next === 'armed') {
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
      .registerRunListener(async (args: { mode: Mode; name?: string }) => {
        if (args.mode === 'disarmed') {
          // Always log disarm attempts — including when mode is already disarmed or
          // when armed_perimeter guard silently ignores the request.
          const who = (args.name?.trim() || 'ukjent').replace(/^user:\s*/i, '');
          this.eventLog.add('info', `Deaktivert av ${who}.`);
          this.pushTimeline(`McCallister Guard: Deaktivert av ${who}`);
        }
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
    this.homey.flow.getConditionCard('alarm_active')
      .registerRunListener(async () => this.stateMachine.getMode() === 'alarm');
    this.homey.flow.getConditionCard('alarm_perimeter_active')
      .registerRunListener(async () => this.stateMachine.getMode() === 'armed_perimeter');
    this.homey.flow.getConditionCard('get_mode')
      .registerRunListener(async (args: { mode: Mode }) => this.stateMachine.getMode() === args.mode);
    this.homey.flow.getConditionCard('alarm_triggered_from')
      .registerRunListener(async (args: { mode: 'armed' | 'armed_perimeter' }) => this.previousArmedMode === args.mode);
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

  /** Returns true if the armed_perimeter auto-schedule is enabled and now falls within the configured window. */
  private isInArmedPerimeterWindow(): boolean {
    const settings = this.getSettings();
    if (!settings.armed_perimeter_auto) return false;
    const on = settings.armed_perimeter_on || '22:00';
    const off = settings.armed_perimeter_off || '06:00';
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const overnight = on > off;
    return overnight ? (hhmm >= on || hhmm < off) : (hhmm >= on && hhmm < off);
  }

  /**
   * Snapshot which perimeter contact sensors are currently open so they can be ignored
   * for the lifetime of the armed_perimeter session. A window left open when you arm
   * for the night should not trigger an alarm.
   */
  private async snapshotOpenPerimeterSensors(): Promise<void> {
    // Use strict matching: only snapshot sensors explicitly listed in perimeter_sensors.
    // If no sensors are configured we snapshot nothing — falling back to "all sensors"
    // would cause the guard to silently ignore sensors the user actually wants monitored.
    const perimeterList = this.getSettings().perimeter_sensors ?? [];
    if (perimeterList.length === 0) return;

    try {
      const devices = await this.homeyApi.devices.getDevices();
      this.openSensorsAtPerimeterStart.clear();
      for (const device of Object.values(devices) as any[]) {
        if (!Array.isArray(device.capabilities)) continue;
        if (!device.capabilities.includes('alarm_contact')) continue;
        if (!perimeterList.includes(device.id)) continue;
        const val = device.capabilitiesObj?.alarm_contact?.value;
        if (val === true) {
          this.openSensorsAtPerimeterStart.add(device.id);
          const name = device.name || device.id;
          this.eventLog.add('info', `Sensor åpen ved aktivering — ignoreres i skallsikring: ${name}.`, device.zone, device.id);
        }
      }
    } catch (err) {
      this.eventLog.add('warning', `Snapshot av åpne sensorer feilet: ${(err as Error).message}`);
    }
  }

  /** Warn about open door/window contact sensors when arming in away mode. */
  private async checkOpenContactSensors(): Promise<void> {
    try {
      const devices = await this.homeyApi.devices.getDevices();
      const open: string[] = [];
      for (const device of Object.values(devices) as any[]) {
        if (!Array.isArray(device.capabilities)) continue;
        if (!device.capabilities.includes('alarm_contact')) continue;
        const val = device.capabilitiesObj?.alarm_contact?.value;
        if (val === true) open.push(device.name || device.id);
      }
      if (open.length > 0) {
        const msg = `${open.length} dør/vindu er åpen(e) ved aktivering: ${open.join(', ')}`;
        this.eventLog.add('warning', msg);
        await this.homey.notifications.createNotification({ excerpt: `⚠️ ${msg}` });
      }
    } catch (err) {
      this.eventLog.add('warning', `Sjekk av åpne sensorer feilet: ${(err as Error).message}`);
    }
  }

  private async onMotion(zoneId: string, deviceId: string): Promise<void> {
    this.motionLastSeen.set(zoneId, Date.now());
    const mode = this.stateMachine.getMode();
    // Motion burst: use alarm-count when in deterrence or alarm mode.
    const isAlertMode = mode === 'deterrence' || mode === 'alarm';
    this.cameras.captureMotionBurst(zoneId, isAlertMode).catch(() => { /* best-effort */ });
    if (mode === 'disarmed') return;
    if (this.stateMachine.isExitDelayActive()) return;
    if (mode === 'armed_perimeter') {
      // In perimeter mode: skip deterrence — go directly to alarm for perimeter sensors.
      if (!this.isPerimeterSensor(deviceId)) return;
      if (this.isPerimeterBypassed()) return;
      await this.enterPerimeterAlarm(zoneId, deviceId, 'motion');
      return;
    }

    // Only log motion for away-armed mode (not perimeter mode).
    this.eventLog.add('info', `Bevegelse i sone ${zoneId}.`, zoneId, deviceId);

    if (mode === 'deterrence' || mode === 'alarm') {
      // Already in deterrence/alarm — update reaction zone without resetting the escalation timer.
      await this.deterrence.handleMotion(zoneId);
      return;
    }

    // armed: start entry delay (first trigger) or confirm immediately (already counting).
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
    // In perimeter mode: silently ignore non-perimeter sensors, bypassed sensors and
    // sensors that were already open when armed_perimeter was activated.
    if (mode === 'armed_perimeter') {
      if (!this.isPerimeterSensor(deviceId)) return;
      if (this.isPerimeterBypassed()) return;
      if (this.openSensorsAtPerimeterStart.has(deviceId)) return;
    } else {
      // Only log door/window for away-armed mode.
      this.eventLog.add('warning', `Dør/vindu åpnet i sone ${zoneId}.`, zoneId, deviceId);
    }

    if (this.isEntryDelaySensor(deviceId)) {
      this.falseAlarm.registerContactOpen();
      if (this.stateMachine.isEntryDelayActive()) return;
      const settings = this.getSettings();
      if (mode === 'armed_perimeter') {
        // Auto-bypass all other perimeter sensors for the same duration as the entry delay.
        // This prevents hallway motion / secondary door sensors from triggering an alarm
        // while an authorised resident walks in through the entry-delay door.
        this.bypassPerimeter(settings.entry_delay);
        this.eventLog.add('info', `Inngangsforsinkelse startet (${settings.entry_delay}s) — perimetersensorer ignoreres i samme periode.`, zoneId, deviceId);
      } else {
        this.eventLog.add('info', `Inngangsforsinkelse startet (${settings.entry_delay}s) — deaktiver for å avbryte.`, zoneId, deviceId);
      }
      this.stateMachine.startEntryDelay(settings.entry_delay, () => {
        if (this.stateMachine.getMode() === 'disarmed') return;
        this.handleConfirmedContact(zoneId, deviceId, mode).catch(() => { /* best-effort */ });
      });
      return;
    }

    if (mode === 'armed_perimeter') {
      await this.enterPerimeterAlarm(zoneId, deviceId, 'contact');
      return;
    }
    this.falseAlarm.registerContactOpen();
    await this.handleConfirmedMotion(zoneId, deviceId, 'contact', 'intrusion');
  }

  private async handleConfirmedContact(zoneId: string, deviceId: string, mode: Mode): Promise<void> {
    if (this.stateMachine.getMode() === 'disarmed') return;
    if (mode === 'armed_perimeter') {
      await this.enterPerimeterAlarm(zoneId, deviceId, 'contact');
      return;
    }
    await this.handleConfirmedMotion(zoneId, deviceId, 'contact', 'entry_delay_timeout');
  }

  private async handleConfirmedMotion(zoneId: string, deviceId: string, sensorType: 'motion' | 'contact', alarmType: AlarmType): Promise<void> {
    if (this.stateMachine.getMode() === 'disarmed') return;
    this.falseAlarm.registerMotion(zoneId);
    await this.enterDeterrence(zoneId, deviceId, sensorType, alarmType);
  }

}

module.exports = McCallisterGuardApp;
