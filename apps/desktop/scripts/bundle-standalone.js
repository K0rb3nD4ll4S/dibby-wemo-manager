'use strict';

/**
 * Bundles scheduler-standalone.js into a self-contained Node.js file
 * using esbuild.  Overwrites the electron-vite output so electron-builder
 * picks up the fully-bundled version (no node_modules required at runtime).
 *
 * Run after `electron-vite build`:
 *   node scripts/bundle-standalone.js
 */

const esbuild = require('esbuild');
const path    = require('path');

const ROOT = path.join(__dirname, '..');

esbuild.build({
  entryPoints: [path.join(ROOT, 'src/main/scheduler-standalone.js')],
  bundle:      true,
  platform:    'node',
  target:      'node18',
  format:      'cjs',
  outfile:     path.join(ROOT, 'out/main/scheduler-standalone.js'),
  // Only keep true Node.js built-ins external — everything else (axios, adm-zip,
  // xml2js, xmlbuilder2, sql.js, @wemo-manager/core …) gets bundled inline.
  external: [
    'electron',
    'fs', 'path', 'os', 'http', 'https', 'net', 'dgram',
    'crypto', 'zlib', 'stream', 'events', 'url', 'util',
    'child_process', 'cluster', 'worker_threads', 'assert',
    'buffer', 'string_decoder', 'querystring', 'readline',
    'tty', 'v8', 'vm', 'module', 'perf_hooks', 'timers',
  ],
  minify:    false,
  sourcemap: false,
}).then(() => {
  console.log('[bundle-standalone] ✅  out/main/scheduler-standalone.js written');
}).catch((e) => {
  console.error('[bundle-standalone] ❌  Failed:', e.message);
  process.exit(1);
});
