import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {buildContext} from '../js/prompt.js';
import {syntheticStory} from './helpers/synthetic-story.mjs';

const read = path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const modules=readdirSync(new URL('../js/',import.meta.url),{recursive:true}).filter(p=>p.endsWith('.js'));
test('离线包包含所有当前模块，页面、文档、代码与缓存版本一致',()=>{
  const sw=read('sw.js'),version=read('js/util.js').match(/APP_VERSION = '([^']+)'/)[1];
  assert.deepEqual([...sw.matchAll(/'\.\/js\/([^']+\.js)'/g)].map(m=>m[1]).sort(),modules.slice().sort());
  assert.ok(sw.includes("CACHE_PREFIX + '"+version+"'"));assert.ok(read('README.md').includes('**'+version+'**'));
  assert.deepEqual([...read('index.html').matchAll(/\?v=([\d.]+)/g)].map(m=>m[1]),[version,version]);
});
test('运行时代码没有使用回归夹具的专有名词或答案暗号',()=>{
  for(const path of modules) assert.doesNotMatch(read('js/'+path),/蓝色笔记本|ANSWER-7421|半温莎结|石中剑/,path);
});
test('引号内明确指向旧物可以追问，普通感叹不带历史',()=>{
  const f=syntheticStory(60), name='信物'+randomUUID().slice(0,8), answer=randomUUID();
  f.path.at(-1).checkpoint.records=[{id:'unique',type:'event',sourceFrom:8,sourceTo:8,event:name+'印着'+answer,items:[name]}];
  const run=text=>buildContext(f.story,[...f.path,{role:'user',kind:'play',inputFormat:'quoted',text}]);
  assert.ok(run('“还记得那件'+name+'吗？”').system.includes(answer));
  assert.deepEqual(run('“以前我也这么想。”').info.retrievalHits,[]);
});
test('没有浏览器分词支持时，明确追问仍能检索记录',()=>{
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    Intl.Segmenter=undefined;
    const {leanMemory}=await import('./js/lean-memory.js');
    const mem={upTo:5,records:[{id:'x',sourceTo:2,event:'地图早已遗失',items:['地图']}]};
    if(!leanMemory(mem,'以前那张地图呢？','','',[],[]).candidates.length)process.exit(1);
  `],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('仅提到同一物件的段落不能当作档案引文的出处',async()=>{
  const {passageForFact}=await import('../js/recall.js');
  const record={id:'r',sourceFrom:1,sourceTo:2,event:'封袋的封口印着「'+randomUUID()+'」'};
  const chapters=[{no:1,text:'他看着封袋的封口。'},{no:2,text:record.event},{no:3},{no:4}];
  assert.equal(passageForFact(chapters,c=>c.text,record,['封袋'],2).chapter.no,2);
  chapters[1].text='门外传来脚步。';
  assert.equal(passageForFact(chapters,c=>c.text,record,['封袋'],2),undefined);
});
