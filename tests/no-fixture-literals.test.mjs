import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
const read = path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const modules=readdirSync(new URL('../js/',import.meta.url),{recursive:true}).filter(p=>p.endsWith('.js'));
test('运行时代码没有使用回归夹具的专有名词或答案暗号',()=>{
  for(const path of modules) assert.doesNotMatch(read('js/'+path),/蓝色笔记本|ANSWER-7421|半温莎结|石中剑|SECRET-A-255|FUT-090|那天河边的玻璃风铃碎了/,path);
});
