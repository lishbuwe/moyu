import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
const read = path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const modules=readdirSync(new URL('../js/',import.meta.url),{recursive:true}).filter(p=>p.endsWith('.js'));
test('离线包包含所有当前模块，页面、文档、代码与缓存版本一致',()=>{
  const sw=read('sw.js'),version=read('js/util.js').match(/APP_VERSION = '([^']+)'/)[1];
  assert.deepEqual([...sw.matchAll(/'\.\/js\/([^']+\.js)'/g)].map(m=>m[1]).sort(),modules.slice().sort());
  assert.ok(sw.includes("CACHE_PREFIX + '"+version+"'"));assert.ok(read('README.md').includes('**'+version+'**'));
  assert.deepEqual([...read('index.html').matchAll(/\?v=([\d.]+)/g)].map(m=>m[1]),[version,version]);
});
