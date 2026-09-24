/* =====================================================================
   STORAGE
   ---------------------------------------------------------------------
   Thin wrapper around the artifact's persistent key-value storage.
   In a real backend this becomes "User Data" + "Analysis API" persistence
   (per the Backend module list in the brief) — same read/write shape.
   ===================================================================== */

const Storage = (function(){
  async function get(key){
    try{
      if (!window.storage) return JSON.parse(localStorage.getItem('forma:' + key) || 'null');
      const r = await window.storage.get(key,false); return r? JSON.parse(r.value): null;
    }
    catch(e){ return null; }
  }
  async function set(key,val){
    try{
      if (!window.storage) { localStorage.setItem('forma:' + key, JSON.stringify(val)); return; }
      await window.storage.set(key, JSON.stringify(val), false);
    }
    catch(e){ console.warn('storage set failed', e); }
  }
  async function del(key){
    try{
      if (!window.storage) { localStorage.removeItem('forma:' + key); return; }
      await window.storage.delete(key,false);
    }catch(e){}
  }
  return { get, set, del };
})();

/* Profile and History are the two persisted domain objects for this MVP. */
const ProfileStore = {
  async load(){ return Storage.get('profile'); },
  async save(profile){ return Storage.set('profile', profile); },
  async clear(){ return Storage.del('profile'); }
};

const HistoryStore = {
  async load(){ return (await Storage.get('history')) || {}; },
  async save(history){ return Storage.set('history', history); },
  async clear(){ return Storage.del('history'); }
};
