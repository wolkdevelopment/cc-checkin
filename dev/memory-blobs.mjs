/* An in-memory stand-in for @netlify/blobs, for tests and the local dev server.
   It follows the documented behavior used by core.mjs: get / getWithMetadata (with etags, and a
   conditional read that returns data: null when the etag still matches), set / setJSON with
   onlyIfMatch and onlyIfNew, list by prefix, and delete. */
export function createMemoryBlobs() {
  const stores = new Map();
  let tick = 0;
  function getStore(opts) {
    const name = typeof opts === "string" ? opts : opts.name;
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    const read = (e, type) => (type === "json" ? JSON.parse(e.v) : e.v);
    function write(key, v, o = {}) {
      const cur = m.get(key);
      if (o.onlyIfNew && cur) return { modified: false };
      if (o.onlyIfMatch && (!cur || cur.etag !== o.onlyIfMatch)) return { modified: false };
      const e = { v, etag: '"' + (++tick).toString(36) + '"', meta: o.metadata || {} };
      m.set(key, e);
      return { modified: true, etag: e.etag };
    }
    const later = v => new Promise(r => setImmediate(() => r(v))); // reads and writes resolve later, like a network
    return {
      get: async (key, o = {}) => later(m.has(key) ? read(m.get(key), o.type) : null),
      getWithMetadata: async (key, o = {}) => later(!m.has(key) ? null
        : o.etag && o.etag === m.get(key).etag ? { data: null, etag: m.get(key).etag, metadata: m.get(key).meta }
        : { data: read(m.get(key), o.type), etag: m.get(key).etag, metadata: m.get(key).meta }),
      set: async (key, v, o) => later(write(key, String(v), o)),
      setJSON: async (key, v, o) => later(write(key, JSON.stringify(v), o)),
      list: async ({ prefix = "" } = {}) => later({ blobs: [...m.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, e]) => ({ key: k, etag: e.etag })), directories: [] }),
      delete: async key => later(void m.delete(key))
    };
  }
  return { getStore, stores };
}
