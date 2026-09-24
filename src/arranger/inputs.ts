// What the arranger knows about the room and the sky right now.
import { presenceAt, presenceHoursAt } from '../presenceSim';
import { cityAtDawn, subsolarLongitude } from '../sun';

export interface RoomInputs {
  at: number; // unix seconds
  utc: string; // "14:35"
  utcHour: number;
  dayOfYear: number;
  season: 'spring' | 'summer' | 'autumn' | 'winter'; // northern hemisphere
  dawnCity: string;
  subsolarLongitude: number;
  moon: { phase: number; illumination: number; name: string };
  listeners: number;
  /** What time it is for the people in the room: share of listeners in each part of their day. */
  room: { night: number; morning: number; day: number; evening: number; hours: number[] };
  /** Someone is on stage: a live stream is playing over the bed. */
  performer?: { name: string };
}

/** Summarize a 24-bin local-hour histogram into shares of night, morning, day, evening. */
export function roomHours(hours: number[]): RoomInputs['room'] {
  const total = hours.reduce((a, b) => a + b, 0) || 1;
  const share = (from: number, to: number) => {
    let n = 0;
    for (let h = 0; h < 24; h++) if (from <= to ? h >= from && h < to : h >= from || h < to) n += hours[h];
    return Math.round((100 * n) / total) / 100;
  };
  return { night: share(22, 5), morning: share(5, 10), day: share(10, 17), evening: share(17, 22), hours };
}

const SYNODIC_DAYS = 29.530588853;
const NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14) / 1000;

export function moonAt(unixSeconds: number): RoomInputs['moon'] {
  const days = (unixSeconds - NEW_MOON_REF) / 86400;
  const phase = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS / SYNODIC_DAYS;
  const illumination = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
  const names = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];
  const name = names[Math.round(phase * 8) % 8];
  return { phase, illumination, name };
}

/** Presence as measured: how many are here and the 24-bin histogram of their local hours. */
export interface Presence { count: number; hours: number[]; performer?: { name: string } | null }

export function roomInputs(nowMs: number = Date.now(), presence?: Presence): RoomInputs {
  const d = new Date(nowMs);
  const at = Math.floor(nowMs / 1000);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((nowMs - yearStart) / 86_400_000);
  const season = dayOfYear < 80 || dayOfYear >= 355 ? 'winter' : dayOfYear < 172 ? 'spring' : dayOfYear < 266 ? 'summer' : 'autumn';
  return {
    at,
    utc: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
    utcHour: d.getUTCHours() + d.getUTCMinutes() / 60,
    dayOfYear,
    season,
    dawnCity: cityAtDawn(d),
    subsolarLongitude: Math.round(subsolarLongitude(d)),
    moon: moonAt(at),
    listeners: presence ? presence.count : presenceAt(nowMs),
    room: roomHours(presence ? presence.hours : presenceHoursAt(nowMs)),
    performer: presence?.performer ?? undefined,
  };
}
