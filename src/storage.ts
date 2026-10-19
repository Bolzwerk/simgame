// Speicherstände: über die Android-Brücke (Dateien in der App) oder localStorage im Browser.

interface AndroidBridge {
  save(key: string, data: string): boolean;
  load(key: string): string | null;
  remove(key: string): void;
  exit(): void;
}

declare global {
  interface Window {
    AndroidBridge?: AndroidBridge;
    onAndroidBack?: () => boolean;
    onAndroidPause?: () => void;
  }
}

export const SLOTS = ['autosave', 'slot1', 'slot2', 'slot3'] as const;
export type Slot = (typeof SLOTS)[number];

export interface SaveMeta {
  name: string;
  year: number;
  month: number;
  pop: number;
  funds: number;
  difficulty: string;
  savedAt: number;
}

function raw(): { save(k: string, d: string): boolean; load(k: string): string | null; remove(k: string): void } {
  const b = window.AndroidBridge;
  if (b) return b;
  return {
    save(k, d) {
      try {
        localStorage.setItem('pixelpolis:' + k, d);
        return true;
      } catch {
        return false;
      }
    },
    load(k) {
      try {
        return localStorage.getItem('pixelpolis:' + k);
      } catch {
        return null;
      }
    },
    remove(k) {
      try {
        localStorage.removeItem('pixelpolis:' + k);
      } catch {
        /* ignorieren */
      }
    },
  };
}

export function saveGame(slot: Slot, data: string, meta: SaveMeta): boolean {
  const s = raw();
  const ok = s.save('save_' + slot, data);
  if (ok) s.save('meta_' + slot, JSON.stringify(meta));
  return ok;
}

export function loadGame(slot: Slot): string | null {
  return raw().load('save_' + slot);
}

export function loadMeta(slot: Slot): SaveMeta | null {
  const m = raw().load('meta_' + slot);
  if (!m) return null;
  try {
    return JSON.parse(m) as SaveMeta;
  } catch {
    return null;
  }
}

export function deleteGame(slot: Slot): void {
  raw().remove('save_' + slot);
  raw().remove('meta_' + slot);
}

export function loadPref(key: string): string | null {
  return raw().load('pref_' + key);
}

export function savePref(key: string, v: string): void {
  raw().save('pref_' + key, v);
}

export function exitApp(): void {
  window.AndroidBridge?.exit();
}
