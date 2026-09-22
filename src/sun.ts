// Where on Earth is it dawn right now?
// Uses the subsolar longitude and treats the sunrise line as 90° west of it.
// That ignores latitude and season, which is fine for one line of text.

const CITIES: ReadonlyArray<readonly [string, number]> = [
  ['Auckland', 174.8], ['Sydney', 151.2], ['Tokyo', 139.7], ['Seoul', 127.0],
  ['Manila', 121.0], ['Perth', 115.9], ['Hong Kong', 114.2], ['Singapore', 103.8],
  ['Bangkok', 100.5], ['Dhaka', 90.4], ['Kolkata', 88.4], ['Delhi', 77.2],
  ['Mumbai', 72.9], ['Karachi', 67.0], ['Dubai', 55.3], ['Tehran', 51.4],
  ['Nairobi', 36.8], ['Cairo', 31.2], ['Istanbul', 29.0], ['Johannesburg', 28.0],
  ['Athens', 23.7], ['Berlin', 13.4], ['Lagos', 3.4], ['Paris', 2.4],
  ['London', -0.1], ['Madrid', -3.7], ['Dakar', -17.4], ['Reykjavík', -21.9],
  ['São Paulo', -46.6], ['Buenos Aires', -58.4], ['Santiago', -70.6],
  ['New York', -74.0], ['Bogotá', -74.1], ['Havana', -82.4], ['Chicago', -87.6],
  ['Mexico City', -99.1], ['Denver', -105.0], ['Los Angeles', -118.2],
  ['Vancouver', -123.1], ['Anchorage', -149.9], ['Honolulu', -157.9],
];

function wrap(lon: number): number {
  return ((lon + 540) % 360) - 180;
}

// Difference between clock noon and solar noon, in minutes. Approximation good to ~1 min.
function equationOfTimeMinutes(date: Date): number {
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - yearStart) / 86_400_000;
  const b = (2 * Math.PI * (dayOfYear - 81)) / 365;
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
}

export function subsolarLongitude(date: Date = new Date()): number {
  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const hoursPastNoon = utcHours + equationOfTimeMinutes(date) / 60 - 12;
  return wrap(-15 * hoursPastNoon);
}

export function dawnLongitude(date: Date = new Date()): number {
  return wrap(subsolarLongitude(date) - 90);
}

export function cityAtDawn(date: Date = new Date()): string {
  const target = dawnLongitude(date);
  let best = CITIES[0];
  let bestDistance = Infinity;
  for (const city of CITIES) {
    const distance = Math.abs(wrap(city[1] - target));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = city;
    }
  }
  return best[0];
}
