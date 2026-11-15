import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';

test('主网页升级直接读取原版故事、角色、API设置和当前故事，不创建个人版数据库',async()=>{
  const dom=new JSDOM('<div id="toast"></div>',{url:'https://lishbuwe.github.io/moyu/'});
  for(const key of ['document','window','localStorage','CustomEvent'])globalThis[key]=dom.window[key];
  globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
  localStorage.setItem('moyu.curStory','existing-story');
  const old=await new Promise((resolve,reject)=>{const req=indexedDB.open('moyu',2);
    req.onupgradeneeded=()=>{const d=req.result;d.createObjectStore('kv');for(const name of ['stories','connections'])d.createObjectStore(name,{keyPath:'id'});for(const name of ['nodes','extras'])d.createObjectStore(name,{keyPath:'id'}).createIndex('storyId','storyId');};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
  const story={id:'existing-story',title:'朋友原来的故事',protagonist:{name:'原主角'},cards:[{id:'c1',name:'原角色'}],headId:'n1'};
  const conn={id:'existing-api',name:'原连接',apiKey:'virtual-old-key',baseUrl:'https://model.example/v1',model:'old-model'};
  const node={id:'n1',storyId:story.id,text:'已经写好的正文'};
  await new Promise((resolve,reject)=>{const tx=old.transaction(['stories','connections','nodes','kv'],'readwrite');tx.objectStore('stories').put(story);tx.objectStore('connections').put(conn);tx.objectStore('nodes').put(node);tx.objectStore('kv').put('原有自定义规则','defaultRules');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});old.close();
  const {db}=await import('../js/db.js');const {getCurrentStory}=await import('../js/state.js');
  assert.deepEqual(await db.get('stories',story.id),story);assert.deepEqual(await db.get('connections',conn.id),conn);assert.deepEqual(await db.get('nodes',node.id),node);assert.equal(await db.kvGet('defaultRules',''),'原有自定义规则');assert.equal(getCurrentStory(),story.id);
  const names=(await indexedDB.databases()).map(d=>d.name);assert.ok(names.includes('moyu'));assert.ok(!names.includes('moyu-yl2c-personal'));
});
