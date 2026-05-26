'use strict';

const CAST_DRIVER_RE = /chromecast|googlecast|google\.cast|nest\.audio|nest\.hub|sonos|airplay/i;

export interface DeviceClassification {
  isAudio: boolean;
  isVideo: boolean;
  isLight: boolean;
  canCastUrl: boolean;
}

function caps(d: any): string[] {
  return Array.isArray(d?.capabilities) ? d.capabilities : [];
}

function driverString(d: any): string {
  return `${String(d?.driverUri ?? '')} ${String(d?.driverId ?? '')}`.toLowerCase();
}

function deviceClass(d: any): string {
  return String(d?.virtualClass ?? d?.class ?? '').toLowerCase();
}

export function isSensor(d: any): boolean {
  const c = caps(d);
  return c.includes('alarm_motion') || c.includes('alarm_contact');
}

export type SensorType = 'motion' | 'contact';

export function sensorType(d: any): SensorType | null {
  const c = caps(d);
  if (c.includes('alarm_contact')) return 'contact';
  if (c.includes('alarm_motion')) return 'motion';
  return null;
}

export function isCastableScreen(d: any): boolean {
  const c = caps(d);
  if (c.includes('cast_url')) return true;
  const driver = driverString(d);
  const cls = deviceClass(d);
  const looksCast = CAST_DRIVER_RE.test(driver) || cls === 'tv';
  if (!looksCast) return false;
  return c.includes('speaker_playing') || c.includes('volume_set');
}

export function isAudioDevice(d: any): boolean {
  const c = caps(d);
  return c.includes('speaker_playing') || c.includes('volume_set');
}

export function isLight(d: any): boolean {
  if (isSensor(d)) return false;
  if (!caps(d).includes('onoff')) return false;
  return deviceClass(d) === 'light';
}

export function isCamera(d: any): boolean {
  if (caps(d).includes('camera_image')) return true;
  return deviceClass(d) === 'camera';
}

export function classify(d: any): DeviceClassification {
  return {
    isAudio: isAudioDevice(d),
    isVideo: isCastableScreen(d),
    isLight: isLight(d),
    canCastUrl: caps(d).includes('cast_url'),
  };
}
