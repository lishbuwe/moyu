import { db } from '../db.js';
import { el, sheet, toast } from '../util.js';
import { streamWithRetry } from '../api.js';
import { computeCost, normalizeUsage, recordUsage } from '../cost.js';
import { inputBudgetChars } from '../prompt.js';
import { activeEdition, consolidationBatches, editorGuide, parseSuggestions } from '../consolidation.js';

export async function openEdition(story, path, cp, conn, reload) {
  const anchor = path.at(-1).id;
  const expected = JSON.stringify(cp.mem);
  const batches = consolidationBatches(cp.mem);
  const key = 'memoryDraft.' + story.id + '.' + cp.node.id;
  async function fingerprint(value) {
    const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
  }
  const sourceVersion = await fingerprint(expected);
  const previous = await db.kvGet(key, null);
  const draft = previous?.sourceVersion === sourceVersion ? previous : { sourceVersion, done:0, groups:[], doubts:[] };
  const edition = activeEdition(path);
  let ctrl, closed = false;
  const panel = sheet({title:'整合已有记忆', onClose:() => { closed = true; ctrl?.abort('user'); }});
  const hint = el('div',{class:'hint'});
  const preview = el('div');
  panel.body.append(hint, preview);
  function button(label, action) {
    return el('button',{class:'btn',onclick:async e => {
      e.currentTarget.disabled = true;
      try { await action(); } catch (err) { if (!closed) toast(err.message,4500); }
      finally { if (!closed) draw(); }
    }},label);
  }
  const write = async value => {
    await db.setMemoryEdition(anchor,story.id,anchor,cp.node.id,expected,value);
    await reload(); panel.close();
  };
  function draw() {
    hint.textContent = (edition ? '当前正文使用整合版。' : '当前正文使用原档。') + '第1–' + cp.mem.upTo + '章 · '+ batches.flat().length +' 条候选 · '+draft.done+'/'+batches.length+' 批。每个新批次最多调用一次，已处理的相同批次直接复用。使用 '+(conn?.model || '未选择连接')+'。关闭后可继续。';
    preview.replaceChildren(); panel.foot.replaceChildren();
    if (ctrl) {panel.foot.append(button('暂停',async()=>ctrl.abort('user')));return;}
    if (draft.done < batches.length && conn) panel.foot.append(button(draft.done ? '继续整合' : '生成草稿',run));
    if (!conn && draft.done < batches.length) preview.append(el('p',{text:'请先设置整理用的连接。'}));
    const details = el('details', {}, el('summary', { text: `查看 ${draft.groups.length} 项整合建议` }));
    if (draft.groups.length) {
      const before = draft.groups.flatMap(g => g.sources).reduce((n, r) => n + r.text.length, 0);
      const after = draft.groups.reduce((n, g) => n + g.text.length, 0);
      preview.append(el('p', { text: `涉及条目的字数：${before} → ${after}` }), details);
    }
    for (const group of draft.groups) {
      details.append(el('details',{class:'card'},el('summary',{text:group.kind+' · '+group.text}),
        ...group.sources.map(s=>el('p',{text:s.text}))));
    }
    if (draft.doubts.length) preview.append(el('details',{},el('summary',{text:'待确认（保留原条）'}),el('p',{text:draft.doubts.join('\n')})));
    if (draft.done === batches.length && draft.groups.length)
      panel.foot.append(button('应用整合版',()=>write({groups:draft.groups})));
    if (draft.done === batches.length && !draft.groups.length) preview.append(el('p',{text:'没有可合并的建议，原有记忆继续生效。'}));
    if (edition) panel.foot.append(button('还原原档',()=>write(null)));
  }
  async function run() {
    if (ctrl) return;
    ctrl = new AbortController(); draw();
    async function ask(user, sourceChars) {
      if (user.length + editorGuide.length > inputBudgetChars(conn)) throw Error('此批超过连接输入预算，可提高整理连接的输入预算后继续');
      const result = await streamWithRetry(conn,{system:editorGuide,messages:[{role:'user',content:user}],signal:ctrl.signal,maxTokens:Math.min(4000, 300 + sourceChars * 2)},{retries:0});
      const usage = normalizeUsage(result.usage,{inChars:user.length+editorGuide.length,outChars:result.text.length});
      await recordUsage({kind:'整合旧记忆',storyId:story.id,model:conn.model,usage,cost:computeCost(usage,conn)});
      return result.text;
    }
    try {
      while (draft.done < batches.length && !ctrl.signal.aborted) {
        const batch = batches[draft.done];
        const user = batch.map((r,i)=>i+'｜第'+r.sourceFrom+'–'+r.sourceTo+'章｜'+r.event).join('\n');
        const cacheKey = 'memoryBatch.v2.' + story.id + '.' + await fingerprint(JSON.stringify(batch.map(r => [r.id,r.sourceFrom,r.sourceTo,r.event])));
        let result = await db.kvGet(cacheKey, null);
        if (!result) {
          const raw = await ask(user, batch.reduce((n, r) => n + r.event.length, 0));
          result = parseSuggestions(raw,batch);
          await db.kvSet(cacheKey,result);
        }
        const next = {...draft, done:draft.done+1, groups:[...draft.groups,...result.groups], doubts:[...draft.doubts,...result.doubts]};
        await db.kvSet(key,next); Object.assign(draft,next);
        if (!closed) draw();
      }
    } finally { ctrl=null; }
  }
  draw();
}
