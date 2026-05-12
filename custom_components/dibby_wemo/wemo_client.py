"""
Async Wemo UPnP/SOAP client.

Handles:
  - SSDP device discovery
  - GetBinaryState / SetBinaryState
  - FetchRules / StoreRules (SQLite-in-ZIP)
  - Full rule CRUD (create / update / delete / toggle)

All I/O is async using asyncio + stdlib http.client run in an executor.
No third-party dependencies — uses only Python stdlib.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import re
import socket
import sqlite3
import zipfile
import xml.etree.ElementTree as ET
from http.client import HTTPConnection
from typing import Any
from urllib.parse import urlparse

from .const import (
    ACTION_NONE, ACTION_OFF, ACTION_ON,
    CONTROL_BASICEVENT, CONTROL_RULES,
    SERVICE_BASICEVENT, SERVICE_RULES,
    SUN_SUNRISE, SUN_SUNSET,
    SSDP_MULTICAST, SSDP_PORT,
    WEMO_PORTS,
)

_LOGGER = logging.getLogger(__name__)

# ── Day-of-week translation ──────────────────────────────────────────────────
#
# Belkin firmware DayID encoding (extracted from the official WeMo Android app):
#   0 = Daily (every day)
#   1 = Sun, 2 = Mon, 3 = Tue, 4 = Wed, 5 = Thu, 6 = Fri, 7 = Sat
#   8 = Weekdays (single row covering Mon-Fri)
#   9 = Weekends (single row covering Sat-Sun)
#
# Dibby internal day numbers: 1 = Mon ... 7 = Sun (ISO-8601).
BELKIN_TO_DIBBY: dict[int, list[int]] = {
    0: [1, 2, 3, 4, 5, 6, 7],
    1: [7], 2: [1], 3: [2], 4: [3], 5: [4], 6: [5], 7: [6],
    8: [1, 2, 3, 4, 5],
    9: [6, 7],
}


def device_days_to_dibby(raw_day_id: int) -> list[int]:
    """One Belkin firmware DayID → list of Dibby day numbers. Unknown → []."""
    return list(BELKIN_TO_DIBBY.get(int(raw_day_id), []))


def dibby_day_to_device(d: int) -> int:
    """Dibby day number (1=Mon..7=Sun) → Belkin DayID (2=Mon..7=Sat,1=Sun)."""
    return 1 if int(d) == 7 else int(d) + 1


# ── Helpers ───────────────────────────────────────────────────────────────────

def _secs_to_hhmm(secs: int) -> str:
    h = (secs // 3600) % 24
    m = (secs % 3600) // 60
    return f"{h:02d}:{m:02d}"


def _hhmm_to_secs(hhmm: str) -> int:
    parts = hhmm.strip().split(":")
    return int(parts[0]) * 3600 + int(parts[1]) * 60


def _js_to_wemo_day(js_day: int) -> int:
    """Convert Python weekday (0=Mon…6=Sun) to Wemo day (1=Mon…7=Sun)."""
    return 7 if js_day == 6 else js_day + 1


# ── SOAP ─────────────────────────────────────────────────────────────────────

def _build_soap(service: str, action: str, args: dict[str, Any]) -> bytes:
    arg_xml = "".join(f"<{k}>{v}</{k}>" for k, v in args.items())
    body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        "<s:Body>"
        f'<u:{action} xmlns:u="{service}">'
        f"{arg_xml}"
        f"</u:{action}>"
        "</s:Body>"
        "</s:Envelope>"
    )
    return body.encode()


def _soap_request_sync(
    host: str, port: int, control_url: str,
    service: str, action: str, args: dict[str, Any],
    timeout: float = 10.0,
) -> str:
    payload = _build_soap(service, action, args)
    headers = {
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPACTION": f'"{service}#{action}"',
        "Content-Length": str(len(payload)),
    }
    conn = HTTPConnection(host, port, timeout=timeout)
    conn.request("POST", control_url, body=payload, headers=headers)
    resp = conn.getresponse()
    body = resp.read().decode(errors="replace")
    conn.close()
    return body


def _parse_soap_value(xml_str: str, tag: str) -> str | None:
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError:
        return None
    for el in root.iter():
        if el.tag.split("}")[-1] == tag:
            return el.text
    return None


async def _soap(
    host: str, port: int, control_url: str,
    service: str, action: str, args: dict[str, Any] = {},
    timeout: float = 10.0,
) -> str:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: _soap_request_sync(host, port, control_url, service, action, args, timeout),
    )


async def _soap_with_fallback(
    host: str, port: int, control_url: str,
    service: str, action: str, args: dict[str, Any] = {},
) -> str:
    ports = [port] + [p for p in WEMO_PORTS if p != port]
    last_err: Exception | None = None
    for p in ports:
        try:
            return await _soap(host, p, control_url, service, action, args)
        except Exception as e:
            last_err = e
    raise RuntimeError(f"All ports failed for {host}: {last_err}")


# ── Device state ─────────────────────────────────────────────────────────────

async def get_binary_state(host: str, port: int) -> bool:
    xml = await _soap_with_fallback(
        host, port, CONTROL_BASICEVENT, SERVICE_BASICEVENT, "GetBinaryState"
    )
    val = _parse_soap_value(xml, "BinaryState") or "0"
    return val.strip() in ("1", "8")


async def set_binary_state(host: str, port: int, on: bool) -> None:
    await _soap_with_fallback(
        host, port, CONTROL_BASICEVENT, SERVICE_BASICEVENT,
        "SetBinaryState", {"BinaryState": "1" if on else "0"},
    )


# ── SSDP Discovery ────────────────────────────────────────────────────────────

def _ssdp_discover_sync(timeout_s: float) -> list[dict]:
    """Broadcast M-SEARCH and collect LOCATION headers."""
    msg = (
        "M-SEARCH * HTTP/1.1\r\n"
        f"HOST: {SSDP_MULTICAST}:{SSDP_PORT}\r\n"
        'MAN: "ssdp:discover"\r\n'
        "MX: 3\r\n"
        "ST: urn:Belkin:device:**\r\n\r\n"
    ).encode()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    sock.settimeout(timeout_s)
    sock.sendto(msg, (SSDP_MULTICAST, SSDP_PORT))

    locations: set[str] = set()
    try:
        while True:
            data, _ = sock.recvfrom(4096)
            text = data.decode(errors="replace")
            m = re.search(r"LOCATION:\s*(\S+)", text, re.IGNORECASE)
            if m:
                locations.add(m.group(1))
    except socket.timeout:
        pass
    finally:
        sock.close()

    return [{"location": loc} for loc in locations]


def _ip_to_base(ip: str) -> str | None:
    """'192.168.18.42' -> '192.168.18.' — return None for invalid/loopback/link-local."""
    parts = ip.split(".")
    if len(parts) != 4:
        return None
    if ip.startswith("127.") or ip.startswith("169.254."):
        return None
    return ".".join(parts[:3]) + "."


def _local_subnet_candidates() -> list[str]:
    """Return every plausible /24 base for this host.

    HAOS in a VM, HA in Docker, and bare-metal each present a different
    interface layout, so a single 'find my IP' trick is unreliable — instead
    we enumerate every approach we know and union the results.

    Strategies:
      1. UDP connect-trick (outbound IP for 8.8.8.8 — usually the LAN IP, but
         in some container setups returns a Docker internal IP).
      2. `socket.gethostbyname_ex(gethostname())` — returns every IP bound to
         the host's name; includes the LAN IP on most Linux/HAOS installs.
      3. Iterate `socket.getaddrinfo(gethostname(), None)` — last-resort, picks
         up any IPv4 address the kernel knows about for this host.

    Loopback (127.x) and link-local (169.254.x) bases are filtered out.
    """
    bases: set[str] = set()

    # 1. Connect trick (most accurate when it works)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        finally:
            s.close()
        b = _ip_to_base(ip)
        if b:
            bases.add(b)
    except Exception as e:
        _LOGGER.debug("Subnet detection (connect-trick) failed: %s", e)

    # 2. gethostbyname_ex — common on HAOS
    try:
        _, _, ips = socket.gethostbyname_ex(socket.gethostname())
        for ip in ips:
            b = _ip_to_base(ip)
            if b:
                bases.add(b)
    except Exception as e:
        _LOGGER.debug("Subnet detection (gethostbyname_ex) failed: %s", e)

    # 3. getaddrinfo — catch-all
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            b = _ip_to_base(ip)
            if b:
                bases.add(b)
    except Exception as e:
        _LOGGER.debug("Subnet detection (getaddrinfo) failed: %s", e)

    return sorted(bases)


def _probe_wemo_ip_sync(host: str, timeout: float = 0.8) -> str | None:
    """Try every Wemo port — return setup.xml URL on first hit, else None."""
    for port in WEMO_PORTS:
        try:
            conn = HTTPConnection(host, port, timeout=timeout)
            conn.request("GET", "/setup.xml")
            resp = conn.getresponse()
            body = resp.read(2048).decode(errors="replace")
            conn.close()
            if resp.status == 200 and "Belkin" in body:
                return f"http://{host}:{port}/setup.xml"
        except Exception:
            continue
    return None


def _unicast_subnet_scan_sync(timeout_s: float = 8.0) -> list[dict]:
    """Probe every host on every local /24 for /setup.xml — container-friendly.

    Multicast SSDP can't cross Docker's bridge network. Even when running in
    HAOS, the integration may live in a container whose 'primary' IP is on a
    Docker-internal bridge (172.x), not the LAN. So we enumerate every /24
    the host has an interface on and scan all of them in parallel.

    A single /24 with 32 workers + 0.8s timeout completes in ~5s. Scanning
    two /24s in parallel with 64 workers stays in the same budget.
    """
    bases = _local_subnet_candidates()
    if not bases:
        _LOGGER.warning("Unicast scan: could not determine any local subnet")
        return []

    _LOGGER.info("Unicast scan: probing /24 base(s) %s with %.1fs budget", bases, timeout_s)

    from concurrent.futures import ThreadPoolExecutor, as_completed

    targets: list[str] = []
    for base in bases:
        for i in range(1, 255):
            targets.append(f"{base}{i}")

    if not targets:
        return []

    workers = min(96, max(32, len(targets) // 8))
    locations: set[str] = set()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_probe_wemo_ip_sync, ip): ip for ip in targets}
        try:
            for fut in as_completed(futures, timeout=timeout_s):
                try:
                    url = fut.result()
                except Exception:
                    continue
                if url:
                    locations.add(url)
        except Exception as e:
            _LOGGER.debug("Unicast scan hit timeout boundary: %s", e)

    _LOGGER.info(
        "Unicast scan: probed %d hosts across %d subnet(s), found %d Wemo URL(s)",
        len(targets), len(bases), len(locations),
    )
    return [{"location": loc} for loc in locations]


def _fetch_setup_xml_sync(location: str) -> dict | None:
    try:
        parsed = urlparse(location)
        conn = HTTPConnection(parsed.hostname, parsed.port or 80, timeout=5)
        conn.request("GET", parsed.path)
        resp = conn.getresponse()
        text = resp.read().decode(errors="replace")
        conn.close()
        root = ET.fromstring(text)
        ns = {"d": "urn:schemas-upnp-org:device-1-0"}

        def find(tag: str) -> str:
            el = root.find(f".//d:{tag}", ns)
            return el.text.strip() if el is not None and el.text else ""

        return {
            "host": parsed.hostname,
            "port": parsed.port or 49153,
            "udn": find("UDN"),
            "name": find("friendlyName"),
            "model": find("modelName") or find("deviceType"),
            "firmware": find("firmwareVersion"),
        }
    except Exception as e:
        _LOGGER.debug("setup.xml fetch failed for %s: %s", location, e)
        return None


async def discover_devices(timeout_s: float = 10.0) -> list[dict]:
    """Return list of WemoDevice dicts.

    First tries SSDP multicast (works on host-network installs and bare-metal
    HA). If that returns nothing — common when HA runs in a Docker bridge
    network and can't escape multicast — falls back to a unicast /24 subnet
    scan that traverses the bridge NAT just fine.
    """
    loop = asyncio.get_event_loop()
    raw = await loop.run_in_executor(None, lambda: _ssdp_discover_sync(timeout_s))
    _LOGGER.info("SSDP M-SEARCH returned %d location(s)", len(raw))

    if not raw:
        _LOGGER.info("SSDP returned no devices — falling back to unicast subnet scan")
        scan_budget = max(6.0, min(timeout_s, 20.0))
        raw = await loop.run_in_executor(
            None, lambda: _unicast_subnet_scan_sync(timeout_s=scan_budget)
        )

    devices: list[dict] = []
    seen_udns: set[str] = set()

    for item in raw:
        dev = await loop.run_in_executor(
            None, lambda loc=item["location"]: _fetch_setup_xml_sync(loc)
        )
        if dev and dev["udn"] and dev["udn"] not in seen_udns:
            seen_udns.add(dev["udn"])
            devices.append(dev)

    return devices


# ── Rules (SQLite in ZIP) ─────────────────────────────────────────────────────

def _http_get_bytes_sync(url: str) -> bytes:
    parsed = urlparse(url)
    conn = HTTPConnection(parsed.hostname, parsed.port or 80, timeout=15)
    conn.request("GET", parsed.path + ("?" + parsed.query if parsed.query else ""))
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return data


def _extract_db_from_zip(zip_bytes: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            if name.endswith(".db"):
                return zf.read(name)
    raise ValueError("No .db file found in rules ZIP")


def _rezip_db(db_bytes: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("temppluginRules.db", db_bytes)
    return buf.getvalue()


async def fetch_rules_raw(host: str, port: int) -> tuple[str, bytes]:
    """Return (version_str, sqlite_db_bytes)."""
    xml = await _soap_with_fallback(
        host, port, CONTROL_RULES, SERVICE_RULES, "FetchRules"
    )
    version = _parse_soap_value(xml, "ruleDbVersion") or "0"
    db_path = _parse_soap_value(xml, "ruleDbPath")
    if not db_path:
        raise RuntimeError("FetchRules returned no ruleDbPath")

    loop = asyncio.get_event_loop()
    zip_bytes = await loop.run_in_executor(None, lambda: _http_get_bytes_sync(db_path))
    db_bytes = _extract_db_from_zip(zip_bytes)
    return version, db_bytes


async def store_rules_raw(host: str, port: int, version: str, db_bytes: bytes) -> None:
    """Upload modified SQLite DB back to device."""
    zip_bytes = _rezip_db(db_bytes)
    b64 = base64.b64encode(zip_bytes).decode()

    # StoreRules MUST use entity-encoded CDATA — hand-craft this XML
    soap_body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        "<s:Body>"
        f'<u:StoreRules xmlns:u="{SERVICE_RULES}">'
        f"<ruleDbVersion>{version}</ruleDbVersion>"
        "<StartSync>NOSYNC</StartSync>"
        f"<ruleDbBody>&lt;![CDATA[{b64}]]&gt;</ruleDbBody>"
        "</u:StoreRules>"
        "</s:Body>"
        "</s:Envelope>"
    ).encode()

    loop = asyncio.get_event_loop()

    def _do_store():
        headers = {
            "Content-Type": 'text/xml; charset="utf-8"',
            "SOAPACTION": f'"{SERVICE_RULES}#StoreRules"',
            "Content-Length": str(len(soap_body)),
        }
        conn = HTTPConnection(host, port, timeout=30)
        conn.request("POST", CONTROL_RULES, body=soap_body, headers=headers)
        resp = conn.getresponse()
        body = resp.read().decode(errors="replace")
        conn.close()
        if "failed" in body.lower():
            raise RuntimeError(f"StoreRules failed: {body[:200]}")

    await loop.run_in_executor(None, _do_store)


async def fetch_rules(host: str, port: int) -> dict:
    """Return parsed rules dict with version, rules, ruleDevices, targets."""
    version, db_bytes = await fetch_rules_raw(host, port)
    conn = sqlite3.connect(":memory:")
    conn.executescript(db_bytes.decode("latin-1", errors="replace"))

    def rows(table: str) -> list[dict]:
        try:
            cur = conn.execute(f"SELECT * FROM {table}")
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]
        except sqlite3.OperationalError:
            return []

    result = {
        "version": version,
        "rules": rows("RULES"),
        "ruleDevices": rows("RULEDEVICES"),
        "targets": rows("TARGETDEVICES"),
    }
    conn.close()
    return result


def _open_db(db_bytes: bytes) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    # Write bytes to temp and restore via iterdump workaround
    tmp = sqlite3.connect(":memory:")
    tmp.executescript(db_bytes.decode("latin-1", errors="replace"))
    script = "\n".join(tmp.iterdump())
    tmp.close()
    conn.executescript(script)
    return conn


def _dump_db(conn: sqlite3.Connection) -> bytes:
    script = "\n".join(conn.iterdump())
    tmp = sqlite3.connect(":memory:")
    tmp.executescript(script)
    buf = io.BytesIO()
    # Dump to SQLite binary via backup
    disk = sqlite3.connect(buf)  # type: ignore[arg-type]
    # backup not available on BytesIO; use file approach
    tmp.close()
    # Serialize via sqlite3 API — write to temp file path
    import tempfile, os
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        path = f.name
    try:
        disk_conn = sqlite3.connect(path)
        conn.backup(disk_conn)
        disk_conn.close()
        with open(path, "rb") as f:
            return f.read()
    finally:
        os.unlink(path)


async def _modify_rules(host: str, port: int, modify_fn) -> None:
    """Fetch DB, apply modify_fn(conn, version) → new_version, store back."""
    version, db_bytes = await fetch_rules_raw(host, port)
    conn = _open_db(db_bytes)
    new_version = str(int(version) + 2)
    modify_fn(conn, new_version)
    new_db = _dump_db(conn)
    conn.close()
    await store_rules_raw(host, port, new_version, new_db)


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS RULES (
            RuleID TEXT, Name TEXT, Type TEXT, RuleOrder INTEGER DEFAULT 0,
            StartDate TEXT DEFAULT '12201982', EndDate TEXT DEFAULT '07301982',
            State TEXT DEFAULT '1', Sync TEXT DEFAULT 'NOSYNC'
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS RULEDEVICES (
            RuleDevicePK INTEGER PRIMARY KEY AUTOINCREMENT,
            RuleID TEXT, DeviceID TEXT, GroupID INTEGER DEFAULT 0,
            DayID INTEGER, StartTime INTEGER DEFAULT 0, RuleDuration INTEGER DEFAULT 0,
            StartAction REAL DEFAULT 1, EndAction REAL DEFAULT -1,
            SensorDuration INTEGER DEFAULT 2, Type INTEGER DEFAULT -1,
            Value INTEGER DEFAULT -1, Level INTEGER DEFAULT -1,
            ZBCapabilityStart TEXT DEFAULT '', ZBCapabilityEnd TEXT DEFAULT '',
            OnModeOffset INTEGER DEFAULT -1, OffModeOffset INTEGER DEFAULT -1,
            CountdownTime INTEGER DEFAULT 0, EndTime INTEGER DEFAULT -1
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS TARGETDEVICES (
            TargetDevicesPK INTEGER PRIMARY KEY AUTOINCREMENT,
            RuleID TEXT, DeviceID TEXT, DeviceIndex INTEGER DEFAULT 0
        )""")
    conn.commit()


async def create_rule(host: str, port: int, rule: dict) -> int:
    """Insert a new rule. Returns new RuleID."""
    new_id: list[int] = []

    def _modify(conn: sqlite3.Connection, _version: str) -> None:
        _ensure_schema(conn)
        cur = conn.execute("SELECT CAST(MAX(CAST(RuleID AS INTEGER)) AS INTEGER) FROM RULES")
        row = cur.fetchone()
        rule_id = (row[0] or 0) + 1
        new_id.append(rule_id)

        rule_type = {"Schedule": "Time Interval", "Countdown": "Countdown Rule", "Away": "Away Mode"}.get(
            rule.get("type", "Schedule"), "Time Interval"
        )
        state = "1" if rule.get("enabled", True) else "0"
        conn.execute(
            "INSERT INTO RULES (RuleID, Name, Type, State) VALUES (?,?,?,?)",
            (str(rule_id), rule.get("name", "Rule"), rule_type, state),
        )

        is_countdown = rule.get("type") == "Countdown"
        days = rule.get("days", [-1]) if is_countdown else rule.get("days", [1, 2, 3, 4, 5, 6, 7])
        start_secs = rule.get("startTime", 0)
        end_secs = rule.get("endTime", -1)
        start_action = rule.get("startAction", ACTION_ON)
        end_action = rule.get("endAction", ACTION_NONE)
        countdown_time = rule.get("countdownTime", 0)
        device_id = rule.get("deviceId", "")

        for day in days:
            # Translate Dibby internal day → Belkin firmware DayID convention so
            # rules created here are also correctly read by the Belkin WeMo app.
            # Negative sentinel values (e.g. countdown -1) pass through unchanged.
            device_day_id = dibby_day_to_device(day) if int(day) > 0 else int(day)
            conn.execute("""
                INSERT INTO RULEDEVICES
                (RuleID, DeviceID, GroupID, DayID, StartTime, RuleDuration,
                 StartAction, EndAction, SensorDuration, CountdownTime, EndTime,
                 OnModeOffset, OffModeOffset)
                VALUES (?,?,0,?,?,0,?,?,2,?,?,?,?)
            """, (
                str(rule_id), device_id, device_day_id, start_secs,
                float(start_action), float(end_action),
                countdown_time, end_secs, -1, -1,
            ))

        conn.execute(
            "INSERT INTO TARGETDEVICES (RuleID, DeviceID, DeviceIndex) VALUES (?,?,0)",
            (str(rule_id), device_id),
        )
        conn.commit()

    await _modify_rules(host, port, _modify)
    return new_id[0] if new_id else -1


async def update_rule(host: str, port: int, rule_id: str, rule: dict) -> None:
    async def _do() -> None:
        await delete_rule(host, port, rule_id)
        rule["deviceId"] = rule.get("deviceId", "")
        await create_rule(host, port, rule)
    await _do()


async def delete_rule(host: str, port: int, rule_id: str) -> None:
    def _modify(conn: sqlite3.Connection, _version: str) -> None:
        conn.execute("DELETE FROM RULES WHERE RuleID=?", (str(rule_id),))
        conn.execute("DELETE FROM RULEDEVICES WHERE RuleID=?", (str(rule_id),))
        conn.execute("DELETE FROM TARGETDEVICES WHERE RuleID=?", (str(rule_id),))
        conn.commit()
    await _modify_rules(host, port, _modify)


async def toggle_rule(host: str, port: int, rule_id: str, enabled: bool) -> None:
    def _modify(conn: sqlite3.Connection, _version: str) -> None:
        conn.execute(
            "UPDATE RULES SET State=? WHERE RuleID=?",
            ("1" if enabled else "0", str(rule_id)),
        )
        conn.commit()
    await _modify_rules(host, port, _modify)
