import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {buildContext} from '../js/prompt.js';
import {syntheticStory} from './helpers/synthetic-story.mjs';

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

test('紧预算只舍弃可选素材，保留场景、追问依据与续写断点',()=>{
  const {story,path}=syntheticStory(60);
  story.cards[0].voice='长篇语气示例'.repeat(700);
  const continuationMessages=[{role:'assistant',content:'续写断点在这里。'}];
  const run=(text,budgetChars)=>buildContext(story,[...path,{role:'user',kind:'play',text}],{budgetChars,continuationMessages});
  const normal=run('我看了他一眼。',6000);
  assert.deepEqual(normal.info.retrievalHits,[]);
  assert.equal(normal.messages.at(-1).content,continuationMessages[0].content);
  assert.ok(normal.info.totalChars<=6000);
  const asked=run('以前那本蓝色笔记本背面写的是什么？',6000);
  assert.ok(asked.system.includes('ANSWER-7421'));
  assert.deepEqual(asked.info.continuity.kept.slice(-2),[59,60]);
  assert.ok(asked.info.totalChars<=6000);
  assert.ok(run('我看了他一眼。',100).info.totalChars>100);
});
