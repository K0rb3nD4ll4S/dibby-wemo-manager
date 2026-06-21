'use strict';

/**
 * Bundles scheduler-standalone.js into a self-contained Node.js file
 * using esbuild.  Overwrites the electron-vite output so electron-builder
 * picks up the fully-bundled version (no node_modules required at runtime).
 *
 * ALSO installs runtime dependencies for the Windows-only add-on tool at
 * tools/clear-wemo-rules/ so it can ship as a stand-alone tarball inside
 * the installer (the user clicks Start menu → Clear Wemo Firmware Rules,
 * the .cmd runs node.exe on the bundled script, deps resolve from the
 * tool's own node_modules).
 *
 * Run after `electron-vite build`:
 *   node scripts/bundle-standalone.js
 */

const esbuild      = require('esbuild');
const path         = require('path');
const fs           = require('fs');
const { spawnSync } = require('child_process');

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

  // ── Install tool dependencies into tools/clear-wemo-rules/node_modules ───
  //
  // The clear-wemo-rules Windows add-on is shipped as a folder under
  // resources/tools/clear-wemo-rules/ via electron-builder's extraResources
  // (the parent `tools` directory is already mapped).  It uses the same
  // axios + adm-zip + xml2js + xmlbuilder2 + sql.js stack as the main app,
  // but Node can't require modules from inside an asar archive — so the
  // tool gets its OWN node_modules at build time and ships it intact.
  //
  // Skip silently if the npm install fails (CI without internet, etc.) —
  // the tool just won't be functional until the user runs npm install
  // themselves.  Logged loudly so it's not invisible.
  const toolDir = path.join(ROOT, 'tools', 'clear-wemo-rules');
  if (!fs.existsSync(path.join(toolDir, 'package.json'))) {
    console.log('[bundle-standalone] (no clear-wemo-rules tool dir found — skipping)');
    return;
  }
  if (fs.existsSync(path.join(toolDir, 'node_modules'))) {
    console.log('[bundle-standalone] clear-wemo-rules/node_modules already present, skipping npm install');
    return;
  }
  console.log('[bundle-standalone] installing clear-wemo-rules deps…');
  const r = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'],
    { cwd: toolDir, stdio: 'inherit' },
  );
  if (r.status === 0) {
    console.log('[bundle-standalone] ✅  clear-wemo-rules/node_modules installed');
  } else {
    console.warn(`[bundle-standalone] ⚠  clear-wemo-rules npm install exit=${r.status} — tool will be non-functional until installed`);
  }
}).catch((e) => {
  console.error('[bundle-standalone] ❌  Failed:', e.message);
  process.exit(1);
});
