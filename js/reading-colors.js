import {el} from './util.js';

const palette = [
  ['墨灰','#393538','#e7e0dd'], ['栗棕','#70472d','#e4b896'],
  ['莓红','#873d55','#efaac0'], ['靛蓝','#354e77','#b3caf1'],
  ['青灰','#365e61','#a6d4d4'], ['灰紫','#644675','#d6b7e6'],
];
const fields = [['bodyColor','正文颜色','--read-text','--text'],['dialogueColor','台词颜色','--read-dialogue','--dialogue']];
const valid = value => typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value);
const expand = hex => hex.length === 4 ? '#'+[...hex.slice(1)].map(c=>c+c).join('') : hex;

export function normalizeReadingPrefs(prefs) {
  const result = {...prefs};
  if (typeof prefs.dialogueColor === 'boolean') result.dialogueTint = prefs.dialogueColor;
  for (const [key] of fields) if (!valid(result[key])) result[key] = '';
  return result;
}

export function applyReadingColors(root,prefs) {
  for (const [key,,variable] of fields) {
    const value = prefs[key];
    const index = palette.findIndex(([,light]) => light === value);
    if (!valid(value)) root.style.removeProperty(variable);
    else root.style.setProperty(variable,prefs[key+'Preset'] && index >= 0 ? 'var(--reading-swatch-'+index+')' : value);
  }
}

function luminance(hex) {
  const [r,g,b] = expand(hex).slice(1).match(/../g).map(pair => {
    const channel = parseInt(pair,16)/255;
    return channel <= 0.04045 ? channel/12.92 : ((channel+0.055)/1.055)**2.4;
  });
  return r*.2126 + g*.7152 + b*.0722;
}

export function readingColorsEditor(getPrefs,setPrefs,media) {
  const box = el('div',{class:'reading-colors'});
  const updates = [];
  function change(patch) {
    setPrefs(patch);
    refresh();
  }
  function refresh() { for (const update of updates) update(); }
  for (const [key,label,,fallback] of fields) {
    const row = el('div',{class:'reading-palette',role:'group','aria-label':label});
    const picker = el('input',{type:'color','aria-label':'自定义'+label,
      oninput:() => change({[key]:picker.value,[key+'Preset']:false})});
    const warning = el('div',{class:'hint',role:'status'});
    const buttons = palette.map(([name,light],i) => el('button',{type:'button',class:'reading-swatch',
      'aria-label':label+' · '+name,style:{backgroundColor:'var(--reading-swatch-'+i+')'},
      onclick:()=>change({[key]:light,[key+'Preset']:true})}));
    row.append(...buttons,picker);
    box.append(el('div',{class:'field'},el('label',{text:label}),row,warning));
    updates.push(() => {
      const prefs = getPrefs();
      const index = prefs[key+'Preset'] ? palette.findIndex(([,light])=>light===prefs[key]) : -1;
      const theme = getComputedStyle(document.documentElement);
      const color = index < 0 ? prefs[key] || theme.getPropertyValue(fallback).trim() : palette[index][media?.matches ? 2 : 1];
      if (valid(color)) picker.value = expand(color);
      buttons.forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));
      const bg = theme.getPropertyValue('--bg').trim();
      let low = false;
      if (prefs[key] && valid(bg) && valid(color)) {
        const a = luminance(bg), b = luminance(color);
        low = (Math.max(a,b)+.05)/(Math.min(a,b)+.05) < 4.5;
      }
      warning.textContent = low ? '这个颜色在当前模式下可能看不清' : '';
    });
  }
  const line = el('span',{},'“明天也会是晴天。”');
  updates.push(()=>line.className=getPrefs().dialogueTint === false && !getPrefs().dialogueColor ? '' : 'reading-sample-dialogue');
  box.append(el('p',{class:'reading-sample'},'她推开窗。',line),el('button',{class:'btn small',onclick:()=>change({
    bodyColor:'', dialogueColor:'', bodyColorPreset:false, dialogueColorPreset:false,
  })},'恢复默认'));
  refresh();
  return {box,refresh};
}
