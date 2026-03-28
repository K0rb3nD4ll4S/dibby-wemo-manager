'use strict';

/** Day numbers: 1=Monday ... 7=Sunday (Wemo convention) */
const DAY_NUMBERS = { Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6, Sunday:7 };
const DAY_NAMES   = { 1:'Monday', 2:'Tuesday', 3:'Wednesday', 4:'Thursday', 5:'Friday', 6:'Saturday', 7:'Sunday' };
const DAY_SHORT   = { 1:'Mon', 2:'Tue', 3:'Wed', 4:'Thu', 5:'Fri', 6:'Sat', 7:'Sun' };

/** Rule types stored in RULES.Type */
const RULE_TYPES = {
  SCHEDULE:  'Schedule',
  AWAY:      'Away',
  COUNTDOWN: 'Countdown',
  LONG_PRESS: 'Long Press',
};

/** Start/End action values */
const ACTIONS = { ON: 1.0, OFF: 0.0, TOGGLE: 2.0, NONE: -1.0 };

/** Network status codes returned by GetNetworkStatus */
const NETWORK_STATUS = { FAILED: '0', SUCCESS: '1', WRONG_PASSWORD: '2', CONNECTING: '3' };

/** Wemo device reset codes for ReSetup action */
const RESET_CODES = { CLEAR_DATA: 1, FACTORY_RESET: 2, CLEAR_WIFI: 5 };

/** Default RULEDEVICES field values */
const RD_DEFAULTS = {
  GroupID: 0,
  RuleDuration: 0,
  StartAction: 1.0,
  EndAction: -1.0,
  SensorDuration: 2,
  Type: -1,
  Value: -1,
  Level: -1,
  ZBCapabilityStart: '',
  ZBCapabilityEnd: '',
  OnModeOffset: -1,
  OffModeOffset: -1,
  CountdownTime: 0,
  EndTime: -1,
};

/** Sun time sentinel codes stored in RULEDEVICES.StartTime / EndTime */
const SUN_CODES = { SUNRISE: -2, SUNSET: -3 };

function namesToDayNumbers(names) {
  return names.map((n) => DAY_NUMBERS[n]).filter(Boolean).sort((a, b) => a - b);
}

function dayNumbersToNames(numbers) {
  return numbers.map((n) => DAY_NAMES[n]).filter(Boolean);
}

function dayNumbersToShort(numbers) {
  return numbers.map((n) => DAY_SHORT[n]).filter(Boolean);
}

function timeToSecs(hhmm) {
  if (!hhmm || !hhmm.includes(':')) return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60;
}

function secsToHHMM(secs) {
  if (secs === undefined || secs === null || secs < 0) return '00:00';
  const h = Math.floor(secs / 3600) % 24;
  const m = Math.floor((secs % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

module.exports = {
  DAY_NUMBERS, DAY_NAMES, DAY_SHORT,
  RULE_TYPES, ACTIONS, NETWORK_STATUS, RESET_CODES, RD_DEFAULTS, SUN_CODES,
  namesToDayNumbers, dayNumbersToNames, dayNumbersToShort,
  timeToSecs, secsToHHMM,
};
