// Imported sample connections for this tab only: in memory, never persisted, never sent anywhere.
import { create } from 'zustand';
import { CONNECTIONS, importSample } from './index';
import type { Reconciled } from './reconcile';

interface SampleImports {
  imported: Record<string, Reconciled>;
  busy: Record<string, boolean>;
  error: string | null;
  importOne: (id: string) => Promise<void>;
  importAll: () => Promise<void>;
  remove: (id: string) => void;
}

export const useSampleImports = create<SampleImports>((set, get) => ({
  imported: {}, busy: {}, error: null,
  async importOne(id) {
    if (get().busy[id]) return;
    set((s) => ({ busy: { ...s.busy, [id]: true }, error: null }));
    try {
      const result = await importSample(id);
      set((s) => ({ imported: { ...s.imported, [id]: result } }));
    } catch {
      set({ error: 'The sample could not be loaded. Reload the page and try again.' });
    } finally {
      set((s) => ({ busy: { ...s.busy, [id]: false } }));
    }
  },
  async importAll() {
    await Promise.all(CONNECTIONS.map((c) => get().importOne(c.id)));
  },
  remove(id) {
    set((s) => {
      const imported = { ...s.imported };
      delete imported[id];
      return { imported };
    });
  },
}));

/** The imported connections in the fixed display order. */
export const importedList = (imported: Record<string, Reconciled>): Reconciled[] => CONNECTIONS.flatMap((c) => (imported[c.id] ? [imported[c.id]] : []));
