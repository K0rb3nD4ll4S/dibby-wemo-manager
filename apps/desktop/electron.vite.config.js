import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const CORE_DIR = resolve(__dirname, '../../packages/wemo-core/src');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        // Bundle workspace package inline instead of externalizing it
        '@wemo-manager/core/src': CORE_DIR,
        '@wemo-manager/core': resolve(__dirname, '../../packages/wemo-core/src/index.js'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index:  resolve(__dirname, 'src/main/index.js'),
          wemo:   resolve(__dirname, 'src/main/wemo.js'),
          store:  resolve(__dirname, 'src/main/store.js'),
          'ipc/devices.ipc':   resolve(__dirname, 'src/main/ipc/devices.ipc.js'),
          'ipc/rules.ipc':     resolve(__dirname, 'src/main/ipc/rules.ipc.js'),
          'ipc/wifi.ipc':      resolve(__dirname, 'src/main/ipc/wifi.ipc.js'),
          'ipc/system.ipc':    resolve(__dirname, 'src/main/ipc/system.ipc.js'),
          'ipc/scheduler.ipc': resolve(__dirname, 'src/main/ipc/scheduler.ipc.js'),
          'ipc/homekit.ipc':   resolve(__dirname, 'src/main/ipc/homekit.ipc.js'),
          'homekit-bridge':    resolve(__dirname, 'src/main/homekit-bridge.js'),
          scheduler:           resolve(__dirname, 'src/main/scheduler.js'),
          'scheduler-standalone': resolve(__dirname, 'src/main/scheduler-standalone.js'),
          'service-manager':      resolve(__dirname, 'src/main/service-manager.js'),
          'service-manager-sync': resolve(__dirname, 'src/main/service-manager-sync.js'),
          'web-server':           resolve(__dirname, 'src/main/web-server.js'),
          'firewall':             resolve(__dirname, 'src/main/firewall.js'),
          'core/sun':             resolve(__dirname, 'src/main/core/sun.js'),
          'core/types':           resolve(__dirname, 'src/main/core/types.js'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.js'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
});
