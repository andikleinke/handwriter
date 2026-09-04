/**
 * Saved hands. A hand fitted from a font (src/pen/fit.js) is kept in
 * IndexedDB so it is offered again on the next visit, next to the built-in
 * hands. The last choice is remembered in localStorage.
 */

const DB = 'handwriter-hands';
const STORE = 'hands';
const CHOICE_KEY = 'handwriter.hand.choice';

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

export const handStore = {
  /** @returns {Promise<Array<{id:string,name:string,fontKey:string,added:number,hand:object}>>} oldest first */
  async list() {
    try {
      const db = await open();
      const all = await tx(db, 'readonly', (s) => s.getAll());
      return (all || []).sort((a, b) => a.added - b.added);
    } catch {
      return [];
    }
  },
  async add(name, fontKey, hand) {
    const id = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const db = await open();
    await tx(db, 'readwrite', (s) => s.put({ id, name, fontKey, added: Date.now(), hand }));
    return id;
  },
  async get(id) {
    const db = await open();
    return (await tx(db, 'readonly', (s) => s.get(id))) ?? null;
  },
  async remove(id) {
    const db = await open();
    await tx(db, 'readwrite', (s) => s.delete(id));
  },
  get choice() {
    try { return localStorage.getItem(CHOICE_KEY) || 'school'; } catch { return 'school'; }
  },
  set choice(id) {
    try { localStorage.setItem(CHOICE_KEY, id); } catch { /* private mode */ }
  },
};
