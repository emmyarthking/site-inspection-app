/* Storage backend for the standalone Site Inspection Log.
   Gives the app the same small API it uses on claude.ai: db, assets, downloads.
   Mode is set in config.js: local (this phone only) or Supabase (shared). */
(() => {
  const CFG = window.SIL_CONFIG || {};
  const SHARED = !!(CFG.supabaseUrl && CFG.supabaseKey);
  const photoUrls = new Map();
  window.__photoUrl = id => photoUrls.get(id) || (SHARED ? CFG.supabaseUrl.replace(/\/$/, "") + "/storage/v1/object/public/photos/" + id + ".jpg" : "");

  // ---------- IndexedDB for local photos ----------
  const idbOpen = () => new Promise((res, rej) => {
    const r = indexedDB.open("sil-photos", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("p");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const idbTx = async (mode, fn) => { const d = await idbOpen(); return new Promise((res, rej) => { const t = d.transaction("p", mode); const q = fn(t.objectStore("p")); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  // ---------- snapshot helpers ----------
  const docSnap = (id, data) => ({ id, exists: data != null, data: () => data == null ? undefined : JSON.parse(JSON.stringify(data)) });
  const colSnap = rows => { const docs = Object.entries(rows).map(([id, d]) => docSnap(id, d)); return { docs, size: docs.length, empty: !docs.length }; };
  const split = path => { const i = path.lastIndexOf("/"); return [path.slice(0, i), path.slice(i + 1)]; };

  // ---------- local store (localStorage) ----------
  function localDb(){
    const key = c => "silstore:" + c;
    const read = c => { try { return JSON.parse(localStorage.getItem(key(c)) || "{}"); } catch { return {}; } };
    const write = (c, v) => localStorage.setItem(key(c), JSON.stringify(v));
    const subs = {};
    const emit = c => (subs[c] || []).forEach(f => f());
    const docRef = path => {
      const [c, id] = split(path);
      return {
        id, path,
        async get(){ return docSnap(id, read(c)[id]); },
        async set(data){ const all = read(c); all[id] = data; write(c, all); emit(c); },
        async update(data){ const all = read(c); all[id] = {...(all[id] || {}), ...data}; write(c, all); emit(c); },
        async delete(){ const all = read(c); delete all[id]; write(c, all); emit(c); },
        onSnapshot(next){ const f = () => next(docSnap(id, read(c)[id])); (subs[c] = subs[c] || []).push(f); setTimeout(f); return () => { subs[c] = subs[c].filter(x => x !== f); }; }
      };
    };
    return {
      doc: docRef,
      collection: c => ({
        doc: id => docRef(c + "/" + (id || rid())),
        onSnapshot(next){ const f = () => next(colSnap(read(c))); (subs[c] = subs[c] || []).push(f); setTimeout(f); return () => { subs[c] = subs[c].filter(x => x !== f); }; }
      })
    };
  }

  // ---------- shared store (Supabase) ----------
  let sb = null;
  function sharedDb(){
    const subs = {}; let channel = null;
    const fetchCol = async c => {
      const { data, error } = await sb.from("docs").select("id,data").eq("collection", c);
      if (error) throw { code: "unavailable", message: error.message };
      const rows = {}; data.forEach(r => rows[r.id] = r.data); return rows;
    };
    const refresh = c => (subs[c] || []).forEach(s => fetchCol(c).then(rows => s.next(rows), e => s.err && s.err(e)));
    const ensureChannel = () => {
      if (channel) return;
      channel = sb.channel("docs-changes").on("postgres_changes", { event: "*", schema: "public", table: "docs" }, p => {
        const c = (p.new && p.new.collection) || (p.old && p.old.collection); if (c) refresh(c); else Object.keys(subs).forEach(refresh);
      }).subscribe();
      window.addEventListener("online", () => Object.keys(subs).forEach(refresh));
      document.addEventListener("visibilitychange", () => { if (!document.hidden) Object.keys(subs).forEach(refresh); });
    };
    const docRef = path => {
      const [c, id] = split(path);
      return {
        id, path,
        async set(data){ const { error } = await sb.from("docs").upsert({ collection: c, id, data, updated_at: new Date().toISOString() }); if (error) throw { code: "unavailable", message: error.message }; refresh(c); },
        async delete(){ const { error } = await sb.from("docs").delete().eq("collection", c).eq("id", id); if (error) throw { code: "unavailable", message: error.message }; refresh(c); },
        onSnapshot(next, err){ ensureChannel(); const s = { next: rows => next(docSnap(id, rows[id])), err }; (subs[c] = subs[c] || []).push(s); refresh(c); return () => { subs[c] = subs[c].filter(x => x !== s); }; }
      };
    };
    return {
      doc: docRef,
      collection: c => ({
        doc: id => docRef(c + "/" + (id || rid())),
        onSnapshot(next, err){ ensureChannel(); const s = { next: rows => next(colSnap(rows)), err }; (subs[c] = subs[c] || []).push(s); refresh(c); return () => { subs[c] = subs[c].filter(x => x !== s); }; }
      })
    };
  }

  // ---------- photos ----------
  const assets = {
    async upload(blob){
      const id = rid() + rid();
      if (SHARED) {
        const { error } = await sb.storage.from("photos").upload(id + ".jpg", blob, { contentType: "image/jpeg", upsert: false });
        if (error) throw { code: "upstream_error", message: error.message };
      } else {
        await idbTx("readwrite", s => s.put(blob, id));
      }
      photoUrls.set(id, URL.createObjectURL(blob));
      return { id, url: photoUrls.get(id), sizeBytes: blob.size, contentType: "image/jpeg" };
    }
  };
  async function loadLocalPhotos(){
    try {
      const d = await idbOpen();
      await new Promise(res => { const t = d.transaction("p"); const s = t.objectStore("p"); const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { photoUrls.set(cur.key, URL.createObjectURL(cur.value)); cur.continue(); } }; t.oncomplete = res; t.onerror = res; });
    } catch {}
  }

  // ---------- downloads ----------
  const downloads = {
    async save({ filename, data }){
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { status: "saved" };
    }
  };

  // ---------- sign-in (shared mode) ----------
  function signIn(){
    return new Promise(resolve => {
      const box = document.getElementById("login");
      box.hidden = false;
      const f = document.getElementById("login-form"), m = document.getElementById("login-msg");
      f.onsubmit = async e => {
        e.preventDefault(); m.textContent = "Signing in…"; m.className = "msg";
        const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
        if (error) { m.textContent = navigator.onLine ? "Email or password is wrong." : "You're offline. Connect once to sign in."; m.className = "msg err"; return; }
        box.hidden = true; resolve();
      };
    });
  }
  async function signOut(){ if (sb) await sb.auth.signOut(); location.reload(); }
  window.__silSignOut = SHARED ? signOut : null;

  // ---------- boot ----------
  const ready = (async () => {
    if (!SHARED) { await loadLocalPhotos(); return { db: localDb(), assets, downloads }; }
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true } });
    const { data } = await sb.auth.getSession();
    if (!data.session) {
      if (!navigator.onLine) return { db: null, assets: null, downloads };  // offline before first sign-in: work locally, sync later
      await signIn();
    }
    return { db: sharedDb(), assets, downloads };
  })();
  window.claude = { use: async name => { const b = await ready; return b[name] || null; } };
})();
