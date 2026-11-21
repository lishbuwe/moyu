import { getConnections, getDefaultConnId, connLabel } from './state.js';
import { streamChat } from './api.js';
import { normalizeUsage } from './cost.js';

const get = id => document.getElementById(id);
const file = get('file'), conn = get('conn'), scene = get('scene');
const run = get('run'), status = get('status'), reveal = get('reveal');
const connections = await getConnections();
for (const c of connections) conn.add(new Option(connLabel(c) + ' · ' + c.model, c.id));
const defaultId = await getDefaultConnId();
if (connections.some(c => c.id === defaultId)) conn.value = defaultId;
let pairs = [], saved = new Map(), busy = false;
const key = () => JSON.stringify([conn.value, scene.value]);
function draw() {
  const results = saved.get(key()) || [];
  get('results').replaceChildren();
  results.forEach((r,i) => {
    const title = document.createElement('h2'), body = document.createElement('article');
    title.textContent = i ? 'B' : 'A';
    body.textContent = r.text;
    get('results').append(title,body);
  });
  reveal.hidden = results.length !== 2;
  get('answer').textContent = '';
  run.disabled = busy || !pairs.length || !conn.value || results.length === 2;
  run.textContent = results.length === 1 ? '生成剩余一篇（一次请求）' : '生成 A / B（两次请求）';
}
if (!connections.length) status.textContent = '请在平时玩墨游的同一浏览器或主屏幕应用里打开，先在设置中添加模型连接。';
file.onchange = async () => {
  pairs = []; saved.clear(); scene.replaceChildren(); draw();
  const selected = file.files[0];
  if (!selected) return;
  try {
    const data = JSON.parse(await selected.text());
    if (file.files[0] !== selected) return;
    if (!Array.isArray(data) || !data.length || !data.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(p => Number.isInteger(p.n) && typeof p.system === 'string' && Array.isArray(p.messages) && p.messages.length && p.messages.every(m => ['user','assistant'].includes(m.role) && typeof m.content === 'string')))) throw Error();
    pairs = data;
    pairs.forEach(([p],i) => scene.add(new Option('第 '+p.n+' 章',i)));
    scene.selectedIndex = Math.max(0,pairs.findIndex(([p])=>p.n===364));
    status.textContent = connections.length ? '生成时请留在本页。结果仅在当前页面保留。' : '此浏览器没有墨游连接，请从墨游设置进入。';
  } catch { status.textContent = '文件无法读取，请选择本次正文盲测包。'; }
  draw();
};
scene.onchange = conn.onchange = () => { status.textContent=''; draw(); };
run.onclick = async () => {
  if (run.disabled) return;
  busy=true; get('controls').disabled=true;
  const results = saved.get(key()) || [];
  saved.set(key(),results);
  draw();
  try {
    const c = connections.find(c=>c.id===conn.value);
    for (const p of pairs[Number(scene.value)].slice(results.length)) {
      status.textContent = '正在生成 '+(results.length?'B':'A')+'…';
      const r = await streamChat(c,{system:p.system,messages:p.messages});
      results.push({text:r.text, usage:r.usage,version:p.version,partial:r.interrupted||r.truncated});
      draw();
    }
    status.textContent = '读完两篇，选 A、B、持平或都不喜欢，再揭晓。';
  } catch(e) { status.textContent = '生成中断。'+e.message; }
  finally { busy=false; get('controls').disabled=false; draw(); }
};
reveal.onclick = () => {
  get('answer').textContent = saved.get(key()).map((r,i)=>{
    const usage=normalizeUsage(r.usage);
    return (i?'B':'A')+' · '+(r.version==='trial'?'实验版':'现版')+' · '+(usage.input && !usage.est ? usage.input+' 输入 token':'接口未报告输入用量')+(r.partial?' · 输出未完整结束':'');
  }).join('　');
};
