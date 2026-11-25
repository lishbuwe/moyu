export const PROTAGONIST_FIELDS = { identity: '当前身份', abilities: '能力与资源', status: '当前状态', relations: '关系变化' };

export function protagonistState(protagonist = {}, path = []) {
  const edits = new Map();
  for (const entry of protagonist.stateEntries || []) {
    if (!Object.hasOwn(PROTAGONIST_FIELDS, entry.field)) continue;
    if (!edits.has(entry.sourceNodeId)) edits.set(entry.sourceNodeId, []);
    edits.get(entry.sourceNodeId).push(entry);
  }
  const state = {};
  for (const node of path) {
    for (const [field, value] of Object.entries(node.checkpoint?.protagonistChanges || {})) {
      if (Object.hasOwn(PROTAGONIST_FIELDS, field) && typeof value === 'string') state[field] = {field, value, sourceNodeId:node.id};
    }
    for (const entry of edits.get(node.id) || []) {
      if (entry.value) state[entry.field] = entry;
      else delete state[entry.field];
    }
  }
  return state;
}

const compact = s => String(s || '').replace(/\s+/g, '');
export function reviewProtagonistChanges(raw, sources, current = {}) {
  const entries = Array.isArray(raw.changes) ? raw.changes : [];
  return entries.filter(c => PROTAGONIST_FIELDS[c.field] && typeof c.value === 'string' && c.value.trim()).slice(0, 12).map(c => {
    const evidence = (Array.isArray(c.evidence) ? c.evidence : []).filter(e => {
      const source = sources.find(s => s.id === e.source);
      return source && typeof e.quote === 'string' && compact(e.quote).length >= 4 && compact(source.text).includes(compact(e.quote));
    });
    return { field: c.field, value: c.value.trim().slice(0, 2000), previous: current[c.field]?.value || '',
      evidence: evidence.map(e => ({ source: e.source, label: sources.find(s => s.id === e.source).label, quote: e.quote })),
      conflict: c.conflict === true, valid: evidence.length > 0 };
  }).filter(c => c.value !== c.previous);
}

export function applyProtagonistChanges(protagonist, changes, sourceNodeId) {
  const selected = changes.filter(c => c.valid && PROTAGONIST_FIELDS[c.field]);
  if (!selected.length) throw new Error('没有可保存且有依据的变化');
  const entries = protagonist.stateEntries || [];
  return { ...protagonist, updateUndo: { entries: structuredClone(entries), sourceNodeId, at: Date.now() },
    stateEntries: [...entries, ...selected.map(c => ({ field: c.field, value: c.value, evidence: c.evidence, sourceNodeId, updatedAt: Date.now() }))] };
}
