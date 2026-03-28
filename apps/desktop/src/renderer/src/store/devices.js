import { create } from 'zustand';

const useDeviceStore = create((set, get) => ({
  devices: [],           // all discovered/saved devices
  selectedUdn: null,     // currently selected device UDN
  deviceGroups: [],
  deviceOrder: [],
  discovering: false,

  get selectedDevice() {
    return get().devices.find((d) => d.udn === get().selectedUdn) ?? null;
  },

  setDevices: (devices) => set({ devices }),

  mergeDevice: (device) => set((s) => {
    const idx = s.devices.findIndex((d) => d.udn === device.udn);
    if (idx >= 0) {
      const updated = [...s.devices];
      updated[idx] = { ...updated[idx], ...device };
      return { devices: updated };
    }
    return { devices: [...s.devices, device] };
  }),

  updateDevice: (udn, patch) => set((s) => ({
    devices: s.devices.map((d) => d.udn === udn ? { ...d, ...patch } : d),
  })),

  selectDevice: (udn) => set({ selectedUdn: udn }),

  setDiscovering: (v) => set({ discovering: v }),
  setDeviceGroups: (g) => set({ deviceGroups: g }),
  setDeviceOrder:  (o) => set({ deviceOrder: o }),
}));

export default useDeviceStore;
