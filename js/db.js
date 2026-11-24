// 墨游 · 本机存储（IndexedDB）
// 和旧版不同：保存失败会直接提示，不会悄悄丢进度。

import { toast } from './util.js';
import { DB_NAME } from './personal.js';

const DB_VER = 2;
const SCHEMA = 1; // 存档格式版本，以后升级格式时据此迁移

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('connections')) db.createObjectStore('connections', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('stories')) db.createObjectStore('stories', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('nodes')) {
        const s = db.createObjectStore('nodes', { keyPath: 'id' });
        s.createIndex('storyId', 'storyId', { unique: false });
      }
      if (!db.objectStoreNames.contains('extras')) {
        const s = db.createObjectStore('extras', { keyPath: 'id' }); // 番外，不进正史
        s.createIndex('storyId', 'storyId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => toast('请关闭其他打开着墨游的页面后再试');
  });
  return dbPromise;
}

function run(store, mode, fn, also = []) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction([store, ...also], mode);
    const os = tx.objectStore(store);
    let result;
    const r = fn(os, tx);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  }));
}

let lastWarn = 0;
function notifyPut(store, obj) {
  try { window.dispatchEvent(new CustomEvent('moyu:put', { detail: { store, obj } })); } catch {}
}
function reportWriteError(e) {
  const now = Date.now();
  if (now - lastWarn < 4000) return;
  lastWarn = now;
  const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
  toast(quota ? '保存失败：设备存储空间不足。请先导出备份。' : '保存失败：' + (e?.message || e), 5000);
  console.error('[墨游] 保存失败', e);
}

const readStories = new WeakMap();
const pendingConflicts = new WeakMap();
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function readStory(story) {
  if (story && [1, 15].includes(Number(story.memEvery)) && !story.memEveryExplicit) story.memEvery = 10;
  if (story) readStories.set(story,structuredClone(story));
  return story;
}

export const db = {
  async get(store, key) { const value = await run(store, 'readonly', (os) => os.get(key)); return store === 'stories' ? readStory(value) : value; },
  async all(store) { const values = await run(store, 'readonly', (os) => os.getAll()); return store === 'stories' ? values.map(readStory) : values; },
  byStory: (storyId) => run('nodes', 'readonly', (os) => os.index('storyId').getAll(storyId)),
  extrasOf: (storyId) => run('extras', 'readonly', (os) => os.index('storyId').getAll(storyId)),
  async put(store, value, key) {
    let r;
    try {
      if (store === 'stories') {
        const snapshot = structuredClone(value);
        let baseline = readStories.get(value);
        const pending = pendingConflicts.get(value);
        if (pending) {
          if (!globalThis.confirm('此故事在另一页有修改。保留本页冲突字段并保存？取消将载入另一页版本。')) {
            const remote = await db.get('stories',snapshot.id);
            if (remote) {
              for (const k of Object.keys(value)) if (!(k in remote)) delete value[k];
              Object.assign(value,remote);
              readStories.set(value,structuredClone(remote));
            }
            pendingConflicts.delete(value);
            throw new Error('已载入另一页的数据，请重新打开当前页面查看');
          }
          baseline = pending;
          pendingConflicts.delete(value);
        }
        let conflict;
        await run(store,'readwrite',(os,tx)=>{
          const read = os.get(snapshot.id);
          read.onsuccess = ()=>{
            const remote = read.result;
            if (remote && (snapshot.writeRevision != null || baseline) && remote.writeRevision !== snapshot.writeRevision) {
              if (!baseline) { conflict=remote; tx.abort(); return; }
              for (const k of new Set([...Object.keys(remote),...Object.keys(baseline),...Object.keys(snapshot)])) {
                if (k === 'writeRevision' || same(remote[k],baseline[k])) continue;
                if (k !== 'updatedAt' && !same(snapshot[k],baseline[k]) && !same(snapshot[k],remote[k])) {
                  conflict=remote; tx.abort(); return;
                }
                if (k in remote) snapshot[k]=remote[k]; else delete snapshot[k];
              }
            }
            snapshot.writeRevision = (remote?.writeRevision || 0)+1;
            os.put(snapshot);
          };
        }).catch(e=>{
          if (!conflict) throw e;
          // Save the remote baseline with only the conflicting local edits rebased on it.
          for (const k of new Set([...Object.keys(baseline || {}),...Object.keys(conflict)])) {
            if (!baseline || !same(value[k],baseline[k])) continue;
            if (k in conflict) value[k]=structuredClone(conflict[k]); else delete value[k];
          }
          pendingConflicts.set(value,conflict);
          throw new Error('故事已在别处更新，本页草稿已保留。再次保存可选择版本');
        });
        for (const k of new Set([...Object.keys(snapshot),...Object.keys(baseline || {})])) {
          if (k !== 'writeRevision' && !(baseline && same(value[k],baseline[k]))) continue;
          if (k in snapshot) value[k]=snapshot[k]; else delete value[k];
        }
        readStories.set(value,structuredClone(snapshot));
        r = snapshot.id;
      } else r = await run(store, 'readwrite', (os) => (key === undefined ? os.put(value) : os.put(value, key)));
    } catch (e) { reportWriteError(e); throw e; }
    // 告诉其他还开着的页面（比如在后台继续生成的游玩页）：这条数据变了
    if (store !== 'kv') notifyPut(store, value);
    return r;
  },
  async setMemoryEdition(nodeId, storyId, headId, cpId, expected, edition) {
    const updated = await open().then(database => new Promise((resolve,reject) => {
      const tx = database.transaction(['nodes','stories'],'readwrite');
      const ns = tx.objectStore('nodes');
      const head = ns.get(nodeId), cp = ns.get(cpId), story = tx.objectStore('stories').get(storyId);
      let value;
      story.onsuccess = () => {
        value = head.result;
        if (!value || story.result?.headId !== headId || JSON.stringify(cp.result?.checkpoint) !== expected) {
          tx.abort(); return;
        }
        value.memoryEdition = edition;
        ns.put(value);
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error || Error('分支或档案已更新，请重新打开记忆页'));
      tx.onerror = () => reject(tx.error);
    }));
    notifyPut('nodes', updated);
    return updated;
  },
  async putStoryWithNode(story, node) {
    try {
      await run('stories', 'readwrite', (stories, tx) => {
        stories.put(story);
        tx.objectStore('nodes').put(node);
      }, ['nodes']);
    } catch (e) { reportWriteError(e); throw e; }
    notifyPut('nodes', node);
    notifyPut('stories', story);
  },
  async putMany(store, values) {
    try {
      return await run(store, 'readwrite', (os) => { for (const v of values) os.put(v); });
    } catch (e) { reportWriteError(e); throw e; }
  },
  async del(store, key) {
    try { return await run(store, 'readwrite', (os) => os.delete(key)); }
    catch (e) { reportWriteError(e); throw e; }
  },
  async delStory(storyId) {
    const nodes = await db.byStory(storyId);
    await run('nodes', 'readwrite', (os) => { for (const n of nodes) os.delete(n.id); });
    const extras = await db.extrasOf(storyId);
    if (extras.length) await run('extras', 'readwrite', (os) => { for (const x of extras) os.delete(x.id); });
    await db.del('kv', 'extraEvidence.' + storyId);
    await db.del('stories', storyId);
  },
  async kvGet(key, fallback) {
    const v = await run('kv', 'readonly', (os) => os.get(key));
    return v === undefined ? fallback : v;
  },
  kvSet: (key, value) => db.put('kv', value, key),
  // 同一个事务内读改写多个键（记账去重），避免重放或多页并发重复累加。
  async kvUpdate(keys, update) {
    try {
      return await open().then((database) => new Promise((resolve, reject) => {
        const tx = database.transaction('kv', 'readwrite');
        const os = tx.objectStore('kv');
        const values = {}; let pending = keys.length; let result; let failure;
        for (const key of keys) {
          const req = os.get(key);
          req.onsuccess = () => {
            values[key] = req.result;
            if (--pending) return;
            try {
              const change = update(values);
              result = change.result;
              for (const [k, v] of Object.entries(change.values)) os.put(v, k);
            } catch (e) { failure = e; tx.abort(); }
          };
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(failure || tx.error || new Error('事务被中止'));
      }));
    } catch (e) { reportWriteError(e); throw e; }
  },
};

/** 向系统申请“持久存储”，降低被系统清理的可能 */
export async function ensurePersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}

export async function storageInfo() {
  const info = { persisted: null, usage: null, quota: null };
  try {
    if (navigator.storage?.persisted) info.persisted = await navigator.storage.persisted();
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      info.usage = e.usage; info.quota = e.quota;
    }
  } catch {}
  return info;
}

/** 导出：默认不含 API 密钥 */
function backupNodes(nodes) {
  return nodes.map(({ relayJob, relayContext, ...node }) => node);
}

function backupExtras(extras) {
  return extras.map((x) => ({ ...x, versions: backupNodes(x.versions || []) }));
}

export async function exportAll({ includeKeys = false } = {}) {
  const [stories, nodes, extras, connections, defaultRules, prefs, modules, fwTemplates, fwBase, globalMemo, packs] = await Promise.all([
    db.all('stories'), db.all('nodes'), db.all('extras'), db.all('connections'),
    db.kvGet('defaultRules', null), db.kvGet('prefs', null),
    db.kvGet('modules', null), db.kvGet('fwTemplates', null), db.kvGet('fwBase', null), db.kvGet('globalMemo', null),
    db.kvGet('packs', null),
  ]);
  let discussions = [];
  try { discussions = await (await import('./discuss.js')).exportDiscussions(); } catch {}
  return {
    app: 'moyu', schema: SCHEMA, exportedAt: Date.now(),
    stories, nodes: backupNodes(nodes), extras: backupExtras(extras), modules, packs, fwTemplates, fwBase, globalMemo, discussions,
    connections: connections.map((c) => (includeKeys ? c : { ...c, apiKey: '' })),
    defaultRules, prefs,
  };
}

export async function exportStory(storyId) {
  const story = await db.get('stories', storyId);
  const nodes = await db.byStory(storyId);
  const extras = await db.extrasOf(storyId);
  const ids = [...new Set([story?.connectionId, story?.memConnId].filter(Boolean))];
  const linked = await Promise.all(ids.map(id => db.get('connections', id)));
  const connections = linked.filter(Boolean).map(c => {
    const fields = ['id','name','format','model','region','maxTokens','inputBudgetChars','mt8000',
      'temperature','stream','viaRelay','promptCache','priceIn','priceOut','priceCache','currency','priceMode','pricePerCall'];
    const config = Object.fromEntries(fields.filter(k => k in c).map(k => [k,c[k]]));
    let baseUrl = '';
    if (c.baseUrl) {
      try {
        const url = new URL(c.baseUrl);
        if (['https:', 'http:'].includes(url.protocol) && !(c.apiKey && url.pathname.includes(c.apiKey))) baseUrl = url.origin + url.pathname;
      } catch {}
    }
    return { ...config, baseUrl, apiKey: '' };
  });
  return { app: 'moyu', schema: SCHEMA, exportedAt: Date.now(), stories: [story], nodes: backupNodes(nodes), extras: backupExtras(extras), connections };
}

/** 导入：同 id 的故事会被覆盖；连接只补充不存在的（不覆盖本机已有密钥） */
export async function importData(data) {
  if (!data || (data.app !== 'moyu' && data.app !== 'yl2c')) throw new Error('这不是墨游的备份文件');
  if ((data.schema || 1) > SCHEMA) throw new Error('这个备份来自更新版本的墨游，请先更新');
  const stories = Array.isArray(data.stories) ? data.stories.filter(Boolean) : [];
  const nodes = Array.isArray(data.nodes) ? data.nodes.filter(Boolean) : [];
  for (const s of stories) {
    const old = await db.byStory(s.id);
    if (old.length) await run('nodes', 'readwrite', (os) => { for (const n of old) os.delete(n.id); });
  }
  if (stories.length) await db.putMany('stories', stories);
  if (nodes.length) await db.putMany('nodes', nodes);
  const extras = Array.isArray(data.extras) ? data.extras.filter(Boolean) : [];
  if (extras.length) await db.putMany('extras', extras);
  // 模块和番外模板：本机还没有的时候才用备份里的（不覆盖本机已经改过的）
  if (Array.isArray(data.modules) && !(await db.kvGet('modules', null))) {
    await db.kvSet('modules', data.modules);
    if (Array.isArray(data.packs)) await db.kvSet('packs', data.packs);
  }
  if (Array.isArray(data.fwTemplates) && !(await db.kvGet('fwTemplates', null))) await db.kvSet('fwTemplates', data.fwTemplates);
  if (data.fwBase && !(await db.kvGet('fwBase', null))) await db.kvSet('fwBase', data.fwBase);
  if (data.globalMemo && !(await db.kvGet('globalMemo', null))) await db.kvSet('globalMemo', data.globalMemo);
  let discussionsError = '';
  if (Array.isArray(data.discussions)) {
    try { await (await import('./discuss.js')).importDiscussions(data.discussions); }
    catch (error) { discussionsError = error?.message || String(error); }
  }
  let addedConn = 0;
  if (Array.isArray(data.connections)) {
    const existing = new Set((await db.all('connections')).map((c) => c.id));
    const fresh = data.connections.filter((c) => c && !existing.has(c.id));
    if (fresh.length) { await db.putMany('connections', fresh); addedConn = fresh.length; }
  }
  if (data.defaultRules && !(await db.kvGet('defaultRules', null))) await db.kvSet('defaultRules', data.defaultRules);
  return { stories: stories.length, nodes: nodes.length, extras: extras.length, connections: addedConn, ...(discussionsError && {discussionsError}) };
}
