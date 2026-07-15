/* Tiny IndexedDB wrapper for storing neighborhood photos as Blobs.
   Photos can be large, so they live in IndexedDB rather than localStorage. */
(function () {
  const DB_NAME = "nyc-tracker";
  const DB_VERSION = 1;
  const STORE = "photos";
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: "id" });
          os.createIndex("hood", "hood", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode) {
    return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  const PhotoStore = {
    // Add a photo record { id, hood, blob, createdAt }
    async add(record) {
      const store = await tx("readwrite");
      return new Promise((resolve, reject) => {
        const r = store.add(record);
        r.onsuccess = () => resolve(record);
        r.onerror = () => reject(r.error);
      });
    },

    // Get all photos for a neighborhood id, sorted oldest-first
    async listForHood(hood) {
      const store = await tx("readonly");
      return new Promise((resolve, reject) => {
        const out = [];
        const idx = store.index("hood");
        const r = idx.openCursor(IDBKeyRange.only(hood));
        r.onsuccess = () => {
          const cur = r.result;
          if (cur) { out.push(cur.value); cur.continue(); }
          else { out.sort((a, b) => a.createdAt - b.createdAt); resolve(out); }
        };
        r.onerror = () => reject(r.error);
      });
    },

    async get(id) {
      const store = await tx("readonly");
      return new Promise((resolve, reject) => {
        const r = store.get(id);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },

    async remove(id) {
      const store = await tx("readwrite");
      return new Promise((resolve, reject) => {
        const r = store.delete(id);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
    },

    async removeForHood(hood) {
      const photos = await this.listForHood(hood);
      await Promise.all(photos.map((p) => this.remove(p.id)));
    },

    async countAll() {
      const store = await tx("readonly");
      return new Promise((resolve, reject) => {
        const r = store.count();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },

    async clearAll() {
      const store = await tx("readwrite");
      return new Promise((resolve, reject) => {
        const r = store.clear();
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
    },

    // For export: return all records with blobs converted to data URLs
    async exportAll() {
      const store = await tx("readonly");
      const all = await new Promise((resolve, reject) => {
        const r = store.getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const withData = await Promise.all(
        all.map(
          (rec) =>
            new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve({ id: rec.id, hood: rec.hood, createdAt: rec.createdAt, data: reader.result });
              reader.readAsDataURL(rec.blob);
            })
        )
      );
      return withData;
    },

    // For import: takes records with data URLs, stores as blobs
    async importAll(records) {
      for (const rec of records || []) {
        try {
          const blob = await (await fetch(rec.data)).blob();
          const store = await tx("readwrite");
          await new Promise((resolve, reject) => {
            const r = store.put({ id: rec.id, hood: rec.hood, createdAt: rec.createdAt, blob });
            r.onsuccess = () => resolve();
            r.onerror = () => reject(r.error);
          });
        } catch (e) {
          console.warn("skip photo import", e);
        }
      }
    },
  };

  window.PhotoStore = PhotoStore;
})();
