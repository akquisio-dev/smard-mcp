/**
 * Solar elevation after Spencer (1971), accurate to about 0.5 degrees. A
 * one-to-one port of smard-forecast's sf/sonne.py; the models were trained
 * with exactly this approximation.
 */

const DAY = 86_400_000;

function dayOfYear(ms: number): number {
  const d = new Date(ms);
  return Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
}

/** Elevation in degrees at an instant (ms since epoch) and place. */
export function solarElevation(ms: number, lat: number, lon: number): number {
  const d = new Date(ms);
  const doy = dayOfYear(ms);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (hour - 12) / 24);
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  // 0.000075 is the constant as printed by Spencer (1971); his later correction gives
  // 0.0000075 (under one second). Kept until the next retraining so that this matches the
  // Python code the models were trained with (smard-forecast sf/sonne.py).
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const w = (((hour * 60 + eqTime + 4 * lon) / 4 - 180) * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const sinH = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(w);
  return (Math.asin(Math.min(1, Math.max(-1, sinH))) * 180) / Math.PI;
}
