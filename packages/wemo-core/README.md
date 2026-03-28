# @wemo-manager/core

**Shared Wemo protocol constants and utilities used by both the Dibby Wemo Manager desktop app and the Homebridge plugin.**

This is an internal package within the `dibby-wemo-manager` monorepo. It is not published to npm — both packages reference it via npm workspaces.

---

## What's in here

### Constants

| Export | Description |
|---|---|
| `DAY_NUMBERS` | Map of day names → Wemo day numbers (Monday=1 … Sunday=7) |
| `DAY_NAMES` | Map of Wemo day numbers → full names |
| `DAY_SHORT` | Map of Wemo day numbers → abbreviated names (Mon, Tue…) |
| `RULE_TYPES` | Wemo firmware rule type strings (Schedule, Away, Countdown, Long Press) |
| `ACTIONS` | StartAction / EndAction numeric codes (ON=1, OFF=0, TOGGLE=2, NONE=-1) |
| `NETWORK_STATUS` | GetNetworkStatus response codes |
| `RESET_CODES` | ReSetup action codes (clear data, factory reset, clear WiFi) |
| `RD_DEFAULTS` | Default field values for a new RULEDEVICES row |
| `SUN_CODES` | Sentinel values for sunrise (−2) and sunset (−3) in StartTime/EndTime |

### Helper functions

| Function | Signature | Description |
|---|---|---|
| `namesToDayNumbers` | `(names: string[]) => number[]` | Convert day name array to sorted Wemo day numbers |
| `dayNumbersToNames` | `(numbers: number[]) => string[]` | Convert day numbers to full name array |
| `dayNumbersToShort` | `(numbers: number[]) => string[]` | Convert day numbers to abbreviated name array |
| `timeToSecs` | `(hhmm: string) => number` | Parse `"HH:MM"` to seconds from midnight |
| `secsToHHMM` | `(secs: number) => string` | Format seconds from midnight to `"HH:MM"` |
| `sunTimes` | `(lat, lng, date?) => { sunrise, sunset }` | Calculate sunrise/sunset as seconds from midnight |

---

## Wemo day number convention

Wemo devices use **1-based day numbers**, not bitmasks:

| Number | Day |
|---|---|
| 1 | Monday |
| 2 | Tuesday |
| 3 | Wednesday |
| 4 | Thursday |
| 5 | Friday |
| 6 | Saturday |
| 7 | Sunday |

Multi-day rules have one `RULEDEVICES` row **per day** — not a single row with a bitmask.

---

## Sun time sentinel codes

When a rule's `StartTime` or `EndTime` is set to one of these values, the scheduler resolves it to the actual sunrise/sunset time for the configured location:

| Constant | Value | Meaning |
|---|---|---|
| `SUN_CODES.SUNRISE` | `-2` | Use today's sunrise time |
| `SUN_CODES.SUNSET` | `-3` | Use today's sunset time |

---

## Usage

```js
const {
  DAY_NUMBERS,
  namesToDayNumbers,
  secsToHHMM,
  sunTimes,
  SUN_CODES,
} = require('@wemo-manager/core');

// Convert user-selected days to Wemo day numbers
const days = namesToDayNumbers(['Monday', 'Wednesday', 'Friday']);
// → [1, 3, 5]

// Format a time stored as seconds from midnight
console.log(secsToHHMM(75600)); // "21:00" (9 PM)

// Check if a StartTime is a sunrise/sunset sentinel
if (startTime === SUN_CODES.SUNRISE) {
  const { sunrise } = sunTimes(lat, lng);
  startTime = sunrise;
}
```

---

## File structure

```
packages/wemo-core/
├── package.json
└── src/
    ├── index.js   — re-exports everything from sun.js and types.js
    ├── types.js   — constants + day/time helper functions
    └── sun.js     — NOAA sunrise/sunset calculator (pure JS, no deps)
```

---

## Notes

- **No external dependencies** — pure JavaScript, no npm packages required.
- `sun.js` implements the NOAA Solar Calculator algorithm (Jean Meeus, *Astronomical Algorithms*). It returns `null` for each value during polar day/polar night.
- `secsToHHMM` returns `"00:00"` for negative input (used for no-time sentinel values like `−1`).
- The DWM scheduler in both the desktop app and the Homebridge plugin uses `SUN_CODES` to resolve rule times at tick time, so sunrise/sunset-based rules automatically adjust every day.

---

## License

MIT
