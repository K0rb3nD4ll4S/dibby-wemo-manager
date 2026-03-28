'use strict';

/**
 * Calculate sunrise and sunset times for a given location and date.
 * Pure JS – no external dependencies.
 *
 * Algorithm: NOAA Solar Calculator (Jean Meeus, Astronomical Algorithms).
 *
 * @param {number} lat  Latitude  in decimal degrees (positive = North)
 * @param {number} lng  Longitude in decimal degrees (positive = East)
 * @param {Date}   date Date to calculate for (default: today)
 * @returns {{ sunrise: number|null, sunset: number|null }}
 *   Times as integer seconds from LOCAL midnight.
 *   null for each value if polar day or polar night.
 */
function sunTimes(lat, lng, date = new Date()) {
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;

  const year  = date.getFullYear();
  const month = date.getMonth() + 1;
  const day   = date.getDate();

  const A   = Math.floor((14 - month) / 12);
  const Y   = year + 4800 - A;
  const M   = month + 12 * A - 3;
  const JDN = day + Math.floor((153 * M + 2) / 5) + 365 * Y
            + Math.floor(Y / 4) - Math.floor(Y / 100) + Math.floor(Y / 400) - 32045;
  const JD  = JDN - 0.5;

  const T = (JD - 2451545.0) / 36525.0;

  let L0 = 280.46646 + T * (36000.76983 + T * 0.0003032);
  L0 = ((L0 % 360) + 360) % 360;

  let Mdeg = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  Mdeg = ((Mdeg % 360) + 360) % 360;
  const Mrad = Mdeg * D2R;

  const C = (1.914602 - T * (0.004817 + 0.000014 * T)) * Math.sin(Mrad)
          + (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad)
          + 0.000289 * Math.sin(3 * Mrad);

  const omega  = 125.04 - 1934.136 * T;
  const lambda = (L0 + C) - 0.00569 - 0.00478 * Math.sin(omega * D2R);

  const eps0 = 23.0
    + (26.0 + (21.448 - T * (46.8150 + T * (0.00059 - T * 0.001813))) / 60.0) / 60.0;
  const eps  = (eps0 + 0.00256 * Math.cos(omega * D2R)) * D2R;

  const sinDec = Math.sin(eps) * Math.sin(lambda * D2R);
  const decl   = Math.asin(sinDec);

  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const y = Math.pow(Math.tan(eps / 2), 2);
  const EqT = 4 * R2D * (
      y * Math.sin(2 * L0 * D2R)
    - 2 * e * Math.sin(Mrad)
    + 4 * e * y * Math.sin(Mrad) * Math.cos(2 * L0 * D2R)
    - 0.5 * y * y * Math.sin(4 * L0 * D2R)
    - 1.25 * e * e * Math.sin(2 * Mrad)
  );

  const cosHA = (Math.cos(90.833 * D2R) - Math.sin(lat * D2R) * sinDec)
              / (Math.cos(lat * D2R) * Math.cos(decl));

  if (cosHA < -1 || cosHA > 1) {
    return { sunrise: null, sunset: null };
  }

  const HA = Math.acos(cosHA) * R2D;
  const tzOffsetMin = -date.getTimezoneOffset();
  const solarNoon   = 720.0 - 4.0 * lng - EqT + tzOffsetMin;

  return {
    sunrise: Math.round((solarNoon - HA * 4.0) * 60),
    sunset:  Math.round((solarNoon + HA * 4.0) * 60),
  };
}

module.exports = { sunTimes };
