"""Constants for the Dibby Wemo integration."""

DOMAIN = "dibby_wemo"
MANUFACTURER = "Belkin"

# Polling intervals
HEALTH_POLL_S = 10
TICK_S = 30
CATCHUP_WINDOW_S = 600  # 10 minutes

# Default SSDP / discovery
SSDP_MULTICAST = "239.255.255.250"
SSDP_PORT = 1900
DEFAULT_DISCOVERY_TIMEOUT_S = 10
DEFAULT_POLL_INTERVAL_S = 30

# Wemo device port candidates (tried in order)
WEMO_PORTS = [49153, 49152, 49154, 49155, 49156]

# SOAP services
SERVICE_BASICEVENT = "urn:Belkin:service:basicevent:1"
SERVICE_RULES      = "urn:Belkin:service:rules:1"
CONTROL_BASICEVENT = "/upnp/control/basicevent1"
CONTROL_RULES      = "/upnp/control/rules1"

# Action codes (stored as floats in SQLite)
ACTION_ON     =  1
ACTION_OFF    =  0
ACTION_TOGGLE =  2
ACTION_NONE   = -1

# Sun time sentinels stored in StartTime/EndTime
SUN_SUNRISE = -2
SUN_SUNSET  = -3

# Wemo day numbering: 1=Mon … 7=Sun
# Python datetime.weekday(): 0=Mon … 6=Sun  (6→7 for Sunday)
WEMO_DAY_NAMES = {
    1: "Monday", 2: "Tuesday", 3: "Wednesday",
    4: "Thursday", 5: "Friday", 6: "Saturday", 7: "Sunday",
}
WEMO_DAY_SHORT = {
    1: "Mon", 2: "Tue", 3: "Wed",
    4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun",
}

# Heartbeat default interval
HEARTBEAT_S = 1

# Config entry keys
CONF_DISCOVERY_TIMEOUT  = "discovery_timeout"
CONF_POLL_INTERVAL      = "poll_interval"
CONF_MANUAL_DEVICES     = "manual_devices"
CONF_HEARTBEAT_INTERVAL = "heartbeat_interval"

# Store filename inside HA config dir
STORE_FILENAME = "dibby-wemo.json"
