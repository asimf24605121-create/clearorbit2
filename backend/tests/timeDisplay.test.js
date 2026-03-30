// Regression tests for time-display boundaries.
// Run: node backend/tests/timeDisplay.test.js
// These tests use fixed ms values — no Date.now() drift.

import { formatRemainingMs } from '../utils/helpers.js';

const TESTS = [
  [0,                    'Expired',          '0ms'],
  [30000,                'Expiring now',     '30s'],
  [59000,                'Expiring now',     '59s'],
  [60000,                '1m left',          'exactly 1m'],
  [59 * 60000,           '59m left',         'exactly 59m'],
  [3600000,              '1h left',          'exactly 1h'],
  [5400000,              '1h 30m left',      '1h 30m'],
  [23 * 3600000,         '23h left',         'exactly 23h'],
  [23 * 3600000 + 59 * 60000, '23h 59m left', '23h 59m'],
  [86399000,             '23h 59m left',     '23h 59m 59s'],
  [86400000,             '1d left',          'exactly 24h'],
  [86400000 + 60000,     '1d left',          '24h 1m'],
  [86400000 + 1800000,   '1d left',          '24h 30m'],
  [90000000,             '1d 1h left',       '25h'],
  [169200000,            '1d 23h left',      '47h'],
  [172800000,            '2d left',          'exactly 48h'],
  [259200000,            '3d left',          'exactly 72h'],
  [604800000,            '7d left',          'exactly 7d'],
  [2592000000,           '30d left',         'exactly 30d'],
  [180000000,            '2d 2h left',       '50h'],
  [262800000,            '3d 1h left',       '73h'],
  [-1000,                'Expired',          'negative'],
  [NaN,                  'Expired',          'NaN'],
  [Infinity,             'Expired',          'Infinity'],
  [null,                 'Expired',          'null'],
  [undefined,            'Expired',          'undefined'],
];

let pass = 0, fail = 0;
for (const [ms, expected, label] of TESTS) {
  const result = formatRemainingMs(ms);
  if (result === expected) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label} (${ms}ms) → "${result}" expected "${expected}"`);
  }
}

console.log(`\n${pass}/${TESTS.length} passed, ${fail} failed`);
if (fail > 0) {
  console.error('REGRESSION DETECTED — time display boundaries are broken');
  process.exit(1);
} else {
  console.log('All time-display boundary tests passed');
}
