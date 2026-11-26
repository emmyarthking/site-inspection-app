/* Storage for the Site Inspection Log: dual storage.
   1. Every change is saved on the phone first (works offline, no waiting).
   2. When config.js has a Supabase project and the user is signed in, changes
      sync both ways with the shared online copy whenever there is a connection.
   The app talks to this through the same small API it uses on claude.ai:
   claude.use("db" | "assets" | "downloads"). */
(() => {
  const CFG = window.SIL_CONFIG || {};
  const CLOUD = !!(CFG.supabaseUrl && CFG.supabaseKey);
  const COLS = ["inspections", "locations", "config"];
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  // ---------- local document store (localStorage) ----------
  const K = c => "silstore:" + c;
  const read = c => { try { return JSON.parse(localStorage.getItem(K(c)) || "{}"); } catch { return {}; } };
  const write = (c, v) => { try { localStorage.setItem(K(c), JSON.stringify(v)); } catch {} };
  const outbox = { get(){ try { return JSON.parse(localStorage.getItem("silstore:outbox") || "[]"); } catch { return []; } },
                   set(v){ try { localStorage.setItem("silstore:outbox", JSON.stringify(v)); } catch {} } };
  const queue = (op, c, id, data) => { const o = outbox.get().filter(x => !(x.c === c && x.id === id)); o.push({op, c, id, data}); outbox.set(o); };

  const subs = {};
  const emit = c => (subs[c] || []).forEach(f => f());
  const docSnap = (id, data) => ({ id, exists: data != null, data: () => data == null ? undefined : JSON.parse(JSON.stringify(data)) });
  const colSnap = rows => { const docs = Object.entries(rows).map(([id, d]) => docSnap(id, d)); return { docs, size: docs.length, empty: !docs.length }; };
  const split = p => { const i = p.lastIndexOf("/"); return [p.slice(0, i), p.slice(i + 1)]; };

  const docRef = path => {
    const [c, id] = split(path);
    return {
      id, path,
      async get(){ return docSnap(id, read(c)[id]); },
      async set(data){ const all = read(c); all[id] = data; write(c, all); queue("set", c, id, data); emit(c); kick(); },
      async update(data){ const all = read(c); all[id] = {...(all[id] || {}), ...data}; write(c, all); queue("set", c, id, all[id]); emit(c); kick(); },
      async delete(){ const all = read(c); delete all[id]; write(c, all); queue("del", c, id); emit(c); kick(); },
      onSnapshot(next){ const f = () => next(docSnap(id, read(c)[id])); (subs[c] = subs[c] || []).push(f); setTimeout(f); return () => { subs[c] = subs[c].filter(x => x !== f); }; }
    };
  };
  const db = {
    doc: docRef,
    collection: c => ({
      doc: id => docRef(c + "/" + (id || rid())),
      onSnapshot(next){ const f = () => next(colSnap(read(c))); (subs[c] = subs[c] || []).push(f); setTimeout(f); return () => { subs[c] = subs[c].filter(x => x !== f); }; }
    })
  };

  // ---------- photos: IndexedDB on the phone, Supabase Storage in the cloud ----------
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open("sil-photos", 1); r.onupgradeneeded = () => r.result.createObjectStore("p"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const idbDo = async (mode, fn) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction("p", mode); const q = fn(t.objectStore("p")); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  const photoUrls = new Map();
  const photoOut = { get(){ try { return JSON.parse(localStorage.getItem("silstore:photoOut") || "[]"); } catch { return []; } },
                     set(v){ try { localStorage.setItem("silstore:photoOut", JSON.stringify(v)); } catch {} } };
  const remotePhoto = id => CFG.supabaseUrl.replace(/\/$/, "") + "/storage/v1/object/public/photos/" + id + ".jpg";
  window.__photoUrl = id => photoUrls.get(id) || (CLOUD ? remotePhoto(id) : "");
  const assets = {
    async upload(blob){
      const id = rid() + rid();
      await idbDo("readwrite", s => s.put(blob, id));
      photoUrls.set(id, URL.createObjectURL(blob));
      if (CLOUD) { photoOut.set([...photoOut.get(), id]); kick(); }
      return { id, url: photoUrls.get(id), sizeBytes: blob.size, contentType: "image/jpeg" };
    }
  };
  async function loadLocalPhotos(){
    try { const d = await idb(); await new Promise(res => { const t = d.transaction("p"); const cur = t.objectStore("p").openCursor(); cur.onsuccess = () => { const c = cur.result; if (c) { photoUrls.set(c.key, URL.createObjectURL(c.value)); c.continue(); } }; t.oncomplete = res; t.onerror = res; }); } catch {}
  }

  // ---------- downloads ----------
  const downloads = { async save({ filename, data }){
    const blob = data instanceof Blob ? data : new Blob([data]);
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return { status: "saved" };
  } };

  // ---------- cloud sync ----------
  let sb = null, session = null, syncing = false, again = false, lastSync = null, lastErr = "";
  const note = () => {
    const el = document.getElementById("cloud-note"); if (!el) return;
    const n = outbox.get().length + photoOut.get().length;
    if (!CLOUD) { el.textContent = "Saved on this phone"; return; }
    if (!session) { el.textContent = "Saved on this phone · sign in to sync"; return; }
    if (!navigator.onLine) { el.textContent = n ? n + " change" + (n > 1 ? "s" : "") + " waiting for connection" : "Offline · saved on this phone"; return; }
    el.textContent = lastErr ? "Sync problem: " + lastErr : n ? "Syncing " + n + " change" + (n > 1 ? "s" : "") + "…" : "Synced" + (lastSync ? " at " + lastSync.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) : "");
  };
  function kick(){ note(); if (CLOUD && session && navigator.onLine) sync(); }
  async function sync(){
    if (syncing) { again = true; return; }
    syncing = true; lastErr = "";
    try {
      // 1. photos up
      for (const id of photoOut.get()) {
        const blob = await idbDo("readonly", s => s.get(id));
        if (blob) { const { error } = await sb.storage.from("photos").upload(id + ".jpg", blob, { contentType: "image/jpeg", upsert: true }); if (error) throw error; }
        photoOut.set(photoOut.get().filter(x => x !== id));
      }
      // 2. changes up
      for (const o of outbox.get()) {
        const { error } = o.op === "del"
          ? await sb.from("docs").delete().eq("collection", o.c).eq("id", o.id)
          : await sb.from("docs").upsert({ collection: o.c, id: o.id, data: o.data, updated_at: new Date().toISOString() });
        if (error) throw error;
        outbox.set(outbox.get().filter(x => !(x.c === o.c && x.id === o.id && x.op === o.op)));
      }
      // 3. everyone's changes down: phone copy = cloud copy + anything still waiting to upload
      const { data, error } = await sb.from("docs").select("collection,id,data");
      if (error) throw error;
      const fresh = {}; COLS.forEach(c => fresh[c] = {});
      data.forEach(r => { (fresh[r.collection] = fresh[r.collection] || {})[r.id] = r.data; });
      for (const o of outbox.get()) { if (o.op === "del") delete fresh[o.c][o.id]; else (fresh[o.c] = fresh[o.c] || {})[o.id] = o.data; }
      Object.keys(fresh).forEach(c => { if (JSON.stringify(fresh[c]) !== JSON.stringify(read(c))) { write(c, fresh[c]); emit(c); } });
      lastSync = new Date();
    } catch (e) { lastErr = navigator.onLine ? (e && e.message ? String(e.message).slice(0, 60) : "try again later") : ""; }
    syncing = false; note();
    if (again) { again = false; sync(); }
  }

  // ---------- sign-in (only when a cloud project is set) ----------
  function showLogin(){
    const box = document.getElementById("login"); if (!box) return;
    box.hidden = false;
    const f = document.getElementById("login-form"), m = document.getElementById("login-msg");
    document.getElementById("login-skip").onclick = () => { box.hidden = true; };
    f.onsubmit = async e => {
      e.preventDefault(); m.textContent = "Signing in…"; m.className = "msg";
      const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
      if (error) { m.textContent = navigator.onLine ? "Email or password is wrong." : "You're offline. Connect to sign in."; m.className = "msg err"; return; }
      session = data.session; box.hidden = true; updateAccount(); kick();
    };
  }
  function updateAccount(){
    const b = document.getElementById("signout"); if (!b) return;
    if (!CLOUD) { b.hidden = true; return; }
    b.hidden = false;
    b.textContent = session ? "Sign out (" + (session.user.email || "") + ")" : "Sign in to sync";
    b.onclick = async () => { if (session) { await sb.auth.signOut(); session = null; updateAccount(); note(); } else showLogin(); };
  }

  const ready = (async () => {
    await loadLocalPhotos();
    if (CLOUD && window.supabase && window.supabase.createClient) {
      sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true } });
      try { session = (await sb.auth.getSession()).data.session; } catch {}
      sb.auth.onAuthStateChange((_e, s) => { session = s; updateAccount(); note(); });
      if (!session && navigator.onLine) setTimeout(showLogin, 300);
      try { sb.channel("docs-changes").on("postgres_changes", { event: "*", schema: "public", table: "docs" }, () => kick()).subscribe(); } catch {}
      window.addEventListener("online", kick);
      window.addEventListener("offline", note);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
      setInterval(kick, 60000);
    }
    setTimeout(() => { updateAccount(); kick(); }, 0);
    return { db, assets, downloads };
  })();
  window.claude = { use: async name => { const b = await ready; return b[name] || null; } };
})();
