import { create } from 'zustand';

const useSettingsStore = create((set) => ({
  theme: 'dark',
  location: null,   // { lat, lng, label, city, country, countryCode, region }
  toasts: [],

  setTheme: (theme) => {
    document.documentElement.classList.toggle('light', theme === 'light');
    set({ theme });
  },

  setLocation: (location) => set({ location }),

  addToast: (msg, type = 'info', duration = 3500) => {
    const id = Date.now();
    set((s) => ({ toasts: [...s.toasts, { id, msg, type }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, duration);
  },

  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export default useSettingsStore;
