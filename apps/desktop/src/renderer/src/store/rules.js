import { create } from 'zustand';

const useRulesStore = create((set) => ({
  rules: [],
  locationInfo: null,
  loading: false,
  error: null,

  setRules: (rules, locationInfo) => set({ rules, locationInfo, error: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  updateRule: (ruleId, patch) => set((s) => ({
    rules: s.rules.map((r) => r.ruleId === ruleId ? { ...r, ...patch } : r),
  })),

  removeRule: (ruleId) => set((s) => ({
    rules: s.rules.filter((r) => r.ruleId !== ruleId),
  })),

  clear: () => set({ rules: [], locationInfo: null, error: null }),
}));

export default useRulesStore;
