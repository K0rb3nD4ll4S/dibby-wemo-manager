"""
NOAA sunrise/sunset calculator.
Direct port of sun.js from the Homebridge plugin.
Returns seconds from LOCAL midnight.
"""

from __future__ import annotations
import math
from datetime import datetime, timezone


def _deg2rad(d: float) -> float:
    return d * math.pi / 180.0


def _rad2deg(r: float) -> float:
    return r * 180.0 / math.pi


def sun_times(lat: float, lng: float, date: datetime | None = None) -> tuple[int | None, int | None]:
    """
    Calculate sunrise and sunset for a given lat/lng and date.

    Returns (sunrise_secs, sunset_secs) as seconds from LOCAL midnight,
    or (None, None) if polar day/night.
    """
    if date is None:
        date = datetime.now()

    # Julian day
    jd = _julian_day(date)

    # Time zone offset in hours (use local system timezone)
    utc_offset = (datetime.now() - datetime.utcnow()).total_seconds() / 3600.0

    sunrise_secs = _calc_sun_time(jd, lat, lng, utc_offset, rising=True)
    sunset_secs  = _calc_sun_time(jd, lat, lng, utc_offset, rising=False)
    return sunrise_secs, sunset_secs


def _julian_day(dt: datetime) -> float:
    a = (14 - dt.month) // 12
    y = dt.year + 4800 - a
    m = dt.month + 12 * a - 3
    jdn = dt.day + (153 * m + 2) // 5 + 365 * y + y // 4 - y // 100 + y // 400 - 32045
    return float(jdn)


def _calc_sun_time(jd: float, lat: float, lng: float, utc_offset: float, rising: bool) -> int | None:
    """Return seconds from local midnight, or None if polar."""
    zenith = 90.833  # official zenith

    # Day of year
    n = jd - 2451545.0 + 0.0008

    # Mean solar noon
    j_star = n - lng / 360.0

    # Solar mean anomaly
    m = (357.5291 + 0.98560028 * j_star) % 360

    # Equation of the centre
    c = 1.9148 * math.sin(_deg2rad(m)) + 0.02 * math.sin(_deg2rad(2 * m)) + 0.0003 * math.sin(_deg2rad(3 * m))

    # Ecliptic longitude
    lam = (m + c + 180 + 102.9372) % 360

    # Solar transit
    j_transit = 2451545.0 + j_star + 0.0053 * math.sin(_deg2rad(m)) - 0.0069 * math.sin(_deg2rad(2 * lam))

    # Declination of the sun
    sin_d = math.sin(_deg2rad(lam)) * math.sin(_deg2rad(23.4397))
    cos_d = math.cos(math.asin(sin_d))

    # Hour angle
    cos_w = (math.cos(_deg2rad(zenith)) - sin_d * math.sin(_deg2rad(lat))) / (cos_d * math.cos(_deg2rad(lat)))

    if cos_w < -1 or cos_w > 1:
        return None  # polar day or polar night

    w = _rad2deg(math.acos(cos_w))

    if rising:
        j_event = j_transit - w / 360.0
    else:
        j_event = j_transit + w / 360.0

    # Convert Julian day fraction to seconds from local midnight
    # j_event is in UTC days since J2000.0
    # Extract fractional part (time of day in UTC)
    utc_hours = (j_event - math.floor(j_event)) * 24.0
    local_hours = (utc_hours + utc_offset) % 24.0
    return int(local_hours * 3600)
