// 正文只引用当前分支上可核对的原文。整理器的判断保存在章节档案上。
import { parseReply } from './parse.js';

function bodyOf(node) {
  return parseReply(node?.text || '').body;
}

function quoteIn(body, quote) {
  return typeof quote === 'string' && quote.length >= 6 && quote.length <= 720 && body.includes(quote);
}

const chapterIndex = (chapters) => new Map(chapters.map((c) => [c.id, c]));

export function continuityArchivePrompt(previous) {
  const open = (previous?.lines || []).slice(-24).map((line) => ({
    id: line.id, people: line.people, detail: line.detail,
  }));
  return [
    '【正在发展的互动】\n' + JSON.stringify(open),
    '同一场戏跨章时保留其起点。只有剧情明确进入另一场对话、另一个时间地点或视角时，才填写 sceneStarts。' +
      'openLines 只记还在发展的试探、冲突、态度变化或没说完的对话。引用正文连续原句，不改写、不加省略号。' +
      'detail 写动作、反应和未定之处，避免替角色定性或预定后续。如果同一互动出现新证据，可用旧 id 更新。' +
      '只有新正文明确解决该互动时，才用 closeLines 关闭它；本批未提及的互动保留。',
  ].join('\n\n');
}

export function updateContinuity(previous, result, batch, nodes) {
  const sources = new Map(batch.map((c) => [c.no, { id: c.id, body: bodyOf(nodes.get(c.id)) }]));
  const scenes = new Map((previous?.scenes || []).map((scene) => [scene.nodeId, scene]));
  const lines = new Map((previous?.lines || []).map((line) => [line.id, line]));
  function verified(value) {
    const source = sources.get(Number(value?.chapter));
    const quote = typeof value?.quote === 'string' ? value.quote.trim() : '';
    return source && quoteIn(source.body, quote) ? { nodeId: source.id, quote } : null;
  }
  for (const value of Array.isArray(result.sceneStarts) ? result.sceneStarts.slice(0, 10) : []) {
    const evidence = verified(value);
    if (evidence) scenes.set(evidence.nodeId, evidence);
  }
  for (const value of Array.isArray(result.openLines) ? result.openLines.slice(0, 12) : []) {
    const evidence = verified(value);
    const detail = typeof value?.detail === 'string' ? value.detail.trim().slice(0, 220) : '';
    const people = Array.isArray(value?.people)
      ? [...new Set(value.people.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim().slice(0, 30)))].slice(0, 6)
      : [];
    if (!evidence || !detail || !people.length) continue;
    const old = lines.get(value.id);
    const id = old?.id || evidence.nodeId + ':' + sources.get(Number(value.chapter)).body.indexOf(evidence.quote);
    // 更新时保留起点，再加最新证据，避免同一条线只剩最后一次互动。
    const refs = old ? [old.refs[0], evidence] : [evidence];
    lines.delete(id);
    lines.set(id, { id, people, detail, refs });
  }
  for (const value of Array.isArray(result.closeLines) ? result.closeLines.slice(0, 12) : []) {
    if (verified(value)) lines.delete(value.id);
  }
  return { scenes: [...scenes.values()].slice(-100), lines: [...lines.values()].slice(-60) };
}

// 未整理的章节和没有场景标记的旧存档，先识别明确的换场文字。
const transition = /^(?:[（(【「“\s]*)(?:次日|翌日|隔天|第二天|与此同时|同一时间|另一边|镜头转到|转场|\d+[天周个月年]+后|[两三四五六七八九十几]+[天周个月年]+后)(?:[，。；：！、\s]|一早|清晨|上午|中午|下午|傍晚|晚上|[）)】」”]|$)/u;

export function continuityPlan(story, path, checkpoint, namesOf) {
  const chapters = [];
  for (let index = 0; index < path.length; index++) {
    const node = path[index];
    if (node.role !== 'assistant' || node.kind === 'ooc' || !node.text?.trim()) continue;
    const user = path[index - 1]?.role === 'user' ? path[index - 1] : null;
    chapters.push({ id: node.id, node, user, index, no: chapters.length + 1 });
  }
  const bodies = new Map();
  function body(chapter) {
    if (!chapter) return '';
    if (!bodies.has(chapter.id)) bodies.set(chapter.id, bodyOf(chapter.node));
    return bodies.get(chapter.id);
  }
  const archive = checkpoint?.mem?.continuity;
  const markers = new Map((archive?.scenes || []).map((scene) => [scene.nodeId, scene.quote]));
  const latestUser = path.findLast((n) => n.role === 'user' && n.kind !== 'ooc');
  const changedScene = transition.test(latestUser?.text || '') && latestUser === path.at(-1);
  let sceneAt = chapters.length;
  if (!changedScene) {
    while (sceneAt > 0) {
      const chapter = chapters[--sceneAt];
      if (quoteIn(body(chapter), markers.get(chapter.id)) ||
          transition.test(chapter.user?.text || '') || transition.test(body(chapter))) break;
      // 只检查可能放进一次请求的近期原文，避免每轮解析整部小说。
      if (chapters.length - sceneAt >= 30) break;
    }
  }
  const scene = chapters.slice(sceneAt);
  const current = [latestUser?.text, latestUser?.director, ...scene.flatMap((c) => [c.user?.text, body(c)])].filter(Boolean).join('\n');
  const byId = chapterIndex(chapters);
  const aliases = new Map((story.cards || []).map((card) => [card.name, namesOf(card)]));
  const protagonist = story.protagonist?.name;
  const mentioned = (name, text) => name && name !== protagonist && (aliases.get(name) || [name]).some((alias) =>
    alias && (alias === name || alias.length >= 2) && text.includes(alias));
  const present = (name) => mentioned(name, current);
  const presentNames = [...aliases.keys()].filter(present);
  const excerpts = [];
  for (const chapter of chapters) for (const quote of Array.isArray(chapter.node.continuityPins) ? chapter.node.continuityPins : []) {
    if (quoteIn(body(chapter), quote)) excerpts.push({ chapter, quote, pinned: true });
  }
  for (const line of archive?.lines || []) {
    if (!line.people?.some(present)) continue;
    const refs = line.refs || [];
    if (!refs.length || !refs.every((ref) => quoteIn(body(byId.get(ref.nodeId)), ref.quote))) continue;
    for (const [index, ref] of refs.entries()) {
      excerpts.push({ chapter: byId.get(ref.nodeId), quote: ref.quote, detail: index === refs.length - 1 ? line.detail : '' });
    }
  }
  excerpts.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.chapter.no - a.chapter.no);
  const pending = chapters.filter((chapter) => chapter.index > (checkpoint?.index ?? -1));
  const pendingRanked = pending.slice(-30).map((chapter) => {
    const text = (chapter.user?.text || '') + '\n' + body(chapter);
    return { chapter, score: presentNames.filter((name) => mentioned(name, text)).length };
  }).sort((a, b) => b.score - a.score || b.chapter.no - a.chapter.no).map(({ chapter }) => chapter);
  return {
    chapters, scene, excerpts, pending, pendingRanked,
  };
}
