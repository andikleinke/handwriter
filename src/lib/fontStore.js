/**
 * Saved fonts. Uploaded font files are kept in IndexedDB so they are offered
 * again on the next visit; the bundled default font is not stored, it is
 * always the first choice. The last choice is remembered in localStorage.
 */

const DB = 'handwriter-fonts';
const STORE = 'fonts';
const CHOICE_KEY = 'handwriter.font.choice';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const fontStore = {
  /** @returns {Promise<Array<{id:string,name:string,family:string,added:number,size:number}>>} newest last */
  async list() {
    try {
      const db = await open();
      const all = await tx(db, 'readonly', (s) => s.getAll());
      return (all || [])
        .map(({ bytes, ...meta }) => ({ ...meta, size: bytes?.byteLength ?? 0 }))
        .sort((a, b) => a.added - b.added);
    } catch {
      return [];
    }
  },
  async add(name, family, bytes) {
    const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const db = await open();
    await tx(db, 'readwrite', (s) => s.put({ id, name, family, added: Date.now(), bytes }));
    return id;
  },
  async bytes(id) {
    const db = await open();
    const rec = await tx(db, 'readonly', (s) => s.get(id));
    return rec?.bytes ?? null;
  },
  async remove(id) {
    const db = await open();
    await tx(db, 'readwrite', (s) => s.delete(id));
  },
  get choice() {
    try { return localStorage.getItem(CHOICE_KEY) || 'default'; } catch { return 'default'; }
  },
  set choice(id) {
    try { localStorage.setItem(CHOICE_KEY, id); } catch { /* private mode */ }
  },
};
