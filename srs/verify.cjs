'use strict';
// 离线定向验证：node srs/verify.cjs。只使用 Node 内置模块。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const html = fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
assert.equal(blocks.length,3);
const runtime = blocks.at(-1)[1];
new vm.Script(runtime);
const initialRows = JSON.parse(blocks[0][1]);
// Historical ordering checks stop at the first M3 row; later additions do not move old rows.
const preM3Rows=initialRows.slice(0,initialRows.findIndex(r=>r.id==='ms-0641'));
const initialState = JSON.parse(blocks[1][1]);
const plain = value => JSON.parse(JSON.stringify(value));
const source = runtime.slice(0,runtime.indexOf('// 启动。')) + runtime.slice(runtime.indexOf('function initialize()'),runtime.indexOf('try { initialize(); }')) + `
globalThis.api = {localDay,addDays,validateRows,validateState,parseCSV,mergeRows,pruneLog,
schedule,expandCards,buildQueue,spellingResult,clozeExample,mergeProgress,statistics,
safeJSON,serializeDocument,snapshotDocument,saveFile,initialize,LESSONS,reveal,gradeCard,recognitionOnly,
renderLessons,bindEvents,READINGS,renderReadings,validateReadings,LANGS,LANG_INFO,kkLatin,
openLesson(id){lesson=id;tab='lessons';render();},
showReadings(){openReading=null;tab='readings';render();},
openReadingItem(id){openReading=id;readingShowZh=false;tab='readings';render();},
toggleReadingZh(){readingShowZh=!readingShowZh;render();},
setData(r,s){rows=r;state=s;dirty=true;revision=1;session=null;fileSnapshot=snapshotDocument(document);},
setHandle(h){fileHandle=h;handleReady=true;},
getData(){return {rows,state,dirty,source,lastSaved,notice,session,fileSnapshot,overwritePending};},
change(){state.settings.newPerDay.es++;touch();},
setHandleStore(fn){handleStore=fn;},
openReview(lang='all'){language=lang;ensureSession();},
revealForTest(){revealed=true;},
setSession(s){session=s;language=s.lang;revealed=true;},
};
})();`;

// 最小通用文档树：保留节点、属性和脚本原文，测试保存边界；不替代浏览器 DOM。
const attrEscape = value => String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const decode = value => value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const voidTags = new Set(['meta','link','img','input','br','hr']);
class TextModel {
  constructor(text) { this.textContent=text; }
  get outerHTML() { return this.textContent; }
}
class ElementModel {
  constructor(tag,attrs={}) { this.tag=tag; this.attrs={...attrs}; this.childNodes=[]; this.listeners={}; }
  get attributes() { return Object.entries(this.attrs).map(([name,value])=>({name,value})); }
  get id() { return this.attrs.id || ''; }
  get content() { return this.attrs.content || ''; }
  set content(value) { this.setAttribute('content',value); }
  get dataset() { return Object.fromEntries(Object.entries(this.attrs).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5),v])); }
  get elements() { return Object.fromEntries(this.querySelectorAll('[name]').map(node=>[node.attrs.name,node])); }
  get value() { return this._value ?? this.attrs.value ?? ''; }
  set value(value) { this._value=value; }
  get textContent() { return this.childNodes.map(node=>node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(new TextModel(String(value))); }
  get innerHTML() { return this.childNodes.map(node=>node.outerHTML).join(''); }
  set innerHTML(value) { this.replaceChildren(...parseNodes(value)); }
  get outerHTML() {
    const start='<'+this.tag+Object.entries(this.attrs).map(([k,v])=>' '+k+'="'+attrEscape(v)+'"').join('')+'>';
    return start+(voidTags.has(this.tag)?'':this.innerHTML+'</'+this.tag+'>');
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name,value) { this.attrs[name]=String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  replaceChildren(...nodes) { this.childNodes=[...nodes]; }
  append(...nodes) { this.childNodes.push(...nodes); }
  matches(selector) {
    const tag=selector.match(/^[a-z][\w-]*/i)?.[0],id=selector.match(/#([\w-]+)/)?.[1],cls=selector.match(/\.([\w-]+)/)?.[1];
    if ((tag && this.tag!==tag) || (id && this.id!==id) || (cls && !(this.attrs.class || '').split(' ').includes(cls))) return false;
    return [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([,key,value])=>Object.hasOwn(this.attrs,key) && (value===undefined || this.attrs[key]===value));
  }
  querySelectorAll(selector) {
    const found=[];
    for (const node of this.childNodes) if (node instanceof ElementModel) {
      if (selector.split(',').some(s=>node.matches(s.trim()))) found.push(node);
      found.push(...node.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type,fn) { (this.listeners[type] ||= []).push(fn); }
  focus() {}
}
function parseNodes(text) {
  const root=new ElementModel('fragment'), stack=[root];
  const token=/<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?[a-z][\w-]*\b[^>]*>/gi;
  let end=0,match;
  while ((match=token.exec(text))) {
    if (match.index>end) stack.at(-1).append(new TextModel(text.slice(end,match.index)));
    const raw=match[0];end=token.lastIndex;
    if (raw.startsWith('<!--')) { stack.at(-1).append(new TextModel(raw));continue; }
    if (/^<!/i.test(raw)) continue;
    const tag=raw.match(/^<\/?([\w-]+)/)[1].toLowerCase();
    if (raw.startsWith('</')) { assert.equal(stack.at(-1).tag,tag);stack.pop();continue; }
    const attrs={};
    for (const [,name,a,b,c] of raw.slice(tag.length+1,-1).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[name]=decode(a ?? b ?? c ?? '');
    const node=new ElementModel(tag,attrs);stack.at(-1).append(node);
    if (['script','style'].includes(tag)) {
      const close=new RegExp('</'+tag+'\\s*>','gi');close.lastIndex=end;
      const closing=close.exec(text);assert(closing,'unclosed '+tag);
      node.textContent=text.slice(end,closing.index);end=token.lastIndex=close.lastIndex;
    } else if (!voidTags.has(tag)) stack.push(node);
  }
  if (end<text.length) stack.at(-1).append(new TextModel(text.slice(end)));
  assert.equal(stack.length,1);
  return root.childNodes;
}
class DocumentModel extends ElementModel {
  constructor(text=html) { super('document');this.childNodes=parseNodes(text);this.hidden=false; }
  get documentElement() { return this.querySelector('html'); }
  get head() { return this.querySelector('head'); }
  get body() { return this.querySelector('body'); }
  getElementById(id) { return this.querySelector('#'+id); }
  createElement(tag) { return new ElementModel(tag); }
  cloneNode() { return new DocumentModel(this.documentElement.outerHTML); }
}
function emptyState() {
  return {version:1,updatedAt:'2026-09-14T00:00:00.000Z',settings:{newPerDay:{es:15,ru:10,ms:10}},cards:{},log:[]};
}
function fixtureHTML(rows=initialRows,state=emptyState()) {
  return html.replace(/(<script[^>]*id="cards-data"[^>]*>)[\s\S]*?(<\/script>)/,(_,a,b)=>a+JSON.stringify(rows)+b)
    .replace(/(<script[^>]*id="state-data"[^>]*>)[\s\S]*?(<\/script>)/,(_,a,b)=>a+JSON.stringify(state)+b);
}
function createAPI(bootstrap=false,text=fixtureHTML()) {
  const cache = new Map();
  const document = new DocumentModel(text);
  const context = vm.createContext({document,DOMParser:class {parseFromString(text){return new DocumentModel(text);}},location:{pathname:'/srs/index.html'},window:{addEventListener(){}},localStorage:{setItem:(k,v)=>cache.set(k,v),getItem:k=>cache.get(k)||null},navigator:{},URL,Blob,FileReader:undefined,setTimeout:() => 0,clearTimeout,console});
  vm.runInContext(source,context);
  if (!bootstrap) context.api.setData(context.api.validateRows(plain(initialRows)),context.api.validateState(emptyState()));
  return {api:context.api,context,cache,document};
}
const {api} = createAPI();
const S1_LESSONS=['es-13','es-14','es-15','es-16'];
const s1Rows=initialRows.filter(row=>S1_LESSONS.includes(row.lesson));
const S2_LESSONS=['es-17','es-18','es-19','es-20'];
const s2Rows=initialRows.filter(row=>S2_LESSONS.includes(row.lesson));
const s2Expanded=s2Rows.reduce((total,row)=>total+(row.tags.split(';').includes('phrase')?1:2),0);
const S3_LESSONS=['es-21','es-22','es-23'];
const s3Rows=initialRows.filter(row=>S3_LESSONS.includes(row.lesson));
const s3Expanded=s3Rows.reduce((total,row)=>total+(row.tags.split(';').includes('phrase')?1:2),0);
const S4_LESSONS=['es-24','es-25'];
const s4Rows=initialRows.filter(row=>S4_LESSONS.includes(row.lesson));
const s4Expanded=s4Rows.reduce((total,row)=>total+(row.tags.split(';').includes('phrase')?1:2),0);
const R1_LESSONS=['ru-13','ru-14','ru-15','ru-16'];
const r1Rows=initialRows.filter(row=>R1_LESSONS.includes(row.lesson));
const r1Expanded=r1Rows.reduce((total,row)=>total+(row.tags.split(';').includes('phrase')?1:2),0);
const R2_LESSONS=['ru-17','ru-18','ru-19','ru-20'];
const r2Rows=initialRows.filter(row=>R2_LESSONS.includes(row.lesson));
const r2Expanded=r2Rows.reduce((total,row)=>total+(row.tags.split(';').includes('phrase')?1:2),0);
const R3_LESSONS=['ru-21','ru-22','ru-23','ru-24'];
const r3Rows=initialRows.filter(row=>R3_LESSONS.includes(row.lesson));
const r3Expanded=r3Rows.reduce((total,row)=>total+(row.tags.split(';').includes('phrase')?1:2),0);
const R4_LESSONS=['ru-25','ru-26','ru-27','ru-28'];
const r4Rows=initialRows.filter(row=>R4_LESSONS.includes(row.lesson));
const r4Expanded=r4Rows.reduce((total,row)=>total+(row.tags.split(';').includes('phrase')?1:2),0);
const R5_LESSONS=['ru-29','ru-30','ru-31'];
const r5Rows=initialRows.filter(row=>R5_LESSONS.includes(row.lesson));
const r5Expanded=r5Rows.reduce((total,row)=>total+(row.tags.split(';').includes('phrase')?1:2),0);
const R6_LESSONS=['ru-32','ru-33','ru-34'];
const r6Rows=initialRows.filter(row=>R6_LESSONS.includes(row.lesson));
const r6Expanded=r6Rows.reduce((total,row)=>total+(row.tags.split(';').includes('phrase')?1:2),0);
// 原有 2895 张卡保持固定基数；新卡按标签计算预期方向，另有逐卡检查。
const s1Expanded=s1Rows.reduce((total,row)=>total+(row.tags.split(';').includes('phrase')?1:2),0);
function record(day='2026-09-14',grade=4) { return api.schedule(null,grade,day); }

test('来源 CSV 与两个内嵌 JSON 完整一致；只有一个可执行脚本且无外部资源',() => {
  const rows = Array.from(api.LANGS).flatMap(lang => {
    const csv = path.join(__dirname,'cards',lang+'.csv');
    // 预留语言尚无 CSV 时，内嵌数据也必须为空。
    if (!fs.existsSync(csv)) {
      assert.equal(initialRows.filter(row=>row.lang===lang).length,0,lang+' 缺少来源 CSV');
      return [];
    }
    const text = fs.readFileSync(csv,'utf8');
    // 纯表头来源表示尚无词条；页面的 CSV 导入仍拒绝没有卡片的输入。
    return text.trim()==='id,lang,lesson,front,back,example,example_zh,note,tags' ? [] : plain(api.parseCSV(text));
  });
  // 内嵌数据按追加顺序保留旧行；来源 CSV 各自按语言排列。
  for (const lang of api.LANGS) assert.deepEqual(rows.filter(row=>row.lang===lang),initialRows.filter(row=>row.lang===lang));
  assert.equal(rows.filter(row=>!['ms','uz','kk'].includes(row.lang)).length,3616);
  assert.equal(rows.filter(row=>row.lang==='ms'&&Number(row.lesson.slice(3))<=12).length,920);
  assert.equal(api.expandCards(rows).length,2895+s1Expanded+r1Expanded+s2Expanded+r2Expanded+s3Expanded+r3Expanded+s4Expanded+r4Expanded+r5Expanded+r6Expanded+api.expandCards(rows.filter(row=>row.lang==='ms')).length+api.expandCards(rows.filter(row=>['uz','kk'].includes(row.lang))).length);
  assert.equal(rows.filter(r=>r.lang==='es').length,1993);
  assert.equal(rows.filter(r=>r.lang==='ru'&&r.tags.split(';').includes('letter')).length,33);
  assert.equal(rows.filter(r=>r.lang==='ru'&&!r.tags.split(';').includes('letter')).length,1590);
  assert.match(html,/<div id="app"><\/div>/);
  assert.doesNotMatch(html,/<(?:script|link|img)[^>]+(?:src|href)=/i);
  assert.doesNotMatch(runtime,/\b(?:fetch|XMLHttpRequest|WebSocket|importScripts)\s*\(/);
  assert.equal(api.LESSONS['es-01'].exercises.length,10);
  assert.equal(api.LESSONS['ru-01'].exercises.length,10);
  assert.equal(api.LESSONS['ru-08'].exercises.length,10);
  assert.equal(api.LESSONS['ru-12'].exercises.length,10);
  assert.equal(api.LESSONS['es-08'].exercises.length,10);
});
test('同语言 front 去重音后不重复；任务 C 四课均有对应卡片',() => {
  const normalize=value=>value.normalize('NFD').replace(/\u0301/g,'').normalize('NFC').toLocaleLowerCase();
  // 西语旧卡保留了 tú/tu、él/el 等有意区分的同形词；本任务的去重约束作用于 ru.csv。
  for (const lang of ['ru']) {
    const seen=new Set();
    for (const row of initialRows.filter(row=>row.lang===lang)) {
      const key=normalize(row.front);
      assert(!seen.has(key),lang+' 重复 front：'+row.front);
      seen.add(key);
    }
  }
  for (const id of ['ru-05','ru-06','ru-07','ru-08']) {
    assert(api.LESSONS[id],id);
    assert(initialRows.some(row=>row.lesson===id),id+' 没有卡片');
  }
});
test('字母集合、国际词重音位置与西语全部人称',() => {
  assert.equal(initialRows.filter(r=>r.lang==='ru'&&r.tags.includes('letter')).map(r=>r.front.split(' ')[0]).join(''),'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ');
  const stressed = ['телефо́н','университе́т','студе́нт','пробле́ма','интерне́т','компью́тер','му́зыка','теа́тр','спо́рт','ко́фе','па́рк','ба́нк','рестора́н','такси́','метро́','ра́дио','музе́й','оте́ль'];
  assert.deepEqual(initialRows.filter(r=>r.lesson==='ru-01'&&r.tags.includes('国际词')).map(r=>r.front),stressed);
  for (const word of stressed) assert.equal((word.match(/[аеёиоуыэюя]\u0301/g)||[]).length,1);
  for (const form of ['soy','eres','es','somos','sois','son','estoy','estás','está','estamos','estáis','están']) assert(initialRows.some(r=>r.front===form));
});
test('CSV 支持 BOM、CRLF、逗号、双引号、多行，错误输入不半导入',() => {
  const csv='\uFEFFid,lang,lesson,front,back,example,example_zh,note,tags\r\nes-test,es,es-02,hola,你好,"Hola, ""hola"".\nHola.",你好,,\r\n';
  assert.equal(api.parseCSV(csv)[0].example,'Hola, "hola".\nHola.');
  assert.throws(()=>api.parseCSV(csv.replace('"Hola,','""Hola,')));
  assert.throws(()=>api.parseCSV(csv+csv.split('\r\n')[1]));
  assert.throws(()=>api.parseCSV('id,front\nes-1,hola'));
  const before=plain(initialRows), changed={...before[0],back:'更新的释义'};
  assert.equal(api.mergeRows(before,[changed])[0].back,'更新的释义');
  assert.equal(before[0].back,'你好');
  assert.throws(()=>api.mergeRows(before,[{...changed,lang:'ru',lesson:'ru-01'}]));
});
test('SM-2 首次、第二次、后续、Again 重置及 ease 下限',() => {
  const good=record(),easy=record('2026-09-14',5),hard=record('2026-09-14',3);
  assert.deepEqual([good.ivl,easy.ivl,hard.ivl],[1,4,1]);
  assert.deepEqual([good.ease,easy.ease,hard.ease],[2.5,2.6,2.36]);
  const second=api.schedule(good,4,'2026-09-15');
  const third=api.schedule(second,4,'2026-09-21');
  assert.deepEqual([second.ivl,third.ivl],[6,15]);
  let again=api.schedule(third,0,'2026-10-06');
  assert.deepEqual([again.ivl,again.reps,again.lapses,again.due],[0,0,1,'2026-10-06']);
  assert.equal(api.schedule(again,5,'2026-10-06').ivl,4);
  for(let i=0;i<20;i++) again=api.schedule(again,0,'2026-10-06');
  assert.equal(again.ease,1.3);
  assert.equal(again.first,'2026-09-14');
});
test('本地日期跨月、闰年和 DST 不按 24 小时相加',() => {
  assert.equal(api.addDays('2026-09-30',1),'2026-10-01');
  assert.equal(api.addDays('2028-02-28',1),'2028-02-29');
  assert.equal(api.addDays('2026-12-31',1),'2027-01-01');
  assert.equal(api.addDays('2026-03-08',1),'2026-03-09');
  assert.equal(api.addDays('2026-11-01',1),'2026-11-02');
  assert.equal(api.localDay(new Date(2026,8,14,0,1)),'2026-09-14');
});
test('新卡按课次、语言额度引入，拼写次日开放，日志清理后仍有效',() => {
  const state=emptyState(),rows=initialRows;
  let queue=api.buildQueue(rows,state,'all','2026-09-14');
  assert.deepEqual([queue.due.length,queue.newCards.length],[0,35]);
  assert(queue.newCards.every(c=>c.direction==='r'));
  assert.deepEqual(['es','ru','ms'].map(lang=>queue.newCards.filter(c=>c.row.lang===lang).length),[15,10,10]);
  state.cards['es-0001:r']=record();
  queue=api.buildQueue(rows,state,'es','2026-09-14');
  assert.equal(queue.newCards.length,14);
  assert(!queue.newCards.some(c=>c.id==='es-0001:p'));
  assert(api.buildQueue(rows,state,'es','2026-09-15').newCards.some(c=>c.id==='es-0001:p'));
  state.cards['es-0001:r']={...state.cards['es-0001:r'],last:'2026-12-01',due:'2026-12-15'};
  assert(api.buildQueue(rows,state,'es','2026-12-01').newCards.some(c=>c.id==='es-0001:p'));
  state.settings.newPerDay.es=0;
  assert.equal(api.buildQueue(rows,state,'es','2026-12-20').newCards.length,0);
  assert.equal(api.buildQueue(rows,state,'es','2026-12-20').due.length,1);
  const later={...rows[0],id:'es-0000',lesson:'es-02'};
  state.settings.newPerDay.es=1;
  assert.equal(api.buildQueue([later,rows[1]],state,'es','2026-09-15').newCards[0].row.lesson,'es-01');
});
test('拼写 NFC、重音、变音符、大小写、空格的三档判定',() => {
  for (const [input,target,lang,grade] of [
    [' cafe\u0301 ','café','es',4],['cafe','café','es',3],['niño','niño','es',4],['nino','niño','es',3],
    ['telefono','teléfono','es',3],['telephono','teléfono','es',0],['Hola','hola','es',0],
    ['телефон','телефо́н','ru',4],['те́лефон','телефо́н','ru',4],['елка','ёлка','ru',3],['музеи','музе́й','ru',3],
    ['por favor','por favor','es',4],['por  favor','por favor','es',0],['','hola','es',0]
  ]) assert.equal(api.spellingResult(input,target,lang).grade,grade,input);
});
test('旧课拼写卡例句可挖空；边界不会误遮单词内部，俄语重音不泄露答案',() => {
  for(const row of initialRows.filter(r=>!['uz','kk'].includes(r.lang) && !S1_LESSONS.includes(r.lesson) && !S2_LESSONS.includes(r.lesson) && !S3_LESSONS.includes(r.lesson) && !S4_LESSONS.includes(r.lesson) && !R1_LESSONS.includes(r.lesson) && !R2_LESSONS.includes(r.lesson) && !R3_LESSONS.includes(r.lesson) && !R4_LESSONS.includes(r.lesson) && !R5_LESSONS.includes(r.lesson) && !R6_LESSONS.includes(r.lesson) && !api.recognitionOnly(r))) assert(!api.clozeExample(row).includes('此例句没有'),row.id+' '+row.front);
  assert.equal(api.clozeExample({front:'es',lang:'es',example:'Es estudiante; es bueno.'}),'____ estudiante; ____ bueno.');
  assert.equal(api.clozeExample({front:'en',lang:'es',example:'El estudiante está en casa.'}),'El estudiante está ____ casa.');
  assert.equal(api.clozeExample({front:'телефо́н',lang:'ru',example:'Э́то телефо́н.'}),'Э́то ____.');
  assert.match(api.clozeExample({front:'leer',lang:'es',example:'Leo.'}),/^____/);
});
test('进度合并按 last，再按同卡日志时间；日志去重、设置保留、未知 id 保留',() => {
  const a=emptyState(),b=emptyState();
  a.cards['es-0001:r']=record('2026-09-15');b.cards['es-0001:r']=record('2026-09-14',0);
  a.cards['es-0002:r']=record('2026-09-15');b.cards['es-0002:r']=record('2026-09-15',5);
  a.log=[{t:'2026-09-15T10:00:00Z',card:'es-0002:r',grade:4}];
  b.log=[...a.log,{t:'2026-09-15T11:00:00Z',card:'es-0002:r',grade:5}];
  b.cards['es-later:r']=record('2026-09-15');b.settings.newPerDay.es=99;
  const merged=api.mergeProgress(a,b,new Date('2026-09-15T12:00:00Z'));
  assert.equal(merged.cards['es-0001:r'].last,'2026-09-15');
  assert.equal(merged.cards['es-0001:r'].first,'2026-09-14');
  assert.equal(merged.cards['es-0002:r'].ivl,4);
  assert(merged.cards['es-later:r']);assert.equal(merged.settings.newPerDay.es,15);assert.equal(merged.log.length,2);
  assert.deepEqual(plain(api.mergeProgress(merged,b,new Date('2026-09-15T12:00:00Z'))),plain(merged));
});
test('日志 60 个本地日期边界、统计 30 天与正确率、旧版无 first 兼容',() => {
  const now=new Date(2026,8,15,12),today=api.localDay(now),cutoff=api.addDays(today,-59);
  const at=day=>new Date(day+'T12:00:00').toISOString();
  const log=[api.addDays(cutoff,-1),cutoff,today].map(t=>({t:at(t),card:'es-0001:r',grade:4}));
  assert.equal(api.pruneLog(log,now).length,2);
  const state=emptyState();state.cards['es-0001:r']=record(today);delete state.cards['es-0001:r'].first;
  state.log=[{t:at(api.addDays(today,-2)),card:'es-0001:r',grade:0},{t:at(today),card:'es-0001:r',grade:4}];
  const valid=api.validateState(state,now);assert.equal(valid.cards['es-0001:r'].first,api.addDays(today,-2));
  const stats=api.statistics(initialRows,valid,today)[0];
  assert.deepEqual([stats.total,stats.new,stats.learning,stats.mastered,stats.reviews,stats.accuracy],[1941+s1Expanded+s2Expanded+s3Expanded+s4Expanded,1940+s1Expanded+s2Expanded+s3Expanded+s4Expanded,1,0,2,'50%']);
  assert.throws(()=>api.validateState({...state,version:2},now));
  assert.throws(()=>api.validateState({...state,cards:{'es-0001:r':{...record(),due:'2026-02-30'}}},now));
});
test('Again 在会话末尾重学，反复 Again 不丢卡，成功后移出',() => {
  const {api:a}=createAPI();a.openReview('es');a.revealForTest();a.gradeCard(0);
  let s=a.getData();assert.equal(s.session.again[0].id,'es-0001:r');assert.equal(s.session.queue[0].id,'es-0002:r');
  const card=s.session.again[0];a.setSession({day:a.localDay(),lang:'all',queue:[],again:[card],done:1});
  a.gradeCard(0);assert.equal(a.getData().session.again.length,1);
  a.revealForTest();a.gradeCard(4);assert.equal(a.getData().session.again.length,0);
  assert.equal(a.getData().state.cards[card.id].lapses,2);
});
test('完整 HTML 序列化、空 app、JSON 结束标签及混合大小写安全往返',() => {
  const {api:a,document}=createAPI();
  const rows=plain(initialRows);rows[0].note='</script><script>bad()</script> <!-- <ScRiPt> & "quoted" \u2028';
  const saved=a.serializeDocument(document,rows,initialState,'2026-09-15T10:00:00Z','file');
  assert(saved.startsWith('<!DOCTYPE html>\n<html'));
  assert.match(saved,/<div id="app"><\/div>/);assert.match(saved,/<\\\/script>/);
  const result=[...saved.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.equal(result.length,3);assert.deepEqual(JSON.parse(result[0][1]),rows);assert.deepEqual(JSON.parse(result[1][1]),initialState);
  assert.doesNotThrow(()=>new vm.Script(result[2][1]));
});
test('首次 picker、IndexedDB 记住句柄、复用及请求权限后写入并关闭',async () => {
  const {api:a,context,cache}=createAPI();const calls=[];let output='';
  const handle={getFile:async()=>({text:async()=>output || fixtureHTML()}),queryPermission:async()=>{calls.push('query');return 'prompt';},requestPermission:async()=>{calls.push('permission');return 'granted';},createWritable:async()=>({write:async text=>{calls.push('write');output=text;},close:async()=>calls.push('close')})};
  context.window.showSaveFilePicker=async options=>{calls.push('picker');assert.equal(options.id,'language-srs');assert.equal(options.suggestedName,'index.html');return handle;};
  a.setHandleStore(async(mode,value)=>{calls.push(mode);assert.equal(value,handle);});
  await a.saveFile();assert.deepEqual(calls,['picker','write','close','put']);
  assert.equal(a.getData().dirty,false);assert(cache.size);assert.match(output,/<div id="app"><\/div>/);
  calls.length=0;await a.saveFile();assert.deepEqual(calls,['query','permission','write','close']);
  assert.deepEqual(JSON.parse(cache.values().next().value).state,plain(a.getData().state));
});
test('写入失败不清除 dirty；并发评分在保存快照之后仍标记未保存',async () => {
  const {api:a,context}=createAPI();context.window.showSaveFilePicker=async()=>{};
  let aborted=false;
  a.setHandle({getFile:async()=>({text:async()=>fixtureHTML()}),queryPermission:async()=> 'granted',createWritable:async()=>({write:async()=>{throw new Error('disk full');},abort:async()=>{aborted=true;}})});
  await a.saveFile();assert.equal(a.getData().dirty,true);assert(aborted);assert.match(a.getData().notice,/disk full/);
  a.setHandle({getFile:async()=>({text:async()=>fixtureHTML()}),queryPermission:async()=> 'granted',createWritable:async()=>({write:async()=>a.change(),close:async()=>{}})});
  await a.saveFile();assert.equal(a.getData().dirty,true);assert.match(a.getData().notice,/新进度/);
});
test('取消 picker 与拒绝权限均保留进度，不降级为静默下载',async () => {
  const {api:a,context}=createAPI();
  context.window.showSaveFilePicker=async()=>{const e=new Error('cancel');e.name='AbortError';throw e;};
  await a.saveFile();assert.equal(a.getData().dirty,true);assert.match(a.getData().notice,/取消/);
  a.setHandle({queryPermission:async()=> 'prompt',requestPermission:async()=> 'denied',createWritable:async()=>assert.fail('must not write')});
  await a.saveFile();assert.equal(a.getData().dirty,true);assert.match(a.getData().notice,/写入权限/);
});
test('加载以文件词条为准：较新缓存保留文件新课与缓存独有词，旧／损坏缓存不覆盖进度',() => {
  for (const kind of ['newer','older','broken']) {
    const {api:a,cache}=createAPI(true),cached=emptyState();
    // 缓存仅含旧课程，并有相同 id 的旧修订及一次未保存的导入。
    const rows=plain(initialRows.filter(row=>['es-01','ru-01'].includes(row.lesson)));
    const extra={...rows[0],id:'es-unsaved',lesson:'es-02'};
    rows[0].note='缓存中的词条修订';rows.push(extra);
    cached.updatedAt=kind==='newer'?'2026-09-15T00:00:00Z':'2026-09-01T00:00:00Z';
    cached.cards['es-0001:r']=record();
    cache.set('language-srs:v1:/srs/index.html',kind==='broken'?'bad json':JSON.stringify({state:cached,cards:rows}));
    a.initialize();const result=a.getData();
    assert.equal(result.source,kind==='newer'?'本地缓存':'文件');
    assert.equal(result.dirty,kind!=='broken');
    assert.equal(result.rows[0].note,initialRows[0].note);
    assert.equal(Object.keys(result.state.cards).length,kind==='newer'?1:0);
    assert.equal(result.rows.some(row=>row.id==='es-unsaved'),kind!=='broken');
    assert.deepEqual(plain(result.rows.slice(0,initialRows.length)),initialRows);
    assert.equal(result.fileSnapshot,a.snapshotDocument(new DocumentModel(fixtureHTML())));
  }
});

test('真实嵌入进度能通过 validateState；全部进度与日志 id 都对应现有卡片',() => {
  const before=JSON.stringify(initialState);
  const valid=api.validateState(plain(initialState),new Date(initialState.updatedAt));
  const ids=new Set(api.expandCards(initialRows).map(card=>card.id));
  assert.equal(Object.keys(valid.cards).length,Object.keys(initialState.cards).length);
  for (const id of [...Object.keys(initialState.cards),...initialState.log.map(item=>item.card)]) assert(ids.has(id),id);
  assert.equal(JSON.stringify(initialState),before);
});
test('课程注册表都有词条、周次、日期、目标、写作任务和 10 题；阅读题属于本课练习',() => {
  assert.deepEqual(Object.keys(api.LESSONS).filter(id=>!id.startsWith('ms-')||Number(id.slice(3))<=12),['es-01','es-02','es-03','es-04','es-05','es-06','es-07','es-08','es-09','es-10','es-11','es-12','es-13','es-14','es-15','es-16','es-17','es-18','es-19','es-20','es-21','es-22','es-23','es-24','es-25','ru-01','ru-02','ru-03','ru-04','ru-05','ru-06','ru-07','ru-08','ru-09','ru-10','ru-11','ru-12','ru-13','ru-14','ru-15','ru-16','ru-17','ru-18','ru-19','ru-20','ru-21','ru-22','ru-23','ru-24','ru-25','ru-26','ru-27','ru-28','ru-29','ru-30','ru-31','ru-32','ru-33','ru-34','ms-01','ms-02','ms-03','ms-04','ms-05','ms-06','ms-07','ms-08','uz-01','uz-02','uz-03','uz-04','uz-05','uz-06','uz-07','uz-08','uz-09','uz-10','kk-01','kk-02','kk-03','kk-04','kk-05','kk-06','kk-07','kk-08','kk-09','kk-10','ms-09','ms-10','ms-11','ms-12']);
  for (const [id,lesson] of Object.entries(api.LESSONS)) {
    assert(initialRows.some(row=>row.lesson===id),id);
    assert.equal(lesson.lang,id.slice(0,2));assert.equal(lesson.week,Number(id.slice(3)));
    for (const key of ['name','dates','goal','writingTask']) assert.equal(typeof lesson[key],'string');
    assert.equal(typeof lesson.explanation,'function');assert(lesson.explanation().length>100);
    assert.equal(lesson.exercises.length,10,id);
    for (const exercise of lesson.exercises) {
      assert(exercise.prompt && exercise.answer);
      if (exercise.options) assert.equal(exercise.options.filter(option=>option===exercise.answer).length,1);
    }
    if (lesson.reading) {
      if (lesson.lang==='ru' && ['ru-03','ru-04'].includes(id)) assert([5,6].includes(lesson.reading.sentences.length));
      if (lesson.lang==='ru' && ['ru-05','ru-06','ru-07','ru-08'].includes(id)) assert(lesson.reading.sentences.length>=8 && lesson.reading.sentences.length<=10);
      assert.equal(lesson.reading.questions.length,lesson.lang==='ms'?4:['es-04','es-05','es-07','es-08','es-09','es-10','es-11','es-12','es-13','es-14','es-15','es-16','es-17','es-18','es-19','es-20','es-21','es-22','es-23','es-24','es-25','ru-05','ru-08','ru-09','ru-10','ru-11','ru-12','ru-13','ru-14','ru-15','ru-16','ru-17','ru-18','ru-19','ru-20','ru-21','ru-22','ru-23','ru-24','ru-25','ru-26','ru-27','ru-28','ru-29','ru-30','ru-31','ru-32','ru-33','ru-34','ms-02','ms-03','ms-04','ms-05','ms-06','ms-07','ms-08','ms-09','ms-10','ms-11','ms-12','uz-10','kk-10'].includes(id)?4:3);
      for (const sentence of lesson.reading.sentences) assert(sentence.text && sentence.zh);
      for (const question of lesson.reading.questions) {
        assert(question.options.includes(question.answer),id+' '+question.prompt);
        assert.equal(question.options.length,new Set(question.options).size);
      }
      assert.deepEqual(lesson.exercises.slice(-lesson.reading.questions.length),lesson.reading.questions);
    } else assert.equal(lesson.reading,null);
  }
  assert.deepEqual(['ru-02','ru-03','ru-04','ru-05','ru-06','ru-07','ru-08'].map(id=>initialRows.filter(row=>row.lesson===id).length),[14,36,40,48,53,50,50]);
  const vocabulary=new Set(initialRows.filter(row=>['ru-01','ru-02','ru-03'].includes(row.lesson)).map(row=>row.front.toLowerCase().replace(/\u0301/g,'')));
  for (const sentence of api.LESSONS['ru-03'].reading.sentences) {
    for (const word of sentence.text.toLowerCase().replace(/\u0301/g,'').match(/[а-яё]+/g)) assert(vocabulary.has(word),word);
  }
});
test('任务 C：ru-05 至 ru-08 的日期、阅读、重音、性别和动词 note 符合要求',() => {
  const expected={
    'ru-05':['10-12 至 10-18',48,10],
    'ru-06':['10-19 至 10-25',53,10],
    'ru-07':['10-26 至 11-01',50,10],
    'ru-08':['11-02 至 11-08',50,10]
  };
  for (const [id,[dates,count]] of Object.entries(expected)) {
    const lesson=api.LESSONS[id],cards=initialRows.filter(row=>row.lesson===id);
    assert(lesson,id);assert.equal(lesson.dates,dates);assert.equal(cards.length,count);
    assert(lesson.reading.sentences.length>=8 && lesson.reading.sentences.length<=10);
    for (const sentence of lesson.reading.sentences) {
      assert(sentence.text.match(/[.?!]$/),id+' sentence punctuation');
      assert(sentence.zh.match(/[\u3400-\u9fff]/),id+' sentence translation');
      assert.equal(sentence.text,sentence.text.normalize('NFC'));
    }
    for (const question of lesson.reading.questions) assert(question.options.includes(question.answer),id+' '+question.prompt);
    assert(lesson.explanation().includes('《东方大学俄语（新版）》第 '+({ 'ru-05':1,'ru-06':2,'ru-07':3,'ru-08':4 }[id])+' 课'),id);
    for (const row of cards) {
      assert.doesNotMatch(row.front,/[A-Za-z\u0341\u00b4]/,row.id);
      const words=row.front.match(/[А-Яа-яЁё\u0301]+/g) || [];
      for (const word of words) {
        if ((word.match(/[аеёиоуыэюя]/gi)||[]).length>1) assert(/[\u0301ёЁ]/.test(word),row.id+' '+word);
      }
      if (row.tags.split(';').includes('名词')) assert.match(row.note,/名词（(?:阳|阴|中|复数)/,row.id);
      if (row.tags.split(';').includes('不定式')) assert.match(row.note,/[一二]变位；六个人称：.*я .*；ты .*；.*мы .*；.*вы .*；они́ /,row.id);
      if (row.tags.split(';').includes('phrase')) assert.deepEqual(api.expandCards([row]).map(card=>card.direction),['r'],row.id);
    }
  }
});
test('修订 C：十个俄语 front、ru-05 例句、ru-07 双句翻译和标题时长正确',() => {
  const csvRows=api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','ru.csv'),'utf8'));
  const expected={
    'ru-0155':'кре́сло',
    'ru-0262':'эта́ж',
    'ru-0158':'корзи́на',
    'ru-0163':'комо́д',
    'ru-0218':'пото́м',
    'ru-0217':'снача́ла',
    'ru-0219':'почти́',
    'ru-0314':'приме́р',
    'ru-0328':'среда́',
    'ru-0184':'уже́'
  };
  for (const [id,front] of Object.entries(expected)) assert.equal(csvRows.find(row=>row.id===id)?.front,front,id);
  const nouns=csvRows.filter(row=>row.id>='ru-0142'&&row.id<='ru-0175');
  assert.equal(nouns.length,34);
  for (const row of nouns) {
    assert.notEqual(row.example,row.front,row.id);
    assert.match(row.example,/[.?!]$/,row.id);
  }
  for (const row of csvRows.filter(row=>row.lesson==='ru-07')) {
    const sentences=(row.example.match(/[.?!](?=\s|$)/g)||[]).length;
    if (sentences===2) assert.equal((row.example_zh.match(/[。？！](?=$|[^。？！])/g)||[]).length,2,row.id);
  }
  const {api:a,document}=createAPI(true);a.initialize();
  for (const id of ['ru-01','ru-02','ru-03','ru-04','ru-05','ru-06','ru-07','ru-08']) {
    a.openLesson(id);
    const title=document.querySelector('.kicker').textContent;
    assert(title.includes(['ru-05','ru-06','ru-07','ru-08'].includes(id)?'每天 30 分钟 + 周末系统块 60 分钟':'每天 10 分钟'),id);
  }
});
test('西语第 2–4 周阅读篇幅、双语句子、日期和练习配额符合课程安排',() => {
  for (const [id,min,max,count,dates,textQuestions] of [
    ['es-02',80,120,100,'09-21 至 09-27',7],
    ['es-03',100,150,100,'09-28 至 10-04',6],
    ['es-04',150,200,40,'10-05 至 10-11',6]
  ]) {
    const lesson=api.LESSONS[id];assert(lesson,id);
    const words=lesson.reading.sentences.flatMap(sentence=>sentence.text.match(/[\p{L}\p{M}]+/gu) || []);
    assert(words.length>=min && words.length<=max,`${id}: ${words.length} words, expected ${min}–${max}`);
    assert.equal(lesson.dates,dates);
    assert.equal(initialRows.filter(row=>row.lesson===id).length,count);
    assert.equal(lesson.exercises.filter(exercise=>!exercise.options).length,textQuestions);
    for (const sentence of lesson.reading.sentences) {
      assert.match(sentence.text,/[.?!]$/);assert.match(sentence.zh,/[\u3400-\u9fff]/);
      assert.equal(sentence.text,sentence.text.normalize('NFC'));
      if (sentence.text.includes('?')) assert(sentence.text.startsWith('¿'));
    }
    assert(lesson.explanation().includes('《现代西班牙语》第 '+lesson.week+' 课'));
  }
  assert.match(api.LESSONS['es-04'].writingTask,/15 分钟.*100 词/);
  assert.match(api.LESSONS['es-04'].explanation(),/本课短文|下方本课/);
});
test('西语新增 id 连续、名词带冠词标性；指定词群、重音和 20 个新同源词齐全',() => {
  const added=initialRows.filter(row=>['es-02','es-03','es-04'].includes(row.lesson));
  assert.deepEqual(added.map(row=>row.id),Array.from({length:240},(_,i)=>'es-'+String(114+i).padStart(4,'0')));
  for (const row of added) {
    for (const field of ['front','example','note']) assert.equal(row[field],row[field].normalize('NFC'),row.id);
    if (row.tags.split(';').includes('名词')) {
      assert.match(row.front,/^(el|la) /,row.id);
      assert.match(row.note,/名词（[阳阴]）/,row.id);
      assert(row.note.includes(row.front.startsWith('la ')?'名词（阴）':'名词（阳）'),row.id);
    }
  }
  const rowsFor=id=>initialRows.filter(row=>row.lesson===id);
  const tagged=(id,tag)=>rowsFor(id).filter(row=>row.tags.split(';').includes(tag));
  for (const [id,tag,count] of [['es-02','家庭',10],['es-02','职业',10],['es-02','地点',15],['es-02','数字',21],['es-02','星期',7],['es-03','食物',12],['es-03','家与家具',10],['es-03','月份',12],['es-03','颜色',6],['es-03','物主形容词',14]]) assert.equal(tagged(id,tag).length,count,id+' '+tag);
  const ar='comprar necesitar mirar escuchar llamar tomar buscar llegar entrar cantar bailar caminar preguntar contestar esperar ayudar usar pagar viajar desayunar'.split(' ');
  const erir='beber aprender comprender vender correr creer deber abrir recibir subir decidir compartir asistir discutir responder'.split(' ');
  const irregular='hacer poder querer decir saber conocer salir venir poner ver dar pensar entender empezar cerrar dormir volver almorzar pedir servir'.split(' ');
  for (const [id,expected] of [['es-02',ar],['es-03',erir],['es-04',irregular]]) assert.deepEqual(tagged(id,'不定式').map(row=>row.front),expected);
  for (const front of ['dieciséis','veintidós','veintitrés','veintiséis','el miércoles','el sábado','la canción','el lápiz','la mano','el problema','mañana','ayer','siempre','nunca','a veces','del','al']) assert(rowsFor('es-02').some(row=>row.front===front),front);
  for (const front of ['feliz','triste','cansado','ocupado','fácil','difícil','caro','barato','rico','interesante','importante','largo','corto','alto','bajo','la hora','el minuto','la semana','el mes','el año','la mañana']) assert(initialRows.some(row=>row.lang==='es' && row.lesson<='es-03' && row.front===front),front);
  assert.match(rowsFor('es-03').find(row=>row.front==='asistir').note,/假朋友.*出席.*帮助/);
  assert.match(rowsFor('es-02').find(row=>row.front==='mañana').back,/明天/);
  assert.match(rowsFor('es-03').find(row=>row.front==='la mañana').back,/早上/);
  const cognates=tagged('es-04','同源词'),previous=new Set(initialRows.filter(row=>row.lang==='es' && row.lesson<'es-04').map(row=>row.front));
  assert.equal(cognates.length,20);assert.equal(new Set(cognates.map(row=>row.front)).size,20);
  for (const row of cognates) assert(!previous.has(row.front),'同源词不重复旧卡：'+row.front);
});
test('西语变位表按人称保留关键不规则词形与重音，全部新讲解 HTML 可解析',() => {
  const contents=Object.fromEntries(['es-02','es-03','es-04'].map(id=>[id,parseNodes(api.LESSONS[id].explanation())[0]]));
  const expected={
    'es-02':[
      ['yo','-o','hablo','tengo','voy'],['tú','-as','hablas','tienes','vas'],
      ['él / ella / usted','-a','habla','tiene','va'],['nosotros / nosotras','-amos','hablamos','tenemos','vamos'],
      ['vosotros / vosotras','-áis','habláis','tenéis','vais'],['ellos / ellas / ustedes','-an','hablan','tienen','van']
    ],
    'es-03':[
      ['yo','-o','como','-o','vivo'],['tú','-es','comes','-es','vives'],['él / ella / usted','-e','come','-e','vive'],
      ['nosotros / nosotras','-emos','comemos','-imos','vivimos'],['vosotros / vosotras','-éis','coméis','-ís','vivís'],['ellos / ellas / ustedes','-en','comen','-en','viven']
    ]
  };
  for (const id of ['es-02','es-03']) {
    const table=contents[id].querySelector('table');
    assert.deepEqual(table.querySelector('tbody').querySelectorAll('tr').map(tr=>tr.querySelectorAll('td').map(td=>td.textContent)),expected[id]);
  }
  const irregularTable=contents['es-04'].querySelector('table');
  const forms=irregularTable.querySelector('tbody').querySelectorAll('tr').map(tr=>tr.querySelectorAll('td').map(td=>td.textContent));
  assert.equal(forms.length,11);
  for (const [name,expectedForms] of [
    ['decir','digo dices dice decimos decís dicen'],['saber','sé sabes sabe sabemos sabéis saben'],
    ['conocer','conozco conoces conoce conocemos conocéis conocen'],['venir','vengo vienes viene venimos venís vienen'],
    ['ver','veo ves ve vemos veis ven'],['dar','doy das da damos dais dan']
  ]) assert.deepEqual(forms.find(row=>row[0].startsWith(name+'（')).slice(1),expectedForms.split(' '));
  for (const word of ['pienso','pensamos','pensáis','duermo','dormimos','dormís','pido','pedimos','pedís','sirvo','servís']) assert(api.LESSONS['es-04'].explanation().includes(word),word);
});
test('任务 D：es-05 至 es-08 的日期、卡片数、阅读篇幅与练习配额符合课程安排',() => {
  const expected={
    'es-05':{dates:'10-12 至 10-18',cards:90,sentences:15,min:150,max:200,questions:4,text:5,book:5},
    'es-06':{dates:'10-19 至 10-25',cards:90,sentences:18,min:170,max:220,questions:3,text:6,book:5},
    'es-07':{dates:'10-26 至 11-01',cards:90,sentences:20,min:170,max:220,questions:4,text:5,book:6},
    'es-08':{dates:'11-02 至 11-08',cards:90,sentences:24,min:220,max:280,questions:4,text:5,book:6}
  };
  for (const [id,want] of Object.entries(expected)) {
    const lesson=api.LESSONS[id],cards=initialRows.filter(row=>row.lesson===id);
    assert(lesson,id);assert.equal(lesson.lang,'es');assert.equal(lesson.week,Number(id.slice(3)));
    assert.equal(lesson.dates,want.dates,id+' 日期');
    assert.equal(cards.length,want.cards,id+' 卡片数');
    assert.equal(lesson.reading.sentences.length,want.sentences,id+' 阅读句数');
    const words=lesson.reading.sentences.flatMap(sentence=>sentence.text.match(/[\p{L}\p{M}]+/gu) || []);
    assert(words.length>=want.min && words.length<=want.max,`${id}: ${words.length} words, expected ${want.min}–${want.max}`);
    assert.equal(lesson.reading.questions.length,want.questions,id+' 阅读题数');
    assert.equal(lesson.exercises.length,10,id+' 练习总数');
    assert.equal(lesson.exercises.filter(exercise=>!exercise.options).length,want.text,id+' 文本题数');
    assert.deepEqual(lesson.exercises.slice(-want.questions),lesson.reading.questions,id+' 阅读题排在末尾');
    for (const sentence of lesson.reading.sentences) {
      assert.match(sentence.text,/[.?!]$/,id);assert.match(sentence.zh,/[㐀-鿿]/,id);
      assert.equal(sentence.text,sentence.text.normalize('NFC'),id);
      if (sentence.text.includes('?')) assert(sentence.text.startsWith('¿'),id+' 问句要以 ¿ 开头');
    }
    for (const question of lesson.reading.questions) {
      assert(question.options.includes(question.answer),id+' '+question.prompt);
      assert.equal(question.options.length,new Set(question.options).size,id+' '+question.prompt);
    }
    const explanation=lesson.explanation();
    assert(explanation.includes('《现代西班牙语》第 '+want.book+' 课'),id+' 教材指引');
    assert.match(explanation,/每天 25 分钟/,id+' 每日 25 分钟');
    assert.match(explanation,/每周.{0,6}30 分钟/,id+' 每周一次 30 分钟');
    assert(parseNodes(explanation)[0].querySelector('table'),id+' 讲解含变位表');
  }
  for (const id of ['es-07','es-08']) assert.match(api.LESSONS[id].explanation(),/preterite/,id+' 应提示英文语法练习册');
  assert.match(api.LESSONS['es-08'].writingTask,/15 分钟.*100 词/);
  assert.match(api.LESSONS['es-08'].explanation(),/月度检查点 2/);
  assert.match(api.LESSONS['es-08'].explanation(),/本课短文|下方本课/);
});
test('任务 D：西语新增 id 连续、名词带冠词标性、变位 note 列六个人称，整句只出识别卡',() => {
  const lessons=['es-05','es-06','es-07','es-08'];
  const added=initialRows.filter(row=>lessons.includes(row.lesson));
  assert.deepEqual(added.map(row=>row.id),Array.from({length:360},(_,i)=>'es-'+String(354+i).padStart(4,'0')));
  // CSV 与内嵌 JSON 的新增段落逐字段一致。
  const csvRows=api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','es.csv'),'utf8'));
  assert.deepEqual(plain(csvRows.filter(row=>lessons.includes(row.lesson))),plain(added));
  const older=new Set(initialRows.filter(row=>row.lang==='es' && !lessons.includes(row.lesson)).map(row=>row.front));
  const gender={el:'名词（阳）',la:'名词（阴）',los:'名词（阳，复数）',las:'名词（阴，复数）'};
  const seen=new Set();
  for (const row of added) {
    for (const field of ['front','back','example','example_zh','note']) {
      assert(row[field],row.id+' '+field+' 不能为空');
      assert.equal(row[field],row[field].normalize('NFC'),row.id+' '+field+' 须为 NFC');
    }
    assert(!older.has(row.front),'新词不与旧卡重复：'+row.front);
    assert(!seen.has(row.front),'新词内部不重复：'+row.front);
    seen.add(row.front);
    assert.match(row.example,/[.?!]$/,row.id+' 例句结尾');
    if (row.example.includes('?')) assert(row.example.startsWith('¿'),row.id+' 问句要以 ¿ 开头');
    const tags=row.tags.split(';');
    if (tags.includes('名词')) {
      const article=row.front.match(/^(el|la|los|las) /);
      assert(article,row.id+' 名词 front 缺冠词');
      assert(row.note.startsWith(gender[article[1]]),row.id+' note 应以 '+gender[article[1]]+' 开头');
    }
    if (tags.includes('不定式') || tags.includes('不规则') || (tags.includes('过去时') && tags.includes('词干变化'))) {
      assert(row.note.split(' / ').length>=6,row.id+' 变位 note 未列出六个人称');
    }
    assert.deepEqual(api.expandCards([row]).map(card=>card.direction),tags.includes('phrase')?['r']:['r','p'],row.id);
  }
  for (const id of lessons) assert.equal(initialRows.filter(row=>row.lesson===id && row.tags.split(';').includes('phrase')).length,5,id+' 整句卡');
  const table=id=>parseNodes(api.LESSONS[id].explanation())[0].querySelectorAll('table')
    .flatMap(node=>node.querySelector('tbody').querySelectorAll('tr').map(tr=>tr.querySelectorAll('td').map(td=>td.textContent)));
  const es05=table('es-05');
  for (const forms of ['yo me me levanto me ducho me acuesto','vosotros / vosotras os os levantáis os ducháis os acostáis','ellos / ellas / ustedes se se levantan se duchan se acuestan'])
    assert(es05.some(row=>row.join(' ')===forms),'es-05 缺变位行：'+forms);
  const es06=table('es-06');
  assert(es06.some(row=>row.join(' ')==='él / ella / usted lo / la le'),'es-06 宾语代词表');
  assert(es06.some(row=>row.slice(1).join(' ')==='aquel aquella aquellos aquellas aquello'),'es-06 指示词表');
  const es07=table('es-07');
  for (const [person,forms] of [['yo','hablé comí viví'],['él / ella / usted','habló comió vivió'],['nosotros / nosotras','hablamos comimos vivimos'],['ellos / ellas / ustedes','hablaron comieron vivieron']])
    assert(es07.some(row=>row[0]===person && row.slice(2).join(' ')===forms),'es-07 '+person);
  const es08=table('es-08');
  for (const [first,forms] of [
    ['hacer（做）','hic- hice hiciste hizo hicimos hicisteis hicieron'],
    ['decir（说）','dij- dije dijiste dijo dijimos dijisteis dijeron'],
    ['traer（带来）','traj- traje trajiste trajo trajimos trajisteis trajeron'],
    ['ser / ir（是；去）','fui fuiste fue fuimos fuisteis fueron'],
    ['ver（看见）','vi viste vio vimos visteis vieron']
  ]) assert(es08.some(row=>row[0]===first && row.slice(1).join(' ')===forms),'es-08 '+first);
});
// 西语阅读的词汇范围：本课及以前的词卡、note 里列出的变位形式、规则动词的推导形式。
// 任务 D（第 5–8 周）与任务 E1（第 9–12 周）共用同一套规则，不各写一份。
const esWords=text=>text.toLowerCase().match(/[\p{L}\p{M}]+/gu) || [];
const ES_ENDINGS={
  ar:['o','as','a','amos','áis','an','é','aste','ó','asteis','aron','ando'],
  er:['o','es','e','emos','éis','en','í','iste','ió','imos','isteis','ieron','iendo'],
  ir:['o','es','e','imos','ís','en','í','iste','ió','isteis','ieron','iendo']
};
// 只额外放行两个人名和形容词在阳性单数名词前的短尾形式；其余全部由词卡推导。
const ES_EXTRA=['ana','juan','primer','buen','gran'];
const ES_PARTICIPLES={abrir:'abierto',cubrir:'cubierto',decir:'dicho',escribir:'escrito',hacer:'hecho',morir:'muerto',poner:'puesto',romper:'roto',ver:'visto',volver:'vuelto',resolver:'resuelto',devolver:'devuelto',descubrir:'descubierto',componer:'compuesto',deshacer:'deshecho',imprimir:'impreso',prever:'previsto',freír:'frito',leer:'leído',creer:'creído',traer:'traído',caer:'caído',oír:'oído',reír:'reído'};
const ES_FUTURE_STEMS={tener:'tendr',poder:'podr',saber:'sabr',haber:'habr',poner:'pondr',salir:'saldr',venir:'vendr',decir:'dir',hacer:'har',querer:'querr',caber:'cabr',valer:'valdr',obtener:'obtendr',mantener:'mantendr',proponer:'propondr',componer:'compondr',deshacer:'deshar',satisfacer:'satisfar'};
const ES_COMMANDS={
  decir:['di','diga','decid','digan','digamos'],hacer:['haz','haga','haced','hagan','hagamos'],
  ir:['ve','vaya','id','vayan','vayamos'],poner:['pon','ponga','poned','pongan','pongamos'],
  salir:['sal','salga','salid','salgan','salgamos'],ser:['sé','sea','sed','sean','seamos'],
  tener:['ten','tenga','tened','tengan','tengamos'],venir:['ven','venga','venid','vengan','vengamos'],
  dar:['da','dé','dad','den','demos'],estar:['está','esté','estad','estén','estemos'],
  saber:['sabe','sepa','sabed','sepan','sepamos'],ver:['ve','vea','ved','vean','veamos'],
  seguir:['sigue','siga','seguid','sigan','sigamos'],sentar:['sienta','siente','sentad','sienten','sentemos'],
  pedir:['pide','pida','pedid','pidan','pidamos'],servir:['sirve','sirva','servid','sirvan','sirvamos'],
  dormir:['duerme','duerma','dormid','duerman','durmamos'],repetir:['repite','repita','repetid','repitan','repitamos'],
  volver:['vuelve','vuelva','volved','vuelvan','volvamos'],querer:['quiere','quiera','quered','quieran','queramos'],
  preferir:['prefiere','prefiera','preferid','prefieran','prefiramos'],cerrar:['cierra','cierre','cerrad','cierren','cerremos'],
  empezar:['empieza','empiece','empezad','empiecen','empecemos'],recordar:['recuerda','recuerde','recordad','recuerden','recordemos'],
  encontrar:['encuentra','encuentre','encontrad','encuentren','encontremos'],oír:['oye','oiga','oíd','oigan','oigamos'],
  mostrar:['muestra','muestre','mostrad','muestren','mostremos'],
  conocer:['conoce','conozca','conoced','conozcan','conozcamos'],ofrecer:['ofrece','ofrezca','ofreced','ofrezcan','ofrezcamos'],
  conducir:['conduce','conduzca','conducid','conduzcan','conduzcamos'],traducir:['traduce','traduzca','traducid','traduzcan','traduzcamos'],
  corregir:['corrige','corrija','corregid','corrijan','corrijamos'],
  comprobar:['comprueba','compruebe','comprobad','comprueben','comprobemos']
};
const esDeaccent=word=>word.normalize('NFD').replace(/\u0301/g,'').normalize('NFC');
// 接宾语代词时保持原动词的重读音节；按新词形的默认重音决定是否写重音符号。
const esNuclei=word=>{
  const groups=[];
  for (let i=0;i<word.length;i++) {
    const char=word[i];
    if (!/[aeiouáéíóúü]/.test(char) || (char==='u' && /[qg]/.test(word[i-1] || '') && /[eiéí]/.test(word[i+1] || ''))) continue;
    const last=groups.at(-1),previous=last?.at(-1);
    const adjoining=previous!==undefined && (i===previous+1 || (i===previous+2 && word[i-1]==='h'));
    if (adjoining && !/[íú]/.test(char+word[previous]) && !(/[aeoáéó]/.test(char) && /[aeoáéó]/.test(word[previous]))) last.push(i);
    else groups.push([i]);
  }
  return groups;
};
const esAttach=(verb,suffix)=>{
  const nuclei=esNuclei(verb);
  if (!nuclei.length) return verb+suffix;
  const written=nuclei.findIndex(group=>group.some(i=>/[áéíóú]/.test(verb[i])));
  const stressed=nuclei[written>=0?written:Math.max(0,nuclei.length-(/[aeiounsáéíóú]$/.test(verb)?2:1))];
  const stressIndex=stressed.find(i=>/[áéíóú]/.test(verb[i])) ?? stressed.find(i=>/[aeo]/.test(verb[i])) ?? stressed.at(-1);
  const joined=esDeaccent(verb)+suffix,extended=esNuclei(joined);
  const defaultStress=extended[Math.max(0,extended.length-(/[aeiouns]$/.test(joined)?2:1))];
  if (defaultStress.includes(stressIndex)) return joined;
  return joined.slice(0,stressIndex)+({a:'á',e:'é',i:'í',o:'ó',u:'ú'}[joined[stressIndex]] || joined[stressIndex])+joined.slice(stressIndex+1);
};
const ES_CLITICS=['me','te','se','lo','la','le','nos','os','los','las','les',...['me','te','se','nos','os'].flatMap(first=>['lo','la','los','las'].map(last=>first+last))];
const esListedForms=row=>row.note.split(/[；;：:。.!?]/).filter(part=>part.includes(' / ')).map(part=>part.trim().replace(/^(?:性数形式|复数形式)\s*/,'').split(' / ')).filter(parts=>parts.every(part=>/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s-]+$/.test(part)));
// 第 17 周起按已学不定式推导虚拟式；不规则范式只对已学动词生效。
const ES_SUBJUNCTIVE_SPECIAL={
  ser:['sea','seas','sea','seamos','seáis','sean'],
  estar:['esté','estés','esté','estemos','estéis','estén'],
  ir:['vaya','vayas','vaya','vayamos','vayáis','vayan'],
  haber:['haya','hayas','haya','hayamos','hayáis','hayan'],
  saber:['sepa','sepas','sepa','sepamos','sepáis','sepan'],
  dar:['dé','des','dé','demos','deis','den']
};
const ES_SUBJUNCTIVE_STEMS={
  tener:['teng'],hacer:['hag'],poder:['pued','pod'],venir:['veng'],poner:['pong'],salir:['salg'],decir:['dig'],
  caber:['quep'],valer:['valg'],ver:['ve'],traer:['traig'],caer:['caig'],oír:['oig'],
  conocer:['conozc'],ofrecer:['ofrezc'],nacer:['nazc'],conducir:['conduzc'],traducir:['traduzc'],
  producir:['produzc'],parecer:['parezc'],pertenecer:['pertenezc'],crecer:['crezc'],
  pedir:['pid'],servir:['sirv'],repetir:['repit'],seguir:['sig'],conseguir:['consig'],
  elegir:['elij'],corregir:['corrij'],vestir:['vist'],
  dormir:['duerm','durm'],morir:['muer','mur'],sentir:['sient','sint'],preferir:['prefier','prefir'],
  mentir:['mient','mint'],hervir:['hierv','hirv'],invertir:['inviert','invirt'],
  querer:['quier','quer'],entender:['entiend','entend'],perder:['pierd','perd'],
  volver:['vuelv','volv'],devolver:['devuelv','devolv'],resolver:['resuelv','resolv'],
  envolver:['envuelv','envolv'],remover:['remuev','remov'],mover:['muev','mov'],
  atender:['atiend','atend'],verter:['viert','vert'],
  pensar:['piens','pens'],cerrar:['cierr','cerr'],empezar:['empiec','empec'],comenzar:['comienc','comenc'],
  calentar:['calient','calent'],recomendar:['recomiend','recomend'],despertar:['despiert','despert'],sentar:['sient','sent'],
  encontrar:['encuentr','encontr'],recordar:['recuerd','record'],mostrar:['muestr','mostr'],
  probar:['prueb','prob'],comprobar:['comprueb','comprob'],costar:['cuest','cost'],
  contar:['cuent','cont'],almorzar:['almuerc','almorc'],acostar:['acuest','acost'],jugar:['juegu','jugu'],
  enviar:['enví','envi'],continuar:['continú','continu'],actuar:['actú','actu'],
  reír:['rí','ri'],freír:['frí','fri'],obtener:['obteng'],mantener:['manteng'],
  proponer:['propong'],componer:['compong'],disponer:['dispong'],deshacer:['deshag'],prever:['preve'],
  evaluar:['evalú','evalu'],confiar:['confí','confi'],esforzar:['esfuerc','esforc'],
  obedecer:['obedezc'],reducir:['reduzc'],rogar:['ruegu','rogu'],
  prohibir:['prohíb','prohib'],tender:['tiend','tend']
};
const esSubjunctive=infinitive=>{
  if (ES_SUBJUNCTIVE_SPECIAL[infinitive]) return ES_SUBJUNCTIVE_SPECIAL[infinitive];
  const match=infinitive.match(/^([\p{L}\p{M}]*)(ar|er|[ií]r)$/u);
  if (!match) return [];
  let [,stem,kind]=match;kind=kind.replace('í','i');
  if (kind==='ar') stem=stem.replace(/c$/,'qu').replace(/g$/,'gu').replace(/z$/,'c');
  else if (/gu$/.test(stem)) stem=stem.slice(0,-1);
  else stem=stem.replace(/g$/,'j');
  // -uir 保留 y；-guir 的 u 用于拼写，不能按 -uir 处理。
  if (/[^g]uir$/.test(infinitive)) stem+='y';
  const [singular,plural=singular]=ES_SUBJUNCTIVE_STEMS[infinitive] || [stem];
  const endings=kind==='ar'?['e','es','e','emos','éis','en']:['a','as','a','amos','áis','an'];
  return endings.map((ending,index)=>(index===3 || index===4?plural:singular)+ending);
};
// 第 24 周起，由已学的单词形容词推导 -mente 与 -ísimo；不从例句取词。
const esAdjectiveDerivations=(row,lesson)=>{
  if (lesson<'es-24' || row.lesson>lesson || !row.tags.split(';').includes('形容词')) return [];
  const word=row.front.toLowerCase();
  if (!/^[a-záéíóúüñ]+$/.test(word)) return [];
  const forms=[word.replace(/o$/,'a')+'mente'];
  // 下面是不涉及古典不规则最高级的常见词干；重音落在 -ísimo 的 í 上。
  const special={joven:'jovenc',antiguo:'antiqu',fiel:'fidel'};
  let stem=special[word] || esDeaccent(word).replace(/ble$/,'bil').replace(/[aeo]$/,'');
  if (!special[word]) stem=stem.replace(/c$/,'qu').replace(/g$/,'gu').replace(/z$/,'c');
  for (const ending of ['ísimo','ísima','ísimos','ísimas']) forms.push(stem+ending);
  return forms;
};
// 只在相应名词已经入卡后使用：carácter 复数移重音，后两词单复数同形。
const ES_NOUN_PLURALS={carácter:'caracteres',síntesis:'síntesis',análisis:'análisis'};
const esVocabulary=lesson => {
  const week=Number(lesson.slice(3)),set=new Set(ES_EXTRA);
  for (const row of initialRows.filter(row=>row.lang==='es' && row.lesson<=lesson)) {
    for (const word of esWords(row.front)) set.add(word);
    for (const form of esAdjectiveDerivations(row,lesson)) set.add(form);
    // 旧课保留既有词汇范围；新课例句独立核验，不能用例句自身扩大词表。
    if (row.lesson<'es-13') for (const word of esWords(row.example)) set.add(word);
    // 只读取明确用斜线列出的词形；不把 note 的散文说明当作允许词表。
    if (row.lesson<'es-13') {
      for (const part of row.note.split(/[；;：:]/)) if (part.includes(' / ')) for (const word of esWords(part)) set.add(word);
    } else for (const forms of esListedForms(row)) for (const form of forms) for (const word of esWords(form)) set.add(word);
    if (row.tags.split(';').includes('名词')) {
      for (const word of esWords(row.front).slice(1)) set.add(ES_NOUN_PLURALS[word] || esAttach(word.replace(/z$/,'c'),/[aeiouáéíóú]$/.test(word)?'s':'es'));
      const feminine=row.note.match(/女性(?:为|是) (?:la|una) ([\p{L}\p{M}]+)/u)?.[1];
      if (feminine) set.add(feminine);
    }
    if (row.lesson>='es-13' && row.tags.split(';').includes('分词')) {
      const infinitive=row.note.match(/(?:对应不定式|不定式)[：: ]+([\p{L}\p{M}]+)/u)?.[1];
      if (infinitive) set.add(infinitive.toLowerCase());
    }
    if (!row.tags.split(';').some(tag=>['动词','不定式'].includes(tag))) continue;
    const taughtInfinitive=row.lesson>='es-13'?row.note.match(/^([\p{L}\p{M}]+) 的(?:现在完成时|过去完成时|简单将来时|条件式|肯定命令式|虚拟式现在时|现在时|简单过去时)/u)?.[1]:null;
    const infinitive=(taughtInfinitive || row.front).toLowerCase().replace(/se$/,''),verb=infinitive.match(/^([\p{L}\p{M}]*?)(ar|er|[ií]r)$/u);
    if (!verb) continue;
    const [,stem,endingKind]=verb,kind=endingKind.replace('í','i');
    set.add(infinitive);
    for (const ending of ES_ENDINGS[kind]) set.add(stem+ending);
    // -ar 词干变化沿用已学动词；从虚拟式词干还原 e 前的拼写变化。
    if (week>=17 && kind==='ar' && ES_SUBJUNCTIVE_STEMS[infinitive]) {
      let presentStem=ES_SUBJUNCTIVE_STEMS[infinitive][0];
      if (/car$/.test(infinitive)) presentStem=presentStem.replace(/qu$/,'c');
      if (/gar$/.test(infinitive)) presentStem=presentStem.replace(/gu$/,'g');
      if (/zar$/.test(infinitive)) presentStem=presentStem.replace(/c$/,'z');
      for (const ending of ['o','as','a','an']) set.add(presentStem+ending);
    }
    if (kind === 'ar') {
      if (stem.endsWith('c')) set.add(stem.slice(0,-1)+'qué');
      if (stem.endsWith('g')) set.add(stem+'ué');
      if (stem.endsWith('z')) set.add(stem.slice(0,-1)+'cé');
    }
    if (week>=9) {
      const irregular={ser:['era','eras','era','éramos','erais','eran'],ir:['iba','ibas','iba','íbamos','ibais','iban'],ver:['veía','veías','veía','veíamos','veíais','veían']}[infinitive];
      for (const form of irregular || (kind==='ar'?['aba','abas','aba','ábamos','abais','aban']:['ía','ías','ía','íamos','íais','ían']).map(end=>stem+end)) set.add(form);
    }
    if (week>=8 && kind==='ir') {
      const changed={pedir:'pid',servir:'sirv',repetir:'repit',seguir:'sigu',conseguir:'consigu',elegir:'elig',preferir:'prefir',sentir:'sint',dormir:'durm',morir:'mur',corregir:'corrig'}[infinitive];
      if (changed) for (const end of ['ió','ieron']) set.add(changed+end);
    }
    if (week>=13) {
      set.add(ES_PARTICIPLES[infinitive] || stem+(kind==='ar'?'ado':'ido'));
      // haber 是本课完成时公式中明确教到的助动词。
      for (const word of ['haber','he','has','ha','hemos','habéis','han','habido']) set.add(word);
    }
    const futureStem=ES_FUTURE_STEMS[infinitive] || esDeaccent(infinitive);
    if (week>=14) for (const end of ['é','ás','á','emos','éis','án']) set.add(futureStem+end);
    if (week>=15) for (const end of ['ía','ías','ía','íamos','íais','ían']) set.add(futureStem+end);
    if (week>=17) for (const form of esSubjunctive(infinitive)) set.add(form);
    // 已学的宾语代词可以接在不定式后；拼写保留需要的重音。
    if (week>=6) for (const suffix of ES_CLITICS) set.add(esAttach(infinitive,suffix));
    if (week>=16) {
      let formalStem=stem;
      if (kind==='ar') formalStem=formalStem.replace(/c$/,'qu').replace(/g$/,'gu').replace(/z$/,'c');
      const forms=ES_COMMANDS[infinitive] || (kind==='ar'
        ? [stem+'a',formalStem+'e',stem+'ad',formalStem+'en',formalStem+'emos']
        : [stem+'e',formalStem+'a',stem+(kind==='er'?'ed':'id'),formalStem+'an',formalStem+'amos']);
      for (const form of forms) {
        set.add(form);
        for (const suffix of ES_CLITICS) set.add(esAttach(form,suffix));
      }
      if (row.front.endsWith('se')) {
        for (let i=0;i<forms.length;i++) {
          if (i===2) set.add(forms[i].replace(/ad$/,'aos').replace(/ed$/,'eos').replace(/[ií]d$/,'íos'));
          else if (i===4) set.add(esAttach(forms[i],'nos').replace(/snos$/,'nos'));
          else set.add(esAttach(forms[i],['te','se','os','se','nos'][i]));
        }
      }
    }
  }
  return set;
};
const esVariants=word=>[word,word.replace(/es$/,''),word.replace(/s$/,''),word.replace(/as$/,'os'),word.replace(/as$/,'o'),word.replace(/a$/,'o'),word.replace(/os$/,'o')];
const esKnown=(lesson,word)=>esVariants(word).some(form=>esVocabulary(lesson).has(form));
const esVocabularyMisses=(lesson,sentences,set=esVocabulary(lesson))=>{
  const unknown=new Map();
  for (const sentence of sentences) for (const word of esWords(sentence.text)) {
    if (!esVariants(word).some(form=>set.has(form)) && !unknown.has(word)) unknown.set(word,{sentence:sentence.text,...(sentence.id?{card:sentence.id}:{})});
  }
  return [...unknown].map(([word,location])=>({word,...location}));
};
const checkSentenceVocabulary=(lesson,sentences,label) => {
  const misses=esVocabularyMisses(lesson,sentences);
  assert.deepEqual(misses,[],label+' 阅读超出词表：'+misses.map(item=>item.word).join('、'));
};
const checkReadingVocabulary=ids => { for (const id of ids) checkSentenceVocabulary(id,api.LESSONS[id].reading.sentences,id); };
test('任务 D：第 5–8 周阅读只用已学词、本课词及其规则变化形式',() => {
  checkReadingVocabulary(['es-05','es-06','es-07','es-08']);
  // 反向检查：规则本身能判出未学的词和还没到的课次。
  assert(!esKnown('es-08','nevera'),'未学的词应判出');
  assert(!esKnown('es-05','durmiendo'),'第 6 周才学的副动词不该通过第 5 周的检查');
  assert(esKnown('es-05','levanto'),'第 5 周应认得反身动词的 yo 形式');
  assert(esKnown('es-08','anduvimos'),'不规则过去时应由 note 里的六个人称放行');
  assert(esKnown('es-07','saqué'),'-car 动词的 yo 过去时应由拼写规则放行');
});
test('任务 E1：es-09 至 es-12 的日期、卡片数、阅读篇幅与练习配额符合课程安排',() => {
  const expected={
    'es-09':{dates:'11-09 至 11-15',cards:80,sentences:26,min:220,max:260,questions:4,text:6,book:7},
    'es-10':{dates:'11-16 至 11-22',cards:80,sentences:28,min:250,max:300,questions:4,text:1,book:7},
    'es-11':{dates:'11-23 至 11-29',cards:80,sentences:28,min:260,max:300,questions:4,text:5,book:8},
    'es-12':{dates:'11-30 至 12-06',cards:40,sentences:32,min:300,max:350,questions:4,text:5,book:null}
  };
  for (const [id,want] of Object.entries(expected)) {
    const lesson=api.LESSONS[id],cards=initialRows.filter(row=>row.lesson===id);
    assert(lesson,id);assert.equal(lesson.lang,'es');assert.equal(lesson.week,Number(id.slice(3)));
    assert.equal(lesson.dates,want.dates,id+' 日期');
    assert.equal(cards.length,want.cards,id+' 卡片数');
    assert.equal(lesson.reading.sentences.length,want.sentences,id+' 阅读句数');
    const words=lesson.reading.sentences.flatMap(sentence=>sentence.text.match(/[\p{L}\p{M}]+/gu) || []);
    assert(words.length>=want.min && words.length<=want.max,`${id}: ${words.length} words, expected ${want.min}–${want.max}`);
    assert.equal(lesson.reading.questions.length,want.questions,id+' 阅读题数');
    assert.equal(lesson.exercises.length,10,id+' 练习总数');
    assert.equal(lesson.exercises.filter(exercise=>!exercise.options).length,want.text,id+' 文本题数');
    assert.deepEqual(lesson.exercises.slice(-want.questions),lesson.reading.questions,id+' 阅读题排在末尾');
    for (const sentence of lesson.reading.sentences) {
      assert.match(sentence.text,/[.?!]$/,id);assert.match(sentence.zh,/[㐀-鿿]/,id);
      assert.equal(sentence.text,sentence.text.normalize('NFC'),id);
      if (sentence.text.includes('?')) assert(sentence.text.startsWith('¿'),id+' 问句要以 ¿ 开头');
    }
    for (const question of lesson.reading.questions) {
      assert(question.options.includes(question.answer),id+' '+question.prompt);
      assert.equal(question.options.length,new Set(question.options).size,id+' '+question.prompt);
    }
    const explanation=lesson.explanation();
    if (want.book) assert(explanation.includes('《现代西班牙语》第 '+want.book+' 课'),id+' 教材指引');
    assert.match(explanation,/每天 25 分钟/,id+' 每日 25 分钟');
    assert.match(explanation,/每周.{0,6}30 分钟/,id+' 每周一次 30 分钟');
    assert(parseNodes(explanation)[0].querySelector('table'),id+' 讲解含表格');
  }
  // es-12 是复盘周：讲解要指到框架文件、月度检查点 3 和下一阶段。
  const review=api.LESSONS['es-12'].explanation();
  for (const text of ['月度检查点 3','framework/metrics-and-review.md','决定矩阵','本课短文','维持模式','建设期','《现代西班牙语》第 5 至 8 课']) assert(review.includes(text),'es-12 讲解缺少：'+text);
  // 教材课次按 spanish/roadmap.md 的第 5 周起每两周 1 课；同一课的 goal 与讲解写法一致。
  for (const [id,book] of [['es-05',5],['es-06',5],['es-07',6],['es-08',6],['es-09',7],['es-10',7],['es-11',8]])
    assert(api.LESSONS[id].goal.includes('《现代西班牙语》第 '+book+' 课'),id+' 目标里的教材课次');
  assert.match(api.LESSONS['es-12'].writingTask,/15 分钟.*100 词/);
  const table=id=>parseNodes(api.LESSONS[id].explanation())[0].querySelectorAll('table')
    .flatMap(node=>node.querySelector('tbody').querySelectorAll('tr').map(tr=>tr.querySelectorAll('td').map(td=>td.textContent)));
  const es09=table('es-09');
  for (const [person,forms] of [['yo','hablaba comía vivía'],['nosotros / nosotras','hablábamos comíamos vivíamos'],['ellos / ellas / ustedes','hablaban comían vivían']])
    assert(es09.some(row=>row[0]===person && row.slice(2).join(' ')===forms),'es-09 '+person);
  for (const [first,forms] of [
    ['ser（是）','era eras era éramos erais eran'],
    ['ir（去）','iba ibas iba íbamos ibais iban'],
    ['ver（看见）','veía veías veía veíamos veíais veían']
  ]) assert(es09.some(row=>row[0]===first && row.slice(1).join(' ')===forms),'es-09 '+first);
  const es10=table('es-10');
  assert(es10.some(row=>row[0].startsWith('saber') && row[1].startsWith('sabía') && row[2].startsWith('supe')),'es-10 意义变化动词表');
  assert(es10.filter(row=>row[1]==='过去未完成时').length>=4,'es-10 对照表的背景类用法');
  assert(es10.filter(row=>row[1]==='简单过去时').length>=3,'es-10 对照表的事件类用法');
  const es11=table('es-11');
  assert(es11.some(row=>row.join(' ').includes('tan + 形容词或副词 + como')),'es-11 同级比较');
  assert(es11.some(row=>row[1]==='在……旁边' && row[0]==='al lado de'),'es-11 方位短语表');
  assert(es11.some(row=>row[1].includes('alguien') && row[2].includes('nadie')),'es-11 不定词表');
  assert(table('es-12').length>=7,'es-12 复习清单按语法点各占一行');
  for (const [id,text] of [['es-09','había'],['es-10','mientras'],['es-11','cien'],['es-12','futuro']])
    assert(api.LESSONS[id].explanation().includes(text),id+' 讲解缺少：'+text);
});
test('任务 E1：西语第 9–12 周 id 连续、名词带冠词标性、变位 note 列六个人称，整句只出识别卡',() => {
  const lessons=['es-09','es-10','es-11','es-12'];
  const added=initialRows.filter(row=>lessons.includes(row.lesson));
  assert.deepEqual(added.map(row=>row.id),Array.from({length:280},(_,i)=>'es-'+String(714+i).padStart(4,'0')));
  // CSV 与内嵌 JSON 的新增段落逐字段一致。
  const csvRows=api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','es.csv'),'utf8'));
  assert.deepEqual(plain(csvRows.filter(row=>lessons.includes(row.lesson))),plain(added));
  const older=new Set(initialRows.filter(row=>row.lang==='es' && !lessons.includes(row.lesson)).map(row=>row.front));
  const gender={el:'名词（阳）',la:'名词（阴）',los:'名词（阳，复数）',las:'名词（阴，复数）'};
  const seen=new Set();
  for (const row of added) {
    assert.equal(row.lang,'es',row.id);
    for (const field of ['front','back','example','example_zh','note']) {
      assert(row[field],row.id+' '+field+' 不能为空');
      assert.equal(row[field],row[field].normalize('NFC'),row.id+' '+field+' 须为 NFC');
    }
    assert(!older.has(row.front),'新词不与旧卡重复：'+row.front);
    assert(!seen.has(row.front),'新词内部不重复：'+row.front);
    seen.add(row.front);
    assert.match(row.example,/[.?!]$/,row.id+' 例句结尾');
    if (row.example.includes('?')) assert(row.example.startsWith('¿'),row.id+' 问句要以 ¿ 开头');
    const tags=row.tags.split(';');
    if (tags.includes('名词')) {
      const article=row.front.match(/^(el|la|los|las) /);
      assert(article,row.id+' 名词 front 缺冠词');
      assert(row.note.startsWith(gender[article[1]]),row.id+' note 应以 '+gender[article[1]]+' 开头');
    }
    if (['不定式','不规则','过去未完成时','过去时'].some(tag=>tags.includes(tag))) {
      assert(row.note.split(' / ').length>=6,row.id+' 变位 note 未列出六个人称');
    }
    assert.deepEqual(api.expandCards([row]).map(card=>card.direction),tags.includes('phrase')?['r']:['r','p'],row.id);
  }
  // 每课 5 条整句，只出识别卡；hace frío 这类多词短语另外标 phrase。
  for (const id of lessons) assert.equal(initialRows.filter(row=>row.lesson===id && row.tags==='句型;phrase').length,5,id+' 整句卡');
  for (const front of ['hace frío','hace calor','cuando era niño','tener miedo','darse cuenta'])
    assert(added.find(row=>row.front===front).tags.split(';').includes('phrase'),front+' 应标 phrase');
  // 各课都覆盖到任务要求的词类。
  const has=(lesson,front)=>added.some(row=>row.lesson===lesson && row.front===front);
  for (const front of ['era','iba','veía','había','el árbol','el verano','hace frío','soñar','a menudo']) assert(has('es-09',front),'es-09 缺 '+front);
  for (const front of ['sabía','conocí','conocía','podía','tenía que','tuve que','de pronto','por eso','aparecer']) assert(has('es-10',front),'es-10 缺 '+front);
  for (const front of ['más','tan','mejor','mayor','alguien','nadie','ningún','al lado de','cien','mil','el edificio']) assert(has('es-11',front),'es-11 缺 '+front);
  for (const front of ['la experiencia','el progreso','repasar','traducir','corregir']) assert(has('es-12',front),'es-12 缺 '+front);
  assert.equal(added.filter(row=>row.lesson==='es-11' && row.tags.split(';').includes('数字')).length,10,'es-11 数字 10 条');
});
test('任务 E1：第 9–12 周阅读只用已学词、本课词及其规则变化形式',() => {
  checkReadingVocabulary(['es-09','es-10','es-11','es-12']);
  // 反向检查：规则本身能判出未学的词和还没到的课次。
  assert(!esKnown('es-12','nevera'),'未学的词应判出');
  assert(!esKnown('es-09','ascensor'),'第 11 周才学的词不该通过第 9 周的检查');
  assert(esKnown('es-09','jugábamos'),'过去未完成时应由 note 里的六个人称放行');
  assert(esKnown('es-10','sabía'),'意义变化动词的过去未完成时应通过第 10 周的检查');
  assert(esKnown('es-11','nadie'),'第 11 周应认得不定代词');
  assert(!esKnown('es-10','nadie'),'第 11 周才学的不定代词不该通过第 10 周的检查');
});
// 任务 S1：建设期第 13–16 周。进度只读，词表、课文与练习分开核验。
test('任务 S1：四课日期、每课 80 条、250–350 词阅读及 6 加 4 题配额',() => {
  const dates=['12-07 至 12-13','12-14 至 12-20','12-21 至 12-27','12-28 至 2027 年 01-03'];
  for (const [i,id] of S1_LESSONS.entries()) {
    const lesson=api.LESSONS[id];
    assert(lesson,id+' 课程存在');
    assert.equal(lesson.lang,'es',id);assert.equal(lesson.week,13+i,id);
    assert.equal(lesson.dates,dates[i],id+' 日期');
    assert.equal(initialRows.filter(row=>row.lesson===id).length,80,id+' 卡片数');
    assert.equal(lesson.dailyTime,'每天 25 分钟 + 每周 30 分钟语法与写作',id+' 时长');
    assert.match(lesson.writingTask,/5 句/,id+' 写作任务');
    const explanation=lesson.explanation(),text=parseNodes(explanation).map(node=>node.textContent).join('').trim();
    assert(text.startsWith('时间分配以复盘结果为准'),id+' 讲解首句');
    assert(explanation.includes('配合教材第二册的对应内容，课次以实际教材为准'),id+' 教材指引');
    assert.doesNotMatch(explanation,/《现代西班牙语》第\s*\d+\s*课/,id+' 不指定教材课次');
    assert.doesNotMatch(explanation.replace(/一封信/g,''),/[死杀封炸战坑砍]/,id+' 讲解措辞');
    const words=lesson.reading.sentences.flatMap(sentence=>esWords(sentence.text));
    assert(words.length>=250 && words.length<=350,id+' 课文 '+words.length+' 词');
    assert.equal(lesson.reading.questions.length,4,id+' 阅读四题');
    assert.equal(lesson.exercises.length,10,id+' 练习十题');
    assert.deepEqual(lesson.exercises.slice(6),lesson.reading.questions,id+' 阅读题属于课内十题');
    assert(lesson.exercises.slice(0,6).filter(exercise=>!exercise.options).length>=4,id+' 六道语法题以文本题为主');
    for (const exercise of lesson.exercises) {
      assert.equal(typeof exercise.answer,'string',id+' 答案为字符串');
      assert(exercise.answer.trim(),id+' 答案非空');
      if (exercise.options) {
        assert(exercise.options.includes(exercise.answer),id+' 答案在选项里');
        assert.equal(new Set(exercise.options).size,exercise.options.length,id+' 选项不重复');
      }
    }
    for (const sentence of lesson.reading.sentences) {
      assert.match(sentence.text,/[.?!]$/,id+' 句尾');
      assert.equal(sentence.text,sentence.text.normalize('NFC'),id+' 西语 NFC');
      assert.match(sentence.zh,/[㐀-鿿]/,id+' 逐句中文');
      if (sentence.text.includes('?')) assert(sentence.text.includes('¿'),id+' 双问号');
    }
  }
});
test('任务 S1：新增 id 连续、CSV 同步且新西语 front 不重复',() => {
  const expected=Array.from({length:320},(_,i)=>'es-'+String(994+i).padStart(4,'0'));
  assert.deepEqual(s1Rows.map(row=>row.id),expected);
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','es.csv'),'utf8')));
  assert.deepEqual(csv.filter(row=>S1_LESSONS.includes(row.lesson)),s1Rows);
  assert.deepEqual(csv.map(row=>row.id),Array.from({length:1993},(_,i)=>'es-'+String(i+1).padStart(4,'0')));
  const seen=new Set(initialRows.filter(row=>row.lang==='es' && !S1_LESSONS.includes(row.lesson)).map(row=>row.front.normalize('NFC').toLowerCase()));
  for (const row of s1Rows) {
    const front=row.front.normalize('NFC').toLowerCase();
    assert(!seen.has(front),'新西语 front 重复：'+row.front);seen.add(front);
  }
  // 追加边界取稳定 id，不用哈希或字节位置固定原内容。
  const previous=initialRows.findIndex(row=>row.id==='ru-0522');
  assert(previous>=0);
  assert.deepEqual(initialRows.slice(previous+1,initialRows.findIndex(row=>row.id==='es-1313')+1).map(row=>row.id),expected,'新行只接在旧行末尾');
});
test('任务 S1：名词带冠词标性、动词列实际人称、整句与变位短语为识别卡',() => {
  const gender={el:'名词（阳）',la:'名词（阴）',los:'名词（阳，复数）',las:'名词（阴，复数）'};
  for (const row of s1Rows) {
    const tags=row.tags.split(';');
    assert.equal(row.lang,'es',row.id);
    for (const field of ['front','back','example','example_zh','note']) {
      assert(row[field]?.trim(),row.id+' '+field+' 非空');
      assert.equal(row[field],row[field].normalize('NFC'),row.id+' '+field+' NFC');
    }
    if (tags.includes('名词')) {
      const article=row.front.match(/^(el|la|los|las) /)?.[1];
      assert(article,row.id+' 名词冠词');
      const expectedGender=row.front==='el agua'?'名词（阴）':gender[article];
      assert(row.note.startsWith(expectedGender),row.id+' 名词性');
      if (row.front==='el agua') assert.match(row.note,/重读.*a|a.*重读/,row.id+' el agua 的冠词说明');
    }
    if (tags.some(tag=>['动词','不定式'].includes(tag)) && !tags.includes('phrase')) {
      const count=row.lesson==='es-16'?5:6;
      const forms=esListedForms(row);
      assert(forms.some(parts=>parts.length===count && !parts.some(part=>/^(yo|tú|usted|vosotros|ustedes|nosotros)$/.test(part))),row.id+' note 应列 '+count+' 个实际变位形式');
    }
    if (tags.includes('分词')) assert.match(row.note,/(?:对应不定式|不定式)[：: ]+[\p{L}\p{M}]+/u,row.id+' 分词注明不定式');
    const finitePhrase=!tags.includes('名词') && /\s/.test(row.front) && /\b(?:he|has|ha|hemos|habéis|han|es|eres|son|tienes|gustaría|podría|podrías|sería|deberías|importaría|agradecería|recomendaría)\b/u.test(row.front.toLowerCase());
    if (tags.includes('句型') || finitePhrase || /[.?!]$/.test(row.front)) assert(tags.includes('phrase'),row.id+' 整句或变位短语需 phrase');
    assert.deepEqual(api.expandCards([row]).map(card=>card.direction),tags.includes('phrase')?['r']:['r','p'],row.id+' 卡片方向');
  }
  const quotas={
    'es-13':{名词:20,分词:15,时间标记:10,不定式:15,形容词:10,句型:5,补充:5},
    'es-14':{名词:20,不规则:12,时间标记:8,不定式:15,形容词:10,句型:5,补充:10},
    'es-15':{礼貌与建议:10,不定式:15,名词:20,形容词:10,副词:10,句型:5,补充:10},
    'es-16':{名词:20,不定式:15,副词与连接词:10,形容词:10,句型:5,补充:20}
  };
  for (const [id,quota] of Object.entries(quotas)) for (const [category,count] of Object.entries(quota)) {
    const found=s1Rows.filter(row=>row.lesson===id && row.tags.split(';').includes(category) && (category==='补充' || !row.tags.split(';').includes('补充')));
    assert.equal(found.length,count,id+' '+category+' 数量');
  }
});
test('任务 S1：完成时、将来时、条件式与肯定命令式讲解覆盖指定形式',() => {
  const required={
    'es-13':['haber','he','has','ha','hemos','habéis','han','hoy','esta semana','alguna vez','todavía no','ya','indefinido','西班牙','拉美'],
    'es-14':['-é','-ás','-á','-emos','-éis','-án','tendr','podr','sabr','habr','pondr','saldr','vendr','dir','har','querr','cabr','valdr','Serán las tres','mañana','la próxima semana','dentro de','2030','ir a'],
    'es-15':['-ía','-ías','-íamos','-íais','-ían','将来时','me gustaría','podría','podrías','deberías','Sería','si','现在时','命令式'],
    'es-16':['tú','usted','vosotros','ustedes','nosotros','di','haz','ve','pon','sal','sé','ten','ven','dímelo','siéntate','no hables']
  };
  for (const [id,items] of Object.entries(required)) for (const text of items) assert(api.LESSONS[id].explanation().toLowerCase().includes(text.toLowerCase()),id+' 讲解缺 '+text);
  for (const [infinitive,stem] of Object.entries(ES_FUTURE_STEMS).slice(0,12)) {
    const card=s1Rows.find(row=>row.lesson==='es-14' && row.note.startsWith(infinitive+' 的简单将来时'));
    assert(card,'es-14 不规则动词 '+infinitive);
    const want=['é','ás','á','emos','éis','án'].map(ending=>stem+ending);
    assert(esListedForms(card).some(forms=>JSON.stringify(forms)===JSON.stringify(want)),card.id+' 六人称及重音');
  }
  for (const front of ['el andén','húmedo','turístico','el currículum','la profesión','cortés','cortésmente']) assert(s1Rows.some(row=>row.front===front),'新词重音：'+front);
  for (const word of ['dímelo','siéntate']) assert(esKnown('es-16',word),'命令式附着代词重音：'+word);
  for (const [base,suffix,want] of [['di','melo','dímelo'],['sienta','te','siéntate'],['da','me','dame'],['espera','me','espérame'],['hacer','lo','hacerlo'],['decir','melo','decírmelo']]) assert.equal(esAttach(base,suffix),want);
});
test('任务 S1：新课短文和全部新卡例句只用已学词及正确的推导词形',() => {
  checkReadingVocabulary(S1_LESSONS);
  for (const row of s1Rows) checkSentenceVocabulary(row.lesson,[{text:row.example}],row.id+' 例句');
  for (const [lesson,word] of [['es-13','viajado'],['es-13','leído'],['es-14','tendremos'],['es-14','trabajaré'],['es-15','tendríamos'],['es-15','comeríais'],['es-16','dímelo'],['es-16','siéntate']]) assert(esKnown(lesson,word),lesson+' 应识别 '+word);
  for (const [lesson,word] of [['es-12','hemos'],['es-13','trabajaremos'],['es-14','trabajaríamos'],['es-15','dímelo'],['es-13','hipopótamo'],['es-16','teneremos'],['es-16','tendriamos']]) assert(!esKnown(lesson,word),lesson+' 应拒绝 '+word);
});
// 任务 S2：建设期第 17–20 周。保留旧卡与真实进度，新增内容逐项检查。
test('任务 S2：四课日期、每课 80 条、250–350 词双语阅读及 6 加 4 题',() => {
  const dates=['2027 年 01-04 至 01-10','2027 年 01-11 至 01-17','2027 年 01-18 至 01-24','2027 年 01-25 至 01-31'];
  for (const [i,id] of S2_LESSONS.entries()) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 课程存在');
    assert.equal(lesson.lang,'es',id+' 语言');assert.equal(lesson.week,17+i,id+' 周次');
    assert.equal(lesson.dates,dates[i],id+' 日期');
    assert.equal(s2Rows.filter(row=>row.lesson===id).length,80,id+' 卡片数量');
    assert.equal(lesson.dailyTime,'每天 25 分钟 + 每周 30 分钟语法与写作',id+' 时长');
    assert.match(lesson.writingTask,/5 句/,id+' 写作任务');
    const explanation=lesson.explanation(),text=parseNodes(explanation).map(node=>node.textContent).join('').trim();
    assert(text.startsWith('时间分配以复盘结果为准'),id+' 讲解首句');
    assert(explanation.includes('配合教材第二册的对应内容，课次以实际教材为准'),id+' 教材指引');
    assert.doesNotMatch(explanation,/《现代西班牙语》第\s*\d+\s*课/,id+' 教材课次以实际教材为准');
    assert.doesNotMatch(explanation.replace(/一封信/g,''),/[死杀封炸战坑砍]/,id+' 讲解措辞');
    const words=lesson.reading.sentences.flatMap(sentence=>esWords(sentence.text));
    assert(words.length>=250 && words.length<=350,id+' 课内阅读 '+words.length+' 词');
    assert.equal(lesson.reading.questions.length,4,id+' 阅读四题');
    assert.equal(lesson.exercises.length,10,id+' 练习十题');
    assert.deepEqual(lesson.exercises.slice(6),lesson.reading.questions,id+' 阅读题属于课内十题');
    assert(lesson.exercises.slice(0,6).filter(exercise=>!exercise.options).length>=4,id+' 语法题以文本题为主');
    for (const question of lesson.exercises) {
      assert(question.prompt?.trim(),id+' 题干非空');
      assert.equal(typeof question.answer,'string',id+' 文本答案');assert(question.answer.trim(),id+' 答案非空');
      if (question.options) {
        assert(question.options.includes(question.answer),id+' 答案在选项里');
        assert.equal(new Set(question.options).size,question.options.length,id+' 选项不重复');
      }
    }
    for (const sentence of lesson.reading.sentences) {
      assert.match(sentence.text,/[.?!]$/,id+' 句尾');
      assert.equal(sentence.text,sentence.text.normalize('NFC'),id+' 西语 NFC');
      assert.match(sentence.zh,/[㐀-鿿]/,id+' 逐句中文');
      if (sentence.text.includes('?')) assert(sentence.text.includes('¿'),id+' 双问号');
    }
  }
});
test('任务 S2：新增 320 个 id 连续、CSV 与内嵌同步、旧行之后追加且 front 不重复',() => {
  const expected=Array.from({length:320},(_,i)=>'es-'+String(1314+i).padStart(4,'0'));
  assert.deepEqual(s2Rows.map(row=>row.id),expected);
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','es.csv'),'utf8')));
  assert.deepEqual(csv.filter(row=>S2_LESSONS.includes(row.lesson)),s2Rows);
  assert.deepEqual(csv.map(row=>row.id),Array.from({length:1993},(_,i)=>'es-'+String(i+1).padStart(4,'0')));
  const previous=initialRows.findIndex(row=>row.id==='ru-0735');assert(previous>=0);
  assert.deepEqual(initialRows.slice(previous+1,initialRows.findIndex(row=>row.id==='es-1633')+1).map(row=>row.id),expected,'cards-data 新行仅在旧末行之后追加');
  const seen=new Set(initialRows.filter(row=>row.lang==='es' && row.lesson<'es-17').map(row=>row.front.normalize('NFC').toLowerCase()));
  for (const row of s2Rows) {
    const front=row.front.normalize('NFC').toLowerCase();
    assert(!seen.has(front),row.id+' front 重复：'+row.front);seen.add(front);
  }
});
test('任务 S2：名词带冠词标性、动词有实际六人称、整句和变位短语只出识别卡',() => {
  const gender={el:'名词（阳）',la:'名词（阴）',los:'名词（阳，复数）',las:'名词（阴，复数）'};
  for (const row of s2Rows) {
    const tags=row.tags.split(';');assert.equal(row.lang,'es',row.id);
    for (const field of ['front','back','example','example_zh','note']) {
      assert(row[field]?.trim(),row.id+' '+field+' 非空');
      assert.equal(row[field],row[field].normalize('NFC'),row.id+' '+field+' NFC');
    }
    if (tags.includes('名词')) {
      const article=row.front.match(/^(el|la|los|las) /)?.[1];assert(article,row.id+' 名词冠词');
      assert(row.note.startsWith(gender[article]),row.id+' 名词标性');
    }
    if (tags.some(tag=>['动词','不定式'].includes(tag))) {
      const forms=esListedForms(row);
      assert(forms.some(parts=>parts.length===6 && parts.every(part=>! /^(yo|tú|usted|vosotros|ustedes|nosotros)$/.test(part))),row.id+' note 列六个实际变位');
      if (row.lesson<='es-18') {
        assert.match(row.note,/虚拟式现在时/,row.id+' note 说明本课时态');
        const reflexive=row.front.endsWith('se'),infinitive=row.front.replace(/se$/,'');
        const expected=esSubjunctive(infinitive).map((form,i)=>(reflexive?['me','te','se','nos','os','se'][i]+' ':'')+form);
        assert(forms.some(parts=>JSON.stringify(parts)===JSON.stringify(expected)),row.id+' 虚拟式六人称及重音');
      }
      if (row.lesson==='es-19' && !tags.includes('补充')) assert.match(row.note,new RegExp(row.front+' (?:a|de|en|con|por)\\b'),row.id+' note 说明介词搭配');
    }
    const finitePhrase=!tags.includes('名词') && /\s/.test(row.front) && /\b(?:quiero|quiera|creo|pienso|es|sea|esté|haya|vaya|espero|siento|alegro|vende|venden|habla|hablan|olvidó|rompió|cayó|perdió|acabó|debe|puede|podemos|tenga|haga)\b/u.test(row.front.toLowerCase());
    if (tags.includes('句型') || finitePhrase || /[.?!]$/.test(row.front)) assert(tags.includes('phrase'),row.id+' 整句或变位短语需 phrase');
    assert.deepEqual(api.expandCards([row]).map(card=>card.direction),tags.includes('phrase')?['r']:['r','p'],row.id+' 卡片方向');
  }
  const quotas={
    'es-17':{不定式:20,触发结构:10,名词:20,形容词:10,句型:5,补充:15},
    'es-18':{情感与观点:15,不定式:15,名词:20,连接词:10,句型:5,补充:15},
    'es-19':{固定搭配:20,不定式:15,名词:20,形容词:10,句型:5,补充:10},
    'es-20':{不定式:20,名词:20,副词:10,句型:5,公告短语:5,补充:20}
  };
  for (const [id,quota] of Object.entries(quotas)) for (const [category,count] of Object.entries(quota)) {
    const selected=s2Rows.filter(row=>row.lesson===id && row.tags.split(';').includes(category) && (category==='补充' || !row.tags.split(';').includes('补充')));
    assert.equal(selected.length,count,id+' '+category+' 配额');
    if (['触发结构','情感与观点','固定搭配','公告短语'].includes(category)) for (const row of selected) assert(row.tags.split(';').includes('phrase'),row.id+' 表达为识别卡');
  }
});
test('任务 S2：虚拟式、介词和 se 的指定讲解要点齐全',() => {
  const required={
    'es-17':['-e','-a','sea','esté','vaya','haya','sepa','dé','tenga','haga','pueda','venga','ponga','salga','diga','否定命令式','querer que','es necesario que','para que','es importante que','主语'],
    'es-18':['no creo que','no pienso que','es posible que','es probable que','quizás','ojalá','me alegro de que','siento que','espero que','creer','pensar','陈述式','虚拟式','cuando','将来'],
    'es-19':['por','para','原因','经过','持续','交换','方式','代替','目的','方向','期限','对象','看法','por favor','por fin','por eso','para siempre','desde','hasta','sobre','entre','不定式'],
    'es-20':['反身','相互','se ven','无人称','se habla español','被动','se venden casas','意外','se me olvidó','se lo','代词位置']
  };
  for (const [id,items] of Object.entries(required)) {
    assert(api.LESSONS[id],id+' 课程存在');
    for (const text of items) assert(api.LESSONS[id].explanation().toLowerCase().includes(text.toLowerCase()),id+' 讲解缺 '+text);
  }
  for (const id of ['es-18','es-19']) assert.match(api.LESSONS[id].explanation(),/<table\b/,id+' 语法对照表');
});
test('任务 S2：新课短文和新卡例句只用已学词，虚拟式按既有不定式推导',() => {
  checkReadingVocabulary(S2_LESSONS);
  for (const lesson of S2_LESSONS) {
    const sentences=s2Rows.filter(row=>row.lesson===lesson).map(row=>({id:row.id,text:row.example}));
    checkSentenceVocabulary(lesson,sentences,lesson+' 卡片例句（缺词项目列出卡片 id）');
  }
  const vocabulary=new Map();
  const known=(lesson,word)=>{
    if (!vocabulary.has(lesson)) vocabulary.set(lesson,esVocabulary(lesson));
    return esVariants(word).some(form=>vocabulary.get(lesson).has(form));
  };
  for (const [verb,forms] of Object.entries(ES_SUBJUNCTIVE_SPECIAL)) {
    assert.deepEqual(esSubjunctive(verb),forms,verb+' 六人称及重音');
    for (const word of forms) assert(known('es-17',word),'es-17 应识别 '+word);
  }
  for (const [verb,want] of [['hablar','hable hables hable hablemos habléis hablen'],['comer','coma comas coma comamos comáis coman'],['dormir','duerma duermas duerma durmamos durmáis duerman'],['buscar','busque busques busque busquemos busquéis busquen']]) assert.deepEqual(esSubjunctive(verb),want.split(' '),verb+' 推导形式');
  for (const word of ['trabajéis','durmáis','tengáis','estés','vayáis']) assert(known('es-17',word),'已学虚拟式 '+word);
  for (const [lesson,word] of [['es-17','cuántas'],['es-19','muéstrelo']]) assert(known(lesson,word),'已学词的性数或命令式代词推导：'+word);
  for (const [lesson,word] of [['es-16','trabajéis'],['es-17','tengais'],['es-17','tenamos'],['es-20','hipopótamo']]) assert(!known(lesson,word),lesson+' 应拒绝 '+word);
  const row=s2Rows[0];assert(row,'新卡存在');const previous=row.example;
  try { row.example='Hipopótamo.';assert(!esKnown('es-20','hipopótamo'),'新例句不能给自身扩充词表'); }
  finally { row.example=previous; }
});
// 俄语阅读的词汇范围：本课及以前词卡的 front 和 note 里列出的形式；旧课保留例句依据。
// R1 / R2 / R3 / R4 新例句不作为自身的放行来源，避免未学词通过例句进入词汇范围。
// 再按本阶段教过的规则推导：名词按格词尾，动词按 -л 过去时，形容词按性数和 -о 副词。
const ruWords=text=>text.normalize('NFD').replace(/́/g,'').normalize('NFC').toLowerCase().match(/[а-яё]+/g) || [];
const ruDeaccent=value=>value.normalize('NFD').replace(/́/g,'').normalize('NFC').toLocaleLowerCase();
const RU_NOUN_ENDINGS={'а':['ы','и','е','у'],'я':['и','е','ю'],'о':['а','е'],'е':['я','и','ю']};
const ruForms=(word,tags) => {
  const out=[];
  if (tags.includes('不定式')) {
    if (word.endsWith('ться')) for (const end of ['лся','лась','лось','лись']) out.push(word.slice(0,-4)+end);
    else if (word.endsWith('ть')) for (const end of ['л','ла','ло','ли']) out.push(word.slice(0,-2)+end);
  } else if (tags.includes('形容词')) {
    if (/(ый|ий|ой)$/.test(word)) {
      // 区分硬、软词尾及拼写规则；硬变化的中性不能生成伪比较级 -ее。
      const stem=word.slice(0,-2),soft=/ий$/.test(word) && !/[гкхжшчщ]ий$/.test(word);
      const eEnding=soft || /[жшчщ]ий$/.test(word),iEnding=soft || /[гкхжшчщ](?:ий|ой)$/.test(word);
      for(const end of [soft?'яя':'ая',eEnding?'ее':'ое',iEnding?'ие':'ые',soft?'юю':'ую',soft?'е':'о']) out.push(stem+end);
    }
  } else if (tags.includes('名词')) {
    const last=word.slice(-1);
    if (RU_NOUN_ENDINGS[last]) for (const end of RU_NOUN_ENDINGS[last]) out.push(word.slice(0,-1)+end);
    else if (last==='ь' || last==='й') for (const end of ['и','я','ю','е','ем']) out.push(word.slice(0,-1)+end);
    else if (!'уыэюи'.includes(last)) for (const end of ['а','я','е','ы','и','у','ом']) out.push(word+end);
  }
  return out;
};
// 不规则范式只在相应名词卡已学时生效，不能单独放行新词。
const RU_NOUN_PARADIGMS={
  друг:{plural:'друзья',genitive:'друзей'},брат:{plural:'братья',genitive:'братьев'},
  ребёнок:{plural:'дети',genitive:'детей'},человек:{plural:'люди',genitive:'людей'},
  сестра:{plural:'сёстры',genitive:'сестёр'},стул:{plural:'стулья',genitive:'стульев'},
  окно:{plural:'окна',genitive:'окон'},письмо:{plural:'письма',genitive:'писем'},
  ручка:{plural:'ручки',genitive:'ручек'},день:{plural:'дни',genitive:'дней'},
  время:{plural:'времена',genitive:'времён'},год:{plural:'годы',genitive:'лет'}
};
const ruConstructionForms=(word,row,lesson) => {
  if (!row.tags.split(';').includes('名词') || row.note.includes('不变格')) return [];
  const out=[],paradigm=RU_NOUN_PARADIGMS[word];
  if (lesson>='ru-13') {
    if (paradigm) out.push(paradigm.genitive);
    else if (/и[яе]$/.test(word)) out.push(word.slice(0,-2)+'ий');
    else if (/ья$/.test(word)) out.push(word.slice(0,-2)+'ей');
    else if (/ье$/.test(word)) out.push(word.slice(0,-2)+'ий');
    else if (/[ао]$/.test(word)) out.push(word.slice(0,-1));
    else if (/я$/.test(word)) out.push(word.slice(0,-1)+'ь');
    else if (/[ьжшчщ]$/.test(word)) out.push(word.replace(/ь$/,'')+'ей');
    else if (/й$/.test(word)) out.push(word.slice(0,-1)+'ев');
    else if (/ц$/.test(word)) out.push(word+'ев');
    else if (!/[аеёиоуыэюя]$/.test(word)) out.push(word+'ов');
  }
  if (lesson>='ru-15' && !/名词（复数/.test(row.note)) {
    if (word==='время') out.push('времени');
    else if (/и[яе]$/.test(word)) out.push(word.slice(0,-1)+'и');
    else if (/ь$/.test(word) && /名词（阴/.test(row.note)) out.push(word.slice(0,-1)+'и');
  }
  if (lesson>='ru-16') {
    const listed=ruWords(row.note.match(/复数主格[： ]+([^；]+)/)?.[1] || '');
    const plurals=paradigm?[paradigm.plural]:listed;
    for (const plural of plurals) {
      if (/[ыа]$/.test(plural)) out.push(plural.slice(0,-1)+'ам');
      else if (/я$/.test(plural)) out.push(plural.slice(0,-1)+'ям');
      else if (/и$/.test(plural)) out.push(plural.slice(0,-1)+(/[гкхжчшщ]и$/.test(plural)?'ам':'ям'));
    }
    // 最早的名词卡还没有复数 note，按单数词尾推导规则复数与格。
    if (!plurals.length) {
      if (/[ао]$/.test(word)) out.push(word.slice(0,-1)+'ам');
      else if (/[яейь]$/.test(word)) out.push(word.slice(0,-1)+'ям');
      else if (!/[аеёиоуыэюя]$/.test(word)) out.push(word+'ам');
    }
  }
  return out;
};
// 第 17 周起推导工具格；不规则形式只有在对应词卡已学时才可用。
const RU_INSTRUMENTAL_SINGULAR={
  время:'временем',день:'днём',мать:'матерью',дочь:'дочерью',отец:'отцом',
  ребёнок:'ребёнком',человек:'человеком',словарь:'словарём',дождь:'дождём',
  огонь:'огнём',путь:'путём',лёд:'льдом',семья:'семьёй',земля:'землёй',
  врач:'врачом',нож:'ножом',ключ:'ключом',муж:'мужем',товарищ:'товарищем',
  учитель:'учителем',писатель:'писателем',кошелёк:'кошельком',певец:'певцом'
};
const RU_INSTRUMENTAL_PLURAL={
  ребёнок:'детьми',человек:'людьми',день:'днями',дверь:'дверями',
  друг:'друзьями',брат:'братьями',стул:'стульями',время:'временами',
  мать:'матерями',дочь:'дочерьми',сестра:'сёстрами'
};
const RU_PRONOUN_INSTRUMENTAL={
  я:['мной','мною'],ты:['тобой','тобою'],он:['им','ним'],она:['ей','ею','ней','нею'],
  оно:['им','ним'],мы:['нами'],вы:['вами'],они:['ими','ними']
};
const ruR2Forms=(word,row,lesson) => {
  const tags=row.tags.split(';'),out=[];
  if (lesson>='ru-17' && tags.includes('代词')) out.push(...(RU_PRONOUN_INSTRUMENTAL[word] || []));
  if (lesson>='ru-17' && tags.includes('名词') && !/不变格|名词（复数/.test(row.note)) {
    const stem=word.slice(0,-1),singular=RU_INSTRUMENTAL_SINGULAR[word];
    if (singular) out.push(singular);
    else if (/а$/.test(word)) {
      const endingStressed=/а\u0301$/.test(row.front);
      out.push(stem+(/[жшчщц]а$/.test(word) && !endingStressed?'ей':'ой'));
    } else if (/я$/.test(word)) out.push(stem+'ей');
    else if (/о$/.test(word)) out.push(stem+'ом');
    else if (/[ей]$/.test(word)) out.push(stem+'ем');
    else if (/ь$/.test(word)) out.push(stem+(/名词（阴/.test(row.note)?'ью':'ем'));
    else if (!/[аеёиоуыэюя]$/.test(word) && !/[жшчщц]$/.test(word)) out.push(word+'ом');
    // 嘶音和 ц 后的 -ом / -ем 取决于格词尾的重音；不能仅凭主格任意生成两套。
    // 不确定的词使用其 note 明列的格形式，或上面的对应词范式。
  }
  if (lesson>='ru-18' && tags.includes('名词') && !row.note.includes('不变格')) {
    const special=RU_INSTRUMENTAL_PLURAL[word];
    if (special) out.push(special);
    else {
      const listed=ruWords(row.note.match(/复数主格[： ]+([^；]+)/)?.[1] || '');
      const plurals=RU_NOUN_PARADIGMS[word]?[RU_NOUN_PARADIGMS[word].plural]:listed;
      for (const plural of plurals) {
        if (/[ыа]$/.test(plural)) out.push(plural.slice(0,-1)+'ами');
        else if (/я$/.test(plural)) out.push(plural.slice(0,-1)+'ями');
        else if (/и$/.test(plural)) out.push(plural.slice(0,-1)+(/[гкхжчшщ]и$/.test(plural)?'ами':'ями'));
      }
      if (!plurals.length && !/名词（复数/.test(row.note)) {
        if (/[ао]$/.test(word)) out.push(word.slice(0,-1)+'ами');
        else if (/[яейь]$/.test(word)) out.push(word.slice(0,-1)+'ями');
        else if (!/[аеёиоуыэюя]$/.test(word)) out.push(word+'ами');
      }
    }
  }
  if (lesson>='ru-20' && tags.includes('形容词') && /(?:ый|ий|ой)$/.test(word)) {
    const stem=word.slice(0,-2);
    // 软词尾 -ий（如 синий）与 г / к / х 后的拼写 -ий 分开处理；嘶音后不重读的 о 写 е。
    const soft=/ий$/.test(word) && !/[гкхжшчщ]ий$/.test(word);
    const eEnding=soft || /[жшчщ]ий$/.test(word);
    out.push(...(eEnding?['его','ем','ей']:['ого','ом','ой']).map(ending=>stem+ending));
    out.push(stem+(soft?'юю':'ую'));
  }
  return out;
};
// R3 的推导仍从已学词卡出发；例句和阅读正文不参与建立允许词表。
const RU_R3_PRONOUNS={
  мой:['моего','моему','моим','моём','моя','моей','мою','моё','мои','моих','моими'],
  твой:['твоего','твоему','твоим','твоём','твоя','твоей','твою','твоё','твои','твоих','твоими'],
  наш:['нашего','нашему','нашим','нашем','наша','нашей','нашу','наше','наши','наших','нашими'],
  ваш:['вашего','вашему','вашим','вашем','ваша','вашей','вашу','ваше','ваши','ваших','вашими'],
  этот:['этого','этому','этим','этом','эта','этой','эту','это','эти','этих','этими'],
  тот:['того','тому','тем','том','та','той','ту','то','те','тех','теми']
};
const RU_R3_NOUNS={сын:{plural:'сыновья',genitive:'сыновей'},дочь:{plural:'дочери',genitive:'дочерей'}};
const RU_R3_ASPECT={читать:'прочитать',писать:'написать',делать:'сделать',покупать:'купить',говорить:'сказать',смотреть:'посмотреть',учить:'выучить',решать:'решить'};
const ruR3Forms=(word,row,lesson) => {
  const tags=row.tags.split(';'),out=[],pronoun=tags.some(tag=>['代词','指示词','疑问词','物主词'].includes(tag));
  if (lesson>='ru-21' && word==='что') out.push('чего','чему','чем','чём');
  if (lesson>='ru-21' && tags.includes('名词') && word==='подарок') out.push('подарка','подарку','подарком','подарке');
  if (lesson>='ru-21' && pronoun) {
    const forms=RU_R3_PRONOUNS[word] || [];
    // 末尾三项是复数；本周只推导单数，下两周逐步开放复数。
    out.push(...forms.slice(0,8));
    if (lesson>='ru-22') out.push(...forms.slice(8,10));
    if (lesson>='ru-23') out.push(...forms.slice(10));
  }
  if (lesson>='ru-21' && (tags.includes('形容词') || pronoun) && /(?:ый|ий|ой)$/.test(word) && !['мой','твой'].includes(word)) {
    const stem=word.slice(0,-2),soft=/ий$/.test(word) && !/[гкхжшчщ]ий$/.test(word);
    const eEnding=soft || /[жшчщ]ий$/.test(word),iEnding=soft || /[гкхжшчщ](?:ий|ой)$/.test(word);
    out.push(stem+(eEnding?'ему':'ому'),stem+(iEnding?'им':'ым'),stem+(eEnding?'ей':'ой'));
    if (pronoun) out.push(...(eEnding?['его','ем']:['ого','ом']).map(end=>stem+end),stem+(soft?'яя':'ая'),stem+(soft?'ее':'ое'),stem+(soft?'юю':'ую'));
    if (lesson>='ru-22') out.push(stem+(iEnding?'ие':'ые'),stem+(iEnding?'их':'ых'));
    if (lesson>='ru-23') out.push(stem+(iEnding?'ими':'ыми'));
  }
  if (lesson>='ru-22' && tags.includes('名词') && !row.note.includes('不变格')) {
    const paradigm=RU_R3_NOUNS[word] || RU_NOUN_PARADIGMS[word];
    const listed=ruWords(row.note.match(/(?:复数主格|主格复数)[： ]+([^；]+)/)?.[1] || '');
    let plurals=paradigm?[paradigm.plural]:listed;
    if (!plurals.length && !/名词（复数/.test(row.note)) {
      if (/а$/.test(word)) plurals=[word.slice(0,-1)+(/[гкхжшчщ]а$/.test(word)?'и':'ы')];
      else if (/я$/.test(word)) plurals=[word.slice(0,-1)+'и'];
      else if (/о$/.test(word)) plurals=[word.slice(0,-1)+'а'];
      else if (/е$/.test(word)) plurals=[word.slice(0,-1)+'я'];
      else if (/ь$/.test(word)) plurals=[word.slice(0,-1)+'и'];
      else if (/й$/.test(word)) plurals=[word.slice(0,-1)+'и'];
      else if (!/[аеёиоуыэюя]$/.test(word)) plurals=[word+(/[гкхжшчщ]$/.test(word)?'и':'ы')];
    }
    if (paradigm) out.push(paradigm.genitive);
    for (const plural of plurals) {
      out.push(plural);
      if (!/[ыаяи]$/.test(plural)) continue;
      const stem=plural.slice(0,-1),soft=/я$/.test(plural) || /и$/.test(plural) && !/[гкхжшчщ]и$/.test(plural);
      out.push(stem+(soft?'ях':'ах'));
      if (lesson>='ru-23') out.push(stem+(soft?'ям':'ам'),RU_INSTRUMENTAL_PLURAL[word] || stem+(soft?'ями':'ами'));
    }
  }
  if (lesson>='ru-24' && tags.includes('不定式')) {
    const pair=RU_R3_ASPECT[word];
    if (pair) out.push(pair,...ruForms(pair,['不定式']));
    for (const form of ruWords(row.note.match(/体配对：([^；]+)/)?.[1] || ''))
      if (/(?:ть|ться)$/.test(form)) out.push(...ruForms(form,['不定式']));
  }
  if (lesson>='ru-21' && tags.includes('不定式') && !row.note.includes('六个人称') && !['мочь','хотеть','бежать'].includes(word)) {
    // 早期卡只列 я / ты 时，以卡片注明的变位类别推导第三人称复数。
    const second=ruWords(row.note.match(/ты ([А-Яа-яЁё\u0301]+)/)?.[1] || '')[0];
    if (second && /第一变位/.test(row.note) && /[её]шь$/.test(second)) {
      const stem=second.slice(0,-3);out.push(stem+(/[аеёиоуыэюя]$/.test(stem)?'ют':'ут'));
    }
    if (second && /第二变位/.test(row.note) && /ишь$/.test(second)) {
      const stem=second.slice(0,-3);out.push(stem+(/[жшчщ]$/.test(stem)?'ат':'ят'));
    }
  }
  return out;
};
// R4：只为已学动词及其 note 明列的体配对增加本周教授的形式。
// 这里的范式不是独立词表；没有对应词卡时，不允许从表中直接取词。
const RU_R4_FUTURE={
  быть:'буду будешь будет будем будете будут',
  прочитать:'прочитаю прочитаешь прочитает прочитаем прочитаете прочитают',
  написать:'напишу напишешь напишет напишем напишете напишут',
  сделать:'сделаю сделаешь сделает сделаем сделаете сделают',
  купить:'куплю купишь купит купим купите купят',
  сказать:'скажу скажешь скажет скажем скажете скажут',
  посмотреть:'посмотрю посмотришь посмотрит посмотрим посмотрите посмотрят',
  выучить:'выучу выучишь выучит выучим выучите выучат',
  решить:'решу решишь решит решим решите решат'
};
const RU_R4_IMPERATIVE={
  читать:'читай читайте',прочитать:'прочитай прочитайте',писать:'пиши пишите',написать:'напиши напишите',
  делать:'делай делайте',сделать:'сделай сделайте',покупать:'покупай покупайте',купить:'купи купите',
  говорить:'говори говорите',сказать:'скажи скажите',смотреть:'смотри смотрите',посмотреть:'посмотри посмотрите',
  учить:'учи учите',выучить:'выучи выучите',решать:'решай решайте',решить:'реши решите',
  открывать:'открывай открывайте',открыть:'открой откройте',закрывать:'закрывай закрывайте',закрыть:'закрой закройте',
  слушать:'слушай слушайте',послушать:'послушай послушайте',забывать:'забывай забывайте',забыть:'забудь забудьте',
  отвечать:'отвечай отвечайте',ответить:'ответь ответьте',проверять:'проверяй проверяйте',проверить:'проверь проверьте',
  давать:'давай давайте',дать:'дай дайте',ждать:'жди ждите',помочь:'помоги помогите',
  идти:'иди идите',ходить:'ходи ходите',ехать:'езжай езжайте',ездить:'езди ездите'
};
const RU_R4_MOTION={
  идти:'иду идёшь идёт идём идёте идут шёл шла шло шли',
  ходить:'хожу ходишь ходит ходим ходите ходят ходил ходила ходило ходили',
  ехать:'еду едешь едет едем едете едут ехал ехала ехало ехали',
  ездить:'езжу ездишь ездит ездим ездите ездят ездил ездила ездило ездили',
  бежать:'бегу бежишь бежит бежим бежите бегут бежал бежала бежало бежали',
  бегать:'бегаю бегаешь бегает бегаем бегаете бегают бегал бегала бегало бегали',
  лететь:'лечу летишь летит летим летите летят летел летела летело летели',
  летать:'летаю летаешь летает летаем летаете летают летал летала летало летали',
  плыть:'плыву плывёшь плывёт плывём плывёте плывут плыл плыла плыло плыли',
  плавать:'плаваю плаваешь плавает плаваем плаваете плавают плавал плавала плавало плавали'
};
const RU_R4_PREFIXED_MOTION={
  пойти:'пойду пойдёшь пойдёт пойдём пойдёте пойдут пошёл пошла пошло пошли',
  поехать:'поеду поедешь поедет поедем поедете поедут поехал поехала поехало поехали',
  прийти:'приду придёшь придёт придём придёте придут пришёл пришла пришло пришли',
  приехать:'приеду приедешь приедет приедем приедете приедут приехал приехала приехало приехали',
  уйти:'уйду уйдёшь уйдёт уйдём уйдёте уйдут ушёл ушла ушло ушли',
  уехать:'уеду уедешь уедет уедем уедете уедут уехал уехала уехало уехали',
  выйти:'выйду выйдешь выйдет выйдем выйдете выйдут вышел вышла вышло вышли',
  выехать:'выеду выедешь выедет выедем выедете выедут выехал выехала выехало выехали',
  войти:'войду войдёшь войдёт войдём войдёте войдут вошёл вошла вошло вошли',
  въехать:'въеду въедешь въедет въедем въедете въедут въехал въехала въехало въехали',
  перейти:'перейду перейдёшь перейдёт перейдём перейдёте перейдут перешёл перешла перешло перешли',
  переехать:'перееду переедешь переедет переедем переедете переедут переехал переехала переехало переехали'
};
const ruR4Forms=(word,row,lesson) => {
  if (lesson<'ru-25' || row.lesson>lesson || !row.tags.split(';').some(tag=>['不定式','运动动词'].includes(tag)) || !ruWords(row.front).includes(word)) return [];
  const infinitives=new Set([word]);
  for (const match of row.note.matchAll(/体配对：([^；]+)/g))
    for (const form of ruWords(match[1])) if (/(?:ть|ться|ти|чь)$/.test(form)) infinitives.add(form);
  if (RU_R3_ASPECT[word]) infinitives.add(RU_R3_ASPECT[word]);
  const out=[];
  for (const base of infinitives) {
    out.push(...(RU_R4_FUTURE[base]?.split(' ') || []));
    if (lesson>='ru-26') out.push(...(RU_R4_IMPERATIVE[base]?.split(' ') || []));
    if (lesson>='ru-27') out.push(...(RU_R4_MOTION[base]?.split(' ') || []));
    if (lesson>='ru-28') out.push(...(RU_R4_PREFIXED_MOTION[base]?.split(' ') || []));
  }
  if (lesson>='ru-26' && /(?:ать|ять|еть)$/.test(word)) {
    const first=ruWords(row.note.match(/я ([А-Яа-яЁё\u0301]+)/)?.[1] || '')[0];
    // 只在 я 的 -ю 前词干与不定式去 -ть 后完全相同时推导 -й / -йте。
    // давать → даю 等改变词干的动词不能套用，仍使用 note 或专门范式。
    if (first?.endsWith('ю') && first.slice(0,-1)===word.slice(0,-2)) out.push(word.slice(0,-2)+'й',word.slice(0,-2)+'йте');
  }
  return [...new Set(out)];
};
// R5 的序数词复习从已学中性日期词或阳性序数词推导；不从正文补词。
const ruR5Forms=(word,row,lesson) => {
  if(lesson<'ru-29' || row.lesson>lesson || !ruWords(row.front).includes(word)) return [];
  const tags=row.tags.split(';');
  if(tags.includes('代词') && ['он','оно'].includes(word)) return ['нём'];
  if(!tags.includes('序数词')) return [];
  // -ое 的旧日期词按词尾重音恢复 -ой / -ый；третье 用独立软变化范式。
  if(['третье','третий'].includes(word)) return ['третий','третья','третье','третьи','третьего','третьему','третьим','третьем','третьей','третью','третьих','третьими'];
  if(!/(?:ый|ой|ое)$/.test(word)) return [];
  const stem=word.slice(0,-2),masculine=/ое$/.test(word)?stem+(/о\u0301е$/.test(row.front)?'ой':'ый'):word;
  return [masculine,...['ая','ое','ые','ого','ому','ым','ом','ой','ую','ых','ыми'].map(end=>stem+end)];
};
// R6：比较级从已学形容词或副词推导，最高级的 самый 从已学表达卡推导。
// 不把范式表或阅读正文当作可以独立取词的来源。
const RU_R6_COMPARATIVES={
  хороший:'лучше',хорошо:'лучше',плохой:'хуже',плохо:'хуже',большой:'больше',много:'больше',маленький:'меньше',мало:'меньше',
  старый:'старше старее',молодой:'моложе',дорогой:'дороже',дешёвый:'дешевле',высокий:'выше',низкий:'ниже',
  близкий:'ближе',близко:'ближе',далёкий:'дальше',далеко:'дальше',лёгкий:'легче',легко:'легче',
  короткий:'короче',долгий:'дольше',долго:'дольше',тихий:'тише',тихо:'тише',громкий:'громче',громко:'громче',
  широкий:'шире',узкий:'уже',глубокий:'глубже',мягкий:'мягче',тонкий:'тоньше',редкий:'реже',редко:'реже',
  простой:'проще',строгий:'строже',яркий:'ярче',сладкий:'слаще',твёрдый:'твёрже',толстый:'толще',чистый:'чище'
};
const RU_R6_REGULAR_BASES=new Set('интересный удобный внимательный важный быстрый медленный сложный слабый просторный компактный стабильный правильный точный красивый полезный спокойный трудный сильный безопасный опасный аккуратный вежливый умный длинный быстро медленно внимательно правильно точно красиво спокойно трудно сильно аккуратно вежливо'.split(' '));
const ruR6Forms=(word,row,lesson) => {
  if(lesson<'ru-32' || row.lesson>lesson || !ruWords(row.front).includes(word)) return [];
  if(word==='самый') return ['самая','самое','самые','самого','самому','самым','самом','самой','самую','самых','самыми'];
  const tags=row.tags.split(';');
  if(!tags.some(tag=>['形容词','副词'].includes(tag))) return [];
  if(RU_R6_COMPARATIVES[word]) return RU_R6_COMPARATIVES[word].split(' ');
  // 只对确认采用规则变化的性质词使用 -ее / -ей；-о 结尾不等于可比较。
  if(!RU_R6_REGULAR_BASES.has(word)) return [];
  if(tags.includes('形容词') && /(?:ый|ой)$/.test(word)) return [word.slice(0,-2)+'ее',word.slice(0,-2)+'ей'];
  if(tags.includes('副词') && /о$/.test(word)) return [word.slice(0,-1)+'ее',word.slice(0,-1)+'ей'];
  return [];
};
const ruVocabulary=lesson => {
  const set=new Set();
  for (const row of initialRows.filter(row=>row.lang==='ru' && row.lesson<=lesson && !row.tags.split(';').includes('letter'))) {
    for (const word of [...ruWords(row.front),...ruWords(row.note),...(row.lesson<'ru-13'?ruWords(row.example):[])]) set.add(word);
    const tags=row.tags.split(';');
    for (const word of ruWords(row.front))
      for (const form of [...ruForms(word,tags),...ruConstructionForms(word,row,lesson),...ruR2Forms(word,row,lesson),...ruR3Forms(word,row,lesson),...ruR4Forms(word,row,lesson),...ruR5Forms(word,row,lesson),...ruR6Forms(word,row,lesson)]) set.add(form);
    // 早期动词卡只列 я / ты；从卡上已给的 ты 形式推导同词干的 он、мы、вы。
    if (tags.includes('不定式')) {
      const second=ruWords(row.note.match(/ты ([А-Яа-яЁё\u0301]+)/)?.[1] || '')[0];
      if (second && /[еиё]шь$/.test(second)) for (const ending of ['т','м','те']) set.add(second.slice(0,-2)+ending);
      if (second && /[еиё]шься$/.test(second)) for (const ending of ['тся','мся','тесь']) set.add(second.slice(0,-4)+ending);
    }
  }
  return set;
};
const ruKnown=(lesson,word)=>ruVocabulary(lesson).has(ruWords(word)[0]);
test('任务 E2：ru-09 至 ru-12 的日期、卡片数、阅读篇幅与练习配额符合课程安排',() => {
  const expected={
    'ru-09':{dates:'11-09 至 11-15',cards:50,sentences:12,text:6,book:5},
    'ru-10':{dates:'11-16 至 11-22',cards:50,sentences:14,text:4,book:6},
    'ru-11':{dates:'11-23 至 11-29',cards:50,sentences:14,text:6,book:7},
    'ru-12':{dates:'11-30 至 12-06',cards:30,sentences:16,text:6,book:null}
  };
  for (const [id,want] of Object.entries(expected)) {
    const lesson=api.LESSONS[id],cards=initialRows.filter(row=>row.lesson===id);
    assert(lesson,id);assert.equal(lesson.lang,'ru');assert.equal(lesson.week,Number(id.slice(3)));
    assert.equal(lesson.dates,want.dates,id+' 日期');
    assert.equal(cards.length,want.cards,id+' 卡片数');
    assert.equal(lesson.reading.sentences.length,want.sentences,id+' 阅读句数');
    assert(lesson.reading.sentences.length>=10 && lesson.reading.sentences.length<=16,id+' 阅读 10–16 句');
    assert.equal(lesson.reading.questions.length,4,id+' 阅读题数');
    assert.equal(lesson.exercises.length,10,id+' 练习总数');
    assert.equal(lesson.exercises.filter(exercise=>!exercise.options).length,want.text,id+' 文本题数');
    assert.deepEqual(lesson.exercises.slice(-4),lesson.reading.questions,id+' 阅读题排在末尾');
    for (const sentence of lesson.reading.sentences) {
      assert.match(sentence.text,/[.?!]$/,id+' 句子标点');
      assert.match(sentence.zh,/[㐀-鿿]/,id+' 逐句中文');
      assert.equal(sentence.text,sentence.text.normalize('NFC'),id+' 句子须为 NFC');
      assert.doesNotMatch(sentence.text,/[A-Za-z]/,id+' 句子不含拉丁字母');
    }
    for (const question of lesson.reading.questions) {
      assert(question.options.includes(question.answer),id+' '+question.prompt);
      assert.equal(question.options.length,new Set(question.options).size,id+' '+question.prompt);
    }
    const explanation=lesson.explanation();
    if (want.book) assert(explanation.includes('《东方大学俄语（新版）》第 '+want.book+' 课'),id+' 教材指引');
    assert.match(explanation,/每天 30 分钟/,id+' 每日 30 分钟');
    assert.match(explanation,/60 分钟系统块/,id+' 每周一次 60 分钟系统块');
    assert(parseNodes(explanation)[0].querySelector('table'),id+' 讲解含表格');
  }
  // 各课讲解要点：ru-09 过去时与否定重音，ru-10 三套词尾与拼写规则，ru-11 保留“跟不上就改成复习”。
  for (const [id,text] of [
    ['ru-09','не́ был'],['ru-09','шёл'],['ru-09','У меня́ был о́тпуск'],['ru-09','未完成体'],
    ['ru-10','七字母规则'],['ru-10','五字母规则'],['ru-10','短尾'],['ru-10','副词'],
    ['ru-11','跟不上就改成复习'],['ru-11','数词 2 至 4'],['ru-11','чего́'],['ru-11','复数属格'],
    ['ru-12','运动动词'],['ru-12','拼写规则']
  ]) assert(api.LESSONS[id].explanation().includes(text),id+' 讲解缺少：'+text);
  // ru-12 是复盘周：讲解要指到框架文件、月度检查点 3 和下一阶段。
  const review=api.LESSONS['ru-12'].explanation();
  for (const text of ['月度检查点 3','framework/metrics-and-review.md','决定矩阵','本课短文','维持模式','建设期','与格','工具格','动词体'])
    assert(review.includes(text),'ru-12 讲解缺少：'+text);
  assert.match(api.LESSONS['ru-12'].writingTask,/15 分钟.*50 词/);
  // 标题行的时长字段沿用第 5 周起的写法。
  const {api:a,document}=createAPI(true);a.initialize();
  for (const id of Object.keys(expected)) {
    a.openLesson(id);
    assert(document.querySelector('.kicker').textContent.includes('每天 30 分钟 + 周末系统块 60 分钟'),id);
  }
});
test('任务 E2：俄语第 9–12 周 id 连续、重音、名词标性、动词列六个人称，整句只出识别卡',() => {
  const lessons=['ru-09','ru-10','ru-11','ru-12'];
  const added=initialRows.filter(row=>lessons.includes(row.lesson));
  assert.deepEqual(added.map(row=>row.id),Array.from({length:180},(_,i)=>'ru-'+String(343+i).padStart(4,'0')));
  // CSV 与内嵌 JSON 的新增段落逐字段一致。
  const csvRows=api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','ru.csv'),'utf8'));
  assert.deepEqual(plain(csvRows.filter(row=>lessons.includes(row.lesson))),plain(added));
  const older=new Set(initialRows.filter(row=>row.lang==='ru' && !lessons.includes(row.lesson)).map(row=>ruDeaccent(row.front)));
  const seen=new Set();
  for (const row of added) {
    assert.equal(row.lang,'ru',row.id);
    for (const field of ['front','back','example','example_zh','note','tags']) {
      assert(row[field],row.id+' '+field+' 不能为空');
      assert.equal(row[field],row[field].normalize('NFC'),row.id+' '+field+' 须为 NFC');
    }
    assert(!older.has(ruDeaccent(row.front)),'新词不与旧卡重复：'+row.front);
    assert(!seen.has(ruDeaccent(row.front)),'新词内部不重复：'+row.front);
    seen.add(ruDeaccent(row.front));
    assert.doesNotMatch(row.front,/[A-Za-ź´]/,row.id+' front 只用西里尔字母和 U+0301');
    for (const word of row.front.match(/[А-Яа-яЁё\u0301]+/g) || []) {
      if ((word.match(/[аеёиоуыэюя]/gi)||[]).length>1) assert(/[́ёЁ]/.test(word),row.id+' 多音节词要标重音：'+word);
      for (let i=0;i<word.length;i++) if (word[i]==='́') assert(/[аеёиоуыэюя]/i.test(word[i-1]),row.id+' 重音标记要跟在元音后');
    }
    assert.match(row.example,/[.?!]$/,row.id+' 例句结尾');
    assert.match(row.example_zh,/[㐀-鿿]/,row.id+' 中文例句');
    const tags=row.tags.split(';');
    if (tags.includes('名词')) assert.match(row.note,/^名词（[阳阴中复]/,row.id+' 名词 note 要标性');
    if (tags.includes('形容词')) assert.equal(row.note.split('四个性数形式：')[1].split('；')[0].split(' / ').length,4,row.id+' 形容词 note 要列四个性数形式');
    if (tags.includes('不定式')) {
      assert.match(row.note,/第[一二]变位|现在时不用/,row.id+' 动词 note 要标变位类型');
      const persons=row.note.split('六个人称：')[1];
      assert(persons,row.id+' 动词 note 要列六个人称');
      assert.equal(persons.split('；过去时：')[0].split('；').length,6,row.id+' 六个人称要列全');
      // 第 9 周是过去时课，动词还要列出四个性数形式。
      if (row.lesson==='ru-09') assert.equal(row.note.split('过去时：')[1].split(' / ').length,4,row.id+' 过去时要列四个形式');
    }
    if (!tags.includes('phrase')) assert.notEqual(row.example,row.front,row.id+' 例句不能就是词条本身');
    assert.deepEqual(api.expandCards([row]).map(card=>card.direction),tags.includes('phrase')?['r']:['r','p'],row.id);
  }
  // 每课 5 条整句，只出识别卡；多词短语另外标 phrase。
  for (const id of lessons) assert.equal(added.filter(row=>row.lesson===id && row.tags==='句型;phrase').length,5,id+' 整句卡');
  for (const front of ['на про́шлой неде́ле','в про́шлом году́','в про́шлом ме́сяце','ещё не','весь день','всю неде́лю','день рожде́ния','сдава́ть экза́мен'])
    assert(added.find(row=>row.front===front).tags.split(';').includes('phrase'),front+' 应标 phrase');
  // 各课都覆盖任务要求的词类。
  const has=(lesson,front)=>added.some(row=>row.lesson===lesson && row.front===front);
  for (const front of ['вчера́','позавчера́','быть','идти́','мочь','гото́вить','встава́ть','ложи́ться','пого́да','дождь','снег']) assert(has('ru-09',front),'ru-09 缺 '+front);
  for (const front of ['ста́рый','плохо́й','си́ний','горя́чий','дешёвый','ста́рший','э́тот','э́та','э́ти','тот','како́й','кака́я','како́е','каки́е','цвет','пальто́']) assert(has('ru-10',front),'ru-10 缺 '+front);
  for (const front of ['из','о́коло','для','без','по́сле','ско́лько','не́сколько','чей','чья','чьё','чьи','хоте́ть','боя́ться','ребёнок','молоко́']) assert(has('ru-11',front),'ru-11 缺 '+front);
  for (const front of ['результа́т','прогре́сс','о́пыт','цель','переводи́ть','запомина́ть','сра́внивать','исправля́ть','гото́виться','сдава́ть']) assert(has('ru-12',front),'ru-12 缺 '+front);
  assert.equal(added.filter(row=>row.lesson==='ru-10' && row.tags==='形容词').length,28,'ru-10 形容词 28 条');
  assert.equal(added.filter(row=>row.lesson==='ru-09' && row.tags.split(';').includes('不定式')).length,15,'ru-09 动词 15 条');
});
test('任务 E2：第 9–12 周阅读只用已学词、本课词及其规则变化形式',() => {
  for (const id of ['ru-09','ru-10','ru-11','ru-12']) {
    const set=ruVocabulary(id);
    for (const sentence of api.LESSONS[id].reading.sentences) {
      for (const word of ruWords(sentence.text)) assert(set.has(word),id+' 阅读超出词表：'+word+'（'+sentence.text+'）');
    }
  }
  // 反向检查：规则本身能判出未学的词和还没到的课次。
  assert(!ruKnown('ru-12','холоди́льник'),'未学的词应判出');
  assert(!ruKnown('ru-09','зелёный'),'第 10 周才学的形容词不该通过第 9 周的检查');
  assert(!ruKnown('ru-10','кошелёк'),'第 11 周才学的名词不该通过第 10 周的检查');
  assert(!ruKnown('ru-08','дождь'),'第 9 周才学的名词不该通过第 8 周的检查');
  assert(ruKnown('ru-09','гото́вил'),'本课动词的过去时应由 note 放行');
  assert(ruKnown('ru-09','спал'),'旧动词的过去时应由推导规则放行');
  assert(ruKnown('ru-11','зонта́'),'note 里的属格单数应放行');
  assert(ruKnown('ru-10','си́нее'),'note 里的性数形式应放行');
  assert(ruKnown('ru-12','тру́дно'),'形容词派生的副词应放行');
});
test('任务 E2 只追加 ru.csv 与 cards-data；已有记录顺序不变',() => {
  // 新的俄语段落整段接在西语第 9–12 周之后，同样只追加。
  assert.deepEqual(initialRows.slice(initialRows.findIndex(row=>row.id==='ru-0343'),initialRows.findIndex(row=>row.id==='es-0994')).map(row=>row.id),Array.from({length:180},(_,i)=>'ru-'+String(343+i).padStart(4,'0')));
});
test('任务 C 只追加 cards-data 与 ru.csv；已有记录顺序不变',() => {
  assert.deepEqual(initialRows.slice(initialRows.findIndex(row=>row.id==='es-0114'),initialRows.findIndex(row=>row.id==='ru-0142')).map(row=>row.id),Array.from({length:240},(_,i)=>'es-'+String(114+i).padStart(4,'0')));
  assert.deepEqual(initialRows.slice(initialRows.findIndex(row=>row.id==='ru-0142'),initialRows.findIndex(row=>row.id==='es-0354')).map(row=>row.id),Array.from({length:201},(_,i)=>'ru-'+String(142+i).padStart(4,'0')));
  // 任务 D 的西语第 5–8 周整段接在 ru 行之后，同样只追加。
  assert.deepEqual(initialRows.slice(initialRows.findIndex(row=>row.id==='es-0354'),initialRows.findIndex(row=>row.id==='es-0714')).map(row=>row.id),Array.from({length:360},(_,i)=>'es-'+String(354+i).padStart(4,'0')));
  // 任务 E1 的西语第 9–12 周同样只追加在最后。
  assert.deepEqual(initialRows.slice(initialRows.findIndex(row=>row.id==='es-0714'),initialRows.findIndex(row=>row.id==='ru-0343')).map(row=>row.id),Array.from({length:280},(_,i)=>'es-'+String(714+i).padStart(4,'0')));
});
test('各课程分语言展示；阅读中文默认折叠；各课练习按题型反馈且不写入进度',() => {
  const {api:a,document}=createAPI(true);a.initialize();
  const before=plain(a.getData().state);
  for (const [id,lesson] of Object.entries(a.LESSONS)) {
    a.openLesson(id);
    assert.equal(document.querySelectorAll('[data-lesson]').length,Object.keys(a.LESSONS).length);
    const page=document.getElementById('content').innerHTML;
    assert(page.indexOf('西语课程')<page.indexOf('俄语课程'));
    assert(page.includes(lesson.goal));assert(page.includes(lesson.writingTask));
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);
    if (lesson.reading) {
      assert(page.includes('含下方 '+lesson.reading.questions.length+' 道阅读理解'));
      const translations=document.querySelectorAll('details').filter(node=>node.querySelector('summary')?.textContent==='查看本句中文');
      assert.equal(translations.length,lesson.reading.sentences.length);
      for (const node of translations) assert.equal(node.getAttribute('open'),null);
    }
    for (const form of document.querySelectorAll('[data-exercise]')) {
      const exercise=lesson.exercises[Number(form.dataset.exercise)];
      const submit=()=>document.getElementById('app').listeners.submit[0]({target:form,preventDefault(){}});
      form.elements.answer.value=exercise.options?.find(option=>option!==exercise.answer) || '不正确的答案';submit();
      const wrong=form.querySelector('.exercise-result');
      assert.equal(wrong.textContent,exercise.options?'选错了；正确答案：'+exercise.answer:'拼写不一致；正确写法：'+exercise.answer+'。');
      assert.match(wrong.innerHTML,/class="feedback wrong"/);
      form.elements.answer.value=exercise.answer;submit();
      assert.equal(form.querySelector('.exercise-result').textContent,exercise.options?'正确':'完全一致。');
    }
    a.openLesson(id); // 已判题结果重新渲染时也按同一种题型显示。
    for (const form of document.querySelectorAll('[data-exercise]')) {
      const exercise=lesson.exercises[Number(form.dataset.exercise)];
      assert.equal(form.querySelector('.exercise-result').textContent,exercise.options?'正确':'完全一致。');
    }
  }
  assert.deepEqual(plain(a.getData().state),before);assert.equal(a.getData().dirty,false);
});
test('选择题错误反馈在切换课程后保留；文本题的符号错误反馈保持原样',() => {
  const {api:a,document}=createAPI(true);a.initialize();a.openLesson('ru-03');
  let form=document.querySelector('[data-exercise="7"]');
  form.elements.answer.value='妈妈';
  document.getElementById('app').listeners.submit[0]({target:form,preventDefault(){}});
  a.openLesson('es-04');a.openLesson('ru-03');
  assert.equal(document.querySelector('[data-exercise="7"]').querySelector('.exercise-result').textContent,'选错了；正确答案：兄弟');
  a.openLesson('es-04');form=document.querySelector('[data-exercise="1"]');
  form.elements.answer.value='se';
  document.getElementById('app').listeners.submit[0]({target:form,preventDefault(){}});
  assert.equal(form.querySelector('.exercise-result').textContent,'拼写对了，符号错了；正确写法：sé。');
  assert.match(form.querySelector('.exercise-result').innerHTML,/class="feedback symbols"/);
});
test('letter / phrase 标签只生成识别卡；其他词条仍有两个方向',() => {
  for (const row of initialRows) {
    const expected=row.tags.split(';').some(tag=>['letter','phrase'].includes(tag))?['r']:['r','p'];
    assert.deepEqual(plain(api.expandCards([row]).map(card=>card.direction)),expected,row.id);
  }
  assert.equal(initialRows.filter(row=>row.tags.split(';').includes('phrase')).length,200+s3Rows.filter(row=>row.tags.split(';').includes('phrase')).length+s4Rows.filter(row=>row.tags.split(';').includes('phrase')).length+r1Rows.filter(row=>row.tags.split(';').includes('phrase')).length+r2Rows.filter(row=>row.tags.split(';').includes('phrase')).length+r3Rows.filter(row=>row.tags.split(';').includes('phrase')).length+r4Rows.filter(row=>row.tags.split(';').includes('phrase')).length+r5Rows.filter(row=>row.tags.split(';').includes('phrase')).length+r6Rows.filter(row=>row.tags.split(';').includes('phrase')).length+initialRows.filter(row=>row.lang==='ms'&&row.tags.split(';').includes('phrase')).length+initialRows.filter(row=>['uz','kk'].includes(row.lang)&&row.tags.split(';').includes('phrase')).length);
  // 标签规则也适用于以后导入的西语词，不靠课次或语言写死。
  for (const tag of ['phrase','letter']) assert.deepEqual(plain(api.expandCards([{...initialRows[0],tags:'extra;'+tag}]).map(card=>card.direction)),['r']);
});
test('新俄语 id 连续；多音节词标 U+0301；名词标性，动词标变位，假朋友有说明',() => {
  const added=initialRows.filter(row=>['ru-02','ru-03','ru-04','ru-05','ru-06','ru-07','ru-08'].includes(row.lesson));
  assert.deepEqual(added.map(row=>row.id),Array.from({length:291},(_,i)=>'ru-'+String(52+i).padStart(4,'0')));
  for (const row of added) {
    assert.doesNotMatch(row.front,/[A-Za-z\u0341\u00b4]/,row.id);
    const words=row.front.match(/[А-Яа-яЁё\u0301]+/g) || [];
    for (const word of words) {
      if ((word.match(/[аеёиоуыэюя]/gi)||[]).length>1) assert(/[\u0301ёЁ]/.test(word),row.id+' '+word);
      for (let i=0;i<word.length;i++) if (word[i]==='\u0301') assert(/[аеёиоуыэюя]/i.test(word[i-1]),row.id);
    }
    if (row.tags.split(';').includes('名词')) assert.match(row.note,/名词（[阳阴中复]/,row.id);
    if (row.tags.split(';').includes('不定式')) {
      assert.match(row.note,/[一二]变位/,row.id);
      if (['ru-05','ru-06','ru-07','ru-08'].includes(row.lesson)) assert.match(row.note,/六个人称：.*я .*；ты .*；.*мы .*；.*вы .*；они́ /,row.id);
      if (row.lesson==='ru-06') assert.match(row.note,/第一变位/,row.id);
      if (row.lesson==='ru-07') assert.match(row.note,/第二变位/,row.id);
      if (row.id==='ru-0298') assert.match(row.note,/第二变位/,row.id);
    }
  }
  for (const front of ['журна́л','магази́н']) assert.match(added.find(row=>row.front===front).note,/假朋友/);
  assert.match(added.find(row=>row.front==='жить').note,/第一变位/);
  assert.match(added.find(row=>row.front==='говори́ть').note,/第二变位/);
  assert.match(added.find(row=>row.front==='Я живу́ в Пеки́не').note,/第 7 周/);
});
test('序列化白名单清除外来 style / script / div / 属性；同一结果重新解析恰有预期三个脚本',() => {
  const {api:a,document}=createAPI();
  document.documentElement.setAttribute('data-external','foreign-html');
  document.documentElement.setAttribute('onload','foreign-load()');
  document.body.setAttribute('class','foreign-body');
  document.body.setAttribute('style','--foreign:1');
  for (const [parent,tag,id,text] of [
    [document.head,'style','_goober','.foreign { color:red; }'],
    [document.head,'script','foreign-head','foreignHead()'],
    [document.body,'script','foreign-script','foreignScript()'],
    [document.body,'div','foreign-div','foreign content'],
    [document.getElementById('app'),'div','foreign-app','foreign nested content']
  ]) { const node=document.createElement(tag);node.setAttribute('id',id);node.textContent=text;parent.append(node); }
  document.body.append(new TextModel('<!-- foreign comment -->'));
  const saved=a.serializeDocument(document,initialRows,emptyState(),'2026-09-15T10:00:00Z','file');
  assert.doesNotMatch(saved,/_goober|foreign|data-external/);
  const parsed=new DocumentModel(saved);
  assert.deepEqual(parsed.head.childNodes.map(node=>node.tag),['meta','meta','meta','meta','title','style']);
  assert.deepEqual(parsed.body.childNodes.map(node=>node.id),['app','cards-data','state-data','srs-app']);
  assert.deepEqual(parsed.documentElement.attrs,{lang:'zh-CN'});assert.deepEqual(parsed.body.attrs,{});
  assert.equal(parsed.getElementById('app').innerHTML,'');
  const scripts=parsed.querySelectorAll('script');assert.equal(scripts.length,3);
  assert.deepEqual(scripts.map(node=>node.id),['cards-data','state-data','srs-app']);
  assert.deepEqual(JSON.parse(scripts[0].textContent),initialRows);
  assert.deepEqual(JSON.parse(scripts[1].textContent),emptyState());
  assert.equal(scripts[2].textContent,runtime);
  assert.equal(parsed.getElementById('srs-style').textContent,document.getElementById('srs-style').textContent);
  const {api:reopened}=createAPI(true,saved);reopened.initialize();
  assert.deepEqual(plain(reopened.getData().rows),initialRows);
  assert.equal(reopened.getData().state.updatedAt,emptyState().updatedAt);
  assert(document.getElementById('_goober'),'克隆清理不能改原文档');
});
test('磁盘 updatedAt 或卡片行数改变：首次不写并显示仍要覆盖，第二次才写；保存后更新快照',async () => {
  for (const kind of ['state','cards']) {
    const {api:a,context,document}=createAPI(true);a.initialize();a.change();
    let disk=kind==='state'?fixtureHTML(initialRows,{...emptyState(),updatedAt:'2026-09-16T00:00:00.000Z'}):fixtureHTML(initialRows.slice(0,-1));
    let reads=0,writes=0,stores=0;
    const handle={queryPermission:async()=> 'granted',getFile:async()=>{reads++;return {text:async()=>disk};},createWritable:async()=>({write:async text=>{writes++;disk=text;},close:async()=>{}})};
    context.window.showSaveFilePicker=async()=>handle;
    a.setHandleStore(async()=>{stores++;});
    a.openLesson('ru-04');
    await a.saveFile();assert.equal(writes,0);assert.equal(reads,1);assert.equal(a.getData().dirty,true);
    assert.equal(a.getData().notice,'文件在本页打开后被外部修改（可能是新课程或另一台设备的进度）。请先重新打开页面；仍要覆盖请再点一次保存');
    assert(document.querySelectorAll('[data-action="save"]').every(button=>button.textContent==='仍要覆盖'));
    await a.saveFile();assert.equal(writes,1);assert.equal(reads,2);assert.equal(stores,1);
    assert.equal(a.getData().dirty,false);assert.equal(a.getData().overwritePending,null);
    assert.equal(a.getData().fileSnapshot,a.snapshotDocument(new DocumentModel(disk)));
    assert(document.querySelectorAll('[data-action="save"]').every(button=>button.textContent==='保存'));
    a.change();await a.saveFile();assert.equal(writes,2);assert.equal(reads,3);
  }
});
test('覆盖确认绑定同一句柄和磁盘快照；两次点击之间文件再次变化会重新提示',async () => {
  const {api:a,context}=createAPI();let day=16,writes=0;
  const handle={queryPermission:async()=> 'granted',getFile:async()=>({text:async()=>fixtureHTML(initialRows,{...emptyState(),updatedAt:`2026-09-${day}T00:00:00.000Z`})}),createWritable:async()=>({write:async()=>{writes++;},close:async()=>{}})};
  context.window.showSaveFilePicker=async()=>{};a.setHandle(handle);
  await a.saveFile();assert.equal(writes,0);
  day++;await a.saveFile();assert.equal(writes,0);
  a.setHandle({...handle});await a.saveFile();assert.equal(writes,0);
  await a.saveFile();assert.equal(writes,1);
});
test('新建空文件可首次保存；getFile 读取失败不能写；另存为不会沿用旧覆盖确认',async () => {
  const {api:a,context}=createAPI();let writes=0;
  const writer=async()=>({write:async()=>{writes++;},close:async()=>{}});
  context.window.showSaveFilePicker=async()=>({getFile:async()=>({text:async()=>''}),createWritable:writer});
  a.setHandleStore(async()=>{});await a.saveFile();assert.equal(writes,1);
  a.setHandle({queryPermission:async()=> 'granted',getFile:async()=>{throw new Error('read unavailable');},createWritable:writer});
  a.change();await a.saveFile();assert.equal(writes,1);assert.match(a.getData().notice,/read unavailable/);assert.equal(a.getData().dirty,true);
  const other={getFile:async()=>({text:async()=>fixtureHTML(initialRows.slice(0,-1))}),createWritable:writer};
  context.window.showSaveFilePicker=async()=>other;
  await a.saveFile({asNew:true});assert.equal(writes,1);assert(a.getData().overwritePending);
  await a.saveFile({asNew:true});assert.equal(writes,1,'重新选文件必须重新确认覆盖');
});

// 任务 F1：阅读理解线。词汇范围沿用上面的推导式检查，对全部 48 篇执行。
const READING_BANDS={2:[80,100],3:[100,130],4:[130,160],5:[150,180],6:[170,200],7:[200,230],8:[220,260],9:[240,280],10:[260,300],11:[280,320],12:[300,350],13:[300,350],14:[300,350],15:[300,350],16:[300,350],17:[350,400],18:[350,400],19:[350,400],20:[350,400],21:[400,450],22:[400,450],23:[400,450],24:[400,450],25:[400,450]};
const READING_GENRES=['对话','日记','邮件','短故事','描写','通知或广告','菜谱或日程','人物介绍','简单新闻'];
test('任务 F1：READINGS 结构完整、篇幅在区间内、答案在选项里、重点词是已学词',() => {
  const esReadings=Object.entries(api.READINGS).filter(([,item])=>item.lang==='es');
  assert.deepEqual(esReadings.map(([id])=>id),Array.from({length:48},(_,i)=>'es-r'+String(i+1).padStart(2,'0')));
  const fronts=new Map();
  for (const row of initialRows.filter(row=>row.lang==='es')) if (!fronts.has(row.front)) fronts.set(row.front,row.lesson);
  const genres=new Set();
  for (const [id,item] of esReadings) {
    assert.equal(item.id,id,id+' 的 id 应与键一致');
    assert.equal(item.lang,'es',id);
    const lesson=api.LESSONS[item.afterLesson];
    assert(lesson && lesson.lang==='es',id+' 的 afterLesson 必须是已有西语课');
    assert.equal(item.week,lesson.week,id+' 的周次应与 afterLesson 一致');
    assert(item.title && item.title.trim() && /[㐀-鿿]/.test(item.title),id+' 标题');
    assert(READING_GENRES.includes(item.genre),id+' 体裁：'+item.genre);
    genres.add(item.genre);
    const words=item.sentences.flatMap(sentence=>sentence.text.match(/[\p{L}\p{M}]+/gu) || []);
    assert.equal(item.words,words.length,id+' words 字段应等于实际词数');
    const band=READING_BANDS[item.week];
    assert(words.length>=band[0] && words.length<=band[1],`${id}: ${words.length} words, expected ${band[0]}–${band[1]}`);
    assert(item.sentences.length>=10,id+' 句数');
    for (const sentence of item.sentences) {
      assert.match(sentence.text,/[.?!]$/,id+'：'+sentence.text);
      assert.equal(sentence.text,sentence.text.normalize('NFC'),id);
      assert.match(sentence.zh,/[㐀-鿿]/,id+'：'+sentence.text);
      if (sentence.text.includes('?')) assert(sentence.text.includes('¿'),id+' 问句要有 ¿');
    }
    assert.equal(item.questions.length,4,id+' 阅读题数');
    for (const question of item.questions) {
      assert(question.prompt && question.prompt.trim(),id);
      assert(question.options.length>=3,id+' '+question.prompt);
      assert(question.options.includes(question.answer),id+' '+question.prompt);
      assert.equal(question.options.length,new Set(question.options).size,id+' '+question.prompt);
    }
    // 每篇至少一道推断或指代题，不能全是找信息。
    assert(item.questions.some(question=>/推断|指的是/.test(question.prompt)),id+' 缺少推断或指代题');
    assert.equal(item.keyWords.length,5,id+' 重点词数');
    for (const word of item.keyWords) {
      const from=fronts.get(word.word);
      assert(from,id+' 重点词不是西语词卡：'+word.word);
      assert(from<=item.afterLesson,id+' 重点词超出课次：'+word.word+'（'+from+'）');
      assert(word.zh && /[㐀-鿿]/.test(word.zh),id+' 重点词缺中文：'+word.word);
    }
    assert(item.retell.length>=3 && item.retell.length<=5,id+' 复述要点 '+item.retell.length+' 条');
    for (const point of item.retell) assert.match(point,/[㐀-鿿]/,id+' 复述要点须为中文');
  }
  assert.deepEqual([...genres].sort(),[...READING_GENRES].sort());
  // 每周两篇，从第 2 周到第 25 周。
  for (let week=2;week<=25;week++) assert.equal(Object.values(api.READINGS).filter(item=>item.lang==='es' && item.week===week).length,2,'第 '+week+' 周篇数');
});
test('任务 F1 / S1 / S2 / S3 / S4：48 篇阅读只用 afterLesson 及之前的词卡与其规则变化形式',() => {
  for (const item of Object.values(api.READINGS)) if (item.lang==='es') checkSentenceVocabulary(item.afterLesson,item.sentences,item.id);
  // 反向检查：范围规则仍能判出未学的词和还没到的课次。
  assert(!esKnown('es-02','porque'),'第 3 周才学的 porque 不该通过第 2 周的检查');
  assert(!esKnown('es-04','que'),'第 5 周才学的 que 不该通过第 4 周的检查');
});
test('任务 S1：八篇阅读对应第 13–16 周、每周体裁不同并覆盖简单新闻',() => {
  const readings=Object.values(api.READINGS).filter(item=>/^es-r(?:2[3-9]|30)$/.test(item.id));
  assert.equal(readings.length,8);
  for (let i=0;i<8;i++) {
    const item=api.READINGS['es-r'+(23+i)],week=13+Math.floor(i/2);
    assert(item,'es-r'+(23+i));
    assert.equal(item.week,week,item.id+' 周次');assert.equal(item.afterLesson,'es-'+week,item.id+' 词汇上限');
  }
  for (let week=13;week<=16;week++) {
    const pair=readings.filter(item=>item.week===week);
    assert.equal(pair.length,2,'第 '+week+' 周两篇');
    assert.notEqual(pair[0].genre,pair[1].genre,'第 '+week+' 周两种体裁');
  }
  const counts=Object.values(api.READINGS).filter(item=>item.lang==='es').reduce((out,item)=>(out[item.genre]=(out[item.genre] || 0)+1,out),{});
  for (const genre of READING_GENRES) assert((counts[genre] || 0)>=(genre==='简单新闻'?1:2),genre+' 篇数');
});
test('任务 S2：八篇阅读对应第 17–20 周、每周两种体裁、350–400 词并执行同一词汇检查',() => {
  const readings=Object.values(api.READINGS).filter(item=>/^es-r3[1-8]$/.test(item.id));
  assert.equal(readings.length,8,'S2 新阅读八篇');
  for (let i=0;i<8;i++) {
    const id='es-r'+(31+i),item=api.READINGS[id],week=17+Math.floor(i/2);assert(item,id+' 存在');
    assert.equal(item.week,week,id+' 周次');assert.equal(item.afterLesson,'es-'+week,id+' 词汇上限');
    const words=item.sentences.flatMap(sentence=>esWords(sentence.text));
    assert.equal(item.words,words.length,id+' 词数字段');
    assert(words.length>=350 && words.length<=400,id+' '+words.length+' 词');
    assert.equal(item.questions.length,4,id+' 四题');
    assert(item.questions.some(question=>/推断|指的是/.test(question.prompt)),id+' 推断或指代题');
    assert.equal(item.keyWords.length,5,id+' 五个已学重点词');
    for (const word of item.keyWords) assert(initialRows.some(row=>row.lang==='es' && row.lesson<=item.afterLesson && row.front===word.word),id+' 重点词应已学：'+word.word);
    checkSentenceVocabulary(item.afterLesson,item.sentences,id);
  }
  for (let week=17;week<=20;week++) {
    const pair=readings.filter(item=>item.week===week);assert.equal(pair.length,2,'第 '+week+' 周两篇');
    assert.notEqual(pair[0].genre,pair[1].genre,'第 '+week+' 周体裁不同');
  }
});
test('任务 F1：validateState 接受缺失与存在的 readings；无效阅读进度被挡下',() => {
  const base=emptyState();
  assert.equal(api.validateState(base).readings,undefined);
  const withReadings={...base,readings:{'es-r01':{done:'2026-09-20',score:3,total:4}}};
  assert.deepEqual(plain(api.validateState(withReadings).readings),{'es-r01':{done:'2026-09-20',score:3,total:4}});
  assert.deepEqual(plain(api.validateState({...base,readings:{}}).readings),{});
  for (const bad of [{done:'2026-13-01',score:1,total:4},{done:'2026-09-20',score:5,total:4},{done:'2026-09-20',score:-1,total:4},{done:'2026-09-20',score:1,total:0},{done:'2026-09-20',score:1.5,total:4},null,'x'])
    assert.throws(()=>api.validateState({...base,readings:{'es-r01':bad}}),/阅读进度/,JSON.stringify(bad));
  assert.throws(()=>api.validateState({...base,readings:[]}),/阅读进度/);
  assert.throws(()=>api.validateState({...base,readings:{'不是 id':{done:'2026-09-20',score:1,total:4}}}),/阅读进度/);
});
test('任务 F1：导入合并阅读进度取 done 更晚者；一边没有该字段也能合并',() => {
  const base=emptyState();
  const current=api.validateState({...base,readings:{'es-r01':{done:'2026-09-20',score:2,total:4},'es-r02':{done:'2026-09-25',score:4,total:4}}});
  const incoming=api.validateState({...base,readings:{'es-r01':{done:'2026-09-22',score:4,total:4},'es-r03':{done:'2026-09-21',score:1,total:4}}});
  const merged=api.mergeProgress(current,incoming);
  assert.deepEqual(plain(merged.readings),{
    'es-r01':{done:'2026-09-22',score:4,total:4},
    'es-r02':{done:'2026-09-25',score:4,total:4},
    'es-r03':{done:'2026-09-21',score:1,total:4}
  });
  // 反方向合并时更早的 done 不能盖掉更晚的。
  assert.deepEqual(plain(api.mergeProgress(incoming,current).readings['es-r01']),{done:'2026-09-22',score:4,total:4});
  assert.equal(api.mergeProgress(api.validateState(base),api.validateState(base)).readings,undefined);
  assert.deepEqual(plain(api.mergeProgress(current,api.validateState(base)).readings),plain(current.readings));
  assert.deepEqual(plain(api.mergeProgress(api.validateState(base),current).readings),plain(current.readings));
});
test('任务 F1：阅读标签的列表与阅读页；答完四题写入进度且序列化后 app 为空',() => {
  const {api:a,document}=createAPI(true);a.initialize();
  assert.deepEqual(document.querySelectorAll('[data-tab]').map(node=>node.dataset.tab),['review','lessons','readings','stats','settings']);
  a.showReadings();
  const list=document.querySelectorAll('[data-reading]');
  assert.equal(list.length,Object.keys(a.READINGS).length);
  assert.deepEqual(list.map(node=>node.dataset.reading),['es','ru','ms'].flatMap(lang=>Object.values(a.READINGS).filter(item=>item.lang===lang).map(item=>item.id)));
  assert(document.getElementById('content').innerHTML.includes('未读'),'未读状态');
  const item=a.READINGS['es-r01'];
  document.getElementById('app').listeners.click[0]({target:{closest:()=>list[0]}});
  assert(document.getElementById('content').innerHTML.includes(item.title),'点列表按钮应打开该篇');
  a.openReadingItem('es-r01');
  const translations=()=>document.querySelectorAll('details').filter(node=>node.querySelector('summary')?.textContent==='查看本句中文');
  assert.equal(translations().length,item.sentences.length);
  for (const node of translations()) assert.equal(node.getAttribute('open'),null);
  a.toggleReadingZh();
  for (const node of translations()) assert.equal(node.getAttribute('open'),'');
  a.toggleReadingZh();
  assert.equal(document.querySelectorAll('[data-question]').length,4);
  assert.equal(document.querySelectorAll('.vocab').at(-1).querySelector('tbody').querySelectorAll('tr').length,5);
  const submit=i => {
    const form=document.querySelector('[data-question="'+i+'"]');
    document.getElementById('app').listeners.submit[0]({target:form,preventDefault(){}});
    return form;
  };
  // 先答错第一题，其余答对；得分按最新一次记。
  document.querySelector('[data-question="0"]').elements.answer.value=item.questions[0].options.find(option=>option!==item.questions[0].answer);
  assert.equal(submit(0).querySelector('.exercise-result').textContent,'选错了；正确答案：'+item.questions[0].answer);
  assert.equal(a.getData().state.readings,undefined,'没答完不写进度');
  for (const i of [1,2,3]) {
    document.querySelector('[data-question="'+i+'"]').elements.answer.value=item.questions[i].answer;
    submit(i);
  }
  const today=a.localDay();
  assert.deepEqual(plain(a.getData().state.readings),{'es-r01':{done:today,score:3,total:4}});
  assert(document.getElementById('content').innerHTML.includes('本次得分 3 / 4'),'得分显示');
  assert.equal(a.getData().dirty,true,'写入阅读进度后应提示保存');
  // 重做同一篇按最新一次记。
  document.querySelector('[data-question="0"]').elements.answer.value=item.questions[0].answer;
  submit(0);
  assert.deepEqual(plain(a.getData().state.readings),{'es-r01':{done:today,score:4,total:4}});
  const back=document.querySelectorAll('[data-action]').find(node=>node.dataset.action==='readings-back');
  document.getElementById('app').listeners.click[0]({target:{closest:()=>back}});
  assert.equal(document.querySelectorAll('[data-reading]').length,Object.keys(a.READINGS).length,'返回按钮回到阅读列表');
  assert(document.getElementById('content').innerHTML.includes('已读 '+today+' · 4 / 4'),'列表显示已读与得分');
  // 序列化仍清空 app，readings 随状态写入并能再次读回。
  const saved=a.serializeDocument(document,initialRows,a.getData().state,'2026-09-15T10:00:00Z','file');
  const parsed=new DocumentModel(saved);
  assert.equal(parsed.getElementById('app').innerHTML,'');
  assert.deepEqual(parsed.body.childNodes.map(node=>node.id),['app','cards-data','state-data','srs-app']);
  assert.deepEqual(JSON.parse(parsed.getElementById('state-data').textContent).readings,{'es-r01':{done:today,score:4,total:4}});
  const {api:reopened}=createAPI(true,saved);reopened.initialize();
  assert.deepEqual(plain(reopened.getData().state.readings),{'es-r01':{done:today,score:4,total:4}});
});
test('任务 F1：统计页的阅读一行；课程标题行的每日时长两种语言都显示',() => {
  const {api:a,document}=createAPI(true);a.initialize();
  a.openReadingItem('es-r02');
  const item=a.READINGS['es-r02'];
  for (let i=0;i<4;i++) {
    document.querySelector('[data-question="'+i+'"]').elements.answer.value=item.questions[i].answer;
    document.getElementById('app').listeners.submit[0]({target:document.querySelector('[data-question="'+i+'"]'),preventDefault(){}});
  }
  const statsTab=document.querySelectorAll('[data-tab]').find(node=>node.dataset.tab==='stats');
  document.getElementById('app').listeners.click[0]({target:{closest:()=>statsTab}});
  const rows=document.querySelectorAll('.stats-table').at(-1).querySelector('tbody').querySelectorAll('tr')
    .map(tr=>[tr.querySelector('th').textContent,...tr.querySelectorAll('td').map(td=>td.textContent)]);
  assert.deepEqual(rows.slice(0,2),[['es · 西语','1 / 48','4.0 / 4'],['ru · 俄语','0 / 60','—']]);
  assert.deepEqual(rows.slice(2).map(row=>row[0]),plain(a.LANGS.slice(2).map(lang=>lang+' · '+a.LANG_INFO[lang].short)));
  const expected={es:['每天 30 分钟 + 每周 3 次系统块 40 分钟','每天 25 分钟 + 每周 30 分钟语法与写作'],ru:['每天 10 分钟','每天 30 分钟 + 周末系统块 60 分钟']};
  for (const [id,lesson] of Object.entries(a.LESSONS)) {
    if (!expected[lesson.lang]) continue; // 乌兹别克语、哈萨克语未排期，不检查时长。
    const want=expected[lesson.lang][lesson.week>=5?1:0];
    assert.equal(lesson.dailyTime,want,id+' dailyTime');
    a.openLesson(id);
    assert(document.querySelector('.kicker').textContent.includes(want),id+' 标题行时长');
  }
});

test('语言表：复习下拉框、设置表单与统计行；旧进度使用默认额度且保留预留语言行为',() => {
  const {api:a,document}=createAPI(true);a.initialize();
  const old={version:1,updatedAt:'2026-09-14T00:00:00.000Z',settings:{newPerDay:{es:15,ru:10}},cards:{},log:[]};
  const checked=a.validateState(old);
  assert.deepEqual(plain(checked.settings.newPerDay),{es:15,ru:10,ms:10,uz:0,kk:0});
  assert.throws(()=>a.validateState({...old,settings:{newPerDay:{es:15,ru:10,uz:1000}}}),/0–999/);
  assert.throws(()=>a.validateState({...old,settings:{newPerDay:{es:15,ru:'x'}}}),/0–999/);
  a.openReview('all');
  document.getElementById('app').listeners.click[0]({target:{closest:()=>document.querySelectorAll('[data-tab]').find(node=>node.dataset.tab==='review')}});
  assert.deepEqual(document.getElementById('language').querySelectorAll('option').map(node=>node.getAttribute('value')),['all',...a.LANGS]);
  document.getElementById('app').listeners.click[0]({target:{closest:()=>document.querySelectorAll('[data-tab]').find(node=>node.dataset.tab==='settings')}});
  assert.deepEqual(document.getElementById('limits').querySelectorAll('input').map(node=>node.getAttribute('name')),plain(a.LANGS));
  document.getElementById('app').listeners.click[0]({target:{closest:()=>document.querySelectorAll('[data-tab]').find(node=>node.dataset.tab==='stats')}});
  const heads=document.querySelectorAll('.stats-table')[0].querySelector('tbody').querySelectorAll('tr').map(tr=>tr.querySelector('th').textContent);
  assert.deepEqual(heads,plain(a.LANGS.map(lang=>lang+' · '+a.LANG_INFO[lang].short)));
  document.getElementById('app').listeners.click[0]({target:{closest:()=>document.querySelectorAll('[data-tab]').find(node=>node.dataset.tab==='lessons')}});
  const page=document.getElementById('app').innerHTML;
  for (const lang of a.LANGS) assert(page.includes('aria-label="'+a.LANG_INFO[lang].short+'课程"'),lang);
  // 乌兹别克语 oʻ / gʻ 的撇号：U+02BB、U+02BC、U+2019 和普通单引号视为同一符号。
  assert.equal(a.spellingResult("o'qituvchi",'oʻqituvchi','uz').grade,4);
  assert.equal(a.spellingResult('gʼisht','gʻisht','uz').grade,4);
  assert.equal(a.spellingResult('o’qituvchi','oʻqituvchi','uz').grade,4);
  assert.equal(a.spellingResult('oqituvchi','oʻqituvchi','uz').grade,0);
  // 哈萨克语和西语不做撇号归一；俄语重音规则不变。
  assert.equal(a.spellingResult('кітап','кітап','kk').grade,4);
  assert.equal(a.spellingResult('китап','кітап','kk').grade,0);
  assert.equal(a.spellingResult('книга','кни́га','ru').grade,4);
});

// 任务 F2：俄语阅读篇目。后续建设期阅读沿用同一套推导式检查。
const RU_READING_SENTENCES={5:[6,8],6:[8,10],7:[8,10],8:[10,12],9:[10,12],10:[12,14],11:[12,14],12:[14,16]};
const RU_READING_GENRES=['对话','日记','短信或便条','人物介绍','房间或城市描写','一天的安排','通知'];
test('任务 F2 / S2 / R2 / S3：既有阅读保留 id 顺序，新篇目在末尾追加',() => {
  assert.deepEqual(Object.keys(api.READINGS).filter(id=>!id.startsWith('ms-r')||Number(id.slice(4))<=22),[
    ...Array.from({length:30},(_,i)=>'es-r'+String(i+1).padStart(2,'0')),
    ...Array.from({length:24},(_,i)=>'ru-r'+String(i+1).padStart(2,'0')),
    ...Array.from({length:8},(_,i)=>'es-r'+String(i+31).padStart(2,'0')),
    ...Array.from({length:8},(_,i)=>'ru-r'+String(i+25).padStart(2,'0')),
    ...Array.from({length:6},(_,i)=>'es-r'+String(i+39).padStart(2,'0')),
    ...Array.from({length:8},(_,i)=>'ru-r'+String(i+33).padStart(2,'0')),
    ...Array.from({length:4},(_,i)=>'es-r'+String(i+45).padStart(2,'0')),
    ...Array.from({length:8},(_,i)=>'ru-r'+String(i+41).padStart(2,'0')),
    ...Array.from({length:6},(_,i)=>'ru-r'+String(i+49).padStart(2,'0')),
    ...Array.from({length:6},(_,i)=>'ru-r'+String(i+55).padStart(2,'0')),
    ...Array.from({length:22},(_,i)=>'ms-r'+String(i+1).padStart(2,'0'))
  ]);
  assert.equal(Object.values(api.READINGS).filter(item=>item.lang==='ru').length,60);
});
test('任务 F2：16 篇俄语阅读结构完整、句数在区间内、答案在选项里、重点词是已学词',() => {
  const fronts=new Map();
  for (const row of initialRows.filter(row=>row.lang==='ru')) if (!fronts.has(row.front)) fronts.set(row.front,row.lesson);
  const genres=new Set();
  for (const [id,item] of Object.entries(api.READINGS).filter(([,item])=>item.lang==='ru' && item.week<=12)) {
    assert.equal(item.id,id,id+' 的 id 应与键一致');
    const lesson=api.LESSONS[item.afterLesson];
    assert(lesson && lesson.lang==='ru',id+' 的 afterLesson 必须是已有俄语课');
    assert.equal(item.week,lesson.week,id+' 的周次应与 afterLesson 一致');
    assert(item.title && item.title.trim() && /[㐀-鿿]/.test(item.title),id+' 标题');
    assert(RU_READING_GENRES.includes(item.genre),id+' 体裁：'+item.genre);
    genres.add(item.genre);
    const words=item.sentences.flatMap(sentence=>sentence.text.match(/[\p{L}\p{M}]+/gu) || []);
    assert.equal(item.words,words.length,id+' words 字段应等于实际词数');
    const band=RU_READING_SENTENCES[item.week];
    assert(item.sentences.length>=band[0] && item.sentences.length<=band[1],
      `${id}: ${item.sentences.length} 句，应为 ${band[0]}–${band[1]} 句`);
    for (const sentence of item.sentences) {
      assert.match(sentence.text,/[.?!]$/,id+'：'+sentence.text);
      assert.equal(sentence.text,sentence.text.normalize('NFC'),id+' 句子须为 NFC');
      assert.doesNotMatch(sentence.text,/[A-Za-z]/,id+' 句子不含拉丁字母');
      assert.match(sentence.zh,/[㐀-鿿]/,id+'：'+sentence.text);
      // 多音节词标 U+0301，重音记号只能跟在元音后面。
      for (const word of sentence.text.match(/[А-Яа-яЁё\u0301]+/g) || []) {
        if ((word.match(/[аеёиоуыэюя]/gi)||[]).length>1) assert(/[́ёЁ]/.test(word),id+' 多音节词要标重音：'+word);
        for (let i=0;i<word.length;i++) if (word[i]==='́') assert(/[аеёиоуыэюя]/i.test(word[i-1]),id+' 重音标记要跟在元音后：'+word);
      }
    }
    assert.equal(item.questions.length,4,id+' 阅读题数');
    for (const question of item.questions) {
      assert(question.prompt && question.prompt.trim(),id);
      assert(question.options.length>=3,id+' '+question.prompt);
      assert(question.options.includes(question.answer),id+' '+question.prompt);
      assert.equal(question.options.length,new Set(question.options).size,id+' '+question.prompt);
    }
    // 每篇至少一道推断或指代题，不能全是找信息。
    assert(item.questions.some(question=>/推断|指的是/.test(question.prompt)),id+' 缺少推断或指代题');
    assert.equal(item.keyWords.length,5,id+' 重点词数');
    for (const word of item.keyWords) {
      const from=fronts.get(word.word);
      assert(from,id+' 重点词不是俄语词卡：'+word.word);
      assert(from<=item.afterLesson,id+' 重点词超出课次：'+word.word+'（'+from+'）');
      assert(word.zh && /[㐀-鿿]/.test(word.zh),id+' 重点词缺中文：'+word.word);
    }
    assert(item.retell.length>=3 && item.retell.length<=5,id+' 复述要点 '+item.retell.length+' 条');
    for (const point of item.retell) assert.match(point,/[㐀-鿿]/,id+' 复述要点须为中文');
  }
  assert.deepEqual([...genres].sort(),[...RU_READING_GENRES].sort());
  // 每周两篇，从第 5 周到第 12 周。
  for (let week=5;week<=12;week++) assert.equal(Object.values(api.READINGS).filter(item=>item.lang==='ru' && item.week===week).length,2,'第 '+week+' 周篇数');
});
test('任务 F2 / R1 / R2 / R3 / R4 / R5 / R6：60 篇俄语阅读只用 afterLesson 及之前的词卡与其规则变化形式',() => {
  for (const item of Object.values(api.READINGS)) {
    if (item.lang!=='ru') continue;
    const set=ruVocabulary(item.afterLesson);
    for (const sentence of item.sentences)
      for (const word of ruWords(sentence.text))
        assert(set.has(word),item.id+' 阅读超出词表：'+word+'（'+sentence.text+'）');
  }
  // 反向检查：范围规则仍能判出未学的词和还没到的课次。
  assert(!ruKnown('ru-05','библиоте́ка'),'第 7 周才学的词不该通过第 5 周的检查');
  assert(!ruKnown('ru-08','вы́ставка'),'第 9 周才学的词不该通过第 8 周的检查');
  assert(!ruKnown('ru-10','кошелёк'),'第 11 周才学的词不该通过第 10 周的检查');
});
test('任务 F2：阅读列表按语言分两段；俄语阅读页逐句中文、重点词表与四道题都在',() => {
  const {api:a,document}=createAPI(true);a.initialize();
  a.showReadings();
  const list=document.querySelectorAll('[data-reading]').map(node=>node.dataset.reading);
  assert.equal(list.filter(id=>id.startsWith('es-r')).length,48);
  assert.deepEqual(list.filter(id=>id.startsWith('ru-r')),Object.values(a.READINGS).filter(item=>item.lang==='ru').map(item=>item.id));
  const item=a.READINGS['ru-r16'];
  a.openReadingItem('ru-r16');
  const html=document.getElementById('content').innerHTML;
  assert(html.includes(item.title),'阅读页标题');
  assert(html.includes('词汇范围到 ru-12'),'阅读页词汇范围');
  assert.equal(document.querySelectorAll('details').filter(node=>node.querySelector('summary')?.textContent==='查看本句中文').length,item.sentences.length);
  assert.equal(document.querySelectorAll('[data-question]').length,4);
  assert.equal(document.querySelectorAll('.vocab').at(-1).querySelector('tbody').querySelectorAll('tr').length,5);
  for (let i=0;i<4;i++) {
    document.querySelector('[data-question="'+i+'"]').elements.answer.value=item.questions[i].answer;
    document.getElementById('app').listeners.submit[0]({target:document.querySelector('[data-question="'+i+'"]'),preventDefault(){}});
  }
  assert.deepEqual(plain(a.getData().state.readings),{'ru-r16':{done:a.localDay(),score:4,total:4}});
});
test('任务 F2：ru-05 至 ru-08 的 note 复数重音已更正，CSV 与内嵌数据一致',() => {
  const csvRows=api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','ru.csv'),'utf8'));
  const lessons=['ru-05','ru-06','ru-07','ru-08'];
  assert.deepEqual(plain(csvRows.filter(row=>lessons.includes(row.lesson))),plain(initialRows.filter(row=>lessons.includes(row.lesson))));
  const byId=new Map(initialRows.map(row=>[row.id,row]));
  for (const [id,plural] of [
    ['ru-0147','словари́'],['ru-0152','шкафы́'],['ru-0157','зеркала́'],['ru-0176','коты́'],['ru-0233','уро́ки'],
    ['ru-0258','полы́'],['ru-0262','этажи́'],['ru-0265','корпуса́'],['ru-0268','места́'],['ru-0324','поезда́']
  ]) assert.equal(byId.get(id).note.split('复数主格：')[1],plural,id+' 复数主格');
  // 这四课的 note 里，复数与变位形式的重音记号都跟在元音后面，且多音节形式都标了重音。
  for (const row of initialRows.filter(row=>lessons.includes(row.lesson))) {
    const forms=row.note.split(/[：；]/).slice(1).join(' ');
    for (const word of forms.match(/[А-Яа-яЁё\u0301]+/g) || []) {
      if ((word.match(/[аеёиоуыэюя]/gi)||[]).length>1) assert(/[́ёЁ]/.test(word),row.id+' note 多音节形式要标重音：'+word);
      for (let i=0;i<word.length;i++) if (word[i]==='́') assert(/[аеёиоуыэюя]/i.test(word[i-1]),row.id+' note 重音记号要跟在元音后：'+word);
    }
  }
});

// 任务 R1：建设期四课和八篇俄语阅读。沿用同一词形推导器检查卡片例句与两条阅读线。
const R1_STANDARD_STRESS={
  друзей:'друзе́й',братьев:'бра́тьев',детей:'дете́й',много:'мно́го',мало:'ма́ло',
  сколько:'ско́лько',несколько:'не́сколько',после:'по́сле',около:'о́коло',кроме:'кро́ме',
  первое:'пе́рвое',второе:'второ́е',третье:'тре́тье',четвёртое:'четвёртое',пятое:'пя́тое',
  шестое:'шесто́е',седьмое:'седьмо́е',восьмое:'восьмо́е',девятое:'девя́тое',десятое:'деся́тое',
  тебе:'тебе́',ему:'ему́',нравится:'нра́вится',нравятся:'нра́вятся',надо:'на́до',нужно:'ну́жно',
  можно:'мо́жно',нельзя:'нельзя́',телефону:'телефо́ну',вторникам:'вто́рникам',
  холодно:'хо́лодно',интересно:'интере́сно',скучно:'ску́чно'
};
function checkR1Russian(text,label) {
  assert.equal(text,text.normalize('NFC'),label+' NFC');
  assert.doesNotMatch(text,/[\u0341\u00b4]/,label+' 使用 U+0301');
  for (const match of text.matchAll(/[А-Яа-яЁё\u0301]+/g)) {
    const word=match[0];
    // -ия 和 пере- 等独立词尾或前缀没有统一重音；по-кита́йски 等完整词仍要检查。
    const ending=text[match.index-1]==='-' && !/[А-Яа-яЁё\u0301]/.test(text[match.index-2] || '');
    const prefix=text[match.index+word.length]==='-' && !/[А-Яа-яЁё\u0301]/.test(text[match.index+word.length+1] || '');
    const vowelCount=(word.match(/[аеёиоуыэюя]/gi)||[]).length;
    // ё 本身就是重读元音，按一个重音计；ё 上不再加 U+0301。
    const accents=(word.match(/\u0301/g)||[]).length + (/[ёЁ]/.test(word) ? 1 : 0);
    if (vowelCount>1 && !ending && !prefix) assert.equal(accents,1,label+' 多音节词须有一个 U+0301：'+word);
    else assert(accents<=1,label+' 重音数：'+word);
    for (let i=0;i<word.length;i++) if (word[i]==='\u0301')
      assert(/[аеёиоуыэюя]/i.test(word[i-1]),label+' 重音须紧随元音：'+word);
    const standard=R1_STANDARD_STRESS[ruDeaccent(word)];
    if (standard) assert.equal(word.toLowerCase(),standard,label+' 标准词形重音：'+word);
  }
}
function checkR1Vocabulary(lesson,sentences,label) {
  const vocabulary=ruVocabulary(lesson);
  for (const sentence of sentences) for (const word of ruWords(sentence.text))
    assert(vocabulary.has(word),label+' 超出词表：'+word+'（'+sentence.text+'）');
}
test('任务 R1：四课日期、卡片数量、14–20 句双语课文和 6 加 4 题配额',() => {
  const dates=['12-07 至 12-13','12-14 至 12-20','12-21 至 12-27','12-28 至 2027 年 01-03'];
  const counts=[50,58,50,55];
  for (const [i,id] of R1_LESSONS.entries()) {
    const lesson=api.LESSONS[id];
    assert(lesson,id+' 课程存在');
    assert.equal(lesson.lang,'ru',id);assert.equal(lesson.week,13+i,id);
    assert.equal(lesson.dates,dates[i],id+' 日期');
    assert.equal(r1Rows.filter(row=>row.lesson===id).length,counts[i],id+' 卡片数');
    assert.equal(lesson.dailyTime,'每天 30 分钟 + 周末系统块 60 分钟',id+' 时长');
    assert.match(lesson.writingTask,/5 句/,id+' 写作任务');
    const explanation=lesson.explanation();
    const text=parseNodes(explanation).map(node=>node.textContent).join('').trim();
    assert(text.startsWith('时间分配以复盘结果为准'),id+' 讲解开头');
    assert(explanation.includes('配合教材第二册的对应内容，课次以实际教材为准'),id+' 教材指引');
    assert.doesNotMatch(explanation,/《东方大学俄语[^》]*》第\s*\d+\s*课/,id+' 教材课次不写固定编号');
    assert.doesNotMatch(text.replace(/一封信/g,''),/[死杀封炸战坑砍]/,id+' 讲解措辞');
    checkR1Russian(decode(explanation.replace(/<[^>]*>/g,' ')),id+' 讲解');
    assert(lesson.reading.sentences.length>=14 && lesson.reading.sentences.length<=20,id+' 课文句数');
    assert.equal(lesson.reading.questions.length,4,id+' 阅读四题');
    assert.equal(lesson.exercises.length,10,id+' 练习十题');
    assert.deepEqual(lesson.exercises.slice(6),lesson.reading.questions,id+' 阅读题属于十题');
    assert(lesson.exercises.slice(0,6).filter(exercise=>!exercise.options).length>=4,id+' 语法题以文本题为主');
    for (const question of lesson.exercises) {
      assert.equal(typeof question.answer,'string',id+' 答案类型');assert(question.answer.trim(),id+' 答案非空');
      checkR1Russian(question.prompt,id+' 题干');checkR1Russian(question.answer,id+' 答案');
      if (question.options) {
        assert(question.options.includes(question.answer),id+' 答案在选项里');
        assert.equal(new Set(question.options).size,question.options.length,id+' 选项不重复');
        for (const option of question.options) checkR1Russian(option,id+' 选项');
      }
    }
    for (const sentence of lesson.reading.sentences) {
      assert.match(sentence.text,/[.?!]$/,id+' 句尾');assert.match(sentence.zh,/[㐀-鿿]/,id+' 逐句中文');
      assert.doesNotMatch(sentence.text,/[A-Za-z]/,id+' 俄语课文不含拉丁字母');
      checkR1Russian(sentence.text,id+' 课文');
    }
    checkR1Vocabulary(id,lesson.reading.sentences,id+' 课文');
  }
});
test('任务 R1：新增 213 个 id 连续，CSV 同步，cards-data 按 id 在旧词之后追加',() => {
  const ids=Array.from({length:213},(_,i)=>'ru-'+String(523+i).padStart(4,'0'));
  assert.deepEqual(r1Rows.map(row=>row.id),ids);
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','ru.csv'),'utf8')));
  assert.deepEqual(csv.filter(row=>R1_LESSONS.includes(row.lesson)),r1Rows);
  assert.deepEqual(csv.map(row=>row.id),Array.from({length:1623},(_,i)=>'ru-'+String(i+1).padStart(4,'0')));
  const previous=initialRows.findIndex(row=>row.id==='es-1313');assert(previous>=0);
  assert.deepEqual(initialRows.slice(previous+1,initialRows.findIndex(row=>row.id==='ru-0735')+1).map(row=>row.id),ids,'新词按原有 id 次序追加');
  const seen=new Set(initialRows.filter(row=>row.lang==='ru' && row.lesson<'ru-13').map(row=>ruDeaccent(row.front)));
  for (const row of r1Rows) {
    const front=ruDeaccent(row.front);assert(!seen.has(front),row.id+' 去 U+0301 后 front 重复：'+row.front);seen.add(front);
  }
});
test('任务 R1：词类配额、名词性和目标格、动词六人称与过去四式、体配对及识别卡',() => {
  const quotas={
    'ru-13':{名词:25,数字:10,不定式:10,句型:5},
    'ru-14':{介词:8,时间方位:15,地点:10,不定式:10,序数词:10,句型:5},
    'ru-15':{不定式:15,名词:15,表达:10,形容词:5,句型:5},
    'ru-16':{副词与无人称表达:15,不定式:10,名词:15,形容词:10,句型:5}
  };
  for (const [id,quota] of Object.entries(quotas)) for (const [tag,count] of Object.entries(quota))
    assert.equal(r1Rows.filter(row=>row.lesson===id && row.tags.split(';').includes(tag)).length,count,id+' '+tag+' 数量');
  const persons=[/^я /,/^ты /,/^он\/она́ /,/^мы /,/^вы /,/^они́ /];
  for (const row of r1Rows) {
    const tags=row.tags.split(';');assert.equal(row.lang,'ru',row.id);
    for (const field of ['front','back','example','example_zh','note','tags']) {
      assert(row[field]?.trim(),row.id+' '+field+' 非空');checkR1Russian(row[field],row.id+' '+field);
    }
    assert.doesNotMatch(row.front,/[A-Za-z]/,row.id+' front 不含拉丁字母');
    assert.match(row.example,/[.?!]$/,row.id+' 例句句尾');assert.match(row.example_zh,/[㐀-鿿]/,row.id+' 中文例句');
    if (tags.includes('名词')) {
      assert.match(row.note,/^名词（[阳阴中复]/,row.id+' 名词标性');
      const cases=row.lesson<='ru-14'?['属格单数','属格复数']:['与格单数',...(row.lesson==='ru-16'?['与格复数']:[])];
      for (const form of cases) assert(new RegExp(form+'：[^；]+').test(row.note),row.id+' '+form);
    }
    if (tags.includes('不定式')) {
      const forms=row.note.match(/六个人称(?:（[^）]+）)?：(.+?)(?=；过去时：)/)?.[1].split('；');
      assert(forms,row.id+' 六个人称');assert.equal(forms.length,6,row.id+' 六个人称完整');
      for (let i=0;i<6;i++) assert.match(forms[i],persons[i],row.id+' 第 '+(i+1)+' 个人称');
      const past=row.note.match(/过去时：([^；]+)/)?.[1].split(' / ');
      assert(past,row.id+' 过去时');assert.equal(past.length,4,row.id+' 过去时四形式');
      assert(past.every(form=>ruWords(form).length>=1),row.id+' 过去时形式非空');
      const pair=row.note.match(/体配对：([^；]+)/)?.[1];
      assert(pair && (ruWords(pair).length>=2 || /(?:没有|无)(?:(?:常用|通用))?(?:对应)?完成体/.test(row.note)),row.id+' 体的配对或无常用完成体的说明');
    }
    if (tags.includes('句型') || tags.includes('表达') || tags.includes('序数词') || /[.?!]$/.test(row.front))
      assert(tags.includes('phrase'),row.id+' 整句、表达及只认的序数词标 phrase');
    const finiteWords=new Set();
    for (const candidate of initialRows.filter(item=>item.lang==='ru' && item.lesson<=row.lesson)) {
      const forms=candidate.note.match(/六个人称(?:（[^）]+）)?：(.+?)(?=；过去时：|$)/)?.[1] || '';
      for (const part of forms.split('；')) for (const word of ruWords(part).slice(part.startsWith('он/')?2:1)) finiteWords.add(word);
    }
    if (ruWords(row.front).length>1 && ruWords(row.front).some(word=>finiteWords.has(word)))
      assert(tags.includes('phrase'),row.id+' 含变位动词的多词短语标 phrase');
    assert.deepEqual(plain(api.expandCards([row]).map(card=>card.direction)),tags.includes('phrase')?['r']:['r','p'],row.id+' 卡片方向');
    checkR1Vocabulary(row.lesson,[{text:row.example}],row.id+' 例句');
  }
});
test('任务 R1：属格复数、介词与时间、两周与格的指定讲解要点完整',() => {
  const required={
    'ru-13':['-ов','-ев','-ей','零词尾','друзей','братьев','детей','нет','много','мало','сколько','несколько','пять книг'],
    'ru-14':['из','с','от','до','у','без','для','после','около','кроме','из китая','с работы','какое число','первое','десятое','每周'],
    'ru-15':['-у','-ю','-е','-и','мне','тебе','ему','ей','нам','вам','им','дать','нравится','лет','надо','нужно','можно','нельзя','不定式'],
    'ru-16':['по телефону','по улице','по вторникам','-ам','-ям','мне холодно','интересно','скучно','与格','宾格']
  };
  for (const [id,items] of Object.entries(required)) {
    const text=ruDeaccent(parseNodes(api.LESSONS[id].explanation()).map(node=>node.textContent).join(' '));
    for (const item of items) assert(text.includes(item),id+' 讲解缺少 '+item);
  }
});
test('任务 R1：八篇阅读的周次、体裁、14–18 句和 100–140 词、四题与已学重点词',() => {
  const fronts=new Map(initialRows.filter(row=>row.lang==='ru').map(row=>[ruDeaccent(row.front),row.lesson]));
  const added=[];
  for (let i=0;i<8;i++) {
    const id='ru-r'+(17+i),item=api.READINGS[id],week=13+Math.floor(i/2);assert(item,id+' 存在');added.push(item);
    assert.equal(item.id,id);assert.equal(item.lang,'ru');assert.equal(item.week,week);assert.equal(item.afterLesson,'ru-'+week);
    assert(item.title?.trim() && /[㐀-鿿]/.test(item.title),id+' 标题');
    assert(READING_GENRES.includes(item.genre),id+' 体裁');
    assert(item.sentences.length>=14 && item.sentences.length<=18,id+' 句数');
    const words=item.sentences.flatMap(sentence=>sentence.text.match(/[\p{L}\p{M}]+/gu) || []);
    assert.equal(item.words,words.length,id+' words 与正文一致');assert(item.words>=100 && item.words<=140,id+' 词数 '+item.words);
    for (const sentence of item.sentences) {
      assert.match(sentence.text,/[.?!]$/,id+' 句尾');assert.match(sentence.zh,/[㐀-鿿]/,id+' 中文');
      assert.doesNotMatch(sentence.text,/[A-Za-z]/,id+' 俄语正文不含拉丁字母');checkR1Russian(sentence.text,id+' 正文');
    }
    assert.equal(item.questions.length,4,id+' 阅读四题');
    for (const question of item.questions) {
      assert(question.prompt?.trim(),id+' 题干');assert(question.options.length>=3,id+' 选项');
      assert(question.options.includes(question.answer),id+' 答案在选项里');
      assert.equal(question.options.length,new Set(question.options).size,id+' 选项不重复');
      for (const text of [question.prompt,...question.options,question.answer]) checkR1Russian(text,id+' 阅读题');
    }
    assert(item.questions.some(question=>/推断|指的是/.test(question.prompt)),id+' 推断或指代题');
    assert.equal(item.keyWords.length,5,id+' 重点词五个');assert.equal(new Set(item.keyWords.map(word=>word.word)).size,5,id+' 重点词不重复');
    for (const word of item.keyWords) {
      const from=fronts.get(ruDeaccent(word.word));assert(from && from<=item.afterLesson,id+' 重点词必须已学：'+word.word);
      assert.match(word.zh,/[㐀-鿿]/,id+' 重点词中文');checkR1Russian(word.word,id+' 重点词');
    }
    assert(item.retell.length>=3 && item.retell.length<=5,id+' 复述三至五条');
    for (const point of item.retell) assert.match(point,/[㐀-鿿]/,id+' 中文复述');
    checkR1Vocabulary(item.afterLesson,item.sentences,id);
  }
  for (let week=13;week<=16;week++) {
    const pair=added.filter(item=>item.week===week);assert.equal(pair.length,2,'第 '+week+' 周两篇');
    assert.notEqual(pair[0].genre,pair[1].genre,'第 '+week+' 周两种体裁');
  }
});
test('任务 R1：词形按已学词卡推导；未学词、未到的课次及自引例句不能通过',() => {
  for (const word of ['книг','друзе́й','бра́тьев','дете́й']) assert(ruKnown('ru-13',word),'第 13 周属格复数：'+word);
  for (const word of ['дру́гу','сестре́','учи́телю']) assert(ruKnown('ru-15',word),'第 15 周单数与格：'+word);
  for (const word of ['друзья́м','бра́тьям','де́тям','учи́телям','вто́рникам']) assert(ruKnown('ru-16',word),'第 16 周复数与格：'+word);
  for (const [lesson,word] of [['ru-12','друзей'],['ru-15','вторникам'],['ru-16','гиппопотам'],['ru-16','книгаов']])
    assert(!ruKnown(lesson,word),lesson+' 应拒绝 '+word);
  // 选取各课首次引入的明确词项；час 在旧词 часы 的 note 中已出现，不适合作反向样本。
  for (const [id,word] of [['ru-13','я́блоко'],['ru-14','апте́ка'],['ru-15','племя́нник'],['ru-16','тропи́нка']]) {
    assert(r1Rows.some(row=>row.lesson===id && row.front===word),id+' 反向样本应为本课词卡');
    assert(!ruKnown('ru-'+String(Number(id.slice(3))-1).padStart(2,'0'),word),id+' 新名词不能提前进入范围');
  }
  const row=r1Rows[0],previous=row.example;
  try { row.example='Гиппопота́м.';assert(!ruKnown('ru-16','гиппопотам'),'新增例句不能给自己放行'); }
  finally { row.example=previous; }
});
test('任务 R1：新课和新阅读 UI 的措辞、时长与逐句中文，只浏览不改进度',() => {
  const {api:a,document}=createAPI(true);a.initialize();const before=plain(a.getData().state);
  for (const id of R1_LESSONS) {
    a.openLesson(id);
    assert.doesNotMatch(document.getElementById('content').textContent.replace(/一封信/g,''),/[死杀封炸战坑砍]/,id+' UI 措辞');
    assert(document.querySelector('.kicker').textContent.includes(a.LESSONS[id].dailyTime),id+' 时长');
  }
  for (let i=17;i<=24;i++) {
    const id='ru-r'+i;a.openReadingItem(id);
    assert.doesNotMatch(document.getElementById('content').textContent.replace(/一封信/g,''),/[死杀封炸战坑砍]/,id+' UI 措辞');
    assert.equal(document.querySelectorAll('[data-question]').length,4,id+' 四题');
    assert.equal(document.querySelectorAll('details').filter(node=>node.querySelector('summary')?.textContent==='查看本句中文').length,a.READINGS[id].sentences.length,id+' 逐句中文');
  }
  assert.deepEqual(plain(a.getData().state),before,'只浏览新内容不写进度');
});

// 任务 R2：建设期第 17–20 周。卡片、课内阅读和阅读线使用同一个词汇范围。
const R2_STANDARD_STRESS={
  тобой:'тобо́й',нами:'на́ми',вами:'ва́ми',ими:'и́ми',ручкой:'ру́чкой',другом:'дру́гом',
  молоком:'молоко́м',заниматься:'занима́ться',интересоваться:'интересова́ться',
  пользоваться:'по́льзоваться',становиться:'станови́ться',работать:'рабо́тать',
  врачом:'врачо́м',перед:'пе́ред',между:'ме́жду',утром:'у́тром',зимой:'зимо́й',
  становишься:'стано́вишься',становится:'стано́вится',становимся:'стано́вимся',
  становитесь:'стано́витесь',кроватью:'крова́тью',летами:'лета́ми'
};
function checkR2Russian(text,label) {
  checkR1Russian(text,label);
  for (const word of text.match(/[А-Яа-яЁё\u0301]+/g) || []) {
    const standard=R2_STANDARD_STRESS[ruDeaccent(word)];
    if (standard) assert.equal(word.toLowerCase(),standard,label+' 标准词形重音：'+word);
  }
}
function ruVocabularyMisses(lesson,sentences,vocabulary=ruVocabulary(lesson)) {
  const unknown=new Map();
  for (const sentence of sentences) for (const word of ruWords(sentence.text))
    if (!vocabulary.has(word) && !unknown.has(word)) unknown.set(word,{sentence:sentence.text,...(sentence.id?{card:sentence.id}:{})});
  return [...unknown].map(([word,location])=>({word,...location}));
}
function checkR2Questions(questions,label) {
  for (const question of questions) {
    assert(question.prompt?.trim(),label+' 题干非空');
    assert.equal(typeof question.answer,'string',label+' 答案是字符串');assert(question.answer.trim(),label+' 答案非空');
    for (const text of [question.prompt,question.answer,...(question.options || [])]) checkR2Russian(text,label+' 题目');
    if (question.options) {
      assert(question.options.length>=3,label+' 至少三个选项');
      assert(question.options.includes(question.answer),label+' 答案在选项里');
      assert.equal(new Set(question.options).size,question.options.length,label+' 选项不重复');
    }
  }
}
test('任务 R2：四课存在、日期、每课 50 条、14–20 句双语课文与 6 加 4 题',() => {
  const dates=['2027 年 01-04 至 01-10','2027 年 01-11 至 01-17','2027 年 01-18 至 01-24','2027 年 01-25 至 01-31'];
  for (const [i,id] of R2_LESSONS.entries()) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 课程存在');
    assert.equal(lesson.lang,'ru',id+' 语言');assert.equal(lesson.week,17+i,id+' 周次');
    assert.equal(lesson.dates,dates[i],id+' 日期');
    assert.equal(r2Rows.filter(row=>row.lesson===id).length,50,id+' 卡片数');
    for (const key of ['name','goal','writingTask']) assert(lesson[key]?.trim(),id+' '+key);
    assert.equal(lesson.dailyTime,'每天 30 分钟 + 周末系统块 60 分钟',id+' 时长');
    assert.match(lesson.writingTask,id==='ru-19'?/100\s*词/:/5\s*句/,id+' 写作篇幅');
    if (id==='ru-19') assert.match(lesson.writingTask,/每个格|六个格/,id+' 六格写作');
    assert.equal(typeof lesson.explanation,'function',id+' 讲解函数');
    const explanation=lesson.explanation(),text=parseNodes(explanation).map(node=>node.textContent).join('').trim();
    assert(text.startsWith('时间分配以复盘结果为准'),id+' 讲解开头');
    assert(explanation.includes('配合教材第二册的对应内容，课次以实际教材为准'),id+' 教材指引');
    assert.doesNotMatch(explanation,/《东方大学俄语[^》]*》第\s*\d+\s*课/,id+' 教材课次');
    assert.doesNotMatch(text.replace(/一封信/g,''),/[死杀封炸战坑砍]/,id+' 讲解措辞');
    checkR2Russian(decode(explanation.replace(/<[^>]*>/g,' ')),id+' 讲解');
    assert(lesson.reading.title?.trim(),id+' 课文标题');
    assert(lesson.reading.sentences.length>=14 && lesson.reading.sentences.length<=20,id+' 课文句数');
    assert.equal(lesson.reading.questions.length,4,id+' 四道阅读题');
    assert(lesson.reading.questions.every(question=>Array.isArray(question.options)),id+' 阅读题都是选择题');
    assert.equal(lesson.exercises.length,10,id+' 十道练习');
    assert.deepEqual(lesson.exercises.slice(6),lesson.reading.questions,id+' 阅读题属于十题');
    assert(lesson.exercises.slice(0,6).filter(exercise=>!exercise.options).length>=4,id+' 语法题以文本题为主');
    checkR2Questions(lesson.exercises,id);
    for (const sentence of lesson.reading.sentences) {
      assert.match(sentence.text,/[.?!]$/,id+' 句尾');assert.match(sentence.zh,/[㐀-鿿]/,id+' 逐句中文');
      assert.doesNotMatch(sentence.text,/[A-Za-z]/,id+' 俄语正文不含拉丁字母');
      checkR2Russian(sentence.text,id+' 课文');
    }
  }
});
test('任务 R2：新增 200 个 id 连续、CSV 与内嵌同步、原有 id 后追加且 front 不重复',() => {
  const expected=Array.from({length:200},(_,i)=>'ru-'+String(736+i).padStart(4,'0'));
  assert.deepEqual(r2Rows.map(row=>row.id),expected);
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','ru.csv'),'utf8')));
  assert.deepEqual(csv.filter(row=>R2_LESSONS.includes(row.lesson)),r2Rows);
  assert.deepEqual(csv.map(row=>row.id),Array.from({length:1623},(_,i)=>'ru-'+String(i+1).padStart(4,'0')));
  const previous=initialRows.findIndex(row=>row.id==='es-1633');assert(previous>=0);
  assert.deepEqual(initialRows.slice(previous+1,initialRows.findIndex(row=>row.id==='ru-0935')+1).map(row=>row.id),expected,'新卡接在原有最后一个 id 之后');
  const seen=new Set(initialRows.filter(row=>row.lang==='ru' && row.lesson<'ru-17').map(row=>ruDeaccent(row.front)));
  for (const row of r2Rows) {
    const front=ruDeaccent(row.front);assert(!seen.has(front),row.id+' 去 U+0301 后 front 重复：'+row.front);seen.add(front);
  }
});
test('任务 R2：词类配额、名词性和目标格、动词六个人称与过去四式、体配对及识别卡',() => {
  const quotas={
    'ru-17':{名词:20,不定式:10,表达:10,形容词:5,句型:5},
    'ru-18':{职业名词:15,方位表达:10,季节与时间:10,不定式:10,句型:5},
    'ru-19':{名词:20,介词搭配:15,不定式:10,句型:5},
    'ru-20':{形容词:25,名词:15,不定式:5,句型:5}
  };
  for (const [id,quota] of Object.entries(quotas)) for (const [tag,count] of Object.entries(quota))
    assert.equal(r2Rows.filter(row=>row.lesson===id && row.tags.split(';').includes(tag)).length,count,id+' '+tag+' 配额');
  const persons=[/^я /,/^ты /,/^он\/она́ /,/^мы /,/^вы /,/^они́ /];
  const finiteByLesson=new Map();
  for (const lesson of R2_LESSONS) {
    const finite=new Set();
    for (const row of initialRows.filter(row=>row.lang==='ru' && row.lesson<=lesson)) {
      const forms=row.note.match(/六个人称(?:（[^）]+）)?：(.+?)(?=；过去时：|$)/)?.[1] || '';
      for (const part of forms.split('；')) for (const word of ruWords(part).slice(part.startsWith('он/')?2:1)) finite.add(word);
      for (const word of ruWords(row.note.match(/过去时：([^；]+)/)?.[1] || '')) finite.add(word);
    }
    finiteByLesson.set(lesson,finite);
  }
  for (const row of r2Rows) {
    const tags=row.tags.split(';');assert.equal(row.lang,'ru',row.id+' 语言');
    for (const field of ['front','back','example','example_zh','note','tags']) {
      assert(row[field]?.trim(),row.id+' '+field+' 非空');checkR2Russian(row[field],row.id+' '+field);
    }
    assert.doesNotMatch(row.front,/[A-Za-z]/,row.id+' front 不含拉丁字母');
    assert.match(row.example,/[.?!]$/,row.id+' 例句句尾');assert.match(row.example_zh,/[㐀-鿿]/,row.id+' 中文例句');
    if (tags.includes('名词') || tags.includes('职业名词')) {
      assert(tags.includes('名词'),row.id+' 名词标签');assert.match(row.note,/^名词（[阳阴中复]/,row.id+' 名词标性');
      const cases={
        'ru-17':['工具格单数'],
        'ru-18':['工具格单数','工具格复数'],
        'ru-19':['主格单数','属格单数','与格单数','宾格单数','工具格单数','前置格单数'],
        'ru-20':['前置格单数','宾格单数','属格单数']
      }[row.lesson];
      for (const form of cases) {
        const listed=row.note.match(new RegExp(form+'(?:（[^）]+）)?：([^；]+)'))?.[1];
        assert(listed && ruWords(listed).length,row.id+' '+form+' 实际词形');
      }
    }
    if (tags.includes('不定式')) {
      const forms=row.note.match(/六个人称(?:（[^）]+）)?：(.+?)(?=；过去时：)/)?.[1].split('；');
      assert(forms,row.id+' 六个人称');assert.equal(forms.length,6,row.id+' 六个人称完整');
      for (let i=0;i<6;i++) {
        assert.match(forms[i],persons[i],row.id+' 第 '+(i+1)+' 个人称');
        assert(ruWords(forms[i]).length>(i===2?2:1),row.id+' 每个人称包含实际动词形式');
      }
      const past=row.note.match(/过去时：([^；]+)/)?.[1].split(' / ');
      assert(past,row.id+' 过去时');assert.equal(past.length,4,row.id+' 过去时四形式');
      assert(past.every(form=>ruWords(form).length>=1),row.id+' 过去时形式非空');
      const pair=row.note.match(/体配对：([^；]+)/)?.[1];
      assert(pair && (ruWords(pair).length>=2 || /(?:没有|无)(?:(?:常用|通用))?(?:对应)?完成体/.test(row.note)),row.id+' 体配对或无常用完成体的说明');
    }
    if (row.lesson==='ru-20' && tags.includes('形容词')) for (const form of ['前置格单数','宾格单数','属格单数']) {
      const listed=row.note.match(new RegExp(form+'(?:（[^）]+）)?：([^；]+)'))?.[1];
      assert(listed && ruWords(listed).length>=(form==='宾格单数'?4:3),row.id+' '+form+' 列阳、阴、中形式，宾格区分阳性有生命与无生命');
    }
    if (tags.some(tag=>['句型','表达','介词搭配'].includes(tag)) || /[.?!]$/.test(row.front) || (ruWords(row.front).length>1 && ruWords(row.front).some(word=>finiteByLesson.get(row.lesson).has(word))))
      assert(tags.includes('phrase'),row.id+' 整句及含变位动词的多词短语标 phrase');
    assert.deepEqual(plain(api.expandCards([row]).map(card=>card.direction)),tags.includes('phrase')?['r']:['r','p'],row.id+' 卡片方向');
  }
});
test('任务 R2：工具格、六格单数总表和形容词三格的指定讲解要点齐全',() => {
  const required={
    'ru-17':['-ом','-ем','-ой','-ей','-ью','мной','тобой','им','ей','нами','вами','ими','писать ручкой','с другом','чай с молоком','заниматься','интересоваться'],
    'ru-18':['быть','стать','работать','врачом','под','над','за','перед','между','-ами','-ями','утром','зимой','六格'],
    'ru-19':['主格','属格','与格','宾格','工具格','前置格','阳','阴','中','软','硬','кто','что','кого','чего','кому','чему','кем','чем','ком','动词','介词','含义'],
    'ru-20':['前置格','宾格','属格','-ом','-ем','-ый','-ого','-ой','-ую','-ей','一致','有生命','拼写']
  };
  for (const [id,items] of Object.entries(required)) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 存在');
    const text=ruDeaccent(parseNodes(lesson.explanation()).map(node=>node.textContent).join(' '));
    for (const item of items) assert(text.includes(item),id+' 讲解缺少 '+item);
    assert.match(lesson.explanation(),/<table\b/,id+' 语法表');
  }
});
test('任务 R2：八篇阅读的周次、体裁、句词范围、四题与五个已学重点词',() => {
  const fronts=new Map(initialRows.filter(row=>row.lang==='ru').map(row=>[ruDeaccent(row.front),row.lesson]));
  const added=[];
  for (let i=0;i<8;i++) {
    const id='ru-r'+(25+i),item=api.READINGS[id],week=17+Math.floor(i/2);assert(item,id+' 存在');added.push(item);
    assert.equal(item.id,id,id+' id');assert.equal(item.lang,'ru',id+' 语言');
    assert.equal(item.week,week,id+' 周次');assert.equal(item.afterLesson,'ru-'+week,id+' 词汇上限');
    assert(item.title?.trim() && /[㐀-鿿]/.test(item.title),id+' 标题');checkR2Russian(item.title,id+' 标题');
    assert(READING_GENRES.includes(item.genre),id+' 体裁');
    const band=week<=18?[14,18,100,140]:[18,22,140,200];
    assert(item.sentences.length>=band[0] && item.sentences.length<=band[1],id+' 句数 '+item.sentences.length);
    const words=item.sentences.flatMap(sentence=>sentence.text.match(/[\p{L}\p{M}]+/gu) || []);
    assert.equal(item.words,words.length,id+' words 与正文一致');
    assert(item.words>=band[2] && item.words<=band[3],id+' 词数 '+item.words);
    for (const sentence of item.sentences) {
      assert.match(sentence.text,/[.?!]$/,id+' 句尾');assert.match(sentence.zh,/[㐀-鿿]/,id+' 中文');
      assert.doesNotMatch(sentence.text,/[A-Za-z]/,id+' 俄语正文不含拉丁字母');checkR2Russian(sentence.text,id+' 正文');
    }
    assert.equal(item.questions.length,4,id+' 阅读四题');
    assert(item.questions.every(question=>Array.isArray(question.options)),id+' 阅读题都是选择题');
    checkR2Questions(item.questions,id);
    assert(item.questions.some(question=>/推断|指的是|指代/.test(question.prompt)),id+' 推断或指代题');
    assert.equal(item.keyWords.length,5,id+' 重点词五个');
    assert.equal(new Set(item.keyWords.map(word=>ruDeaccent(word.word))).size,5,id+' 重点词不重复');
    for (const word of item.keyWords) {
      const from=fronts.get(ruDeaccent(word.word));assert(from && from<=item.afterLesson,id+' 重点词必须已学：'+word.word);
      assert.match(word.zh,/[㐀-鿿]/,id+' 重点词中文');checkR2Russian(word.word,id+' 重点词');
    }
    assert(item.retell.length>=3 && item.retell.length<=5,id+' 复述三至五条');
    for (const point of item.retell) assert.match(point,/[㐀-鿿]/,id+' 中文复述');
  }
  for (let week=17;week<=20;week++) {
    const pair=added.filter(item=>item.week===week);assert.equal(pair.length,2,'第 '+week+' 周两篇');
    assert.notEqual(pair[0].genre,pair[1].genre,'第 '+week+' 周两种体裁');
  }
});
test('任务 R2：新卡例句、四课课文和八篇阅读都执行已学词范围检查',() => {
  for (const lesson of R2_LESSONS) {
    assert(api.LESSONS[lesson],lesson+' 存在');
    const sentences=[...r2Rows.filter(row=>row.lesson===lesson).map(row=>({id:row.id,text:row.example})),...api.LESSONS[lesson].reading.sentences];
    assert.deepEqual(ruVocabularyMisses(lesson,sentences),[],lesson+' 新卡例句与课文词汇范围');
  }
  for (let i=25;i<=32;i++) {
    const id='ru-r'+i,item=api.READINGS[id];assert(item,id+' 存在');
    assert.deepEqual(ruVocabularyMisses(item.afterLesson,item.sentences),[],id+' 阅读线词汇范围');
  }
});
test('任务 R2：工具格和形容词词形只由已学词按课程阶段推导，未学词与例句自引不能通过',() => {
  const noun=front=>initialRows.find(row=>row.lang==='ru' && ruDeaccent(row.front)===front && row.tags.split(';').includes('名词'));
  for (const [base,form] of [['ручка','ручкой'],['друг','другом'],['молоко','молоком'],['дверь','дверью'],['врач','врачом']]) {
    const row=noun(base);assert(row,'推导基词 '+base+' 必须是词卡');
    assert(ruR2Forms(base,row,'ru-17').includes(form),'工具格单数：'+form);
    assert(!ruR2Forms(base,row,'ru-16').includes(form),'第 17 周前不由新规则引入：'+form);
    assert(ruKnown('ru-17',form),'已学单数工具格：'+form);
  }
  for (const [base,form] of [['друг','друзьями'],['ребёнок','детьми'],['учитель','учителями'],['книга','книгами']]) {
    const row=noun(base);assert(row,'推导基词 '+base);
    assert(ruR2Forms(base,row,'ru-18').includes(form),'工具格复数：'+form);
    assert(!ruR2Forms(base,row,'ru-17').includes(form),'第 18 周前不由新规则引入：'+form);
    assert(ruKnown('ru-18',form),'已学复数工具格：'+form);
  }
  for (const [base,forms] of [['новый',['нового','новом','новой','новую']],['синий',['синего','синем','синей','синюю']],['русский',['русского','русском','русской','русскую']]]) {
    const row=initialRows.find(row=>row.lang==='ru' && ruDeaccent(row.front)===base && row.tags.split(';').includes('形容词'));assert(row,'推导基词 '+base);
    for (const form of forms) {
      assert(ruR2Forms(base,row,'ru-20').includes(form),'形容词单数格：'+form);
      assert(!ruR2Forms(base,row,'ru-19').includes(form),'第 20 周前不由新规则引入：'+form);
    }
  }
  for (const word of ['гиппопотам','книгаами','другями','русскего','синого']) assert(!ruKnown('ru-20',word),'未学词或错误词形：'+word);
  const row=r2Rows[0];assert(row,'新卡存在');const previous=row.example;
  try { row.example='Гиппопота́м.';assert(!ruKnown('ru-20','гиппопотам'),'新增例句不能给自身扩充词表'); }
  finally { row.example=previous; }
});
test('任务 R2：新课和新阅读 UI 的措辞、时长、逐句中文，只浏览不写进度',() => {
  const {api:a,document}=createAPI(true);a.initialize();const before=plain(a.getData().state);
  for (const id of R2_LESSONS) {
    assert(a.LESSONS[id],id+' 存在');a.openLesson(id);
    assert.doesNotMatch(document.getElementById('content').textContent.replace(/一封信/g,''),/[死杀封炸战坑砍]/,id+' UI 措辞');
    const title=document.querySelector('.kicker').textContent;
    assert(title.includes(a.LESSONS[id].dailyTime),id+' 时长');
    assert(title.includes(a.LESSONS[id].dates),id+' 完整日期');
    assert.equal((title.match(/2027 年/g) || []).length,1,id+' 年份只显示一次');
    assert.doesNotMatch(title,/2026 年/,id+' 不增加上一年年份');
  }
  for (let i=25;i<=32;i++) {
    const id='ru-r'+i;assert(a.READINGS[id],id+' 存在');a.openReadingItem(id);
    assert.doesNotMatch(document.getElementById('content').textContent.replace(/一封信/g,''),/[死杀封炸战坑砍]/,id+' UI 措辞');
    assert.equal(document.querySelectorAll('[data-question]').length,4,id+' 四题');
    assert.equal(document.querySelectorAll('details').filter(node=>node.querySelector('summary')?.textContent==='查看本句中文').length,a.READINGS[id].sentences.length,id+' 逐句中文');
  }
  // 旧课省略起始年份的日期仍补 2026 年，跨年课同时保留终点年份。
  for (const id of ['ru-01','ru-16']) {
    a.openLesson(id);const title=document.querySelector('.kicker').textContent;
    assert.match(title,/2026 年/,id+' 旧课起始年份');
    if (id==='ru-16') assert.match(title,/2027 年/,id+' 跨年终点');
  }
  assert.deepEqual(plain(a.getData().state),before,'只浏览新内容不写进度');
});

test('任务 S2：新课和新阅读 UI 的措辞、时长、逐句中文，只浏览不写进度',() => {
  const {api:a,document}=createAPI(true);a.initialize();const before=plain(a.getData().state);
  for (const id of S2_LESSONS) {
    assert(a.LESSONS[id],id+' 存在');a.openLesson(id);
    assert.doesNotMatch(document.getElementById('content').textContent.replace(/一封信/g,''),/[死杀封炸战坑砍]/,id+' UI 措辞');
    assert(document.querySelector('.kicker').textContent.includes(a.LESSONS[id].dailyTime),id+' 时长');
  }
  for (let i=31;i<=38;i++) {
    const id='es-r'+i;assert(a.READINGS[id],id+' 存在');a.openReadingItem(id);
    assert.doesNotMatch(document.getElementById('content').textContent.replace(/一封信/g,''),/[死杀封炸战坑砍]/,id+' UI 措辞');
    assert.equal(document.querySelectorAll('[data-question]').length,4,id+' 四题');
    assert.equal(document.querySelectorAll('details').filter(node=>node.querySelector('summary')?.textContent==='查看本句中文').length,a.READINGS[id].sentences.length,id+' 逐句中文');
  }
  assert.deepEqual(plain(a.getData().state),before,'只浏览新内容不写进度');
});

// 任务 S3：第 21–23 周课程、词卡和阅读线，沿用已有词形推导与 UI 夹具。
test('任务 S3：三课日期、80 条词卡、250–350 词双语课文及 6 加 4 题',() => {
  const dates=['2027 年 02-01 至 02-07','2027 年 02-08 至 02-14','2027 年 02-15 至 02-21'];
  const writing=[/80 词/,/5 句/,/100 词/];
  for (const [i,id] of S3_LESSONS.entries()) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 存在');
    assert.equal(lesson.lang,'es');assert.equal(lesson.week,21+i);assert.equal(lesson.dates,dates[i]);
    assert.equal(s3Rows.filter(row=>row.lesson===id).length,80,id+' 词卡数');
    assert.equal(lesson.dailyTime,'每天 25 分钟 + 每周 30 分钟语法与写作');
    assert.match(lesson.writingTask,writing[i]);
    const explanation=lesson.explanation(),nodes=parseNodes(explanation);
    assert(nodes.map(node=>node.textContent).join('').trim().startsWith('时间分配以复盘结果为准'),id+' 讲解首句');
    assert(explanation.includes('配合教材第二册的对应内容，课次以实际教材为准'),id+' 教材指引');
    assert.match(explanation,/<table\b/,id+' 语法对照表');
    const count=lesson.reading.sentences.flatMap(sentence=>esWords(sentence.text)).length;
    assert(count>=250 && count<=350,id+' 课文 '+count+' 词');
    assert.equal(lesson.reading.questions.length,4);assert.equal(lesson.exercises.length,10);
    assert.deepEqual(lesson.exercises.slice(6),lesson.reading.questions);
    lesson.reading.questions.forEach((question,index)=>assert.equal(lesson.exercises[6+index],question,id+' 阅读题复用同一对象'));
    assert(lesson.exercises.slice(0,6).filter(question=>!question.options).length>=4,id+' 语法题以文本题为主');
    for (const question of lesson.exercises) {
      assert(question.prompt?.trim());assert.equal(typeof question.answer,'string');assert(question.answer.trim());
      if (question.options) {
        assert(question.options.includes(question.answer),id+' 答案在选项内');
        assert.equal(new Set(question.options).size,question.options.length);
      }
    }
    for (const sentence of lesson.reading.sentences) {
      assert.match(sentence.text,/[.?!]$/,id+' 句尾');assert.match(sentence.zh,/[㐀-鿿]/,id+' 逐句中文');
      assert.equal(sentence.text,sentence.text.normalize('NFC'));
      if (sentence.text.includes('?')) assert(sentence.text.includes('¿'),id+' 双问号');
    }
  }
});
test('任务 S3：240 个连续 id、CSV 与内嵌同步、按旧末行 id 追加且无新 front 重复',() => {
  const expected=Array.from({length:240},(_,i)=>'es-'+String(1634+i).padStart(4,'0'));
  assert.deepEqual(s3Rows.map(row=>row.id),expected);
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','es.csv'),'utf8')));
  assert.deepEqual(csv.filter(row=>S3_LESSONS.includes(row.lesson)),s3Rows);
  assert.deepEqual(csv.map(row=>row.id),Array.from({length:1993},(_,i)=>'es-'+String(i+1).padStart(4,'0')));
  const previous=initialRows.findIndex(row=>row.id==='ru-0935');assert(previous>=0);
  assert.deepEqual(initialRows.slice(previous+1,initialRows.findIndex(row=>row.id==='es-1873')+1).map(row=>row.id),expected,'cards-data 按 id 在旧末行之后追加');
  const seen=new Set(initialRows.filter(row=>row.lang==='es' && row.lesson<'es-21').map(row=>row.front.normalize('NFC').toLowerCase()));
  for (const row of s3Rows) {
    const key=row.front.normalize('NFC').toLowerCase();assert(!seen.has(key),row.id+' front 重复：'+row.front);seen.add(key);
  }
});
test('任务 S3：类别配额、名词冠词标性、短语识别卡及重音编码',() => {
  const quotas={
    'es-21':{连接词:15,不定式:15,名词:20,形容词:15,句型:5,补充:10},
    'es-22':{动词短语:15,形容词:10,不定式:15,名词:20,副词:10,句型:5,补充:5},
    'es-23':{叙事动词:20,名词:20,时间与顺序:10,间接引语动词:5,句型:5,补充:20}
  };
  const gender={el:'名词（阳）',la:'名词（阴）',los:'名词（阳，复数）',las:'名词（阴，复数）'};
  for (const [id,quota] of Object.entries(quotas)) for (const [category,count] of Object.entries(quota)) {
    const rows=s3Rows.filter(row=>row.lesson===id && row.tags.split(';').includes(category) && (category==='补充' || !row.tags.split(';').includes('补充')));
    assert.equal(rows.length,count,id+' '+category+' 配额');
    if (category==='动词短语' || (id==='es-21' && category==='连接词')) for (const row of rows) assert(row.tags.split(';').includes('phrase'),row.id+' 指定表达只认');
  }
  for (const row of s3Rows) {
    const tags=row.tags.split(';');assert.equal(row.lang,'es');
    for (const field of ['front','back','example','example_zh','note']) {
      assert(row[field]?.trim(),row.id+' '+field+' 非空');
      assert.equal(row[field],row[field].normalize('NFC'),row.id+' '+field+' NFC');
    }
    if (tags.includes('名词')) {
      const article=row.front.match(/^(el|la|los|las) /)?.[1];assert(article,row.id+' 名词冠词');
      assert(row.note.startsWith(gender[article]),row.id+' 名词标性');
    }
    if (tags.includes('句型') || tags.includes('动词短语') || /[.?!]$/.test(row.front)) assert(tags.includes('phrase'),row.id+' 整句和动词短语');
    assert.deepEqual(api.expandCards([row]).map(card=>card.direction),tags.includes('phrase')?['r']:['r','p'],row.id+' 卡片方向');
  }
  for (const front of ['la edición','la muñeca','el síntoma','el músculo','la versión','cronológico']) assert(s3Rows.some(row=>row.front===front),'词卡保留重音或 ñ：'+front);
});
test('任务 S3：动词 note 的六人称、现在时重音及过去完成时不变分词',() => {
  const special={
    concluir:['concluyo','concluyes','concluye','concluimos','concluís','concluyen'],
    demostrar:['demuestro','demuestras','demuestra','demostramos','demostráis','demuestran'],
    doler:['duelo','dueles','duele','dolemos','doléis','duelen'],
    temblar:['tiemblo','tiemblas','tiembla','temblamos','tembláis','tiemblan']
  };
  const endings={ar:['o','as','a','amos','áis','an'],er:['o','es','e','emos','éis','en'],ir:['o','es','e','imos','ís','en']};
  for (const row of s3Rows.filter(row=>row.tags.split(';').includes('不定式'))) {
    const forms=esListedForms(row),reflexive=row.front.endsWith('se'),verb=row.front.replace(/se$/,'');
    const match=verb.match(/^(.*)(ar|er|ir)$/u);assert(match,row.id+' 不定式');
    const [,stem,kind]=match;
    let expected;
    if (row.lesson==='es-23') {
      assert.match(row.note,/过去完成时/);
      const participle=ES_PARTICIPLES[verb] || stem+(kind==='ar'?'ado':'ido');
      expected=['había','habías','había','habíamos','habíais','habían'].map(aux=>aux+' '+participle);
    } else {
      assert.match(row.note,/现在时/);
      expected=special[verb] || endings[kind].map(end=>stem+end);
    }
    if (reflexive) expected=expected.map((form,i)=>['me','te','se','nos','os','se'][i]+' '+form);
    assert(forms.some(parts=>JSON.stringify(parts)===JSON.stringify(expected)),row.id+' 六人称及重音：'+expected.join(' / '));
  }
  for (const word of ['había','habías','habíamos','habíais','habían']) assert(esKnown('es-23',word),'已学助动词 '+word);
  for (const word of ['habia','habias','habiamos','habiais','habian']) assert(!esKnown('es-23',word),'助动词不可省略重音 '+word);
});
test('任务 S3：关系从句、动词短语、过去时叙事与写作要求完整',() => {
  const required={
    'es-21':['que','quien','donde','el que','lo que','cuyo','aunque','sin embargo','además','por lo tanto','en cambio','es decir','por ejemplo','主题句','举例','转折','结论'],
    'es-22':['estar','分词','ser','aburrido','llevar','seguir','acabar de','volver a','empezar a','dejar de','tener que','hay que'],
    'es-23':['había','habías','habíamos','habíais','habían','分词','现在完成时','简单过去时','过去未完成时','过去完成时','dijo que','preguntó si','decir','preguntar','contar','explicar','responder','ya','todavía','antes','después de que']
  };
  for (const [id,items] of Object.entries(required)) for (const item of items) assert(api.LESSONS[id].explanation().toLowerCase().includes(item),id+' 讲解缺 '+item);
  assert.match(api.LESSONS['es-21'].writingTask,/两个关系从句/);assert.match(api.LESSONS['es-21'].writingTask,/三个连接词/);
  assert.match(api.LESSONS['es-23'].writingTask,/三种过去时/);
});
test('任务 S3：新卡例句和三课短文沿用已学词范围；后课词和例句自引仍被拒绝',() => {
  checkReadingVocabulary(S3_LESSONS);
  for (const lesson of S3_LESSONS) checkSentenceVocabulary(lesson,s3Rows.filter(row=>row.lesson===lesson).map(row=>({id:row.id,text:row.example})),lesson+' 卡片例句');
  for (const [lesson,word] of [['es-20','vecindario'],['es-21','músculo'],['es-22','hallazgo'],['es-23','hipopótamo']]) assert(!esKnown(lesson,word),lesson+' 应拒绝 '+word);
  const row=s3Rows[0];assert(row);const original=row.example;
  try {row.example='Hipopótamo.';assert(!esKnown('es-23','hipopótamo'),'新卡例句不扩大词表');}
  finally {row.example=original;}
});
test('任务 S3：六篇阅读按周对应课程、400–450 词、同周体裁不同、四题和五个已学重点词',() => {
  const ids=Array.from({length:6},(_,i)=>'es-r'+(39+i));
  const items=ids.map(id=>api.READINGS[id]);
  for (const [i,id] of ids.entries()) {
    const item=items[i],week=21+Math.floor(i/2);assert(item,id+' 存在');
    assert.equal(item.id,id);assert.equal(item.lang,'es');assert.equal(item.week,week);assert.equal(item.afterLesson,'es-'+week);
    const count=item.sentences.flatMap(sentence=>esWords(sentence.text)).length;
    assert.equal(item.words,count);assert(count>=400 && count<=450,id+' '+count+' 词');
    assert.equal(item.questions.length,4);assert(item.questions.some(question=>/推断|指代|指的是/.test(question.prompt)),id+' 推断或指代题');
    for (const question of item.questions) assert(question.options.includes(question.answer),id+' 答案在选项里');
    assert.equal(item.keyWords.length,5);assert.equal(new Set(item.keyWords.map(word=>word.word)).size,5);
    for (const word of item.keyWords) assert(initialRows.some(row=>row.lang==='es' && row.lesson<=item.afterLesson && row.front===word.word),id+' 重点词 '+word.word);
    assert(item.retell.length>=3 && item.retell.length<=5);
    checkSentenceVocabulary(item.afterLesson,item.sentences,id);
  }
  for (let i=0;i<6;i+=2) assert.notEqual(items[i].genre,items[i+1].genre,'第 '+items[i].week+' 周体裁不同');
});
test('任务 S3：新内容 UI 措辞、时长和逐句中文，只浏览不改进度',() => {
  const {api:a,document}=createAPI(true);a.initialize();const before=plain(a.getData().state);
  for (const id of S3_LESSONS) {
    a.openLesson(id);
    assert.doesNotMatch(document.getElementById('content').textContent.replace(/一封信/g,''),/[死杀封炸战坑砍]/,id+' UI 措辞');
    assert(document.querySelector('.kicker').textContent.includes(a.LESSONS[id].dailyTime));
  }
  for (let i=39;i<=44;i++) {
    const id='es-r'+i;a.openReadingItem(id);
    assert.doesNotMatch(document.getElementById('content').textContent.replace(/一封信/g,''),/[死杀封炸战坑砍]/,id+' UI 措辞');
    assert.equal(document.querySelectorAll('[data-question]').length,4);
    assert.equal(document.querySelectorAll('details').filter(node=>node.querySelector('summary')?.textContent==='查看本句中文').length,a.READINGS[id].sentences.length);
  }
  assert.deepEqual(plain(a.getData().state),before,'只浏览新内容不写进度');
});

// 任务 R3：第 21–24 周。追加边界只检查 id 顺序，不固定旧内容字节或哈希。
const R3_STANDARD_STRESS={
  моего:'моего́',моему:'моему́',моим:'мои́м',моей:'мое́й',мою:'мою́',мои:'мои́',моих:'мои́х',моими:'мои́ми',
  твоего:'твоего́',твоему:'твоему́',твоим:'твои́м',твоей:'твое́й',твою:'твою́',твои:'твои́',твоих:'твои́х',твоими:'твои́ми',
  этого:'э́того',этому:'э́тому',этим:'э́тим',этом:'э́том',этих:'э́тих',этими:'э́тими',
  который:'кото́рый',которого:'кото́рого',которому:'кото́рому',которым:'кото́рым',которыми:'кото́рыми',
  люди:'лю́ди',людей:'люде́й',людям:'лю́дям',людьми:'людьми́',дети:'де́ти',детям:'де́тям',детьми:'детьми́',
  друзья:'друзья́',друзьям:'друзья́м',друзьями:'друзья́ми',братья:'бра́тья',братьям:'бра́тьям',братьями:'бра́тьями',
  сыновья:'сыновья́',сыновей:'сынове́й',сыновьям:'сыновья́м',сыновьями:'сыновья́ми',
  дочери:'до́чери',дочерей:'дочере́й',дочерям:'дочеря́м',дочерях:'дочеря́х',дочерьми:'дочерьми́',дочерями:'дочеря́ми',
  домах:'дома́х',гостей:'госте́й',гостям:'гостя́м',гостями:'гостя́ми',гостях:'гостя́х',
  прочитал:'прочита́л',написал:'написа́л',сделал:'сде́лал',купил:'купи́л',сказал:'сказа́л',посмотрел:'посмотре́л',выучил:'вы́учил',решил:'реши́л'
};
function checkR3Russian(text,label) {
  checkR2Russian(text,label);
  for (const match of text.matchAll(/[А-Яа-яЁё\u0301]+/g)) {
    const word=match[0],base=ruDeaccent(word);
    // 表观点的 по-мо́ему 与代词与格 моему́ 重音不同，按连字符区分。
    const opinion=base==='моему' && /(?:^|[^а-яё])по-$/i.test(text.slice(0,match.index));
    const standard=opinion?'мо́ему':R3_STANDARD_STRESS[base];
    if (standard) assert.equal(word.toLowerCase(),standard,label+' 标准重音：'+word);
  }
}
function checkR3Text(value,label) {
  if (typeof value==='string') {
    checkR3Russian(value,label);
    assert.doesNotMatch(value.replace(/一封信/g,''),/[死杀封炸战坑砍]/,label+' 措辞');
  } else if (Array.isArray(value)) value.forEach((item,i)=>checkR3Text(item,label+' '+i));
  else if (value && typeof value==='object') for (const [key,item] of Object.entries(value)) checkR3Text(item,label+' '+key);
}
test('任务 R3：四课日期、201 条卡片、双语课文及 6 加 4 题',() => {
  const dates=['2027 年 02-01 至 02-07','2027 年 02-08 至 02-14','2027 年 02-15 至 02-21','2027 年 02-22 至 02-28'];
  for (const [i,id] of R3_LESSONS.entries()) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 存在');
    assert.equal(lesson.lang,'ru');assert.equal(lesson.week,21+i);assert.equal(lesson.dates,dates[i]);
    assert.equal(r3Rows.filter(row=>row.lesson===id).length,i===0?51:50,id+' 卡片数');
    for (const field of ['name','goal','writingTask']) assert(lesson[field]?.trim(),id+' '+field);
    assert.equal(lesson.dailyTime,'每天 30 分钟 + 周末系统块 60 分钟');
    assert.match(lesson.writingTask,id==='ru-23'?/100\s*词/:/5\s*句/);
    assert.equal(typeof lesson.explanation,'function');
    const explanation=lesson.explanation(),text=parseNodes(explanation).map(node=>node.textContent).join('').trim();
    assert(text.startsWith('时间分配以复盘结果为准'),id+' 开头');
    assert(explanation.includes('配合教材第二册的对应内容，课次以实际教材为准'),id+' 教材');
    checkR3Text({...lesson,explanation:decode(explanation.replace(/<[^>]*>/g,' '))},id);
    assert(lesson.reading.title?.trim());
    assert(lesson.reading.sentences.length>=14 && lesson.reading.sentences.length<=20,id+' 14–20 句');
    for (const sentence of lesson.reading.sentences) {
      assert.match(sentence.text,/[.?!][»”"]?$/);assert.match(sentence.zh,/[㐀-鿿]/);
      assert.doesNotMatch(sentence.text,/[A-Za-z]/);
    }
    assert.equal(lesson.reading.questions.length,4);assert(lesson.reading.questions.every(q=>Array.isArray(q.options)));
    assert.equal(lesson.exercises.length,10);assert.deepEqual(lesson.exercises.slice(6),lesson.reading.questions);
    assert(lesson.reading.questions.every((question,i)=>lesson.exercises[i+6]===question),id+' 阅读题共用对象，避免 UI 重复显示');
    assert(lesson.exercises.slice(0,6).filter(q=>!q.options).length>=4);
    checkR2Questions(lesson.exercises,id);
  }
});
test('任务 R3：指定代词、单复数六格总表和八组动词体讲解完整',() => {
  const required={
    'ru-21':['与格','工具格','мой','твой','наш','ваш','э́тот','тот','кото́рый','како́й','тако́й','моему́','мои́м','кото́рому','кото́рым'],
    'ru-22':['主格','宾格','属格','前置格','-ах','-ях','но́вые','си́ние','有生命复数宾格等于复数属格'],
    'ru-23':['-ам','-ям','-ами','-ями','单复数六格总表','代词复数全表','лю́ди','де́ти','друзья́','бра́тья','сыновья́','дочь','дочеря́м','дочерьми́'],
    'ru-24':['过程','重复','结果','前缀','后缀','未完成体不等于','过去时不按六个人称','чита́ть / прочита́ть','писа́ть / написа́ть','де́лать / сде́лать','покупа́ть / купи́ть','говори́ть / сказа́ть','смотре́ть / посмотре́ть','учи́ть / вы́учить','реша́ть / реши́ть']
  };
  for (const [id,parts] of Object.entries(required)) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 存在');const text=parseNodes(lesson.explanation()).map(node=>node.textContent).join('');
    for (const part of parts) assert(text.toLowerCase().includes(part.toLowerCase()),id+' 讲解要点：'+part);
  }
});
test('任务 R3：id ru-0936 至 ru-1136 连续、CSV 同步且在既有 id 之后追加',() => {
  const ids=Array.from({length:201},(_,i)=>'ru-'+String(936+i).padStart(4,'0'));
  assert.deepEqual(r3Rows.map(row=>row.id),ids);
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','ru.csv'),'utf8')));
  assert.deepEqual(csv.filter(row=>R3_LESSONS.includes(row.lesson)),r3Rows);
  assert.deepEqual(csv.map(row=>row.id),Array.from({length:1623},(_,i)=>'ru-'+String(i+1).padStart(4,'0')));
  const previous=initialRows.findIndex(row=>row.id==='es-1873');assert(previous>=0);
  assert.deepEqual(initialRows.slice(previous+1,initialRows.findIndex(row=>row.id==='ru-1136')+1).map(row=>row.id),ids);
  const seen=new Set(initialRows.filter(row=>row.lang==='ru' && row.lesson<'ru-21').map(row=>ruDeaccent(row.front)));
  for (const row of r3Rows) {
    const key=ruDeaccent(row.front);assert(!seen.has(key),row.id+' 重复 front');seen.add(key);
  }
});
test('任务 R3：类别配额、名词标性及目标格、动词六人称与体配对、短语仅识别',() => {
  const quotas={
    'ru-21':{代词表:6,形容词:15,名词:15,不定式:10,句型:5},
    'ru-22':{名词:20,形容词:10,不定式:10,句型:5,量词:5},
    'ru-23':{名词:20,形容词:10,不定式:10,句型:5,表达:5},
    'ru-24':{不定式:25,名词:15,副词:5,句型:5}
  };
  for (const [id,quota] of Object.entries(quotas)) for (const [tag,count] of Object.entries(quota))
    assert.equal(r3Rows.filter(row=>row.lesson===id && row.tags.split(';').includes(tag)).length,count,id+' '+tag);
  const persons=[/^я /,/^ты /,/^он\/она́ /,/^мы /,/^вы /,/^они́ /];
  const finite=new Set();
  for (const row of initialRows.filter(row=>row.lang==='ru')) {
    for (const part of row.note.match(/六个人称(?:（[^）]+）)?：(.+?)(?=；过去时|；未完成体过去时|$)/)?.[1]?.split('；') || [])
      ruWords(part).slice(part.startsWith('он/')?2:1).forEach(word=>finite.add(word));
    for (const match of row.note.matchAll(/(?:过去时|过去时四形式)：([^；]+)/g)) ruWords(match[1]).forEach(word=>finite.add(word));
  }
  for (const row of r3Rows) {
    checkR3Text(row,row.id);const tags=row.tags.split(';');
    if (tags.includes('代词表')) for (const name of ['主格','属格','与格','宾格','工具格','前置格']) {
      const forms=row.note.match(new RegExp(name+'单数：([^；]+)'))?.[1];
      assert(forms && forms.split(' / ').length===3,row.id+' '+name+' 三性单数');
    }
    if (tags.includes('形容词')) {
      const names=row.lesson==='ru-21'?['与格单数','工具格单数']:row.lesson==='ru-22'?['主格复数','宾格复数','属格复数','前置格复数']:['主格复数','宾格复数','属格复数','前置格复数','与格复数','工具格复数'];
      for (const name of names) assert(ruWords(row.note.match(new RegExp(name+'(?:（[^）]*）)?：([^；]+)'))?.[1] || '').length,row.id+' '+name+' 实际词形');
    }
    if (row.note.startsWith('名词')) assert.match(row.note,/^名词（[阳阴中]/,row.id+' 名词性别含名词性量词');
    for (const field of ['front','back','example','example_zh','note','tags']) assert(row[field]?.trim(),row.id+' '+field);
    assert.match(row.example,/[.?!][»”"]?$/);assert.match(row.example_zh,/[㐀-鿿]/);assert.doesNotMatch(row.front,/[A-Za-z]/);
    if (tags.includes('名词')) {
      assert.match(row.note,/^名词（[阳阴中]/,row.id+' 标性');
      const targets=row.lesson==='ru-21'?['与格单数','工具格单数']:row.lesson==='ru-22'?['主格复数','宾格复数','属格复数','前置格复数']:row.lesson==='ru-23'?['与格复数','工具格复数']:[];
      for (const target of targets) {
        const reversed=target.endsWith('复数')?'复数'+target.slice(0,-2):target;
        assert(ruWords(row.note.match(new RegExp('(?:'+target+'|'+reversed+')(?:（[^）]*）)?：([^；]+)'))?.[1] || '').length,row.id+' '+target);
      }
    }
    if (tags.includes('不定式')) {
      const forms=row.note.match(/六个人称(?:（[^）]+）)?：(.+?)(?=；过去时|；未完成体过去时|$)/)?.[1]?.split('；');
      assert(forms,row.id+' 六人称');assert.equal(forms.length,6,row.id+' 六人称');
      forms.forEach((form,i)=>{assert.match(form,persons[i]);assert(ruWords(form).length>(i===2?2:1));});
      assert(ruWords(row.note.match(/体配对：([^；]+)/)?.[1] || '').length>=2,row.id+' 体配对');
      const past=[...row.note.matchAll(/(?:过去时|过去时四形式)：([^；]+)/g)].map(match=>match[1].split(' / '));
      assert(past.length>=1,row.id+' 过去时');past.forEach(forms=>assert.equal(forms.length,4,row.id+' 四式'));
      if (row.lesson==='ru-24') {
        assert.match(row.note,/未完成体/);assert(past.length>=2,row.id+' 两种体的过去时');
        assert(/(?:ть|ться)$/.test(ruDeaccent(row.front)),row.id+' 不定式 front');
      }
    }
    const words=ruWords(row.front);
    if (tags.some(tag=>['句型','代词表'].includes(tag)) || row.lesson==='ru-23' && tags.includes('表达') || /[.?!][»”"]?$/.test(row.front) || words.length>1 && words.some(word=>finite.has(word)))
      assert(tags.includes('phrase'),row.id+' phrase');
    if (tags.includes('phrase')) assert.deepEqual(plain(api.expandCards([row]).map(card=>card.direction)),['r']);
  }
});
test('任务 R3：八篇阅读周次、体裁、18–22 句及 140–200 词、理解题和重点词',() => {
  const genres=['对话','日记','邮件','短故事','描写','通知或广告','菜谱或日程','人物介绍','简单新闻'];
  const fronts=new Map(initialRows.filter(row=>row.lang==='ru').map(row=>[ruDeaccent(row.front),row.lesson]));
  const added=[];
  for (let i=0;i<8;i++) {
    const id='ru-r'+(33+i),item=api.READINGS[id],week=21+Math.floor(i/2);assert(item,id+' 存在');added.push(item);
    assert.equal(item.id,id);assert.equal(item.lang,'ru');assert.equal(item.week,week);assert.equal(item.afterLesson,'ru-'+week);
    assert.match(item.title,/[㐀-鿿]/);assert(genres.includes(item.genre));checkR3Text(item,id);
    assert(item.sentences.length>=18 && item.sentences.length<=22,id+' 18–22 句');
    const words=item.sentences.flatMap(s=>s.text.match(/[\p{L}\p{M}]+/gu) || []).length;
    assert.equal(item.words,words,id+' 实际词数');assert(words>=140 && words<=200,id+' 140–200 词：'+words);
    for (const sentence of item.sentences) { assert.match(sentence.text,/[.?!][»”"]?$/);assert.match(sentence.zh,/[㐀-鿿]/);assert.doesNotMatch(sentence.text,/[A-Za-z]/); }
    assert.equal(item.questions.length,4);assert(item.questions.every(q=>Array.isArray(q.options)));checkR2Questions(item.questions,id);
    assert(item.questions.some(q=>/推断|指代|指的是/.test(q.prompt)),id+' 推断或指代题');
    assert.equal(item.keyWords.length,5);assert.equal(new Set(item.keyWords.map(word=>ruDeaccent(word.word))).size,5);
    for (const word of item.keyWords) { const from=fronts.get(ruDeaccent(word.word));assert(from && from<=item.afterLesson,id+' 重点词：'+word.word);assert.match(word.zh,/[㐀-鿿]/); }
    assert(item.retell.length>=3 && item.retell.length<=5);item.retell.forEach(point=>assert.match(point,/[㐀-鿿]/));
  }
  for (let i=0;i<8;i+=2) assert.notEqual(added[i].genre,added[i+1].genre,'同周体裁不同');
  for (let week=21;week<=24;week++) assert.equal(Object.values(api.READINGS).filter(item=>item.lang==='ru' && item.week===week).length,2);
});
test('任务 R3：新卡例句、四课课文和八篇阅读沿用推导式词汇范围检查',() => {
  for (const id of R3_LESSONS) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 存在');
    const sentences=[...r3Rows.filter(row=>row.lesson===id).map(row=>({text:row.example,id:row.id})),...lesson.reading.sentences];
    assert.deepEqual(ruVocabularyMisses(id,sentences),[],id+' 例句与课文未学词');
  }
  for (let i=33;i<=40;i++) { const item=api.READINGS['ru-r'+i];assert(item);assert.deepEqual(ruVocabularyMisses(item.afterLesson,item.sentences),[],item.id+' 未学词'); }
});
test('任务 R3：新词形由已学词推导，未学词及自引例句不能通过',() => {
  const row=front=>initialRows.find(row=>row.lang==='ru' && ruDeaccent(row.front)===front) || initialRows.find(row=>row.lang==='ru' && row.tags.split(';').some(tag=>['代词','指示词','疑问词','物主词'].includes(tag)) && ruWords(row.front).includes(front));
  for (const [base,form,week] of [['новый','новому',21],['новый','новыми',23],['мой','моему',21],['книга','книгах',22],['сын','сыновьями',23],['читать','прочитала',24]]) {
    const source=row(base);assert(source,base+' 已有词卡');
    assert(ruR3Forms(base,source,'ru-'+week).includes(form),base+' 推导 '+form);
    assert(!ruR3Forms(base,source,'ru-'+(week-1)).includes(form),form+' 课次限制');
  }
  const first=r3Rows.find(row=>row.lesson==='ru-22' && row.tags.split(';').includes('名词'));assert(first);
  assert(!ruKnown('ru-21',first.front),'后续课程新词不得提前通过');assert(!ruKnown('ru-24','гиппопота́м'),'未学词');
  for (const [base,invalid] of [['мочь','можут'],['хотеть','хочут']]) assert(!ruR3Forms(base,row(base),'ru-24').includes(invalid),'不规则动词不能套常规推导：'+invalid);
  const previous=first.example;
  try { first.example='Гиппопота́м.';assert(!ruKnown('ru-24','гиппопота́м'),'新例句不能扩充自身词汇范围'); }
  finally { first.example=previous; }
});
test('任务 R3：新课程和阅读 UI 可显示，浏览不改变进度',() => {
  const {api:a,document}=createAPI(true);a.initialize();const before=plain(a.getData().state);
  for (const id of R3_LESSONS) {
    a.openLesson(id);const page=document.getElementById('content').textContent;
    assert(page.includes(a.LESSONS[id].name));assert(page.includes(a.LESSONS[id].dailyTime));
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);
    assert.doesNotMatch(page.replace(/一封信/g,''),/[死杀封炸战坑砍]/);
  }
  for (let i=33;i<=40;i++) {
    const id='ru-r'+i;a.openReadingItem(id);assert(document.getElementById('content').textContent.includes(a.READINGS[id].title));
    assert.equal(document.querySelectorAll('details').filter(node=>node.querySelector('summary')?.textContent==='查看本句中文').length,a.READINGS[id].sentences.length);
  }
  assert.deepEqual(plain(a.getData().state),before);
});

// 任务 S4：第 24–25 周，复用已有词形推导与 UI 夹具。
test('任务 S4：两课日期、80 与 40 条词卡、250–350 词课文及 6 加 4 题',() => {
  const dates=['2027 年 02-22 至 02-28','2027 年 03-01 至 03-07'];
  for (const [i,id] of S4_LESSONS.entries()) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 课程存在');
    assert.equal(lesson.lang,'es');assert.equal(lesson.week,24+i);assert.equal(lesson.dates,dates[i]);
    assert.equal(s4Rows.filter(row=>row.lesson===id).length,i===0?80:40,id+' 词卡数');
    for (const field of ['name','goal','writingTask']) assert(lesson[field]?.trim(),id+' '+field);
    assert.equal(lesson.dailyTime,'每天 25 分钟 + 每周 30 分钟语法与写作');
    const explanation=lesson.explanation(),text=parseNodes(explanation).map(node=>node.textContent).join('').trim();
    assert(text.startsWith('时间分配以复盘结果为准'),id+' 开头时间提示');
    assert(explanation.includes('配合教材第二册的对应内容，课次以实际教材为准'),id+' 教材指引');
    assert(lesson.reading.title?.trim());
    const count=lesson.reading.sentences.flatMap(sentence=>esWords(sentence.text)).length;
    assert(count>=250 && count<=350,id+' 课文 '+count+' 词');
    for (const sentence of lesson.reading.sentences) {
      assert.match(sentence.text,/[.?!]$/,id+' 句尾');assert.match(sentence.zh,/[㐀-鿿]/,id+' 逐句中文');
      assert.equal(sentence.text,sentence.text.normalize('NFC'),id+' 重音编码');
      if (sentence.text.includes('?')) assert(sentence.text.includes('¿'),id+' 双问号');
    }
    assert.equal(lesson.reading.questions.length,4);assert.equal(lesson.exercises.length,10);
    assert.deepEqual(lesson.exercises.slice(6),lesson.reading.questions);
    assert(lesson.reading.questions.every((question,index)=>lesson.exercises[index+6]===question),id+' 阅读题共用对象');
    assert(lesson.exercises.slice(0,6).filter(question=>!question.options).length>=4,id+' 语法题以文本题为主');
    for (const question of lesson.exercises) {
      assert(question.prompt?.trim());assert.equal(typeof question.answer,'string');assert(question.answer.trim());
      if (question.options) {assert(question.options.includes(question.answer),id+' 答案在选项里');assert.equal(new Set(question.options).size,question.options.length);}
    }
    assert(lesson.reading.questions.every(question=>Array.isArray(question.options)),id+' 阅读四题均为选择题');
  }
});
test('任务 S4：120 个连续 id、CSV 同步、按既有 id 末尾追加且 front 无新重复',() => {
  const ids=Array.from({length:120},(_,i)=>'es-'+String(1874+i).padStart(4,'0'));
  assert.deepEqual(s4Rows.map(row=>row.id),ids);
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','es.csv'),'utf8')));
  assert.deepEqual(csv.filter(row=>S4_LESSONS.includes(row.lesson)),s4Rows);
  assert.deepEqual(csv.map(row=>row.id),Array.from({length:1993},(_,i)=>'es-'+String(i+1).padStart(4,'0')));
  const previous=initialRows.findIndex(row=>row.id==='ru-1136');assert(previous>=0);
  assert.deepEqual(initialRows.slice(previous+1,initialRows.findIndex(row=>row.id==='es-1993')+1).map(row=>row.id),ids,'新词卡在旧末行之后追加');
  const seen=new Set(initialRows.filter(row=>row.lang==='es' && row.lesson<'es-24').map(row=>row.front.normalize('NFC').toLowerCase()));
  for (const row of s4Rows) {const key=row.front.normalize('NFC').toLowerCase();assert(!seen.has(key),row.id+' 重复 front：'+row.front);seen.add(key);}
});
test('任务 S4：类别配额、名词冠词标性、phrase 方向与西语重音',() => {
  const quotas={
    'es-24':{形容词:25,数量与程度:10,观点表达:10,名词:15,不定式:10,句型:5,补充:5},
    'es-25':{同源学习:30,句型:5,连接词:5}
  };
  for (const [id,quota] of Object.entries(quotas)) for (const [tag,count] of Object.entries(quota))
    assert.equal(s4Rows.filter(row=>row.lesson===id && row.tags.split(';').includes(tag)).length,count,id+' '+tag+' 配额');
  const gender={el:'名词（阳）',la:'名词（阴）',los:'名词（阳，复数）',las:'名词（阴，复数）'};
  for (const row of s4Rows) {
    const tags=row.tags.split(';');assert.equal(row.lang,'es');
    for (const field of ['front','back','example','example_zh','note']) {
      assert(row[field]?.trim(),row.id+' '+field+' 非空');assert.equal(row[field],row[field].normalize('NFC'),row.id+' '+field+' NFC');
    }
    if (tags.includes('名词')) {
      const article=row.front.match(/^(el|la|los|las) /)?.[1];assert(article,row.id+' 名词冠词');assert(row.note.startsWith(gender[article]),row.id+' 名词标性');
    }
    if (tags.some(tag=>['句型','观点表达'].includes(tag)) || /[.?!]$/.test(row.front)) assert(tags.includes('phrase'),row.id+' 整句和观点表达只认');
    assert.deepEqual(plain(api.expandCards([row]).map(card=>card.direction)),tags.includes('phrase')?['r']:['r','p'],row.id+' 卡片方向');
  }
  for (const [id,count] of [['es-24',145],['es-25',75]]) assert.equal(api.expandCards(s4Rows.filter(row=>row.lesson===id)).length,count,id+' 生成卡数');
  assert.equal(s4Expanded,220);
  for (const front of ['muchísimo','poquísimo','sonreír','el carácter','la síntesis','el análisis','la acentuación','la ortografía'])
    assert(s4Rows.some(row=>row.front===front),'重音词条：'+front);
  const reviewRows=s4Rows.filter(row=>row.lesson==='es-25');
  assert(reviewRows.every(row=>row.tags.split(';').some(tag=>['同源学习','句型','连接词'].includes(tag))),'复习课词卡只含同源学习词、旧句型和连接词');
  assert.equal(reviewRows.filter(row=>row.tags.split(';').includes('同源学习') && row.tags.split(';').includes('名词')).length,30);
  assert(!reviewRows.some(row=>row.tags.split(';').some(tag=>['不定式','动词','新语法'].includes(tag))),'复习课不添加新动词或新语法词卡');
});
test('任务 S4：十个现在时动词 note 列六人称，sonreír 的重音与词干正确',() => {
  const special={sonreír:['sonrío','sonríes','sonríe','sonreímos','sonreís','sonríen']};
  const endings={ar:['o','as','a','amos','áis','an'],er:['o','es','e','emos','éis','en'],ir:['o','es','e','imos','ís','en']};
  const finite=new Set();
  for (const row of s4Rows.filter(row=>row.tags.split(';').includes('不定式'))) {
    assert.match(row.note,/现在时/);const match=row.front.match(/^(.*)(ar|er|[ií]r)$/u);assert(match,row.id+' 不定式');
    const [,stem,kind]=match,expected=special[row.front] || endings[kind.replace('í','i')].map(end=>stem+end);
    assert(esListedForms(row).some(forms=>JSON.stringify(forms)===JSON.stringify(expected)),row.id+' 六人称及重音：'+expected.join(' / '));
    expected.forEach(form=>finite.add(form));
  }
  for (const row of initialRows.filter(row=>row.lang==='es' && row.tags.split(';').some(tag=>['动词','不定式'].includes(tag))))
    for (const forms of esListedForms(row)) for (const form of forms) if (esWords(form).length===1) finite.add(form);
  for (const row of s4Rows) if (esWords(row.front).length>1 && esWords(row.front).some(word=>finite.has(word)))
    assert(row.tags.split(';').includes('phrase'),row.id+' 含变位动词的多词短语只认');
});
test('任务 S4：描述与观点、邮件格式、十二周复习表、自测和 B1 预告完整',() => {
  const required={
    'es-24':['-ísimo','demasiado','bastante','cada','ambos','varios','不定代词','-mente','外貌','性格','creo que','en mi opinión','me parece que','estoy de acuerdo','称呼','结尾'],
    'es-25':['DELE A2','阅读','写作','阅读复述','150 词','阶段复盘','B1','虚拟式过去时','复合时态','间接引语','条件式对过去的推测','继续进行的动作']
  };
  for (const [id,parts] of Object.entries(required)) {const lesson=api.LESSONS[id];assert(lesson);for (const part of parts) assert(lesson.explanation().toLowerCase().includes(part.toLowerCase()),id+' 讲解要点：'+part);}
  assert.match(api.LESSONS['es-24'].writingTask,/100\s*词/);assert.match(api.LESSONS['es-24'].writingTask,/邮件/);
  assert.match(api.LESSONS['es-25'].writingTask,/限时/);assert.match(api.LESSONS['es-25'].writingTask,/150\s*词/);assert.match(api.LESSONS['es-25'].writingTask,/复盘表/);
  const tables=parseNodes(api.LESSONS['es-25'].explanation()).flatMap(node=>node instanceof ElementModel?[...(node.tag==='table'?[node]:[]),...node.querySelectorAll('table')]:[]);
  const review=tables.find(table=>table.querySelectorAll('tr').filter(row=>row.querySelectorAll('td').length>=4).length>=12);assert(review,'第 13–24 周语法复习表');
  const rows=review.querySelectorAll('tr').filter(row=>row.querySelectorAll('td').length>=4);
  for (let week=13;week<=24;week++) {
    const row=rows.find(row=>new RegExp('(?:^|\\D)'+week+'(?:\\D|$)').test(row.querySelectorAll('td')[0].textContent));assert(row,'第 '+week+' 周复习行');
    const cells=row.querySelectorAll('td');assert(cells.filter(cell=>/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(cell.textContent)).length>=2,'第 '+week+' 周两个例句');
    assert(row.textContent.match(/[.?!]/g)?.length>=2,'第 '+week+' 周两个完整例句');
    assert(cells.at(-1).textContent.trim(),'第 '+week+' 周常见错误');
  }
});
test('任务 S4：-ísimo 与 -mente 只从已学形容词推导，并保留课次与重音限制',() => {
  const adjective={id:'fixture-adjective',lesson:'es-02',front:'rápido',tags:'形容词'};
  assert.deepEqual(esAdjectiveDerivations(adjective,'es-23'),[],'第 24 周前不新增派生范围');
  assert(esAdjectiveDerivations(adjective,'es-24').includes('rápidamente'));
  assert(esAdjectiveDerivations(adjective,'es-24').includes('rapidísimas'));
  assert(!esAdjectiveDerivations(adjective,'es-24').includes('rapidamente'),'副词保留原形容词重音');
  for (const [front,expected] of [['rico','riquísimo'],['largo','larguísimo'],['feliz','felicísimo'],['amable','amabilísimo'],['joven','jovencísimo']])
    assert(esAdjectiveDerivations({...adjective,front},'es-24').includes(expected),front+' → '+expected);
  assert.deepEqual(esAdjectiveDerivations({...adjective,lesson:'es-25'},'es-24'),[],'后课形容词不能提前推导');
  assert.deepEqual(esAdjectiveDerivations({...adjective,tags:'名词'},'es-24'),[],'不从名词推导形容词派生');
  assert(esVocabulary('es-24').has('caracteres'),'carácter 复数改变重音位置');
  for (const word of ['síntesis','análisis']) assert(esVocabulary('es-25').has(word),word+' 单复数同形');
  for (const word of ['hipopótamo','hipopotamísimo','hipopotamamente','rapidisimo']) assert(!esKnown('es-25',word),'未学词或缺重音：'+word);
  const later=s4Rows.find(row=>row.lesson==='es-25' && row.tags.split(';').includes('名词'));assert(later);
  assert(!esKnown('es-24',later.front.replace(/^(?:el|la|los|las) /,'')),'第 25 周新词不能提前通过');
  const first=s4Rows[0];assert(first);const original=first.example;
  try {first.example='Hipopótamo.';assert(!esKnown('es-25','hipopótamo'),'新卡例句不扩大词表');} finally {first.example=original;}
});
test('任务 S4：新卡例句与两课课文沿用已有词汇范围检查',() => {
  checkReadingVocabulary(S4_LESSONS);
  for (const id of S4_LESSONS) checkSentenceVocabulary(id,s4Rows.filter(row=>row.lesson===id).map(row=>({id:row.id,text:row.example})),id+' 新卡例句');
});
test('任务 S4：四篇阅读周次、400–450 词、体裁轮换、四题与五个已学重点词',() => {
  const items=[];
  for (let i=0;i<4;i++) {
    const id='es-r'+(45+i),item=api.READINGS[id],week=24+Math.floor(i/2);assert(item,id+' 存在');items.push(item);
    assert.equal(item.id,id);assert.equal(item.lang,'es');assert.equal(item.week,week);assert.equal(item.afterLesson,'es-'+week);
    assert(READING_GENRES.includes(item.genre));const count=item.sentences.flatMap(sentence=>esWords(sentence.text)).length;
    assert.equal(item.words,count);assert(count>=400 && count<=450,id+' '+count+' 词');
    assert.equal(item.questions.length,4);assert(item.questions.some(question=>/推断|指代|指的是/.test(question.prompt)),id+' 推断或指代题');
    for (const question of item.questions) assert(question.options.includes(question.answer),id+' 答案在选项里');
    assert.equal(item.keyWords.length,5);assert.equal(new Set(item.keyWords.map(word=>word.word)).size,5);
    for (const word of item.keyWords) assert(initialRows.some(row=>row.lang==='es' && row.lesson<=item.afterLesson && row.front===word.word),id+' 已学重点词：'+word.word);
    assert(item.retell.length>=3 && item.retell.length<=5);item.retell.forEach(point=>assert.match(point,/[㐀-鿿]/));
    checkSentenceVocabulary(item.afterLesson,item.sentences,id);
  }
  for (let i=0;i<4;i+=2) assert.notEqual(items[i].genre,items[i+1].genre,'第 '+items[i].week+' 周体裁不同');
  assert.notEqual(api.READINGS['es-r44'].genre,items[0].genre,'与上一篇轮换体裁');
});
test('任务 S4：新课与阅读 UI 的时长、练习、中文折叠和措辞，浏览不改进度',() => {
  const {api:a,document}=createAPI(true);a.initialize();const before=plain(a.getData().state);
  for (const id of S4_LESSONS) {
    assert(a.LESSONS[id]);a.openLesson(id);const page=document.getElementById('content').textContent;
    assert(page.includes(a.LESSONS[id].name));assert(page.includes(a.LESSONS[id].dailyTime));assert(page.includes(a.LESSONS[id].dates));
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);assert.doesNotMatch(page.replace(/一封信/g,''),/[死杀封炸战坑砍]/);
  }
  for (let i=45;i<=48;i++) {
    const id='es-r'+i;assert(a.READINGS[id]);a.openReadingItem(id);const page=document.getElementById('content').textContent;
    assert(page.includes(a.READINGS[id].title));assert.equal(document.querySelectorAll('[data-question]').length,4);
    assert.equal(document.querySelectorAll('details').filter(node=>node.querySelector('summary')?.textContent==='查看本句中文').length,a.READINGS[id].sentences.length);
    assert.doesNotMatch(page.replace(/一封信/g,''),/[死杀封炸战坑砍]/);
  }
  assert.deepEqual(plain(a.getData().state),before,'只浏览新内容不写进度');
});

// 任务 R4：第 25–28 周，沿用卡片来源的词汇检查和进度隔离夹具。
const R4_STANDARD_STRESS={
  говорили:'говори́ли',помог:'помо́г',плыла:'плыла́',плыло:'плыло́',плыли:'плы́ли',
  буду:'бу́ду',будешь:'бу́дешь',будет:'бу́дет',будем:'бу́дем',будете:'бу́дете',будут:'бу́дут',
  прочитаю:'прочита́ю',прочитаешь:'прочита́ешь',прочитает:'прочита́ет',прочитаем:'прочита́ем',прочитаете:'прочита́ете',прочитают:'прочита́ют',
  напишу:'напишу́',напишешь:'напи́шешь',напишет:'напи́шет',напишем:'напи́шем',напишете:'напи́шете',напишут:'напи́шут',
  куплю:'куплю́',купишь:'ку́пишь',купит:'ку́пит',купим:'ку́пим',купите:['ку́пите','купи́те'],купят:'ку́пят',
  скажу:'скажу́',скажешь:'ска́жешь',скажет:'ска́жет',скажем:'ска́жем',скажете:'ска́жете',скажут:'ска́жут',
  читай:'чита́й',читайте:'чита́йте',прочитай:'прочита́й',прочитайте:'прочита́йте',
  пиши:'пиши́',пишите:'пиши́те',напиши:'напиши́',напишите:'напиши́те',скажи:'скажи́',скажите:'скажи́те',
  давай:'дава́й',давайте:'дава́йте',завтра:'за́втра',через:'че́рез',неделю:'неде́лю',скоро:'ско́ро',потом:'пото́м',
  идти:'идти́',иду:'иду́',идут:'иду́т',ходить:'ходи́ть',хожу:'хожу́',ходишь:'хо́дишь',ходит:'хо́дит',ходим:'хо́дим',ходите:['хо́дите','ходи́те'],ходят:'хо́дят',
  ходил:'ходи́л',ходила:'ходи́ла',ходило:'ходи́ло',ходили:'ходи́ли',
  ехать:'е́хать',еду:'е́ду',едешь:'е́дешь',едет:'е́дет',едем:'е́дем',едете:'е́дете',едут:'е́дут',
  ехал:'е́хал',ехала:'е́хала',ехало:'е́хало',ехали:'е́хали',
  ездить:'е́здить',езжу:'е́зжу',ездишь:'е́здишь',ездит:'е́здит',ездим:'е́здим',ездите:'е́здите',ездят:'е́здят',
  ездил:'е́здил',ездила:'е́здила',ездило:'е́здило',ездили:'е́здили',
  бежать:'бежа́ть',бегу:'бегу́',бежишь:'бежи́шь',бежит:'бежи́т',бежим:'бежи́м',бежите:'бежи́те',бегут:'бегу́т',бегать:'бе́гать',
  лететь:'лете́ть',лечу:'лечу́',летишь:'лети́шь',летит:'лети́т',летим:'лети́м',летите:'лети́те',летят:'летя́т',летать:'лета́ть',
  плыву:'плыву́',плывут:'плыву́т',плавать:'пла́вать',
  пойти:'пойти́',пойду:'пойду́',пойдут:'пойду́т',поехать:'пое́хать',поеду:'пое́ду',поедешь:'пое́дешь',поедет:'пое́дет',поедем:'пое́дем',поедете:'пое́дете',поедут:'пое́дут',
  прийти:'прийти́',приду:'приду́',придут:'приду́т',приехать:'прие́хать',уйти:'уйти́',уйду:'уйду́',уйдут:'уйду́т',уехать:'уе́хать',
  выйти:'вы́йти',выйду:'вы́йду',выйдешь:'вы́йдешь',выйдет:'вы́йдет',выйдем:'вы́йдем',выйдете:'вы́йдете',выйдут:'вы́йдут',
  вышел:'вы́шел',вышла:'вы́шла',вышло:'вы́шло',вышли:'вы́шли',войти:'войти́',войду:'войду́',войдут:'войду́т',
  перейти:'перейти́',перейду:'перейду́',перейдут:'перейду́т',переехать:'перее́хать',домой:'домо́й',москву:'москву́'
};
function checkR4Russian(text,label) {
  checkR3Russian(text,label);
  for (const word of text.match(/[А-Яа-яЁё\u0301]+/g) || []) {
    const standard=R4_STANDARD_STRESS[ruDeaccent(word)];
    if (standard) assert((Array.isArray(standard)?standard:[standard]).includes(word.toLowerCase()),label+' 标准重音：'+word);
  }
}
function checkR4Text(value,label) {
  if (typeof value==='string') {
    checkR4Russian(value,label);
    assert.doesNotMatch(value.replace(/一封信/g,''),/[死杀封炸战坑砍]/,label+' 措辞');
  } else if (Array.isArray(value)) value.forEach((item,i)=>checkR4Text(item,label+' '+i));
  else if (value && typeof value==='object') for (const [key,item] of Object.entries(value)) checkR4Text(item,label+' '+key);
}
test('任务 R4：四课日期、190 条卡片、14–20 句双语课文和 6 加 4 题',() => {
  const dates=['2027 年 03-01 至 03-07','2027 年 03-08 至 03-14','2027 年 03-15 至 03-21','2027 年 03-22 至 03-28'];
  for (const [i,id] of R4_LESSONS.entries()) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 存在');
    assert.equal(lesson.lang,'ru');assert.equal(lesson.week,25+i);assert.equal(lesson.dates,dates[i]);
    assert.equal(r4Rows.filter(row=>row.lesson===id).length,[50,50,45,45][i],id+' 词卡数');
    for (const field of ['name','goal','writingTask']) assert(lesson[field]?.trim(),id+' '+field);
    assert.equal(lesson.dailyTime,'每天 30 分钟 + 周末系统块 60 分钟');
    assert.match(lesson.writingTask,id==='ru-26'?/100\s*词/:/5\s*句/,id+' 写作篇幅');
    assert.equal(typeof lesson.explanation,'function');
    const explanation=lesson.explanation(),text=parseNodes(explanation).map(node=>node.textContent).join('').trim();
    assert(text.startsWith('时间分配以复盘结果为准'),id+' 开头时间提示');
    assert(text.includes('配合教材第二册的对应内容，课次以实际教材为准'),id+' 教材指引');
    checkR4Text({...lesson,explanation:decode(explanation.replace(/<[^>]*>/g,' '))},id);
    assert(lesson.reading.title?.trim());
    assert(lesson.reading.sentences.length>=14 && lesson.reading.sentences.length<=20,id+' 14–20 句');
    for (const sentence of lesson.reading.sentences) {
      assert.match(sentence.text,/[.?!][»”"]?$/,id+' 句尾');assert.match(sentence.zh,/[㐀-鿿]/,id+' 逐句中文');assert.doesNotMatch(sentence.text,/[A-Za-z]/);
    }
    assert.equal(lesson.reading.questions.length,4);assert(lesson.reading.questions.every(question=>Array.isArray(question.options)));
    assert.equal(lesson.exercises.length,10);assert.deepEqual(lesson.exercises.slice(6),lesson.reading.questions);
    assert(lesson.reading.questions.every((question,index)=>lesson.exercises[index+6]===question),id+' 阅读题共用对象');
    assert(lesson.exercises.slice(0,6).filter(question=>!question.options).length>=4,id+' 语法题以文本题为主');
    checkR2Questions(lesson.exercises,id);
  }
});
test('任务 R4：将来时、命令式、定向与前缀运动动词的讲解覆盖指定形式',() => {
  const required={
    'ru-25':['未完成体','完成体','不定式','бу́ду','прочита́ю','напишу́','куплю́','скажу́','за́втра','че́рез неде́лю','ско́ро','пото́м'],
    'ru-26':['未完成体','完成体','背景','连续','命令式','чита́й','чита́йте','прочита́й','прочита́йте','-и','-ь','-й','否定','пожа́луйста','дава́й'],
    'ru-27':['定向','不定向','习惯','宾格','идти́','ходи́ть','е́хать','е́здить','иду́','идёшь','шёл','бежа́ть','бе́гать','лете́ть','лета́ть','плыть','пла́вать'],
    'ru-28':['по-','при-','у-','вы-','в-','пере-','出发','到达','离开','出来','进入','穿过','пойти́','пое́хать','прийти́ домо́й','уе́хать в Москву́','未完成体','完成体']
  };
  for (const [id,parts] of Object.entries(required)) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 存在');const text=parseNodes(lesson.explanation()).map(node=>node.textContent).join('');
    for (const part of parts) assert(text.includes(part),id+' 讲解形式：'+part);
  }
});
test('任务 R4：ru-1137 至 ru-1326 连续，CSV 与嵌入同步并按旧末行追加',() => {
  const ids=Array.from({length:190},(_,i)=>'ru-'+String(1137+i).padStart(4,'0'));
  assert.deepEqual(r4Rows.map(row=>row.id),ids);
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','ru.csv'),'utf8')));
  assert.deepEqual(csv.filter(row=>R4_LESSONS.includes(row.lesson)),r4Rows);
  assert.deepEqual(csv.map(row=>row.id),Array.from({length:1623},(_,i)=>'ru-'+String(i+1).padStart(4,'0')));
  const previous=initialRows.findIndex(row=>row.id==='es-1993');assert(previous>=0);
  assert.deepEqual(initialRows.slice(previous+1,initialRows.findIndex(row=>row.id==='ru-1326')+1).map(row=>row.id),ids,'cards-data 只在旧末行之后追加');
  const seen=new Set(initialRows.filter(row=>row.lang==='ru' && row.lesson<'ru-25').map(row=>ruDeaccent(row.front)));
  for (const row of r4Rows) {const key=ruDeaccent(row.front);assert(!seen.has(key),row.id+' 重复 front：'+row.front);seen.add(key);}
});
test('任务 R4：各类卡片数量、名词标性和格形式、六人称、过去时与体说明',() => {
  checkR4Russian('пере- / -ами / идёшь / самолёт','抽象词缀和 ё 重音');
  assert.throws(()=>checkR4Russian('переход','未标重音的完整词'));
  assert.throws(()=>checkR4Russian('по-китайски','连字符词仍须标重音'));
  assert.throws(()=>checkR4Russian('самолёт\u0301','ё 不再加 U+0301'));
  const quotas={
    'ru-25':{不定式:20,时间表达:10,名词:15,句型:5},
    'ru-26':{不定式:20,请求表达:10,名词:10,副词:5,句型:5},
    'ru-27':{运动动词:10,名词:15,时间表达:10,句型:5,形容词:5},
    'ru-28':{运动动词:15,名词:15,时间表达:5,句型:5,副词:5}
  };
  for (const [id,quota] of Object.entries(quotas)) for (const [tag,count] of Object.entries(quota))
    assert.equal(r4Rows.filter(row=>row.lesson===id && row.tags.split(';').includes(tag)).length,count,id+' '+tag+' 配额');
  const persons=[/^я /,/^ты /,/^он\/она́ /,/^мы /,/^вы /,/^они́ /];
  for (const row of r4Rows) {
    checkR4Text(row,row.id);const tags=row.tags.split(';');assert.equal(row.lang,'ru');
    for (const field of ['front','back','example','example_zh','note','tags']) assert(row[field]?.trim(),row.id+' '+field+' 非空');
    assert.match(row.example,/[.?!][»”"]?$/);assert.match(row.example_zh,/[㐀-鿿]/);assert.doesNotMatch(row.front,/[A-Za-z]/);
    if (tags.includes('名词')) {
      assert.match(row.note,/^名词（[阳阴中]/,row.id+' 名词标性');
      for (const name of ['主格','属格','与格','宾格','工具格','前置格'])
        assert(ruWords(row.note.match(new RegExp('(?:'+name+'单数|单数'+name+'|'+name+')：([^；]+)'))?.[1] || '').length,row.id+' '+name+' 实际词形');
    }
    if (tags.some(tag=>['不定式','运动动词'].includes(tag))) {
      const groups=[...row.note.matchAll(/六个人称(?:（[^）]+）)?：((?:[^；]*；){5}[^；]*)/g)].map(match=>match[1].split('；'));
      assert(groups.length,row.id+' 六个人称');
      for (const forms of groups) forms.forEach((form,index)=>{assert.match(form,persons[index],row.id+' 人称顺序');assert(ruWords(form).length>(index===2?2:1),row.id+' 实际变位');});
      const past=[...row.note.matchAll(/(?:过去时|过去时四形式)：([^；]+)/g)].map(match=>match[1].split(' / '));
      assert(past.length,row.id+' 过去时');for (const forms of past) {assert.equal(forms.length,4,row.id+' 过去时四形式');assert(forms.every(form=>ruWords(form).length));}
      assert.match(row.note,/未完成体|完成体/,row.id+' 体的类型');
      assert.match(row.note,/体配对|体说明/,row.id+' 体配对或运动动词体说明');
      if (row.lesson==='ru-25') assert.match(row.note,/将来时/,row.id+' 将来时形式');
      if (row.lesson==='ru-26') {
        const imperative=row.note.match(/命令式(?:（[^）]*）)?：([^；]+)/)?.[1];
        assert(imperative && imperative.split(' / ').length>=2,row.id+' 命令式两形式');
      }
    }
  }
});
test('任务 R4：整句、请求及含变位动词的短语只识别，附加运动动词只认',() => {
  const finite=new Set();
  for (const row of initialRows.filter(row=>row.lang==='ru')) {
    for (const match of row.note.matchAll(/六个人称(?:（[^）]+）)?：((?:[^；]*；){5}[^；]*)/g))
      for (const part of match[1].split('；')) ruWords(part).slice(part.startsWith('он/')?2:1).forEach(word=>finite.add(word));
    for (const match of row.note.matchAll(/(?:过去时|过去时四形式|命令式)：([^；]+)/g)) ruWords(match[1]).forEach(word=>finite.add(word));
    for (const word of ruWords(row.front)) ruR4Forms(word,row,'ru-28').forEach(form=>finite.add(form));
  }
  for (const row of r4Rows) {
    const tags=row.tags.split(';'),words=ruWords(row.front);
    if (tags.some(tag=>['句型','请求表达'].includes(tag)) || /[.?!][»”"]?$/.test(row.front) || words.length>1 && words.some(word=>finite.has(word))) assert(tags.includes('phrase'),row.id+' phrase');
    if (row.lesson==='ru-27' && ['бежать','бегать','лететь','летать','плыть','плавать'].includes(ruDeaccent(row.front))) assert(tags.includes('phrase'),row.id+' 附加运动动词只认');
    assert.deepEqual(plain(api.expandCards([row]).map(card=>card.direction)),tags.includes('phrase')?['r']:['r','p'],row.id+' 生成方向');
  }
  for (const [id,count] of [['ru-25',95],['ru-26',85],['ru-27',81],['ru-28',85]])
    assert.equal(api.expandCards(r4Rows.filter(row=>row.lesson===id)).length,count,id+' 生成卡数');
  assert.equal(r4Expanded,346);
});
test('任务 R4：八篇阅读的日期关联、体裁、篇幅、四题和已学重点词',() => {
  const fronts=new Map(initialRows.filter(row=>row.lang==='ru').map(row=>[ruDeaccent(row.front),row.lesson]));
  const added=[];
  for (let i=0;i<8;i++) {
    const id='ru-r'+(41+i),item=api.READINGS[id],week=25+Math.floor(i/2);assert(item,id+' 存在');added.push(item);
    assert.equal(item.id,id);assert.equal(item.lang,'ru');assert.equal(item.week,week);assert.equal(item.afterLesson,'ru-'+week);
    assert.match(item.title,/[㐀-鿿]/);assert(READING_GENRES.includes(item.genre));checkR4Text(item,id);
    const minSentences=week<=26?18:22,maxSentences=week<=26?22:26,minWords=week<=26?140:200,maxWords=week<=26?200:260;
    assert(item.sentences.length>=minSentences && item.sentences.length<=maxSentences,id+' 句数：'+item.sentences.length);
    const words=item.sentences.flatMap(sentence=>ruWords(sentence.text)).length;
    assert.equal(item.words,words,id+' 实际词数');assert(words>=minWords && words<=maxWords,id+' 词数：'+words);
    for (const sentence of item.sentences) {assert.match(sentence.text,/[.?!][»”"]?$/);assert.match(sentence.zh,/[㐀-鿿]/);assert.doesNotMatch(sentence.text,/[A-Za-z]/);}
    assert.equal(item.questions.length,4);assert(item.questions.every(question=>Array.isArray(question.options)));checkR2Questions(item.questions,id);
    assert(item.questions.some(question=>/推断|指代|指的是/.test(question.prompt)),id+' 推断或指代题');
    assert.equal(item.keyWords.length,5);assert.equal(new Set(item.keyWords.map(word=>ruDeaccent(word.word))).size,5);
    for (const word of item.keyWords) {const from=fronts.get(ruDeaccent(word.word));assert(from && from<=item.afterLesson,id+' 已学重点词：'+word.word);assert.match(word.zh,/[㐀-鿿]/);}
    assert(item.retell.length>=3 && item.retell.length<=5);item.retell.forEach(point=>assert.match(point,/[㐀-鿿]/));
  }
  for (let i=0;i<8;i+=2) assert.notEqual(added[i].genre,added[i+1].genre,'第 '+added[i].week+' 周体裁不同');
  assert.notEqual(api.READINGS['ru-r40'].genre,added[0].genre,'与上一篇轮换体裁');
  for (let week=25;week<=28;week++) assert.equal(Object.values(api.READINGS).filter(item=>item.lang==='ru' && item.week===week).length,2,'第 '+week+' 周两篇');
});
test('任务 R4：全部新卡例句、四课课文与八篇阅读使用同一推导式词汇范围',() => {
  for (const id of R4_LESSONS) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 存在');
    assert.deepEqual(ruVocabularyMisses(id,[...r4Rows.filter(row=>row.lesson===id).map(row=>({text:row.example,id:row.id})),...lesson.reading.sentences]),[],id+' 例句与课文未学词');
  }
  for (let i=41;i<=48;i++) {const item=api.READINGS['ru-r'+i];assert(item);assert.deepEqual(ruVocabularyMisses(item.afterLesson,item.sentences),[],item.id+' 阅读未学词');}
});
test('任务 R4：新词形按课程和已学动词推导，不允许后课词或例句给自身扩充范围',() => {
  const row=front=>initialRows.find(row=>row.lang==='ru' && ruDeaccent(row.front)===front);
  for (const [base,form,week] of [['быть','будешь',25],['читать','прочитаю',25],['читать','читайте',26],['идти','шёл',27],['приходить','придут',28]]) {
    const source=row(base);assert(source,base+' 已学卡');
    assert(ruR4Forms(base,source,'ru-'+week).includes(form),base+' 推导 '+form);
    assert(!ruR4Forms(base,source,'ru-'+(week-1)).includes(form),form+' 推导有课次限制');
  }
  const fake={lesson:'ru-29',front:'пойти́',tags:'动词;不定式',note:'体配对：идти́ — пойти́'};
  assert.deepEqual(ruR4Forms('пойти',fake,'ru-28'),[],'后续课卡片不得提前推导');
  assert.deepEqual(ruR4Forms('пойти',{...fake,lesson:'ru-28',tags:'名词'},'ru-28'),[],'只从动词卡推导');
  assert.deepEqual(ruR4Forms('пойти',{...fake,lesson:'ru-28',front:'чита́ть'},'ru-28'),[],'调用词必须来自卡片 front');
  const regular={lesson:'ru-25',front:'добавля́ть',tags:'动词;不定式',note:'未完成体；六个人称：я добавля́ю；ты добавля́ешь；он/она́ добавля́ет；мы добавля́ем；вы добавля́ете；они́ добавля́ют'};
  assert(ruR4Forms('добавлять',regular,'ru-26').includes('добавляйте'),'从已学不定式与明列词干推导规则命令式');
  assert(!ruR4Forms('добавлять',regular,'ru-25').includes('добавляйте'),'命令式有课次限制');
  const changing={...regular,front:'дава́ть',note:'未完成体；я даю́ / ты даёшь'};
  assert(!ruR4Forms('давать',changing,'ru-26').includes('дайте'),'词干改变时不能套用规则命令式');
  for (const word of ['гиппопотам','прочитую','пойдишь','пришол','ездю']) assert(!ruKnown('ru-28',word),'未学词或错误词形：'+word);
  const later=r4Rows.find(row=>row.lesson==='ru-28' && row.tags.split(';').includes('名词'));assert(later);
  assert(!ruKnown('ru-27',later.front),'第 28 周名词不得提前通过');
  const previous=later.example;
  try {later.example='Гиппопота́м.';assert(!ruKnown('ru-28','гиппопотам'),'新例句不能扩充自身词表');} finally {later.example=previous;}
});
test('任务 R4：课程和阅读 UI 显示完整，浏览过程不改变用户进度',() => {
  const {api:a,document}=createAPI(true);a.initialize();const before=plain(a.getData().state);
  for (const id of R4_LESSONS) {
    assert(a.LESSONS[id]);a.openLesson(id);const page=document.getElementById('content').textContent;
    assert(page.includes(a.LESSONS[id].name));assert(page.includes(a.LESSONS[id].dailyTime));assert(page.includes(a.LESSONS[id].dates));
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);assert.doesNotMatch(page.replace(/一封信/g,''),/[死杀封炸战坑砍]/);
  }
  for (let i=41;i<=48;i++) {
    const id='ru-r'+i;assert(a.READINGS[id]);a.openReadingItem(id);const page=document.getElementById('content').textContent;
    assert(page.includes(a.READINGS[id].title));assert.equal(document.querySelectorAll('[data-question]').length,4);
    assert.equal(document.querySelectorAll('details').filter(node=>node.querySelector('summary')?.textContent==='查看本句中文').length,a.READINGS[id].sentences.length);
    assert.doesNotMatch(page.replace(/一封信/g,''),/[死杀封炸战坑砍]/);
  }
  assert.deepEqual(plain(a.getData().state),before);
});

// 任务 R5：第 29–31 周。复用既有词形推导器、问题检查器和离线 UI 模型。
const R5_STANDARD_STRESS={
  тридцать:'три́дцать',сорок:'со́рок',пятьдесят:'пятьдеся́т',шестьдесят:'шестьдеся́т',семьдесят:'се́мьдесят',восемьдесят:'во́семьдесят',девяносто:'девяно́сто',
  двести:'две́сти',триста:'три́ста',четыреста:'четы́реста',пятьсот:'пятьсо́т',шестьсот:'шестьсо́т',семьсот:'семьсо́т',восемьсот:'восемьсо́т',девятьсот:'девятьсо́т',тысяча:'ты́сяча',
  одиннадцатый:'оди́ннадцатый',двенадцатый:'двена́дцатый',тринадцатый:'трина́дцатый',четырнадцатый:'четы́рнадцатый',пятнадцатый:'пятна́дцатый',шестнадцатый:'шестна́дцатый',семнадцатый:'семна́дцатый',восемнадцатый:'восемна́дцатый',девятнадцатый:'девятна́дцатый',двадцатый:'двадца́тый',двадцатого:'двадца́того',девяти:'девяти́',
  чая:'ча́я',половина:'полови́на',четверть:'че́тверть',число:'число́',часа:['часа́','ча́са'],часов:'часо́в',первого:'пе́рвого',мая:'ма́я',
  умываться:'умыва́ться',встречаться:'встреча́ться',бояться:'боя́ться',смеяться:'смея́ться',находиться:'находи́ться',нравиться:'нра́виться',можно:'мо́жно',надо:'на́до',нельзя:'нельзя́',пора:'пора́',жарко:'жа́рко',холодно:'хо́лодно',говорят:'говоря́т',пишут:'пи́шут',
  потому:'потому́',поэтому:'поэ́тому',если:'е́сли',когда:'когда́',хотя:'хотя́',или:'и́ли',который:'кото́рый',чтобы:'что́бы'
};
function checkR5Text(value,label) {
  checkR4Text(value,label);
  const visit=item=>{
    if(typeof item==='string') for(const word of item.match(/[А-Яа-яЁё\u0301]+/g)||[]) {
      const standard=R5_STANDARD_STRESS[ruDeaccent(word)];
      if(standard) assert((Array.isArray(standard)?standard:[standard]).includes(word.toLowerCase()),label+' 标准词形重音：'+word);
    }
    else if(Array.isArray(item)) item.forEach(visit);
    else if(item && typeof item==='object') Object.values(item).forEach(visit);
  };
  visit(value);
}
test('任务 R5：三课日期、155 条词条、双语课文、写作和 6 加 4 题',()=>{
  const dates=['2027 年 03-29 至 04-04','2027 年 04-05 至 04-11','2027 年 04-12 至 04-18'];
  for(const [i,id] of R5_LESSONS.entries()) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 存在');
    assert.equal(lesson.lang,'ru');assert.equal(lesson.week,29+i);assert.equal(lesson.dates,dates[i]);
    assert.equal(r5Rows.filter(row=>row.lesson===id).length,[55,50,50][i]);
    for(const field of ['name','goal','writingTask']) assert(lesson[field]?.trim(),id+' '+field);
    assert.equal(lesson.dailyTime,'每天 30 分钟 + 周末系统块 60 分钟');
    assert.match(lesson.writingTask,id==='ru-31'?/100\s*(?:个俄语)?词/:/5\s*句/);
    if(id==='ru-31') assert.match(lesson.writingTask,/五种|5\s*种/);
    assert.equal(typeof lesson.explanation,'function');
    const explanation=lesson.explanation(),text=parseNodes(explanation).map(n=>n.textContent).join('').trim();
    assert(text.startsWith('时间分配以复盘结果为准'));assert(text.includes('配合教材第二册的对应内容，课次以实际教材为准'));
    checkR5Text({...lesson,explanation:decode(explanation.replace(/<[^>]*>/g,' '))},id);
    assert(lesson.reading.title?.trim());assert(lesson.reading.sentences.length>=14 && lesson.reading.sentences.length<=20,id+' 14–20句');
    for(const sentence of lesson.reading.sentences){assert.match(sentence.text,/[.?!][»”"]?$/);assert.match(sentence.zh,/[㐀-鿿]/);assert.doesNotMatch(sentence.text,/[A-Za-z]/);}
    assert.equal(lesson.reading.questions.length,4);assert.equal(lesson.exercises.length,10);
    assert.deepEqual(lesson.exercises.slice(6),lesson.reading.questions);
    assert(lesson.reading.questions.every((q,index)=>q===lesson.exercises[index+6] && Array.isArray(q.options)),id+' 共用阅读选择题');
    assert(lesson.exercises.slice(0,6).filter(q=>!q.options).length>=4,id+' 语法题以文本题为主');
    checkR2Questions(lesson.exercises,id);
  }
});
test('任务 R5：讲解包含数量和日期、反身与无人称句、复合句和标点',()=>{
  const required={
    'ru-29':['оди́ннадцать','два́дцать','ты́сяча','主格','属格单数','属格复数','пе́рвый','двадца́тый','形容词','час','часа́','часо́в','полови́на','без','宾格','число́','когда́','пе́рвого ма́я','年份'],
    'ru-30':['умыва́ться','встреча́ться','продаётся','боя́ться','смея́ться','находи́ться','нра́виться','真正反身','相互','被动','固定','过去时','мо́жно','на́до','нельзя́','пора́','жа́рко','хо́лодно','与格','不定人称','говоря́т','пи́шут'],
    'ru-31':['что','потому́ что','поэ́тому','е́сли','когда́','хотя́','и́ли','а','но','кото́рый','主格','属格','与格','宾格','工具格','前置格','что́бы','不定式','过去时','目的','逗号']
  };
  for(const [id,parts] of Object.entries(required)){
    const text=parseNodes(api.LESSONS[id].explanation()).map(n=>n.textContent).join('');
    for(const part of parts)assert(text.toLowerCase().includes(part.toLowerCase()),id+' 讲解要点：'+part);
  }
});
test('任务 R5：ru-1327 至 ru-1481 连续，CSV 同步并从旧末行追加',()=>{
  const ids=Array.from({length:155},(_,i)=>'ru-'+String(i+1327).padStart(4,'0'));
  assert.deepEqual(r5Rows.map(row=>row.id),ids);
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','ru.csv'),'utf8')));
  assert.deepEqual(csv.filter(row=>R5_LESSONS.includes(row.lesson)),r5Rows);
  assert.deepEqual(csv.map(row=>row.id),Array.from({length:1623},(_,i)=>'ru-'+String(i+1).padStart(4,'0')));
  const previous=initialRows.findIndex(row=>row.id==='ru-1326');assert(previous>=0);
  assert.deepEqual(initialRows.slice(previous+1,initialRows.findIndex(row=>row.id==='ru-1482')).map(row=>row.id),ids,'cards-data R5 条目保留追加顺序');
  const seen=new Set(initialRows.filter(row=>row.lang==='ru' && row.lesson<'ru-29').map(row=>ruDeaccent(row.front)));
  for(const row of r5Rows){const key=ruDeaccent(row.front);assert(!seen.has(key),row.id+' front重复');seen.add(key);}
});
test('任务 R5：类别数量、名词性与格形式、动词六个人称及过去四式',()=>{
  const quotas={'ru-29':{数词:30,时间名词:10,表达:10,句型:5},'ru-30':{反身动词:20,无人称表达:10,名词:10,副词:5,句型:5},'ru-31':{连接词:15,不定式:15,名词:15,句型:5}};
  for(const [id,quota] of Object.entries(quotas)) for(const [tag,count] of Object.entries(quota)) assert.equal(r5Rows.filter(r=>r.lesson===id && r.tags.split(';').includes(tag)).length,count,id+' '+tag);
  const persons=[/^я /,/^ты /,/^он\/она́ /,/^мы /,/^вы /,/^они́ /];
  for(const row of r5Rows){
    checkR5Text(row,row.id);const tags=row.tags.split(';');
    for(const field of ['front','back','example','example_zh','note','tags'])assert(row[field]?.trim(),row.id+' '+field);
    assert.match(row.example,/[.?!][»”"]?$/);assert.match(row.example_zh,/[㐀-鿿]/);assert.doesNotMatch(row.front,/[A-Za-z]/);
    if(tags.some(tag=>['名词','时间名词'].includes(tag))){
      assert.match(row.note,/^名词（[阳阴中]/,row.id+' 名词标性');
      const ordered=row.note.match(/单数六格（主、属、与、宾、工具、前置）：([^；]+)/)?.[1].split(' / ');
      if(ordered){assert.equal(ordered.length,6,row.id+' 六格顺序');assert(ordered.every(form=>ruWords(form).length));}
      else for(const name of ['主格','属格','与格','宾格','工具格','前置格'])assert(ruWords(row.note.match(new RegExp('(?:'+name+'单数|单数'+name+'|'+name+')：([^；]+)'))?.[1]||'').length,row.id+' '+name+' 实际形式');
    }
    if(tags.includes('不定式')){
      const groups=[...row.note.matchAll(/六个人称(?:（[^）]+）)?：((?:[^；]*；){5}[^；]*)/g)].map(m=>m[1].split('；'));
      assert(groups.length,row.id+' 六个人称');
      for(const forms of groups) forms.forEach((form,index)=>{assert.match(form,persons[index]);assert(ruWords(form).length>(index===2?2:1),row.id+' 实际变位');});
      const past=[...row.note.matchAll(/(?:过去时|过去时四形式)：([^；]+)/g)].map(m=>m[1].split(' / '));
      assert(past.length,row.id+' 过去时');for(const forms of past){assert.equal(forms.length,4);assert(forms.every(form=>ruWords(form).length));}
      assert.match(row.note,/未完成体|完成体/);assert.match(row.note,/体配对|体说明/);
    }
  }
});
test('任务 R5：整句、时间表达和含变位动词的短语只生成识别卡',()=>{
  const finite=new Set();
  for(const row of initialRows.filter(r=>r.lang==='ru')) {
    for(const match of row.note.matchAll(/六个人称(?:（[^）]+）)?：((?:[^；]*；){5}[^；]*)/g))
      for(const part of match[1].split('；')) ruWords(part).slice(part.startsWith('он/')?2:1).forEach(w=>finite.add(w));
    for(const match of row.note.matchAll(/(?:过去时|过去时四形式|命令式)：([^；]+)/g))ruWords(match[1]).forEach(w=>finite.add(w));
  }
  for(const row of r5Rows){
    const tags=row.tags.split(';'),words=ruWords(row.front);
    if(tags.includes('句型') || row.lesson==='ru-29' && tags.includes('表达') || /[.?!][»”"]?$/.test(row.front) || words.length>1 && words.some(w=>finite.has(w)))assert(tags.includes('phrase'),row.id+' phrase');
    assert.deepEqual(plain(api.expandCards([row]).map(c=>c.direction)),tags.includes('phrase')?['r']:['r','p']);
  }
});
test('任务 R5：六篇阅读日期关联、体裁轮换、22–26句与200–260词',()=>{
  const fronts=new Map(initialRows.filter(r=>r.lang==='ru').map(r=>[ruDeaccent(r.front),r.lesson]));
  const genres=['短故事','描写','通知或广告','菜谱或日程','人物介绍','简单新闻'];
  let previous=api.READINGS['ru-r48'].genre;
  for(let i=0;i<6;i++){
    const id='ru-r'+(49+i),item=api.READINGS[id],week=29+Math.floor(i/2);assert(item,id+' 存在');
    assert.equal(item.id,id);assert.equal(item.lang,'ru');assert.equal(item.week,week);assert.equal(item.afterLesson,'ru-'+week);
    assert.equal(item.genre,genres[i]);assert.notEqual(item.genre,previous);previous=item.genre;
    assert.match(item.title,/[㐀-鿿]/);checkR5Text(item,id);
    assert(item.sentences.length>=22 && item.sentences.length<=26,id+' 句数');
    const words=item.sentences.flatMap(s=>ruWords(s.text)).length;assert.equal(item.words,words);assert(words>=200 && words<=260,id+' 词数：'+words);
    for(const s of item.sentences){assert.match(s.text,/[.?!][»”"]?$/);assert.match(s.zh,/[㐀-鿿]/);assert.doesNotMatch(s.text,/[A-Za-z]/);}
    assert.equal(item.questions.length,4);assert(item.questions.every(q=>Array.isArray(q.options)));checkR2Questions(item.questions,id);
    assert(item.questions.some(q=>/推断|指代|指的是/.test(q.prompt)),id+' 推断或指代');
    assert.equal(item.keyWords.length,5);assert.equal(new Set(item.keyWords.map(w=>ruDeaccent(w.word))).size,5);
    for(const word of item.keyWords){const from=fronts.get(ruDeaccent(word.word));assert(from && from<=item.afterLesson,id+' 已学重点词：'+word.word);assert.match(word.zh,/[㐀-鿿]/);}
    assert(item.retell.length>=3 && item.retell.length<=5);item.retell.forEach(point=>assert.match(point,/[㐀-鿿]/));
  }
  for(let week=29;week<=31;week++)assert.equal(Object.values(api.READINGS).filter(r=>r.lang==='ru' && r.week===week).length,2);
});
test('任务 R5：新卡例句、课内阅读与阅读线均用同一推导式词汇范围',()=>{
  for(const id of R5_LESSONS)assert.deepEqual(ruVocabularyMisses(id,[...r5Rows.filter(r=>r.lesson===id).map(r=>({id:r.id,text:r.example})),...api.LESSONS[id].reading.sentences]),[],id+' 例句和课文未学词');
  for(let i=49;i<=54;i++){const item=api.READINGS['ru-r'+i];assert.deepEqual(ruVocabularyMisses(item.afterLesson,item.sentences),[],item.id+' 未学词');}
  for(const week of [30,31]){
    const row=r5Rows.find(r=>r.lesson==='ru-'+week && r.tags.split(';').includes('名词'));assert(row);
    assert(!ruKnown('ru-'+(week-1),row.front),'后课名词不能提前通过：'+row.front);
  }
  const row=r5Rows.find(r=>r.lesson==='ru-29'),before=row.example;
  try{row.example='Гиппопота́м.';assert(!ruKnown('ru-31','гиппопотам'),'新例句不能给自身扩充范围');}finally{row.example=before;}
  assert.throws(()=>checkR5Text('самолёт\u0301','重复重音'));
  assert.throws(()=>checkR5Text('одиннадцатый','漏重音'));
  assert.throws(()=>checkR5Text('пя́тьдесят','错误重音'));
});
test('任务 R5：序数词变格只从已学词卡推导且保留课次限制',()=>{
  const fifth=initialRows.find(row=>row.lang==='ru' && ruDeaccent(row.front)==='пятое');assert(fifth);
  assert(ruR5Forms('пятое',fifth,'ru-29').includes('пятого'));
  assert.deepEqual(ruR5Forms('пятое',fifth,'ru-28'),[]);
  assert.deepEqual(ruR5Forms('пятое',{...fifth,lesson:'ru-30'},'ru-29'),[]);
  assert.deepEqual(ruR5Forms('пятое',{...fifth,tags:'名词'},'ru-29'),[]);
  assert.deepEqual(ruR5Forms('пятое',{...fifth,front:'шесто́е'},'ru-29'),[]);
  const third=initialRows.find(row=>row.lang==='ru' && ruDeaccent(row.front)==='третье');assert(third);
  assert(ruR5Forms('третье',third,'ru-29').includes('третьего'));
  assert(!ruR5Forms('третье',third,'ru-29').includes('третього'));
  const sixth=initialRows.find(row=>row.lang==='ru' && ruDeaccent(row.front)==='шестое');assert(sixth);
  assert(ruR5Forms('шестое',sixth,'ru-29').includes('шестой'));
  assert(!ruR5Forms('шестое',sixth,'ru-29').includes('шестый'));
});
test('任务 R5：三课六篇 UI 完整，浏览内容不改变真实进度',()=>{
  const {api:a,document}=createAPI(true,html);a.initialize();const before=plain(a.getData().state);
  for(const id of R5_LESSONS){
    a.openLesson(id);const page=document.getElementById('content').textContent;
    for(const field of ['name','dailyTime','dates'])assert(page.includes(a.LESSONS[id][field]));
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);assert.doesNotMatch(page.replace(/一封信/g,''),/[死杀封炸战坑砍]/);
  }
  for(let i=49;i<=54;i++){
    const id='ru-r'+i;a.openReadingItem(id);const page=document.getElementById('content').textContent;
    assert(page.includes(a.READINGS[id].title));assert.equal(document.querySelectorAll('[data-question]').length,4);
    assert.equal(document.querySelectorAll('details').filter(n=>n.querySelector('summary')?.textContent==='查看本句中文').length,a.READINGS[id].sentences.length);
    assert.doesNotMatch(page.replace(/一封信/g,''),/[死杀封炸战坑砍]/);
  }
  assert.deepEqual(plain(a.getData().state),before);
});

// 任务 R6：第 32–34 周，比较、写作与阶段复盘。
const R6_STANDARD_STRESS={
  больше:'бо́льше',меньше:'ме́ньше',лучше:'лу́чше',хуже:'ху́же',старше:'ста́рше',моложе:'моло́же',
  дороже:'доро́же',дешевле:'деше́вле',дешевый:'дешёвый',выше:'вы́ше',ниже:'ни́же',ближе:'бли́же',дальше:'да́льше',
  легче:'ле́гче',тише:'ти́ше',громче:'гро́мче',проще:'про́ще',быстрее:'быстре́е',быстрей:'быстре́й',
  интереснее:'интере́снее',удобнее:'удо́бнее',короче:'коро́че',шире:'ши́ре',дольше:'до́льше',
  сильнее:'сильне́е',сильней:'сильне́й',старее:'старе́е',важна:'важна́',важнее:'важне́е',
  самый:'са́мый',самая:'са́мая',самое:'са́мое',самые:'са́мые',намного:'намно́го',гораздо:'гора́здо',
  компактный:'компа́ктный',стабильный:'стаби́льный',сравнение:'сравне́ние',стоимость:'сто́имость',
  дорогой:'дорого́й',уважаемый:'уважа́емый',уважением:'уваже́нием',моему:['моему́','мо́ему'],
  кажется:'ка́жется',согласен:'согла́сен',согласна:'согла́сна',согласны:'согла́сны',
  адресат:'адреса́т',подпись:'по́дпись',характер:'хара́ктер',досуг:'досу́г',хобби:'хо́бби',основной:'основно́й',
  искренний:'и́скренний',искренняя:'и́скренняя',искреннее:'и́скреннее',искренние:'и́скренние',тестирование:'тести́рование',
  самооценка:'самооце́нка',самопроверка:'самопрове́рка',критерий:'крите́рий',анализ:'ана́лиз',процент:'проце́нт'
};
function checkR6Text(value,label) {
  checkR5Text(value,label);
  const visit=item=>{
    if(typeof item==='string') for(const word of item.match(/[А-Яа-яЁё\u0301]+/g)||[]) {
      const standard=R6_STANDARD_STRESS[ruDeaccent(word)];
      if(standard) assert((Array.isArray(standard)?standard:[standard]).includes(word.toLowerCase()),label+' 标准词形重音：'+word);
    }
    else if(Array.isArray(item)) item.forEach(visit);
    else if(item && typeof item==='object') Object.values(item).forEach(visit);
  };
  visit(value);
}
test('任务 R6：三课日期、142 条词条、课文与 6 加 4 题',()=>{
  const dates=['2027 年 04-19 至 04-25','2027 年 04-26 至 05-02','2027 年 05-03 至 05-09'];
  for(const [i,id] of R6_LESSONS.entries()) {
    const lesson=api.LESSONS[id];assert(lesson,id+' 存在');
    assert.equal(lesson.lang,'ru');assert.equal(lesson.week,32+i);assert.equal(lesson.dates,dates[i]);
    assert.equal(lesson.dailyTime,'每天 30 分钟 + 周末系统块 60 分钟');
    assert.equal(r6Rows.filter(row=>row.lesson===id).length,[52,60,30][i]);
    assert.equal(api.expandCards(r6Rows.filter(row=>row.lesson===id)).length,[94,100,55][i]);
    assert.equal(typeof lesson.explanation,'function');
    const explanation=lesson.explanation(),text=parseNodes(explanation).map(n=>n.textContent).join('').trim();
    assert(text.startsWith('时间分配以复盘结果为准'));assert(text.includes('配合教材第二册的对应内容，课次以实际教材为准'));
    checkR6Text({...lesson,explanation:decode(explanation.replace(/<[^>]*>/g,' '))},id);
    assert(lesson.reading.title?.trim());assert(lesson.reading.sentences.length>=14 && lesson.reading.sentences.length<=20);
    for(const sentence of lesson.reading.sentences){assert.match(sentence.text,/[.?!][»”"]?$/);assert.match(sentence.zh,/[㐀-鿿]/);assert.doesNotMatch(sentence.text,/[A-Za-z]/);}
    assert.equal(lesson.reading.questions.length,4);assert.equal(lesson.exercises.length,10);
    assert.deepEqual(lesson.exercises.slice(6),lesson.reading.questions);
    assert(lesson.reading.questions.every((q,index)=>q===lesson.exercises[index+6] && Array.isArray(q.options)),id+' 共用阅读选择题');
    assert(lesson.exercises.slice(0,6).filter(q=>!q.options).length>=4,id+' 文本题为主');
    checkR2Questions(lesson.exercises,id);
  }
  assert.match(api.LESSONS['ru-32'].writingTask,/5\s*句/);
  assert.match(api.LESSONS['ru-33'].writingTask,/100\s*(?:个俄语)?词/);assert.match(api.LESSONS['ru-33'].writingTask,/邮件/);
  assert.match(api.LESSONS['ru-34'].writingTask,/限时/);assert.match(api.LESSONS['ru-34'].writingTask,/100\s*(?:个俄语)?词/);assert.match(api.LESSONS['ru-34'].writingTask,/复盘表/);
});
test('任务 R6：比较级、邮件结构、语法总表和阶段自测覆盖讲解要点',()=>{
  const required={
    'ru-32':['-ее','-ей','бо́льше','ме́ньше','лу́чше','ху́же','ста́рше','моло́же','доро́же','деше́вле','чем','属格','са́мый','всех','副词','намно́го','гора́здо'],
    'ru-33':['Дорого́й','Уважа́емый','С уваже́нием','称呼','结尾','段落','人','地方','事件','я ду́маю, что','по-мо́ему','мне ка́жется','согла́сен','学习','工作','家庭','城市','爱好'],
    'ru-34':['13','33','格','形容词','代词','体','过去','将来','运动动词','数词','ТРКИ','基础级','阅读','写作','复述','100','我这半年','复盘','B1','副动词','形动词','被动','复杂数词','熟悉文本复测']
  };
  for(const [id,parts] of Object.entries(required)) {
    const text=parseNodes(api.LESSONS[id].explanation()).map(n=>n.textContent).join('');
    for(const part of parts) assert(text.toLowerCase().includes(part.toLowerCase()),id+' 讲解要点：'+part);
  }
  const text=api.LESSONS['ru-34'].explanation();
  const tables=parseNodes(text).flatMap(n=>n instanceof ElementModel?[...(n.tag==='table'?[n]:[]),...n.querySelectorAll('table')]:[]);
  assert(tables.length>=2,'语法总表与阶段复盘表');
  const review=tables.find(t=>/复盘/.test(t.textContent));assert(review);
  for(const part of ['小时','SRS','掌握','阅读','写作','兴趣','下']) assert(review.textContent.includes(part),'复盘字段：'+part);
});
test('任务 R6：ru-1482 至 ru-1623 连续，CSV 同步且旧末行后只追加新 id',()=>{
  const ids=Array.from({length:142},(_,i)=>'ru-'+String(i+1482).padStart(4,'0'));
  assert.deepEqual(r6Rows.map(row=>row.id),ids);
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','ru.csv'),'utf8')));
  assert.deepEqual(csv.filter(row=>R6_LESSONS.includes(row.lesson)),r6Rows);
  assert.deepEqual(csv.map(row=>row.id),Array.from({length:1623},(_,i)=>'ru-'+String(i+1).padStart(4,'0')));
  const previous=initialRows.findIndex(row=>row.id==='ru-1481');assert(previous>=0);
  assert.deepEqual(initialRows.slice(previous+1,initialRows.findIndex(row=>row.id==='ru-1623')+1).map(row=>row.id),ids);
  const seen=new Set(initialRows.filter(row=>row.lang==='ru' && row.lesson<'ru-32').map(row=>ruDeaccent(row.front)));
  for(const row of r6Rows){const key=ruDeaccent(row.front);assert(!seen.has(key),row.id+' front 重复');seen.add(key);}
});
test('任务 R6：各类别卡片数量、名词性与六格、动词六人称和过去四式',()=>{
  const quotas={'ru-32':{形容副词:20,比较级:12,名词:10,句型:5,表达:5},'ru-33':{表达:15,名词:20,不定式:10,形容词:10,句型:5},'ru-34':{名词:25,句型:5}};
  for(const [id,quota] of Object.entries(quotas)) for(const [tag,count] of Object.entries(quota)) {
    const matches=row=>tag==='形容副词'?row.tags.split(';').some(t=>['形容词','副词'].includes(t)):row.tags.split(';').includes(tag);
    assert.equal(r6Rows.filter(row=>row.lesson===id && matches(row)).length,count,id+' '+tag);
  }
  const persons=[/^я /,/^ты /,/^он\/она́ /,/^мы /,/^вы /,/^они́ /];
  for(const row of r6Rows) {
    checkR6Text(row,row.id);const tags=row.tags.split(';');
    for(const field of ['front','back','example','example_zh','note','tags']) assert(row[field]?.trim(),row.id+' '+field);
    assert.match(row.example,/[.?!][»”"]?$/);assert.match(row.example_zh,/[㐀-鿿]/);assert.doesNotMatch(row.front,/[A-Za-z]/);
    if(tags.includes('名词')) {
      assert.match(row.note,/^名词（[阳阴中]/,row.id+' 名词标性');
      const ordered=row.note.match(/单数六格（主、属、与、宾、工具、前置）：([^；]+)/)?.[1].split(' / ');
      if(ordered){assert.equal(ordered.length,6,row.id+' 六格顺序');assert(ordered.every(form=>ruWords(form).length));}
      else for(const name of ['主格','属格','与格','宾格','工具格','前置格']) assert(ruWords(row.note.match(new RegExp('(?:'+name+'单数|单数'+name+'|'+name+')：([^；]+)'))?.[1]||'').length,row.id+' '+name);
    }
    if(tags.includes('不定式')) {
      const groups=[...row.note.matchAll(/六个人称(?:（[^）]+）)?：((?:[^；]*；){5}[^；]*)/g)].map(m=>m[1].split('；'));
      assert(groups.length,row.id+' 六个人称');
      for(const forms of groups) forms.forEach((form,i)=>{assert.match(form,persons[i]);assert(ruWords(form).length>(i===2?2:1));});
      const past=[...row.note.matchAll(/(?:过去时|过去时四形式)：([^；]+)/g)].map(m=>m[1].split(' / '));
      assert(past.length,row.id+' 过去时');for(const forms of past){assert.equal(forms.length,4);assert(forms.every(form=>ruWords(form).length));}
      assert.match(row.note,/未完成体|完成体/);assert.match(row.note,/体配对|体说明/);
    }
  }
});
test('任务 R6：整句、指定表达与含变位动词的多词短语只生成识别卡',()=>{
  const finite=new Set();
  for(const row of initialRows.filter(r=>r.lang==='ru')) {
    for(const match of row.note.matchAll(/六个人称(?:（[^）]+）)?：((?:[^；]*；){5}[^；]*)/g))
      for(const part of match[1].split('；')) ruWords(part).slice(part.startsWith('он/')?2:1).forEach(w=>finite.add(w));
    for(const match of row.note.matchAll(/(?:过去时|过去时四形式|命令式)：([^；]+)/g)) ruWords(match[1]).forEach(w=>finite.add(w));
  }
  for(const row of r6Rows) {
    const tags=row.tags.split(';'),words=ruWords(row.front);
    if(tags.some(t=>['句型','表达'].includes(t)) || /[.?!][»”"]?$/.test(row.front) || words.length>1 && words.some(w=>finite.has(w))) assert(tags.includes('phrase'),row.id+' phrase');
    assert.deepEqual(plain(api.expandCards([row]).map(c=>c.direction)),tags.includes('phrase')?['r']:['r','p']);
  }
});
test('任务 R6：六篇阅读按周关联、体裁轮换、22–26句与200–260词',()=>{
  const fronts=new Map(initialRows.filter(r=>r.lang==='ru').map(r=>[ruDeaccent(r.front),r.lesson]));
  const genres=['对话','日记','邮件','短故事','描写','通知或广告'];let previous=api.READINGS['ru-r54'].genre;
  for(let i=0;i<6;i++) {
    const id='ru-r'+(55+i),item=api.READINGS[id],week=32+Math.floor(i/2);assert(item,id+' 存在');
    assert.equal(item.id,id);assert.equal(item.lang,'ru');assert.equal(item.week,week);assert.equal(item.afterLesson,'ru-'+week);
    assert.equal(item.genre,genres[i]);assert.notEqual(item.genre,previous);previous=item.genre;checkR6Text(item,id);
    assert.match(item.title,/[㐀-鿿]/);assert(item.sentences.length>=22 && item.sentences.length<=26);
    const words=item.sentences.flatMap(s=>ruWords(s.text)).length;assert.equal(item.words,words);assert(words>=200 && words<=260,id+' 词数：'+words);
    for(const sentence of item.sentences){assert.match(sentence.text,/[.?!][»”"]?$/);assert.match(sentence.zh,/[㐀-鿿]/);assert.doesNotMatch(sentence.text,/[A-Za-z]/);}
    assert.equal(item.questions.length,4);assert(item.questions.every(q=>Array.isArray(q.options)));checkR2Questions(item.questions,id);
    assert(item.questions.some(q=>/推断|指代|指的是/.test(q.prompt)),id+' 推断或指代');
    assert.equal(item.keyWords.length,5);assert.equal(new Set(item.keyWords.map(w=>ruDeaccent(w.word))).size,5);
    for(const word of item.keyWords){const from=fronts.get(ruDeaccent(word.word));assert(from && from<=item.afterLesson,id+' 已学重点词：'+word.word);assert.match(word.zh,/[㐀-鿿]/);}
    assert(item.retell.length>=3 && item.retell.length<=5);item.retell.forEach(point=>assert.match(point,/[㐀-鿿]/));
  }
  for(let week=32;week<=34;week++) assert.equal(Object.values(api.READINGS).filter(r=>r.lang==='ru' && r.week===week).length,2);
});
test('任务 R6：新卡例句、课内阅读与阅读线均执行原有推导式词汇范围检查',()=>{
  for(const id of R6_LESSONS) assert.deepEqual(ruVocabularyMisses(id,[...r6Rows.filter(r=>r.lesson===id).map(r=>({id:r.id,text:r.example})),...api.LESSONS[id].reading.sentences]),[],id+' 例句和课文未学词');
  for(let i=55;i<=60;i++){const item=api.READINGS['ru-r'+i];assert.deepEqual(ruVocabularyMisses(item.afterLesson,item.sentences),[],item.id+' 未学词');}
  for(const week of [33,34]) {
    const row=r6Rows.find(r=>r.lesson==='ru-'+week && r.tags.split(';').includes('名词'));assert(row);
    assert(!ruKnown('ru-'+(week-1),row.front),'后课名词不能提前通过：'+row.front);
  }
  const row=r6Rows[0],before=row.example;
  try{row.example='Гиппопота́м.';assert(!ruKnown('ru-34','гиппопотам'),'新例句不能给自身扩充词汇');}finally{row.example=before;}
});
test('任务 R6：比较级派生保留词卡来源、词性与课次限制，重音检查拒绝错误',()=>{
  const row=initialRows.find(r=>r.lang==='ru' && ruDeaccent(r.front)==='лёгкий');assert(row);
  assert(ruR6Forms('лёгкий',row,'ru-32').includes('легче'));
  assert.deepEqual(ruR6Forms('лёгкий',row,'ru-31'),[]);
  assert.deepEqual(ruR6Forms('лёгкий',{...row,lesson:'ru-33'},'ru-32'),[]);
  assert.deepEqual(ruR6Forms('лёгкий',{...row,tags:'名词'},'ru-32'),[]);
  assert.deepEqual(ruR6Forms('лёгкий',{...row,front:'сло́жный'},'ru-32'),[]);
  const regular=initialRows.find(r=>r.lang==='ru' && ruDeaccent(r.front)==='интересный');assert(regular);
  assert.deepEqual(ruR6Forms('интересный',regular,'ru-32'),['интереснее','интересней']);
  for(const [base,wrong] of [['ежедневно','ежедневнее'],['намного','намногее'],['твёрдый','твёрдее'],['толстый','толстее'],['чистый','чистее']]) {
    const card=initialRows.find(r=>r.lang==='ru' && ruDeaccent(r.front)===base);assert(card);
    assert(!ruR6Forms(base,card,'ru-34').includes(wrong),'不能生成不存在的比较级：'+wrong);
    assert(!ruKnown('ru-34',wrong),'完整词表也不放行：'+wrong);
  }
  assert.doesNotThrow(()=>checkR6Text('По-мо́ему, э́то пра́вильно. Я пишу́ моему́ дру́гу.','观点与与格'));
  assert.throws(()=>checkR6Text('По-моему́, э́то пра́вильно.','观点重音'));
  assert.throws(()=>checkR6Text('Я пишу́ мо́ему дру́гу.','与格重音'));
  for(const wrong of ['самолёт\u0301','интереснее','больше́','деше́вый','компа́ктны́й']) assert.throws(()=>checkR6Text(wrong,'错误重音样本'));
});
test('任务 R6：三课六篇 UI 完整，浏览内容不改变真实进度',()=>{
  const {api:a,document}=createAPI(true,html);a.initialize();const before=plain(a.getData().state);
  for(const id of R6_LESSONS) {
    a.openLesson(id);const page=document.getElementById('content').textContent;
    for(const field of ['name','dailyTime','dates']) assert(page.includes(a.LESSONS[id][field]));
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);assert.doesNotMatch(page.replace(/一封信/g,''),/[死杀封炸战坑砍]/);
  }
  for(let i=55;i<=60;i++) {
    const id='ru-r'+i;a.openReadingItem(id);const page=document.getElementById('content').textContent;
    assert(page.includes(a.READINGS[id].title));assert.equal(document.querySelectorAll('[data-question]').length,4);
    assert.equal(document.querySelectorAll('details').filter(n=>n.querySelector('summary')?.textContent==='查看本句中文').length,a.READINGS[id].sentences.length);
    assert.doesNotMatch(page.replace(/一封信/g,''),/[死杀封炸战坑砍]/);
  }
  assert.deepEqual(plain(a.getData().state),before);
});

test('任务 M0：第三种语言注册与旧进度兼容',() => {
  // M0 的无马来语内容状态用夹具保留；实际 M1 内容另行验证。
  const {api:a,document,cache}=createAPI(true,fixtureHTML(initialRows.filter(row=>row.lang!=='ms'),initialState));
  for (const [id,item] of Object.entries(a.LESSONS)) if(item.lang==='ms') delete a.LESSONS[id];
  for (const [id,item] of Object.entries(a.READINGS)) if(item.lang==='ms') delete a.READINGS[id];
  a.initialize();
  assert.deepEqual(plain(a.LANGS.slice(0,3)),['es','ru','ms']);
  assert.equal(a.LANG_INFO.ms.short,'马来语');assert.equal(a.LANG_INFO.ms.long,'马来语');
  const old=emptyState();delete old.settings.newPerDay.ms;
  const beforeOld=plain(old),checked=a.validateState(old);
  assert.deepEqual(plain(checked.settings.newPerDay),{es:15,ru:10,ms:10,uz:0,kk:0});
  assert.deepEqual(old,beforeOld,'校验不能修改旧进度对象');
  for (const lang of a.LANGS) {
    const missing=plain(old);delete missing.settings.newPerDay[lang];
    assert.equal(a.validateState(missing).settings.newPerDay[lang],a.LANG_INFO[lang].newPerDay);
    for (const value of [0,999]) {
      const valid=plain(old);valid.settings.newPerDay[lang]=value;
      assert.equal(a.validateState(valid).settings.newPerDay[lang],value);
    }
    for (const value of [-1,'x',1000,1.5,null,true,undefined]) {
      const invalid=plain(old);invalid.settings.newPerDay[lang]=value;
      assert.throws(()=>a.validateState(invalid),/0–999/,lang+' 非法额度');
    }
  }
  const cached=createAPI(true,fixtureHTML(initialRows,old));
  cached.cache.set('language-srs:v1:/srs/index.html',JSON.stringify({state:{...old,updatedAt:'2026-09-15T00:00:00.000Z'}}));
  cached.api.initialize();
  assert.equal(cached.api.getData().source,'本地缓存');
  assert.equal(cached.api.getData().state.settings.newPerDay.ms,10);

  const clickTab=tab=>document.getElementById('app').listeners.click[0]({target:{closest:()=>document.querySelectorAll('[data-tab]').find(node=>node.dataset.tab===tab)}});
  const beforeBrowse=plain(a.getData().state);
  clickTab('lessons');
  const page=document.getElementById('content').innerHTML;
  assert(page.indexOf('西语课程')<page.indexOf('俄语课程'));
  assert(page.indexOf('俄语课程')<page.indexOf('马来语课程'));
  assert.equal(document.querySelectorAll('[data-lesson]').length,79);
  assert.equal(document.querySelector('section[aria-label="马来语课程"]').querySelector('.course-picker').innerHTML,'');
  assert.equal(Object.values(a.LESSONS).filter(item=>item.lang==='ms').length,0);
  clickTab('readings');
  const readingSections=document.querySelectorAll('section[aria-label]').map(node=>node.getAttribute('aria-label'));
  assert(readingSections.indexOf('俄语阅读')<readingSections.indexOf('马来语阅读'));
  assert.match(document.querySelector('section[aria-label="马来语阅读"]').textContent,/这门语言暂时没有阅读篇目。/);
  assert.equal(Object.values(a.READINGS).filter(item=>item.lang==='ms').length,0);
  clickTab('review');
  assert.equal(document.getElementById('language').querySelector('option[value="ms"]').textContent,'ms · 马来语');
  document.getElementById('app').listeners.change[0]({target:{id:'language',value:'ms'}});
  assert.match(document.getElementById('content').textContent,/当前没有待复习卡片/);
  clickTab('stats');
  const [cardTable,readingTable]=document.querySelectorAll('.stats-table');
  const rowFor=table=>table.querySelector('tbody').querySelectorAll('tr').find(row=>row.querySelector('th').textContent==='ms · 马来语');
  assert.deepEqual(rowFor(cardTable).querySelectorAll('td').map(node=>node.textContent),['0','0','0','0','0','0','—']);
  assert.deepEqual(rowFor(readingTable).querySelectorAll('td').map(node=>node.textContent),['0 / 0','—']);
  assert.deepEqual(plain(a.getData().state),beforeBrowse,'浏览页面不改进度');
  clickTab('settings');
  const form=document.getElementById('limits'),input=document.getElementById('limit-ms');
  assert.equal(input.getAttribute('name'),'ms');assert.equal(input.value,'10');
  const submit=()=>document.getElementById('app').listeners.submit[0]({target:form,preventDefault(){}});
  for (const [lang,value] of Object.entries({es:15,ru:10,ms:7})) form.elements[lang].value=String(value);
  submit();
  assert.equal(a.getData().state.settings.newPerDay.ms,7);
  assert.deepEqual(plain(a.getData().state.cards),beforeBrowse.cards);
  assert.deepEqual(plain(a.getData().state.log),beforeBrowse.log);
  const beforeInvalid=plain(a.getData().state),cacheBeforeInvalid=[...cache];
  form.elements.es.value='99';form.elements.ru.value='98';
  for (const value of ['-1','x','1000','1.5']) {
    input.value=value;submit();
    assert.match(a.getData().notice,/每日新卡数须为 0–999 的整数/);
    assert.deepEqual(plain(a.getData().state),beforeInvalid,'非法额度不能部分应用');
  }
  assert.deepEqual([...cache],cacheBeforeInvalid);
  for (const incoming of [old,checked,{...old,settings:{newPerDay:{es:99,ru:98,ms:42}}}]) {
    const merged=a.mergeProgress(a.getData().state,a.validateState(incoming));
    assert.deepEqual(plain(merged.settings),beforeInvalid.settings,'合并保留本机 ms 额度');
    assert.equal(merged.settings.newPerDay.ms,7);
  }

  assert.equal(fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8').split('\n')[0],'id,lang,lesson,front,back,example,example_zh,note,tags');
  assert.equal(a.getData().rows.filter(row=>row.lang==='ms').length,0);
  // 固定为文件进度时间，单独验证迁移与保存；避免未来运行时触发既有的 60 天日志清理。
  const legacy=plain(initialState);delete legacy.settings.newPerDay.ms;
  const now=new Date(initialState.updatedAt),migrated=a.validateState(legacy,now);
  const saved=a.serializeDocument(document,initialRows,migrated,initialState.updatedAt,'file');
  const parsed=new DocumentModel(saved),savedState=parsed.getElementById('state-data').textContent;
  assert.deepEqual(JSON.parse(savedState),{...initialState,settings:plain(migrated.settings)});
  const progressBytes=text=>{
    const start=text.indexOf('\n  "cards":');assert(start>=0);
    return Buffer.from(text.slice(start));
  };
  assert.deepEqual(progressBytes(savedState),progressBytes(blocks[1][1]),'cards 与 log 原始字节不变');
  const reopened=a.validateState(JSON.parse(savedState),now);
  const savedAgain=a.serializeDocument(parsed,JSON.parse(parsed.getElementById('cards-data').textContent),reopened,initialState.updatedAt,'file');
  assert.deepEqual(progressBytes(new DocumentModel(savedAgain).getElementById('state-data').textContent),progressBytes(blocks[1][1]));
  assert.equal(reopened.settings.newPerDay.ms,10);
});

// U1：1995 年拉丁字母方案与第一轮五课。旧数据行数来自现有来源 CSV，不依赖字节偏移。
const uzRows=initialRows.filter(row=>row.lang==='uz');
const uzLessonIds=Array.from({length:5},(_,i)=>'uz-'+String(i+1).padStart(2,'0'));
const uzTokens=text=>String(text).toLocaleLowerCase().match(/[a-zʻʼ]+/g)||[];
const uzSuffixes={
  1:[],
  2:['man','san','miz','siz','dir','lar','mi'],
  3:['lar','im','ing','i','m','ng','si','imiz','ingiz','miz','ngiz','lari'],
  4:['da','ga','ka','qa','dan'],
  5:['aman','asan','adi','amiz','asiz','adilar','yman','ysan','ydi','ymiz','ysiz','ydilar','mayman','maysan','maydi','maymiz','maysiz','maydilar'],
  6:['ni','ning'],
  7:['dim','ding','di','dik','dingiz','dilar','madim','mading','madi','madik','madingiz','madilar'],
  8:['ta','emasman','emassan','emasmiz','emassiz'],
  9:['roq'],
  10:[]
};
const uzNames=new Set(['aziz','nilufar','bobur','dilnoza','toshkent','samarqand','buxoro','pekin','xitoy']);
function uzKnownWords(week) {
  const learned=uzRows.filter(row=>Number(row.lesson.slice(3))<=week);
  const known=new Set([...uzNames,'bu']); // uz-01 international words use the uz-02 demonstrative in short examples.
  for(const row of learned) for(const field of ['front','note']) for(const token of uzTokens(row[field])) known.add(token);
  const suffixes=Array.from({length:week},(_,i)=>uzSuffixes[i+1]).flat().sort((a,b)=>b.length-a.length);
  function allowed(word,depth=0) {
    if(known.has(word)) return true;
    if(depth>=3) return false;
    return suffixes.some(ending=>word.endsWith(ending)&&word.length>ending.length+1&&allowed(word.slice(0,-ending.length),depth+1));
  }
  return allowed;
}
test('U1：旧行位于乌兹别克语行之前；新 CSV 与内嵌行一致且 id 连续',()=>{
  const oldCount=['es','ru','ms'].reduce((n,lang)=>{
    const raw=fs.readFileSync(path.join(__dirname,'cards',lang+'.csv'),'utf8');
    return n+(raw.trim()==='id,lang,lesson,front,back,example,example_zh,note,tags'?0:api.parseCSV(raw).filter(r=>r.lang!=='ms'||Number(r.lesson.slice(3))<=8).length);
  },0);
  assert.deepEqual(preM3Rows.slice(0,oldCount),preM3Rows.filter(row=>!['uz','kk'].includes(row.lang)));
  assert.deepEqual(preM3Rows.slice(oldCount,oldCount+uzRows.length),uzRows);
  assert.deepEqual(plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','uz.csv'),'utf8'))),uzRows);
  assert.deepEqual(uzRows.map(row=>row.id),Array.from({length:uzRows.length},(_,i)=>'uz-'+String(i+1).padStart(4,'0')));
  assert.equal(new Set(uzRows.map(row=>row.front.toLocaleLowerCase().replace(/[’']/g,'ʻ'))).size,uzRows.length);
  assert.deepEqual(uzRows.filter(row=>row.tags.split(';').includes('letter')).map(row=>row.front),
    'A a|B b|D d|E e|F f|G g|H h|I i|J j|K k|L l|M m|N n|O o|P p|Q q|R r|S s|T t|U u|V v|X x|Y y|Z z|Oʻ oʻ|Gʻ gʻ|Sh sh|Ch ch|Ng ng'.split('|'));
  assert.equal(uzRows.filter(row=>row.lesson==='uz-01'&&row.tags.split(';').includes('international')).length,15);
  for(const row of uzRows) {
    assert(row.front&&row.back&&row.example&&row.example_zh,row.id);
    assert(!/[\u0400-\u04ff'’]/.test(row.front+' '+row.example),row.id+' 拼写');
    const directions=plain(api.expandCards([row]).map(card=>card.direction));
    assert.deepEqual(directions,row.tags.split(';').some(tag=>['letter','phrase'].includes(tag))?['r']:['r','p'],row.id);
  }
});
test('U1：五课规模、讲解、练习和阅读符合课程安排',()=>{
  assert.deepEqual(uzLessonIds.map(id=>uzRows.filter(row=>row.lesson===id).length),[44,40,40,40,40]);
  assert.deepEqual(uzLessonIds.map(id=>api.expandCards(uzRows.filter(row=>row.lesson===id)).length),[59,75,75,75,75]);
  for(const [index,id] of uzLessonIds.entries()) {
    const item=api.LESSONS[id];assert(item,id);
    assert.equal(item.week,index+1);assert.equal(item.lang,'uz');assert.equal(item.dates,'');assert(!('dailyTime' in item));
    assert.equal(item.exercises.length,10,id);
    const prose=item.explanation();
    assert.match(prose,/^<div class="lesson-text">/);
    assert.match(prose,/<h4>常见错误<\/h4>/);assert.match(prose,/<h4>写作任务<\/h4>/);
    const han=(prose.match(/[\u4e00-\u9fff]/g)||[]).length;
    assert(han>=400&&han<=900,id+' 讲解中文字符 '+han);
    assert.doesNotMatch(prose+' '+item.goal+item.writingTask,/死|杀|绞|封|炸|翻车|战|马甲|病灶|尸|打回|实弹|作战|收割|坑|砍/);
    for(const q of item.exercises) {
      assert(q.prompt&&q.answer,id);
      if(q.options)assert.equal(q.options.filter(x=>x===q.answer).length,1,id+' '+q.prompt);
      else assert(uzRows.some(row=>row.front===q.answer),id+' 文本答案不在词表：'+q.answer);
    }
    if(index<2) assert.equal(item.reading,null);
    else {
      assert(item.reading.sentences.length>=6&&item.reading.sentences.length<=10,id);
      assert(item.reading.questions.length>=3&&item.reading.questions.length<=4,id);
      assert.deepEqual(item.exercises.slice(-item.reading.questions.length),item.reading.questions);
      for(const sentence of item.reading.sentences)assert(sentence.text&&sentence.zh,id);
      for(const q of item.reading.questions)assert(q.options.length===3&&q.options.filter(x=>x===q.answer).length===1,id);
    }
  }
});
test('U1：卡片例句与课文只用到本课之前已学的词形和词尾',()=>{
  for(let week=1;week<=5;week++) {
    const id='uz-'+String(week).padStart(2,'0'),allowed=uzKnownWords(week);
    const examples=uzRows.filter(row=>row.lesson===id).map(row=>({label:row.id,text:row.example,short:week===1&&row.tags.split(';').includes('international')}));
    const reading=(api.LESSONS[id].reading?.sentences||[]).map((sentence,i)=>({label:id+' 第'+(i+1)+'句',text:sentence.text}));
    for(const {label,text,short} of [...examples,...reading]) {
      const words=uzTokens(text);
      assert(words.length>=(short?2:4)&&words.length<=(short?3:10),label+' 例句词数 '+words.length);
      for(const word of words)assert(allowed(word),label+' 超出词表：'+word+'（'+text+'）');
    }
  }
});
test('U1：uz-02 至 uz-05 的非短语例句框架每课最多重复三次',()=>{
  for(const id of uzLessonIds.slice(1)) {
    const frames=new Map();
    for(const row of uzRows.filter(row=>row.lesson===id&&!row.tags.split(';').includes('phrase'))) {
      const stem=row.front.toLocaleLowerCase().replace(/moq$/,'');
      const frame=row.example.toLocaleLowerCase().split(stem).join('□').replace(/\s+/g,' ').trim();
      const ids=frames.get(frame)||[];ids.push(row.id);frames.set(frame,ids);
      assert(ids.length<=3,id+' 重复例句框架：'+frame+'（'+ids.join('、')+'）');
    }
  }
});
test('U1：uz-02 至 uz-05 每课至少四道非阅读语法题',()=>{
  for(const id of uzLessonIds.slice(1)) {
    const lesson=api.LESSONS[id],readingCount=lesson.reading?.questions.length||0;
    const grammar=lesson.exercises.slice(0,lesson.exercises.length-readingCount)
      .filter(q=>q.prompt.includes('____')||Array.isArray(q.options));
    assert(grammar.length>=4,id+' 语法题数 '+grammar.length);
  }
});

const uzRound2Ids=Array.from({length:5},(_,i)=>'uz-'+String(i+6).padStart(2,'0'));
const uzRound2Rows=uzRows.filter(row=>uzRound2Ids.includes(row.lesson));
test('U2：五课在旧行后追加，id 连续，CSV 同步且 front 唯一',()=>{
  const priorUzCount=uzRows.filter(row=>Number(row.lesson.slice(3))<6).length;
  const priorCount=preM3Rows.findIndex(row=>row.lesson==='uz-06');
  const csvRows=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards','uz.csv'),'utf8')));
  assert.deepEqual(preM3Rows.slice(0,priorCount),preM3Rows.filter(row=>row.lang!=='kk'&&!uzRound2Ids.includes(row.lesson)));
  assert.deepEqual(preM3Rows.slice(priorCount,priorCount+uzRound2Rows.length),uzRound2Rows);
  assert.deepEqual(csvRows.slice(0,priorUzCount),uzRows.slice(0,priorUzCount),'旧 uz 行按原顺序逐条一致');
  assert.deepEqual(csvRows.slice(priorUzCount),uzRound2Rows);
  assert.deepEqual(uzRows.map(row=>row.id),Array.from({length:uzRows.length},(_,i)=>'uz-'+String(i+1).padStart(4,'0')));
  assert.equal(new Set(uzRows.map(row=>row.front.toLocaleLowerCase().replace(/[’']/g,'ʻ'))).size,uzRows.length);
  for(const row of uzRound2Rows) {
    assert(row.front&&row.back&&row.example&&row.example_zh,row.id);
    assert.doesNotMatch(row.front+' '+row.example,/[\u0400-\u04ff'’]/,row.id+' 正字法');
    assert.doesNotMatch((row.back+' '+row.example_zh+' '+row.note).replace(/一封信/g,''),/死|杀|绞|封|炸|翻车|战|马甲|病灶|尸|打回|实弹|作战|收割|坑|砍/,row.id+' 中文措辞');
    assert.deepEqual(plain(api.expandCards([row]).map(card=>card.direction)),row.tags.split(';').some(tag=>['letter','phrase'].includes(tag))?['r']:['r','p'],row.id);
  }
  assert.match(uzRound2Rows.find(row=>row.front==='baliq').note,/baligʻi/);
  assert.match(uzRound2Rows.find(row=>row.front==='mashq').note,/mashqi/);
});
test('U2：每课四十词、七十五卡、十题和规定篇幅',()=>{
  assert(api.LESSONS['uz-01'].exercises.filter(q=>/字母|撇号|oʻ|gʻ/.test(q.prompt)).length>=3,'第一课至少三道字母题');
  for(const [i,id] of uzRound2Ids.entries()) {
    const lesson=api.LESSONS[id],entries=uzRound2Rows.filter(row=>row.lesson===id);
    assert(lesson,id);assert.equal(lesson.week,i+6);assert.equal(lesson.lang,'uz');
    assert.equal(lesson.dates,'');assert(!('dailyTime' in lesson));
    assert.equal(entries.length,40,id);assert.equal(entries.filter(row=>row.tags.split(';').includes('phrase')).length,5,id);
    assert.equal(api.expandCards(entries).length,75,id);
    const prose=lesson.explanation(),han=(prose.match(/[\u4e00-\u9fff]/g)||[]).length;
    assert.match(prose,/^<div class="lesson-text">/);assert.match(prose,/<h4>常见错误<\/h4>/);
    assert.match(prose,/<h4>写作任务<\/h4>/);assert(han>=400&&han<=900,id+' 讲解汉字数 '+han);
    assert.doesNotMatch(prose+' '+lesson.goal+lesson.writingTask,/死|杀|绞|封|炸|翻车|战|马甲|病灶|尸|打回|实弹|作战|收割|坑|砍/);
    assert.equal(lesson.exercises.length,10,id);
    assert.equal(lesson.reading.sentences.length>= (i===4?12:6) && lesson.reading.sentences.length<=(i===4?16:10),true,id);
    assert.equal(lesson.reading.questions.length,i===4?4:3,id);
    assert.deepEqual(lesson.exercises.slice(-lesson.reading.questions.length),lesson.reading.questions);
    for(const question of lesson.exercises) {
      assert(question.prompt&&question.answer,id);
      if(question.options) assert(question.options.length===3&&question.options.filter(x=>x===question.answer).length===1,id+' '+question.prompt);
      else assert(uzRows.some(row=>row.front===question.answer),id+' '+question.answer);
    }
    const grammar=lesson.exercises.slice(0,-lesson.reading.questions.length).filter(q=>q.prompt.includes('____')||Array.isArray(q.options));
    assert(grammar.length>=(i===4?6:4),id+' 语法题 '+grammar.length);
  }
});
test('U2：例句和课文只用本课前已学词形及按课次开放的词尾',()=>{
  for(let week=6;week<=10;week++) {
    const id='uz-'+String(week).padStart(2,'0'),allowed=uzKnownWords(week);
    const segments=[...uzRound2Rows.filter(row=>row.lesson===id).map(row=>({label:row.id,text:row.example})),
      ...api.LESSONS[id].reading.sentences.map((sentence,i)=>({label:id+' 课文 '+(i+1),text:sentence.text}))];
    for(const {label,text} of segments) {
      const words=uzTokens(text);assert(words.length>=4&&words.length<=10,label+' 词数 '+words.length);
      for(const word of words)assert(allowed(word),label+' 未学词形 '+word+'：'+text);
    }
  }
});
test('U2：非短语例句去掉词头后，同课框架最多重复三次',()=>{
  for(const id of uzRound2Ids) {
    const frames=new Map();
    for(const row of uzRound2Rows.filter(row=>row.lesson===id&&!row.tags.split(';').includes('phrase'))) {
      const stem=row.front.toLocaleLowerCase().replace(/moq$/,'');
      const frame=row.example.toLocaleLowerCase().split(stem).join('□').replace(/\s+/g,' ').trim();
      const ids=frames.get(frame)||[];ids.push(row.id);frames.set(frame,ids);
      assert(ids.length<=3,id+' 例句框架：'+frame+'（'+ids.join('、')+'）');
    }
  }
});

const kkLessonIds=Array.from({length:5},(_,i)=>'kk-'+String(i+1).padStart(2,'0'));
const kkRows=initialRows.filter(row=>row.lang==='kk');
const kkNames=new Set(['асан','айгүл','ерлан','дана','алматы','астана','шымкент','бейжің','қытай']);
const kkTokens=text=>String(text).toLocaleLowerCase().match(/[\p{L}]+(?:-[\p{L}]+)?/gu)||[];
// Each stage only removes endings introduced by that lesson or earlier lessons.
const kkSuffixes={
  1:[],
  2:'мын мін бын бін пын пін сың сің сыз сіз мыз міз быз біз пыз піз сыңдар сіңдер сыздар сіздер'.split(' '),
  3:'лар лер дар дер тар тер ым ім м ың ің ң ыңыз іңіз ңыз ңіз ы і сы сі ымыз іміз мыз міз ларың лерің дарың дерің тарың терің лары лері дары дері тары тері да де та те'.split(' '),
  4:'да де та те нда нде ға ге қа ке на не а е дан ден тан тен нан нен'.split(' '),
  5:'амын емін ймын ймін ады еді йды йді асын есін аймын еймін айды ейді маймын меймін баймын беймін паймын пеймін майды мейді байды бейді пайды пейді ма ме ба бе па пе'.split(' '),
  6:'ны ні ды ді ты ті ның нің дың дің тың тің н'.split(' '),
  7:'дым дім тым тім дың дің тың тің дыңыз діңіз тыңыз тіңіз дық дік тық тік ды ді ты ті мады меді бады беді пады педі'.split(' '),
  8:[],
  9:'рақ рек ырақ ірек лау леу дау деу тау теу'.split(' '),
  10:[]
};
function kkKnownWords(week) {
  const known=new Set(kkNames);
  for(const row of kkRows.filter(row=>Number(row.lesson.slice(3))<=week&&!row.tags.split(';').includes('letter')))
    for(const field of ['front','note']) for(const word of kkTokens(row[field])) known.add(word);
  if(week>=1) known.add('бұл'); // first-lesson international word examples anticipate lesson 2.
  if(week>=2) for(const word of 'ма ме ба бе па пе'.split(' ')) known.add(word);
  if(week>=3) for(const word of 'менің сенің сіздің оның біздің үйде үстелде отбасымда бөлмеде'.split(' ')) known.add(word);
  const suffixes=Array.from({length:week},(_,i)=>kkSuffixes[i+1]).flat().sort((a,b)=>b.length-a.length);
  function allowed(word,depth=0) {
    if(known.has(word)) return true;
    // Instrumental -мен/-бен/-пен is not introduced in these lessons.
    if(/[мбп]ен$/.test(word)) return false;
    if(depth>=3) return false;
    return suffixes.some(ending=>word.endsWith(ending)&&word.length>ending.length+1&&allowed(word.slice(0,-ending.length),depth+1));
  }
  return allowed;
}
test('K1：旧行保持前缀，五课 CSV 与内嵌 JSON 同步且 id 连续',()=>{
  const oldCsvRows=['es','ru','ms','uz'].map(lang=>{
    const raw=fs.readFileSync(path.join(__dirname,'cards',lang+'.csv'),'utf8');
    return raw.trim()==='id,lang,lesson,front,back,example,example_zh,note,tags'?[]:plain(api.parseCSV(raw)).filter(r=>r.lang!=='ms'||Number(r.lesson.slice(3))<=8);
  });
  const oldCount=oldCsvRows.reduce((n,part)=>n+part.length,0);
  assert.equal(preM3Rows.length,oldCount+kkRows.length);
  assert.deepEqual(preM3Rows.slice(0,oldCount),preM3Rows.filter(row=>row.lang!=='kk'));
  for(const [i,lang] of ['es','ru','ms','uz'].entries())
    assert.deepEqual(preM3Rows.slice(0,oldCount).filter(row=>row.lang===lang),oldCsvRows[i],lang+' 旧 CSV 行');
  assert.deepEqual(preM3Rows.slice(oldCount),kkRows);
  assert.deepEqual(plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards/kk.csv'),'utf8'))),kkRows);
  assert.deepEqual(kkRows.map(row=>row.id),Array.from({length:kkRows.length},(_,i)=>'kk-'+String(i+1).padStart(4,'0')));
  assert.equal(new Set(kkRows.map(row=>row.front.toLocaleLowerCase().replace(/[’']/g,"'"))).size,kkRows.length);
  for(const row of kkRows) {
    assert(row.front&&row.back&&row.example&&row.example_zh,row.id);
    assert.doesNotMatch(row.front+' '+row.example,/\u0301/,row.id+' 正字法不加重音');
    assert.doesNotMatch((row.back+' '+row.example_zh+' '+row.note).replace(/一封信/g,''),/死|杀|绞|封|炸|翻车|战|马甲|病灶|尸|打回|实弹|作战|收割|坑|砍/,row.id);
    assert.deepEqual(plain(api.expandCards([row]).map(card=>card.direction)),row.tags.split(';').some(tag=>['letter','phrase'].includes(tag))?['r']:['r','p'],row.id);
  }
});
test('K1：字母、国际词与每课规模正确；讲解、阅读及练习齐全',()=>{
  assert.deepEqual(kkLessonIds.map(id=>kkRows.filter(row=>row.lesson===id).length),[57,40,40,40,40]);
  assert.deepEqual(kkLessonIds.map(id=>api.expandCards(kkRows.filter(row=>row.lesson===id)).length),[72,75,75,75,75]);
  assert.deepEqual(kkRows.filter(row=>row.lesson==='kk-01'&&row.tags.split(';').includes('letter')).map(row=>row.front.split(' ')[0]),
    'А Ә Б В Г Ғ Д Е Ё Ж З И Й К Қ Л М Н Ң О Ө П Р С Т У Ұ Ү Ф Х Һ Ц Ч Ш Щ Ъ Ы І Ь Э Ю Я'.split(' '));
  assert.equal(kkRows.filter(row=>row.lesson==='kk-01'&&row.tags.split(';').includes('international')).length,15);
  for(const row of kkRows.filter(row=>row.tags.split(';').includes('letter'))) {
    assert.match(row.back,/读音提示/);assert.match(row.back,/俄语/);
    assert(row.example.toLocaleLowerCase().includes(row.front.split(' ')[1]),row.id+' 字母例词');
  }
  assert(kkRows.some(row=>row.front==='І і'&&row.front.includes('\u0456')));
  assert(kkRows.some(row=>row.front==='Һ һ'&&row.front.includes('\u04bb')));
  for(const row of kkRows.filter(row=>row.lesson==='kk-01'&&row.tags.split(';').includes('international')))
    assert.equal(row.example,'Бұл '+row.front+'.',row.id+' 国际词短句');
  assert.equal(kkRows.filter(row=>row.lesson==='kk-01'&&row.tags.split(';').includes('letter')&&/[ӘҒҚҢӨҰҮҺІ]/.test(row.front)).length,9);
  assert(api.LESSONS['kk-01'].exercises.filter(q=>/字母|特有|U\+0456|һ/.test(q.prompt)).length>=3);
  for(const [i,id] of kkLessonIds.entries()) {
    const item=api.LESSONS[id],entries=kkRows.filter(row=>row.lesson===id);
    assert(item,id);assert.equal(item.lang,'kk');assert.equal(item.week,i+1);assert.equal(item.dates,'');assert(!('dailyTime' in item));
    const prose=item.explanation(),han=(prose.match(/[\u4e00-\u9fff]/g)||[]).length;
    assert.match(prose,/^<div class="lesson-text">/);assert.match(prose,/<h4>常见错误<\/h4>/);assert.match(prose,/<h4>写作任务<\/h4>/);
    assert(han>=400&&han<=900,id+' 讲解汉字数 '+han);
    assert.doesNotMatch(prose+' '+item.goal+item.writingTask,/死|杀|绞|封|炸|翻车|战|马甲|病灶|尸|打回|实弹|作战|收割|坑|砍/,id);
    for(const row of entries.filter(row=>row.tags==='noun'&&i===2)) assert.match(row.note,/复数.*第三人称领属/,row.id);
    for(const row of entries.filter(row=>row.tags==='verb'&&i===4)) assert.match(row.note,/第一人称.*第三人称/,row.id);
    assert.equal(item.exercises.length,10,id);
    if(i===0) assert.equal(item.reading,null);
    else assert.equal(entries.filter(row=>row.tags.split(';').includes('phrase')).length,5,id);
    const questions=item.reading?.questions||[];
    if(i>=2) {
      assert(item.reading.sentences.length>=6&&item.reading.sentences.length<=10,id);
      assert(questions.length>=3&&questions.length<=4,id);
      assert.deepEqual(item.exercises.slice(-questions.length),questions,id);
      for(const sentence of item.reading.sentences)assert(sentence.text&&sentence.zh,id);
    } else assert.equal(item.reading,null,id);
    for(const q of item.exercises) {
      assert(q.prompt&&q.answer,id);
      if(q.options) assert(q.options.length===3&&q.options.filter(option=>option===q.answer).length===1,id+' '+q.prompt);
      else assert(kkRows.some(row=>row.front===q.answer),id+' 文本答案 '+q.answer);
    }
    if(i>=1) {
      const grammar=item.exercises.slice(0,item.exercises.length-questions.length).filter(q=>q.prompt.includes('____')||Array.isArray(q.options));
      assert(grammar.length>=4,id+' 语法题数 '+grammar.length);
    }
  }
});
test('K1：全部例句和课文限定在当课及之前的词与词尾',()=>{
  for(let week=1;week<=5;week++) {
    const id='kk-'+String(week).padStart(2,'0'),allowed=kkKnownWords(week);
    const segments=kkRows.filter(row=>row.lesson===id).map(row=>({label:row.id,text:row.example,tags:row.tags}));
    segments.push(...(api.LESSONS[id].reading?.sentences||[]).map((s,i)=>({label:id+' 课文 '+(i+1),text:s.text,tags:''})));
    for(const {label,text,tags} of segments) {
      const words=kkTokens(text);
      const letter=week===1&&tags.split(';').includes('letter');
      const international=week===1&&tags.split(';').includes('international');
      assert(words.length>=(letter?1:international?2:4)&&words.length<=(letter?1:international?3:10),label+' 词数 '+words.length);
      if(letter) continue; // 字母卡的例词用于认字，不作为第一课已学词。
      for(const word of words)assert(allowed(word),label+' 未学词形 '+word+'：'+text);
    }
  }
});
test('K1：非短语例句框架每课最多重复三次',()=>{
  for(const id of kkLessonIds.slice(1)) {
    const frames=new Map();
    for(const row of kkRows.filter(row=>row.lesson===id&&!row.tags.split(';').includes('phrase'))) {
      const stem=row.tags.split(';').includes('verb')?row.front.replace(/у$/,''):row.front;
      const frame=row.example.toLocaleLowerCase().split(stem.toLocaleLowerCase()).join('□').replace(/\s+/g,' ').trim();
      const ids=frames.get(frame)||[];ids.push(row.id);frames.set(frame,ids);
      assert(ids.length<=3,id+' 重复框架 '+frame+'（'+ids.join('、')+'）');
    }
  }
});

const kkRound2Ids=Array.from({length:5},(_,i)=>'kk-'+String(i+6).padStart(2,'0'));
const kkRound2Rows=kkRows.filter(row=>kkRound2Ids.includes(row.lesson));
test('K2：新行紧接旧行，id 连续，CSV 同步且 front 唯一',()=>{
  const previous=kkRows.filter(row=>Number(row.lesson.slice(3))<=5);
  const first=preM3Rows.findIndex(row=>row.lesson==='kk-06');
  const csvRows=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards/kk.csv'),'utf8')));
  assert.equal(first,preM3Rows.length-kkRound2Rows.length);
  assert.deepEqual(preM3Rows.slice(first),kkRound2Rows);
  assert.deepEqual(csvRows.slice(0,previous.length),previous,'前五课旧行逐条保持原文');
  assert.deepEqual(csvRows.slice(previous.length),kkRound2Rows);
  assert.equal(kkRound2Rows[0].id,'kk-'+String(previous.length+1).padStart(4,'0'));
  assert.deepEqual(kkRows.map(row=>row.id),Array.from({length:kkRows.length},(_,i)=>'kk-'+String(i+1).padStart(4,'0')));
  assert.equal(new Set(kkRows.map(row=>row.front.toLocaleLowerCase().replace(/[’']/g,"'"))).size,kkRows.length);
  for(const row of kkRound2Rows) {
    assert(row.front&&row.back&&row.example&&row.example_zh,row.id);
    assert.doesNotMatch(row.front+' '+row.example,/\u0301/,row.id+' 不加重音');
    assert.doesNotMatch((row.back+' '+row.example_zh+' '+row.note).replace(/一封信/g,''),/死|杀|绞|封|炸|翻车|战|马甲|病灶|尸|打回|实弹|作战|收割|坑|砍/,row.id);
    assert.deepEqual(plain(api.expandCards([row]).map(card=>card.direction)),row.tags.split(';').some(tag=>['letter','phrase'].includes(tag))?['r']:['r','p'],row.id);
  }
});
test('K2：五课规模、讲解、阅读和练习符合本轮要求',()=>{
  assert.equal(api.LESSONS['kk-01'].exercises.filter(q=>/字母|特有|U\+0456|һ/.test(q.prompt)).length>=3,true);
  for(const [i,id] of kkRound2Ids.entries()) {
    const lesson=api.LESSONS[id],entries=kkRound2Rows.filter(row=>row.lesson===id);
    assert(lesson,id);assert.equal(lesson.lang,'kk');assert.equal(lesson.week,i+6);
    assert.equal(lesson.dates,'');assert(!('dailyTime' in lesson));
    assert.equal(entries.length,40,id);
    assert(entries.filter(row=>row.tags.split(';').includes('phrase')).length>=4,id);
    assert.equal(api.expandCards(entries).length,entries.length*2-entries.filter(row=>row.tags.split(';').includes('phrase')).length,id);
    const prose=lesson.explanation(),han=(prose.match(/[\u4e00-\u9fff]/g)||[]).length;
    assert.match(prose,/^<div class="lesson-text">/);assert.match(prose,/<h4>常见错误<\/h4>/);assert.match(prose,/<h4>写作任务<\/h4>/);
    assert(han>=400&&han<=900,id+' 讲解汉字数 '+han);
    assert.doesNotMatch(prose+' '+lesson.goal+lesson.writingTask,/死|杀|绞|封|炸|翻车|战|马甲|病灶|尸|打回|实弹|作战|收割|坑|砍/,id);
    assert.equal(lesson.exercises.length,10,id);
    assert.equal(lesson.reading.sentences.length>= (i===4?12:6) && lesson.reading.sentences.length<=(i===4?16:10),true,id);
    assert.equal(lesson.reading.questions.length,i===4?4:3,id);
    assert.deepEqual(lesson.exercises.slice(-lesson.reading.questions.length),lesson.reading.questions,id);
    for(const q of lesson.exercises) {
      assert(q.prompt&&q.answer,id);
      if(q.options)assert(q.options.length===3&&q.options.filter(x=>x===q.answer).length===1,id+' '+q.prompt);
      else assert(kkRows.some(row=>row.front===q.answer),id+' 文本答案 '+q.answer);
    }
    const grammar=lesson.exercises.slice(0,-lesson.reading.questions.length).filter(q=>q.prompt.includes('____')||Array.isArray(q.options));
    assert(grammar.length>=(i===4?6:4),id+' 语法题 '+grammar.length);
  }
});
test('K2：例句和课文只使用已学词、note 形式及按课开放的词尾',()=>{
  const problems=[];
  for(let week=6;week<=10;week++) {
    const id='kk-'+String(week).padStart(2,'0'),allowed=kkKnownWords(week);
    const segments=[...kkRound2Rows.filter(row=>row.lesson===id).map(row=>({label:row.id,text:row.example})),
      ...api.LESSONS[id].reading.sentences.map((s,i)=>({label:id+' 课文 '+(i+1),text:s.text}))];
    for(const {label,text} of segments) {
      const words=kkTokens(text);
      if(words.length<4||words.length>10)problems.push(label+' 词数 '+words.length+'：'+text);
      for(const word of words)if(!allowed(word))problems.push(label+' 未学词形 '+word+'：'+text);
    }
  }
  assert.deepEqual(problems,[]);
});
test('K2：非短语例句去掉目标词后，同课框架最多重复三次',()=>{
  for(const id of kkRound2Ids) {
    const frames=new Map();
    for(const row of kkRound2Rows.filter(row=>row.lesson===id&&!row.tags.split(';').includes('phrase'))) {
      const stem=row.tags.split(';').includes('verb')?row.front.replace(/у$/,''):row.front;
      const frame=row.example.toLocaleLowerCase().split(stem.toLocaleLowerCase()).join('□').replace(/\s+/g,' ').trim();
      const ids=frames.get(frame)||[];ids.push(row.id);frames.set(frame,ids);
      assert(ids.length<=3,id+' 重复框架 '+frame+'（'+ids.join('、')+'）');
    }
  }
});

test('哈萨克语拉丁写法：2021 年方案逐字母转写；课程、复习卡显示，拼写卡作答前不显示；设置可关闭且不改进度',() => {
  const pairs=[
    ['Қазақстан','Qazaqstan'],['Менің атым Асан.','Menıñ atym Asan.'],['кітабым','kıtabym'],['үй','üi'],
    ['Иә, мен студентпін.','İä, men studentpın.'],['шай','şai'],['ұшақ','ūşaq'],['сөйлеу','söileu'],
    ['ғ ң ө һ х','ğ ñ ö h h'],['чемпион','tşempion'],['ащы','aştşy'],['аю','aiu'],['аяқ','aiaq'],
    ['актёр','aktior'],['объект','obekt'],['альбом','albom'],['экран','ekran'],['цирк','tsirk'],
    ['І і','I ı'],['Ы ы','Y y'],['Ю ю','İu iu'],['Щ щ','Ştş ştş'],['Ч ч','Tş tş'],['Ё ё','İo io']
  ];
  for (const [cyr,lat] of pairs) assert.equal(api.kkLatin(cyr),lat,cyr);
  // 全部哈萨克语卡片转写后不再含西里尔字母。
  for (const row of initialRows.filter(row=>row.lang==='kk')) for (const key of ['front','example']) assert.doesNotMatch(api.kkLatin(row[key]),/[Ѐ-ӿ]/,row.id+' '+key);
  const {api:a,document}=createAPI(true);a.initialize();
  const before=plain(a.getData().state);
  a.openLesson('kk-03');
  let page=document.getElementById('app').innerHTML;
  assert(page.includes('class="muted latin" lang="kk-Latn"'));
  assert(page.includes(api.kkLatin('Менің отбасымда төрт адам бар.')));
  a.openLesson('ru-05');
  assert(!document.getElementById('app').innerHTML.includes('class="muted latin"'),'只给哈萨克语显示');
  const kkRow=initialRows.find(row=>row.lang==='kk'&&!row.tags.split(';').some(tag=>['letter','phrase'].includes(tag)));
  const card=id=>a.expandCards([kkRow]).find(item=>item.direction===id);
  // 识别卡：正面显示词条的拉丁写法。
  a.setSession({day:'2026-09-30',lang:'kk',queue:[card('r')],again:[],done:0});
  document.getElementById('app').listeners.click[0]({target:{closest:()=>document.querySelectorAll('[data-tab]').find(node=>node.dataset.tab==='review')}});
  assert(document.getElementById('app').innerHTML.includes('>'+api.kkLatin(kkRow.front)+'<'),'识别卡显示拉丁写法');
  // 拼写卡作答前的正面模板里没有拉丁写法，避免提示答案。
  const spellingFront=runtime.slice(runtime.indexOf('const front = spelling ?'),runtime.indexOf('const back = !revealed'));
  const beforeColon=spellingFront.slice(0,spellingFront.indexOf('` : `'));
  assert(beforeColon.length>100 && !beforeColon.includes('latinLine'),'拼写卡正面不显示拉丁写法');
  // 设置页开关
  document.getElementById('app').listeners.click[0]({target:{closest:()=>document.querySelectorAll('[data-tab]').find(node=>node.dataset.tab==='settings')}});
  assert(document.getElementById('show-latin'),'设置页有拉丁写法开关');
  document.getElementById('app').listeners.change[0]({target:{id:'show-latin',checked:false}});
  a.openLesson('kk-03');
  page=document.getElementById('app').innerHTML;
  assert(!page.includes('class="muted latin"'),'关闭后不显示');
  document.getElementById('app').listeners.change[0]({target:{id:'show-latin',checked:true}});
  a.openLesson('kk-03');
  assert(document.getElementById('app').innerHTML.includes('class="muted latin"'),'重新打开后显示');
  assert.deepEqual(plain(a.getData().state),before,'开关不写入进度');
});

// 可选的离线编辑诊断：仍使用正式检查的推导器，按位置一次报告全部缺词。
const vocabularyFlag=process.argv.indexOf('--vocab-report');
if (vocabularyFlag!==-1) {
  assert(process.argv[vocabularyFlag+1],'--vocab-report 后需要 JSON 文件路径');
  const segments=[
    ...r6Rows.map(row=>({id:row.id,lesson:row.lesson,sentences:[{text:row.example}]})),
    ...R6_LESSONS.filter(id=>api.LESSONS[id]).map(id=>({id,lesson:id,sentences:api.LESSONS[id].reading.sentences})),
    ...Object.values(api.READINGS).filter(item=>/^ru-r(?:5[5-9]|60)$/.test(item.id)).map(item=>({id:item.id,lesson:item.afterLesson,sentences:item.sentences})),
    ...r5Rows.map(row=>({id:row.id,lesson:row.lesson,sentences:[{text:row.example}]})),
    ...R5_LESSONS.filter(id=>api.LESSONS[id]).map(id=>({id,lesson:id,sentences:api.LESSONS[id].reading.sentences})),
    ...Object.values(api.READINGS).filter(item=>/^ru-r(?:49|5[0-4])$/.test(item.id)).map(item=>({id:item.id,lesson:item.afterLesson,sentences:item.sentences})),
    ...r4Rows.map(row=>({id:row.id,lesson:row.lesson,sentences:[{text:row.example}]})),
    ...R4_LESSONS.filter(id=>api.LESSONS[id]).map(id=>({id,lesson:id,sentences:api.LESSONS[id].reading.sentences})),
    ...Object.values(api.READINGS).filter(item=>/^ru-r4[1-8]$/.test(item.id)).map(item=>({id:item.id,lesson:item.afterLesson,sentences:item.sentences})),
    ...s4Rows.map(row=>({id:row.id,lesson:row.lesson,sentences:[{text:row.example}]})),
    ...S4_LESSONS.filter(id=>api.LESSONS[id]).map(id=>({id,lesson:id,sentences:api.LESSONS[id].reading.sentences})),
    ...Object.values(api.READINGS).filter(item=>/^es-r4[5-8]$/.test(item.id)).map(item=>({id:item.id,lesson:item.afterLesson,sentences:item.sentences})),
    ...r3Rows.map(row=>({id:row.id,lesson:row.lesson,sentences:[{text:row.example}]})),
    ...R3_LESSONS.filter(id=>api.LESSONS[id]).map(id=>({id,lesson:id,sentences:api.LESSONS[id].reading.sentences})),
    ...Object.values(api.READINGS).filter(item=>/^ru-r(?:3[3-9]|40)$/.test(item.id)).map(item=>({id:item.id,lesson:item.afterLesson,sentences:item.sentences})),
    ...s3Rows.map(row=>({id:row.id,lesson:row.lesson,sentences:[{text:row.example}]})),
    ...S3_LESSONS.filter(id=>api.LESSONS[id]).map(id=>({id,lesson:id,sentences:api.LESSONS[id].reading.sentences})),
    ...Object.values(api.READINGS).filter(item=>/^es-r(?:39|4[0-4])$/.test(item.id)).map(item=>({id:item.id,lesson:item.afterLesson,sentences:item.sentences})),
    ...s2Rows.map(row=>({id:row.id,lesson:row.lesson,sentences:[{text:row.example}]})),
    ...S2_LESSONS.filter(id=>api.LESSONS[id]).map(id=>({id,lesson:id,sentences:api.LESSONS[id].reading.sentences})),
    ...Object.values(api.READINGS).filter(item=>/^es-r3[1-8]$/.test(item.id)).map(item=>({id:item.id,lesson:item.afterLesson,sentences:item.sentences})),
    ...r2Rows.map(row=>({id:row.id,lesson:row.lesson,sentences:[{text:row.example}]})),
    ...R2_LESSONS.filter(id=>api.LESSONS[id]).map(id=>({id,lesson:id,sentences:api.LESSONS[id].reading.sentences})),
    ...Object.values(api.READINGS).filter(item=>/^ru-r(?:2[5-9]|3[0-2])$/.test(item.id)).map(item=>({id:item.id,lesson:item.afterLesson,sentences:item.sentences}))
  ];
  // 诊断数据在本段内不变，同一语言与课次只建一次词表；正式测试默认仍重新推导。
  const vocabularies=new Map();
  const report=segments.map(item=>{
    const russian=item.lesson.startsWith('ru-');
    if (!vocabularies.has(item.lesson)) vocabularies.set(item.lesson,(russian?ruVocabulary:esVocabulary)(item.lesson));
    return {id:item.id,lesson:item.lesson,misses:(russian?ruVocabularyMisses:esVocabularyMisses)(item.lesson,item.sentences,vocabularies.get(item.lesson))};
  }).filter(item=>item.misses.length);
  fs.writeFileSync(process.argv[vocabularyFlag+1],JSON.stringify(report,null,2)+'\n');
}

// 本次改课时传入开工前的 /tmp 留底；日常复习保存后不再使用旧基线。
const backupFlag=process.argv.indexOf('--state-backup');
if (backupFlag!==-1) {
  assert(process.argv[backupFlag+1],'--state-backup 后需要文件路径');
  test('state-data 原始字节与 /tmp 开工留底一致（支持完整 script 块或内部内容）',() => {
    const bytes=fs.readFileSync(path.join(__dirname,'index.html'));
    const opening=Buffer.from('<script type="application/json" id="state-data">');
    const start=bytes.indexOf(opening)+opening.length;
    assert(start>=opening.length);
    const end=bytes.indexOf(Buffer.from('</script>'),start);assert(end>start);
    const backup=fs.readFileSync(process.argv[backupFlag+1]);
    const fullBlock=backup.subarray(0,opening.length).equals(opening);
    assert.deepEqual(fullBlock?bytes.subarray(start-opening.length,end+'</script>'.length):bytes.subarray(start,end),backup);
  });
}


// 任务 M1：马来语第 1–4 周。词汇边界从当前词卡推导，不从例句反向补词。
const M1_LESSONS=['ms-01','ms-02','ms-03','ms-04'];
const M1_READINGS=Array.from({length:6},(_,i)=>'ms-r'+String(i+1).padStart(2,'0'));
const ms1Rows=initialRows.filter(row=>M1_LESSONS.includes(row.lesson));
const ms1Expanded=ms1Rows.reduce((n,row)=>n+(row.tags.split(';').includes('phrase')?1:2),0);
const msWords=text=>text.match(/[A-Za-z]+(?:-[A-Za-z]+)*/g)||[];
// 后续任务在此按开放周次添加前缀／派生规则：
// ber- 5，meN- 6，-kan 9，-i 10，di- 11，ter- 12，peN- 13，
// -an / peN-an / per-an 14，ke-an 15，se- 16；语气词 20，相互形式 21。
function msBerForm(root) {
  if(root==='ajar') return 'belajar';
  return (root.startsWith('r')||root==='kerja'?'be':'ber')+root;
}
// 词根的读音不能仅凭元音字母组数量可靠判断；这里只列已核对的单音节词根。
// 这是构词例外与音节信息，不是阅读词汇白名单；词根仍须来自截至该课的 front。
const MS_MONOSYLLABLES=new Set(['cat','bom','pam','lap','pos','cap','cam','cas','sah']);
function msMenRule(root) {
  if(MS_MONOSYLLABLES.has(root)) return {prefix:'menge-',keep:true};
  if(root==='kaji') return {prefix:'meng-',keep:true,exception:true};
  if(root==='tadbir') return {prefix:'men-',keep:true,exception:true};
  if(/^(?:ng|ny|[lmnrwy])/.test(root)) return {prefix:'me-',keep:true};
  if(/^(?:[bfv]|p[rl])/.test(root)) return {prefix:'mem-',keep:true};
  if(/^p/.test(root)) return {prefix:'mem-',keep:false};
  if(/^(?:[cdjz]|sy|[st][b-df-hj-np-tv-z])/.test(root)) return {prefix:'men-',keep:true};
  if(/^t/.test(root)) return {prefix:'men-',keep:false};
  if(/^(?:[aeiough]|kh|k[lr])/.test(root)) return {prefix:'meng-',keep:true};
  if(/^k/.test(root)) return {prefix:'meng-',keep:false};
  if(/^s/.test(root)) return {prefix:'meny-',keep:false};
  return null;
}
function msMenForm(root) {
  const rule=msMenRule(root);
  return rule ? rule.prefix.slice(0,-1)+(rule.keep?root:root.slice(1)) : null;
}
// peN- 与 meN- 共享鼻音同化规则；ny 是原词根的一部分时不脱落。
function msPenForm(root) {
  if(msMenRule(root)?.exception) return null;
  if(root==='tani') return 'petani';
  const active=msMenForm(root);
  return active?'p'+active.slice(1):null;
}
function msPerAnForm(root) {
  if(root==='ajar') return 'pelajaran';
  return (root.startsWith('r')||root==='kerja'?'pe':'per')+root+'an';
}
function msForms(front,lessonIndex) {
  const forms=new Set(msWords(front).map(word=>word.toLowerCase()));
  // A learned active front supplies its stem spelling through its own morphology note.
  // This is not a vocabulary snapshot: notes never add unrelated lexical items.
  const row=initialRows.find(r=>r.lang==='ms'&&r.front.toLowerCase()===front.toLowerCase()&&Number(r.lesson.slice(3))<=lessonIndex);
  const active=row?.note.match(/^meN- \+ ([a-z]+)(?: \+ -(kan|i))? →/);
  const passive=row?.note.match(/^di- \+ ([a-z]+)(?: \+ -(kan|i))?/);
  const suffixed=active?.[2]||passive?.[2];
  const lexicalException=row?.note.includes('特殊形式');
  const roots=[...forms];
  const regularMen=root=>msMenRule(root)?.exception?null:msMenForm(root);
  for(const root of roots) {
    // Retain M1/M2 prefix rules; already suffixed entries are whole words, not new roots.
    if(active||passive||suffixed||lexicalException) continue;
    if(lessonIndex>=5) forms.add(msBerForm(root));
    const prefixed=lessonIndex>=6?regularMen(root):null;
    if(prefixed) forms.add(prefixed);
    const suffixes=['',...(lessonIndex>=9?['kan']:[]),...(lessonIndex>=10?['i']:[])];
    for(const suffix of suffixes) {
      if(suffix) {forms.add(root+suffix);if(prefixed) forms.add(prefixed+suffix);}
      if(lessonIndex>=11) forms.add('di'+root+suffix);
      if(lessonIndex>=12) forms.add((root.startsWith('r')?'te':'ter')+root+suffix);
    }
  }
  if(active&&!lexicalException&&!msMenRule(active[1])?.exception) {
    const [,root,originalSuffix='']=active;
    const suffixes=new Set([originalSuffix,...(lessonIndex>=9?['kan']:[]),...(lessonIndex>=10?['i']:[])]);
    for(const suffix of suffixes) {
      const prefixed=regularMen(root);
      if(prefixed) forms.add(prefixed+suffix);
      // Imperatives with -kan/-i omit meN-; passive II also permits the bare stem from week 12.
      if(suffix||lessonIndex>=12) forms.add(root+suffix);
      if(lessonIndex>=11) forms.add('di'+root+suffix);
      if(lessonIndex>=12) forms.add((root.startsWith('r')?'te':'ter')+root+suffix);
    }
  }
  if(passive&&lessonIndex>=12) forms.add(passive[1]+(passive[2]||''));
  // Recover only this learned word's explicitly analysed root, never arbitrary note vocabulary.
  // Nominalisation uses the lexical root: menuliskan → penulisan, not penuliskanan.
  if(lessonIndex>=13) {
    const analysed=row?.note.match(/^(?:peN-|pe-|per-|pel-|pem-|ber-|ke-) \+ ([a-z]+)|^([a-z]+) \+ -an/);
    const derivationRoots=lexicalException?[]:active?[active[1]]:passive?[passive[1]]:
      analysed?[analysed[1]||analysed[2]]:roots;
    for(const root of derivationRoots) {
      const noun=msPenForm(root);
      if(noun) forms.add(noun);
      if(['kerja','tani'].includes(root)) forms.add('pe'+root);
      if(root==='ajar') forms.add('pelajar');
      if(lessonIndex>=14) {
        forms.add(root==='jawab'?'jawapan':root+'an');
        if(noun) forms.add(noun+'an');
        forms.add(msPerAnForm(root));
        if(root==='ajar'||root==='belajar') forms.add('pembelajaran');
      }
      if(lessonIndex>=15) forms.add('ke'+root+'an');
      if(lessonIndex>=16) forms.add('se'+root);
    }
  }
  // M6: productive reciprocal patterns open in week 21; lexical/irregular forms remain whole words.
  if(lessonIndex>=21) {
    const reciprocalRoots=new Set(roots.filter(root=>!root.includes('-')));
    if(active&&!lexicalException&&!msMenRule(active[1])?.exception) reciprocalRoots.add(active[1]);
    const paired=row?.note.match(/^ber- \+ ([a-z]+) \+ -an/);
    if(paired) reciprocalRoots.add(paired[1]);
    for(const root of reciprocalRoots) {
      forms.add(msBerForm(root)+'an');
      forms.add(msBerForm(root)+'-'+root+'an');
      const activeForm=regularMen(root);
      if(activeForm) for(const suffix of ['', 'i', 'kan']) forms.add(root+'-'+activeForm+suffix);
    }
  }
  // Reduplication precedes enclitics: buku-bukunya, never bukunya-bukunya.
  if(lessonIndex>=3) for(const word of [...forms]) if(!word.includes('-')) forms.add(word+'-'+word);
  if(lessonIndex>=2) for(const word of [...forms]) for(const suffix of ['nya','ku','mu']) forms.add(word+suffix);
  // M5：-lah / -kah 连写；一般 pun 分写，只推导拼写固定的连词。
  // 这些是构词限制，实际允许词仍须来自截至该课的 front。
  if(lessonIndex>=20) {
    const joinedPun=new Set(['ada','andai','atau','bagaimana','biar','kalau','kendati','lagi','mahu','meski','sekali','sungguh','walau']);
    for(const word of [...forms]) {
      forms.add(word+'lah');forms.add(word+'kah');
      if(joinedPun.has(word)) forms.add(word+'pun');
    }
  }
  return forms;
}
// Cache only this run's immutable source rows. Custom row fixtures are derived independently.
// This stores computed forms, not a fixed vocabulary snapshot, and avoids rebuilding them per sentence.
const msVocabularyCache=new Map();
function msVocabulary(lesson,rows=initialRows) {
  const week=Number(lesson.slice(3));
  if(rows===initialRows&&msVocabularyCache.has(week))return msVocabularyCache.get(week);
  const allowed=new Set();
  for(const row of rows.filter(row=>row.lang==='ms' && Number(row.lesson.slice(3))<=week))
    for(const form of msForms(row.front,week)) allowed.add(form);
  if(rows===initialRows)msVocabularyCache.set(week,allowed);
  return allowed;
}
// 专名单独声明；不会把任意大写句首词当成专名放行。
const MS_PROPER_NAMES=new Set('Ali Siti Aminah Farid Mei Ling Raju Malaysia China England Melaka Kuala Lumpur Pulau Pinang Johor Bahru'.split(' '));
function msVocabularyMisses(lesson,sentences,rows=initialRows) {
  const allowed=msVocabulary(lesson,rows);
  return sentences.flatMap((sentence,i)=>msWords(sentence.text).filter(word=>!allowed.has(word.toLowerCase())&&!MS_PROPER_NAMES.has(word))
    .map(word=>({id:sentence.id||i+1,word,text:sentence.text})));
}
const msWordCount=sentences=>sentences.reduce((sum,sentence)=>sum+sentence.text.trim().split(/\s+/).length,0);
// ElementModel 的选择器不支持 *；用递归遍历取得完整 HTML 树。
function msWalk(nodes) {
  return nodes.flatMap(node=>node instanceof ElementModel?[node,...msWalk(node.childNodes)]:[]);
}
const msExplanationSentences=lesson=>msWalk(parseNodes(lesson.explanation()))
  .filter(node=>node.tag==='p'&&node.getAttribute('lang')==='ms').map(node=>({text:node.textContent}));
const M1_TEXTS=()=>[
  ...ms1Rows.map(row=>({id:row.id,lesson:row.lesson,text:row.example})),
  ...M1_LESSONS.flatMap(id=>[...(api.LESSONS[id].reading?.sentences||[]),...msExplanationSentences(api.LESSONS[id])].map(s=>({id,lesson:id,...s}))),
  ...M1_READINGS.flatMap(id=>api.READINGS[id].sentences.map(s=>({id,lesson:api.READINGS[id].afterLesson,...s})))
];
test('任务 M1：四课周次、日期、时长、目标与写作任务符合参数表',()=>{
  const start=Date.UTC(2026,9,5);
  const short=date=>String(date.getUTCMonth()+1).padStart(2,'0')+'-'+String(date.getUTCDate()).padStart(2,'0');
  for(const [i,id] of M1_LESSONS.entries()) {
    const lesson=api.LESSONS[id];assert(lesson,id);
    assert.equal(lesson.lang,'ms');assert.equal(lesson.week,i+1);
    assert.equal(lesson.dates,short(new Date(start+i*7*86400000))+' 至 '+short(new Date(start+(i*7+6)*86400000)));
    assert.equal(lesson.dailyTime,'每天 15 分钟 + 每周 1 次系统块 30 分钟');
    for(const field of ['name','goal','writingTask']) assert(lesson[field].trim(),id+' '+field);
    const first=parseNodes(lesson.explanation())[0].querySelector('p').textContent;
    assert(first.includes(lesson.dailyTime));
    assert(first.includes('配合《Complete Malay》的对应单元，单元以实际教材为准'));
  }
  assert.equal(initialState.settings.newPerDay.ms,10);
  assert.match(api.LESSONS['ms-01'].writingTask,/10 个词和 3 句/);
  assert.match(api.LESSONS['ms-04'].writingTask,/5 句.*钟点/);
});
test('任务 M1：320 条词卡每课 80 条，连续 id、同源 CSV 与内嵌逐字段一致',()=>{
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8')));
  assert.deepEqual(csv.filter(row=>M1_LESSONS.includes(row.lesson)),ms1Rows);
  assert.equal(ms1Rows.length,320);
  assert.deepEqual(ms1Rows.map(row=>row.id),Array.from({length:320},(_,i)=>'ms-'+String(i+1).padStart(4,'0')));
  for(const id of M1_LESSONS) {
    const rows=ms1Rows.filter(row=>row.lesson===id);assert.equal(rows.length,80,id);
    assert(rows.every(row=>row.lang==='ms'));
  }
  const all=initialRows.filter(row=>row.lang==='ms').map(row=>row.front.toLowerCase());
  assert.equal(new Set(all).size,all.length,'同语言 front 不区分大小写去重');
  assert.deepEqual(initialRows.slice(initialRows.findIndex(row=>row.id==='ms-0001'),initialRows.findIndex(row=>row.id==='ms-0320')+1),ms1Rows);
  assert.equal(initialRows[initialRows.findIndex(row=>row.id==='ms-0001')-1].id,'ru-1623');
});
test('任务 M1：词类、例句原形、量词与动词注释完整，整句仅生成识别卡',()=>{
  const parts=new Set('名词 动词 形容词 代词 数词 量词 介词 连词 副词 助动词 语气词 疑问词 问候'.split(' '));
  for(const row of ms1Rows) {
    const tags=row.tags.split(';');assert(parts.has(tags[0]),row.id+' 词类');
    assert(!tags.includes('letter'));
    assert(row.back && row.example_zh && row.note,row.id+' 中文与注释');
    assert(row.example.toLowerCase().includes(row.front.toLowerCase()),row.id+' 例句含 front 原形');
    assert(/[.!?]$/.test(row.example),row.id+' 完整交际句');
    if(/[.!?]$/.test(row.front)) assert(tags.includes('phrase'),row.id+' 整句识别');
    if(tags[0]==='名词'&&!tags.includes('phrase')) assert(/量词/.test(row.note),row.id+' 名词量词提示');
    if(tags[0]==='形容词') assert(row.note.includes('形容词，后置'),row.id+' 形容词后置');
    if(tags[0]==='动词'&&/及物/.test(row.note)&&!/不及物/.test(row.note)) assert(/宾语/.test(row.note),row.id+' 常见宾语');
    const cards=plain(api.expandCards([row]));
    assert.deepEqual(cards.map(card=>card.direction),tags.includes('phrase')?['r']:['r','p']);
    if(!tags.includes('phrase')) {
      assert(api.clozeExample(row).includes('____'),row.id+' 例句可挖空');
      assert(!api.clozeExample(row).includes('此例句没有'),row.id+' 挖空应找到完整词条');
    }
  }
  for(const front of ['belajar','bekerja']) {
    const row=ms1Rows.find(row=>row.front===front);assert(row);assert.match(row.note,/词根.*整词记/);
  }
});
test('任务 M1：马来西亚拼写、无越课口语缩略，印尼语对照只在 note',()=>{
  const banned=new Set('karena uang kantor universitas bahwa senin delapan mau saja sepeda sepatu kamar bisa kemarin'.split(' '));
  const informal=new Set('aku kau engkau tak nak dah je ni tu'.split(' '));
  // M1 不教「毒液」义的 bisa，所以在本轮正文中一律拒绝。
  for(const item of [...ms1Rows.map(row=>({id:row.id,text:row.front})),...M1_TEXTS()])
    for(const word of msWords(item.text).map(w=>w.toLowerCase())) {
      assert(!banned.has(word),item.id+' 印尼语形式 '+word);
      assert(!informal.has(word),item.id+' 越课口语 '+word);
    }
  for(const row of ms1Rows) for(const word of msWords(row.note).map(w=>w.toLowerCase()))
    if(banned.has(word)) assert(row.note.includes('印尼语作'),row.id+' 对照前标明来源');
});
test('任务 M1：四课各 10 题，第一课 4 道补字母、4 道中译、2 道填空，后三课 6 加 4',()=>{
  for(const id of M1_LESSONS) {
    const lesson=api.LESSONS[id];assert.equal(lesson.exercises.length,10);
    for(const exercise of lesson.exercises) {
      assert(exercise.prompt && exercise.answer);
      if(exercise.options) {assert(exercise.options.includes(exercise.answer));assert.equal(new Set(exercise.options).size,exercise.options.length);}
      else assert.equal(typeof exercise.answer,'string');
      if(exercise.prompt.includes('____')) assert(/[（(].+[）)]/.test(exercise.prompt),'填空应给提示：'+exercise.prompt);
    }
    if(id==='ms-01') {
      assert.equal(lesson.reading,null);
      assert.equal(lesson.exercises.filter(e=>e.prompt.startsWith('补双字母')).length,4);
      assert.equal(lesson.exercises.filter(e=>e.prompt.startsWith('看中文')).length,4);
      assert.equal(lesson.exercises.filter(e=>e.prompt.startsWith('填空')).length,2);
    } else {
      assert.equal(lesson.reading.questions.length,4);
      assert.equal(lesson.exercises.slice(0,6).filter(e=>e.prompt.startsWith('阅读：')).length,0);
      for(let i=0;i<4;i++) assert.equal(lesson.exercises[i+6],lesson.reading.questions[i],'阅读题共用对象');
    }
  }
  assert(api.LESSONS['ms-04'].exercises.slice(0,6).filter(q=>q.prompt.startsWith('复习第')).length>=2);
});
test('任务 M1：三篇课内阅读词数、句数、中文与四道选择题完整',()=>{
  const ranges={'ms-02':[40,60,8,9],'ms-03':[50,65,9,10],'ms-04':[60,70,10,10]};
  for(const [id,[min,max,smin,smax]] of Object.entries(ranges)) {
    const reading=api.LESSONS[id].reading;assert(reading.title);
    const words=msWordCount(reading.sentences);
    assert(words>=min&&words<=max,id+' 词数 '+words);
    assert(reading.sentences.length>=smin&&reading.sentences.length<=smax,id+' 句数');
    for(const s of reading.sentences) assert(s.text && s.zh && /[.!?]$/.test(s.text));
    for(const q of reading.questions) assert(q.options.includes(q.answer));
  }
});
test('任务 M1：六篇阅读线连续追加，周次、体裁、精确词数与句数符合各篇区间',()=>{
  const ids=Object.keys(api.READINGS),previous=ids.indexOf('ru-r60');
  assert.deepEqual(ids.slice(previous+1,previous+7),M1_READINGS);
  assert.deepEqual(Object.values(api.READINGS).filter(r=>r.lang==='ms'&&r.week<=4).map(r=>r.id),M1_READINGS);
  const ranges=[[40,55,8,9],[40,55,8,10],[50,65,9,10],[45,60,8,10],[60,70,9,10],[55,70,8,10]];
  const genres=['人物介绍','对话','房间或城市描写','短信或便条','日常生活','通知或广告'];
  for(const [i,id] of M1_READINGS.entries()) {
    const item=api.READINGS[id],week=2+Math.floor(i/2),[min,max,smin,smax]=ranges[i];
    assert.equal(item.id,id);assert.equal(item.lang,'ms');assert.equal(item.week,week);
    assert.equal(item.afterLesson,'ms-0'+week);assert.equal(item.genre,genres[i]);assert(item.title);
    assert.equal(item.words,msWordCount(item.sentences));
    assert(item.words>=min&&item.words<=max,id+' 词数 '+item.words);
    assert(item.sentences.length>=smin&&item.sentences.length<=smax,id+' 句数');
    for(const sentence of item.sentences) assert(sentence.text&&sentence.zh&&/[.!?]$/.test(sentence.text));
  }
  for(let week=2;week<=4;week++) {
    const pair=M1_READINGS.map(id=>api.READINGS[id]).filter(r=>r.week===week);
    assert.equal(pair.length,2);assert.notEqual(pair[0].genre,pair[1].genre);
  }
  const speakers=api.READINGS['ms-r02'].sentences.map(s=>s.text.split(':')[0]);
  assert.deepEqual([...new Set(speakers)],['Ali','Siti']);
  for(const speaker of new Set(speakers)) assert([4,5].includes(speakers.filter(s=>s===speaker).length));
});
test('任务 M1：阅读线各 3 道阅读题与 1 道推断题、5 个已学关键词、5 行复述',()=>{
  for(const id of M1_READINGS) {
    const item=api.READINGS[id];assert.equal(item.questions.length,4);
    assert.equal(item.questions.filter(q=>q.prompt.startsWith('阅读：')).length,3);
    assert.equal(item.questions.filter(q=>q.prompt.startsWith('推断：')).length,1);
    for(const q of item.questions) {assert(q.options.includes(q.answer));assert.equal(new Set(q.options).size,q.options.length);}
    assert.equal(item.keyWords.length,5);assert.equal(new Set(item.keyWords.map(k=>k.word)).size,5);
    const learned=new Set(initialRows.filter(r=>r.lang==='ms'&&r.lesson<=item.afterLesson).map(r=>r.front.toLowerCase()));
    for(const k of item.keyWords) {assert(k.zh);assert(learned.has(k.word.toLowerCase()),id+' 关键词未学 '+k.word);}
    assert.equal(item.retell.length,5);assert(item.retell.every(line=>typeof line==='string'&&line.trim()));
  }
});
test('任务 M1：所有新词卡例句、课文、阅读线及讲解完整例句均不超课次词汇范围',()=>{
  for(const id of M1_LESSONS) assert.deepEqual(msVocabularyMisses(id,M1_TEXTS().filter(t=>t.lesson===id)),[],id+' 未学词');
});
test('任务 M1：msForms 后附与重叠分周开放，未教词缀、未来词和大写句首不能放行',()=>{
  assert.deepEqual([...msForms('buku',1)],['buku']);
  for(const form of ['bukunya','bukuku','bukumu']) {
    assert(!msForms('buku',1).has(form));assert(msForms('buku',2).has(form));
  }
  assert(!msForms('buku',2).has('buku-buku'));
  assert(msForms('buku',3).has('buku-buku'));assert(msForms('buku',3).has('buku-bukunya'));
  assert(!msForms('buku',3).has('bukunya-bukunya'));
  assert(msForms('bahasa Melayu',1).has('bahasa'));assert(msForms('bahasa Melayu',1).has('melayu'));
  for(const [root,form] of [['ajar','belajar'],['kerja','bekerja'],['tulis','menulis'],['baca','membaca'],['buku','sebuku'],['baca','dibaca'],['tulis','tuliskan']])
    assert(!msForms(root,4).has(form),form+' 未开放推导');
  assert(msVocabulary('ms-02').has('belajar'),'只接受本课明确教授的整词');
  assert(!msVocabulary('ms-01').has('belajar'));assert(!msVocabulary('ms-03').has('sedang'));
  assert(msVocabularyMisses('ms-03',[{text:'Sedang baca buku.'}]).some(item=>item.word==='Sedang'));
  assert(msVocabularyMisses('ms-02',[{text:'Saya membaca buku.'}]).some(item=>item.word==='membaca'));
  assert(msVocabularyMisses('ms-02',[{text:'Saya suka pepatung.'}]).some(item=>item.word==='pepatung'));
  assert.deepEqual(msVocabularyMisses('ms-02',[{text:'Ali ada di Kuala Lumpur.'}]),[]);
});
test('任务 M1：讲解 HTML 可解析，语法要点、中文提纲与自查完整',()=>{
  const required=[
    ['26','ng','ny','kh','sy','gh','tangan','tanggal','ai','au','oi','(C)V(C)','bahasa Melayu','Isnin','Januari','kami','kita','selamat tinggal','selamat jalan'],
    ['主语','宾语','ialah','adalah','tidak','bukan','di mana','ke mana','dari mana','mengapa','kenapa','-kah','-nya','-ku','-mu','sangat','sekali','dan','atau','tetapi'],
    ['orang','ekor','buah','batang','helai','biji','keping','pasang','cawan','gelas','seorang','sebuah','sebelas','dua belas','dua puluh','seratus','seribu','pertama','kedua','ketiga','重叠','tiada','yang'],
    ['sudah','telah','belum','akan','sedang','masih','pernah','baru','semalam','kelmarin','Isnin','Khamis','Jumaat','Ahad','Mac','Ogos','Disember','pukul','setengah','suku','minit','pada','5 Oktober 2026']
  ];
  for(const [i,id] of M1_LESSONS.entries()) {
    const lesson=api.LESSONS[id],markup=lesson.explanation(),nodes=msWalk(parseNodes(markup));
    assert(nodes.filter(n=>n.tag==='h4').length>=5);
    assert(msExplanationSentences(lesson).length>=3);
    assert(nodes.some(n=>n.tag==='ol'&&n.querySelectorAll('li').length===5),'五句中文提纲');
    assert(markup.includes('自查'));assert(nodes.some(n=>n.tag==='ul'&&n.querySelectorAll('li').length>=3));
    for(const part of required[i]) assert(markup.includes(part),id+' 缺少讲解 '+part);
    for(const paragraph of nodes.filter(n=>n.tag==='p'&&n.getAttribute('lang')==='ms')) {
      const parent=nodes.find(n=>n.childNodes.includes(paragraph));
      const next=parent.childNodes[parent.childNodes.indexOf(paragraph)+1];
      assert(next instanceof ElementModel && /[\u4e00-\u9fff]/.test(next.textContent),'例句后紧跟中文');
    }
  }
});
test('任务 M1：只追加，旧 es／ru 原行按 id 顺序与未改来源一致，M0 旧 ms 为空',()=>{
  const first=initialRows.findIndex(row=>row.id==='ms-0001');assert.equal(first,3616);
  const oldRows=initialRows.slice(0,first);
  assert.equal(oldRows.filter(row=>row.lang==='ms').length,0,'M0 没有旧 ms 词条');
  const rawRows=[...blocks[0][1].matchAll(/\n  \{\n[\s\S]*?\n  \}/g)].map(match=>match[0].slice(1));
  assert.equal(rawRows.length,initialRows.length);
  const rawById=new Map(rawRows.map(line=>[JSON.parse(line).id,line]));
  for(const lang of ['es','ru']) {
    const oldCSV=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards',lang+'.csv'),'utf8')));
    assert.deepEqual(oldRows.filter(row=>row.lang===lang),oldCSV,lang+' 旧行逐字段及顺序');
    for(const row of oldCSV) assert.equal(rawById.get(row.id),JSON.stringify([row],null,2).slice(2,-2),row.id+' 旧行原样');
  }
  // 不用内容哈希或字节偏移；新行只出现在旧行之后。
  assert(oldRows.every(row=>row.lang==='es'||row.lang==='ru'));
  assert.deepEqual(initialRows.slice(first,first+320).map(row=>row.id),ms1Rows.map(row=>row.id));
  const lessonIds=Object.keys(api.LESSONS),readingIds=Object.keys(api.READINGS);
  assert.deepEqual(lessonIds.slice(lessonIds.indexOf('ru-34')+1,lessonIds.indexOf('ru-34')+5),M1_LESSONS);
  assert.deepEqual(readingIds.slice(readingIds.indexOf('ru-r60')+1,readingIds.indexOf('ru-r60')+7),M1_READINGS);
});
test('任务 M1：渲染四课六篇、切换中文与页内练习不改变真实进度',()=>{
  const {api:a,document}=createAPI(true,html);a.initialize();
  const before=plain(a.getData().state),beforeData=plain(a.getData().rows),dirty=a.getData().dirty;
  for(const id of M1_LESSONS) {
    a.openLesson(id);const page=document.getElementById('content').textContent;
    for(const field of ['name','dates','dailyTime','goal','writingTask']) assert(page.includes(a.LESSONS[id][field]),id+' '+field);
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);
    for(const form of document.querySelectorAll('[data-exercise]')) {
      form.elements.answer.value=a.LESSONS[id].exercises[Number(form.dataset.exercise)].answer;
      document.getElementById('app').listeners.submit[0]({target:form,preventDefault(){}});
    }
  }
  a.showReadings();
  assert.deepEqual(document.querySelectorAll('[data-reading]').map(n=>n.dataset.reading).filter(id=>M1_READINGS.includes(id)),M1_READINGS);
  for(const id of M1_READINGS) {
    a.openReadingItem(id);const page=document.getElementById('content').textContent;
    assert(page.includes(a.READINGS[id].title));assert.equal(document.querySelectorAll('[data-question]').length,4);
    const translations=()=>document.querySelectorAll('details').filter(n=>n.querySelector('summary')?.textContent==='查看本句中文');
    assert.equal(translations().length,a.READINGS[id].sentences.length);
    assert(translations().every(n=>n.getAttribute('open')===null));
    a.toggleReadingZh();assert(translations().every(n=>n.getAttribute('open')!==null));
    a.toggleReadingZh();
  }
  assert.deepEqual(plain(a.getData().state),before);assert.deepEqual(plain(a.getData().rows),beforeData);
  assert.equal(a.getData().dirty,dirty);
});

// M1 交付的旧 ms 行原文，仅用于只追加检查，不用于词汇放行。
const M2_OLD_MS_CSV="id,lang,lesson,front,back,example,example_zh,note,tags\nms-0001,ms,ms-01,saya,我,Saya pelajar.,我是学生。,第一人称单数,代词\nms-0002,ms,ms-01,awak,你,Awak guru.,你是老师。,常用于熟悉的人；正式称呼可用 anda,代词\nms-0003,ms,ms-01,anda,您；你,Anda pelajar.,您是学生。,较正式的第二人称,代词\nms-0004,ms,ms-01,dia,他；她,Dia guru.,他是老师。,不分性别,代词\nms-0005,ms,ms-01,beliau,他；她（敬称）,Beliau guru saya.,他是我的老师。,用于值得尊敬的人,代词\nms-0006,ms,ms-01,kami,我们（不含听话人）,Kami pelajar.,我们是学生。,不含听话人,代词\nms-0007,ms,ms-01,kita,我们（含听话人）,Kita keluarga.,我们是一家人。,包含听话人,代词\nms-0008,ms,ms-01,mereka,他们；她们,Mereka kawan saya.,他们是我的朋友。,第三人称复数,代词\nms-0009,ms,ms-01,ini,这；这个,Buku ini buku saya.,这本书是我的书。,指示词；作定语时放名词后,代词\nms-0010,ms,ms-01,itu,那；那个,Rumah itu rumah saya.,那所房子是我的家。,指示词；作定语时放名词后,代词\nms-0011,ms,ms-01,Ini rumah.,这是房子。,Ini rumah.,这是房子。,无系词句；整句识别,代词;phrase\nms-0012,ms,ms-01,Itu sekolah.,那是学校。,Itu sekolah.,那是学校。,无系词句；整句识别,代词;phrase\nms-0013,ms,ms-01,selamat pagi,早上好,\"Selamat pagi, Ali!\",早上好，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0014,ms,ms-01,selamat tengah hari,中午好,\"Selamat tengah hari, Siti!\",中午好，西蒂！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0015,ms,ms-01,selamat petang,下午好,\"Selamat petang, Ali!\",下午好，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0016,ms,ms-01,selamat malam,晚上好,\"Selamat malam, Siti!\",晚上好，西蒂！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0017,ms,ms-01,Apa khabar?,你好吗？,Apa khabar?,你好吗？,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0018,ms,ms-01,khabar baik,很好（回答问候）,\"Khabar baik, terima kasih.\",很好，谢谢。,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0019,ms,ms-01,terima kasih,谢谢,\"Terima kasih, Ali!\",谢谢你，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0020,ms,ms-01,sama-sama,不客气,\"Sama-sama, Siti!\",不客气，西蒂！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0021,ms,ms-01,maaf,对不起,\"Maaf, Ali!\",对不起，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0022,ms,ms-01,selamat tinggal,再见（对留下的人说）,\"Selamat tinggal, Siti!\",再见，西蒂！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0023,ms,ms-01,selamat jalan,再见（对离开的人说）,\"Selamat jalan, Ali!\",再见，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0024,ms,ms-01,ya,是；对,\"Ya, ini buku saya.\",是的，这是我的书。,礼貌用语；作为完整交际话语识别,语气词;问候\nms-0025,ms,ms-01,tidak,不；不是,\"Tidak, itu buku Ali.\",不，那是阿里的书。,可单独作否定回答；否定谓语的区别见 ms-02,语气词;问候\nms-0026,ms,ms-01,satu,一,Ini satu buku.,这是一本书。,基数词；置于名词前，本周先认数字,数词\nms-0027,ms,ms-01,dua,二,Ini dua buku.,这是二本书。,基数词；置于名词前，本周先认数字,数词\nms-0028,ms,ms-01,tiga,三,Ini tiga buku.,这是三本书。,基数词；置于名词前，本周先认数字,数词\nms-0029,ms,ms-01,empat,四,Ini empat buku.,这是四本书。,基数词；置于名词前，本周先认数字,数词\nms-0030,ms,ms-01,lima,五,Ini lima buku.,这是五本书。,基数词；置于名词前，本周先认数字,数词\nms-0031,ms,ms-01,enam,六,Ini enam buku.,这是六本书。,基数词；置于名词前，本周先认数字,数词\nms-0032,ms,ms-01,tujuh,七,Ini tujuh buku.,这是七本书。,基数词；置于名词前，本周先认数字,数词\nms-0033,ms,ms-01,lapan,八,Ini lapan buku.,这是八本书。,基数词；置于名词前，本周先认数字,数词\nms-0034,ms,ms-01,sembilan,九,Ini sembilan buku.,这是九本书。,基数词；置于名词前，本周先认数字,数词\nms-0035,ms,ms-01,sepuluh,十,Ini sepuluh buku.,这是十本书。,基数词；置于名词前，本周先认数字,数词\nms-0036,ms,ms-01,buku,书,Ini buku saya.,这是我的书。,量词 buah,名词;教室\nms-0037,ms,ms-01,meja,桌子,Ini meja saya.,这是我的桌子。,量词 buah,名词;教室\nms-0038,ms,ms-01,kerusi,椅子,Ini kerusi saya.,这是我的椅子。,量词 buah,名词;教室\nms-0039,ms,ms-01,pen,笔,Ini pen saya.,这是我的笔。,量词 batang,名词;教室\nms-0040,ms,ms-01,pensel,铅笔,Ini pensel saya.,这是我的铅笔。,量词 batang,名词;教室\nms-0041,ms,ms-01,kertas,纸,Ini kertas saya.,这是我的纸。,量词 helai,名词;教室\nms-0042,ms,ms-01,beg,包,Ini beg saya.,这是我的包。,量词 buah,名词;教室\nms-0043,ms,ms-01,bilik,房间,Ini bilik saya.,这是我的房间。,量词 buah,名词;教室\nms-0044,ms,ms-01,pintu,门,Ini pintu saya.,这是我的门。,量词 buah,名词;教室\nms-0045,ms,ms-01,tingkap,窗户,Ini tingkap saya.,这是我的窗户。,量词 buah,名词;教室\nms-0046,ms,ms-01,rumah,房子；家,Ini rumah saya.,这是我的房子。,量词 buah,名词;教室\nms-0047,ms,ms-01,sekolah,学校,Ini sekolah saya.,这是我的学校。,量词 buah,名词;教室\nms-0048,ms,ms-01,kelas,班级,Ini kelas saya.,这是我的班级。,量词 buah,名词;教室\nms-0049,ms,ms-01,guru,老师,Ini guru saya.,这是我的老师。,量词 orang,名词;教室\nms-0050,ms,ms-01,pelajar,学生,Ini pelajar saya.,这是我的学生。,量词 orang,名词;教室\nms-0051,ms,ms-01,orang,人,Dia orang Malaysia.,他是马来西亚人。,量词 orang；ms-03 也用作人的量词,名词;家庭\nms-0052,ms,ms-01,lelaki,男子,Lelaki itu bapa saya.,那个男子是我的父亲。,量词 orang,名词;家庭\nms-0053,ms,ms-01,perempuan,女子,Perempuan itu ibu saya.,那个女子是我的母亲。,量词 orang,名词;家庭\nms-0054,ms,ms-01,kawan,朋友,Ali kawan saya.,阿里是我的朋友。,量词 orang,名词;家庭\nms-0055,ms,ms-01,keluarga,家庭；家人,Ini keluarga saya.,这是我的家人。,量词 buah；指家庭时使用，家人按 orang 计数,名词;家庭\nms-0056,ms,ms-01,ibu,母亲,Ibu saya guru.,我的母亲是老师。,量词 orang,名词;家庭\nms-0057,ms,ms-01,bapa,父亲,Bapa saya guru.,我的父亲是老师。,量词 orang,名词;家庭\nms-0058,ms,ms-01,abang,哥哥,Abang saya pelajar.,我的哥哥是学生。,量词 orang,名词;家庭\nms-0059,ms,ms-01,kakak,姐姐,Kakak saya pelajar.,我的姐姐是学生。,量词 orang,名词;家庭\nms-0060,ms,ms-01,adik,弟弟；妹妹,Adik saya pelajar.,我的弟弟是学生。,量词 orang,名词;家庭\nms-0061,ms,ms-01,komputer,电脑,Itu komputer Ali.,那是阿里的电脑。,量词 buah,名词;城市;英语借词\nms-0062,ms,ms-01,telefon,电话；手机,Itu telefon Ali.,那是阿里的电话。,量词 buah,名词;城市;英语借词\nms-0063,ms,ms-01,bas,公共汽车,Itu bas.,那是公共汽车。,量词 buah,名词;城市;英语借词\nms-0064,ms,ms-01,teksi,出租车,Itu teksi.,那是出租车。,量词 buah,名词;城市;英语借词\nms-0065,ms,ms-01,hospital,医院,Itu hospital.,那是医院。,量词 buah,名词;城市;英语借词\nms-0066,ms,ms-01,restoran,餐馆,Itu restoran.,那是餐馆。,量词 buah,名词;城市;英语借词\nms-0067,ms,ms-01,hotel,酒店,Itu hotel.,那是酒店。,量词 buah,名词;城市;英语借词\nms-0068,ms,ms-01,bank,银行,Itu bank.,那是银行。,量词 buah,名词;城市;英语借词\nms-0069,ms,ms-01,kamera,相机,Itu kamera Ali.,那是阿里的相机。,量词 buah,名词;城市;英语借词\nms-0070,ms,ms-01,tiket,票,Itu tiket Ali.,那是阿里的票。,量词 keping,名词;城市;英语借词\nms-0071,ms,ms-01,gereja,教堂,Ini gereja.,这是教堂。,量词 buah,名词;身边事物;葡语借词\nms-0072,ms,ms-01,bendera,旗帜,Ini bendera.,这是旗帜。,量词 helai,名词;身边事物;葡语借词\nms-0073,ms,ms-01,keju,奶酪,Ini keju.,这是奶酪。,量词 keping,名词;身边事物;葡语借词\nms-0074,ms,ms-01,teh,茶,Ini teh.,这是茶。,量词 cawan,名词;身边事物;闽南语借词\nms-0075,ms,ms-01,mi,面条,Ini mi.,这是面条。,量词 mangkuk,名词;身边事物;闽南语借词\nms-0076,ms,ms-01,kuih,糕点,Ini kuih.,这是糕点。,量词 biji,名词;身边事物;闽南语借词\nms-0077,ms,ms-01,Saya pelajar.,我是学生。,Saya pelajar.,我是学生。,整句识别；名字 Ali 可换成自己的名字,代词;phrase\nms-0078,ms,ms-01,Ini buku saya.,这是我的书。,Ini buku saya.,这是我的书。,整句识别；名字 Ali 可换成自己的名字,代词;phrase\nms-0079,ms,ms-01,Nama saya Ali.,我的名字是阿里。,Nama saya Ali.,我的名字是阿里。,整句识别；名字 Ali 可换成自己的名字,名词;phrase\nms-0080,ms,ms-01,Terima kasih banyak.,非常感谢。,Terima kasih banyak.,非常感谢。,整句识别；名字 Ali 可换成自己的名字,问候;phrase\nms-0081,ms,ms-02,baca,读,Saya baca buku.,我读书。,及物；常见宾语 buku,动词;学习与工作\nms-0082,ms,ms-02,makan,吃,Saya makan mi.,我吃面条。,及物；常见宾语 mi、kuih,动词;学习与工作\nms-0083,ms,ms-02,minum,喝,Saya minum teh.,我喝茶。,及物；常见宾语 teh,动词;学习与工作\nms-0084,ms,ms-02,tulis,写,Saya tulis nama saya.,我写我的名字。,及物；常见宾语 nama、e-mel,动词;学习与工作\nms-0085,ms,ms-02,pergi,去,Saya pergi ke sekolah.,我去学校。,不及物；目的地用 ke,动词;学习与工作\nms-0086,ms,ms-02,ada,有；在,Saya ada komputer.,我有电脑。,表示拥有或存在；后接 buku、komputer 等事物,动词;学习与工作\nms-0087,ms,ms-02,suka,喜欢,Saya suka bahasa Melayu.,我喜欢马来语。,及物；常见宾语 bahasa Melayu、mi,动词;学习与工作\nms-0088,ms,ms-02,tinggal,住,Saya tinggal di Melaka.,我住在马六甲。,不及物；住处用 di,动词;学习与工作\nms-0089,ms,ms-02,belajar,学习,Saya belajar bahasa Melayu.,我学习马来语。,bel- + ajar；词根 ajar；本周只作整词记，第 5 周再学前缀规则；常见学习内容（宾语）bahasa Melayu,动词;学习与工作\nms-0090,ms,ms-02,bekerja,工作,Ibu saya bekerja di bank.,我的母亲在银行工作。,be- + kerja；词根 kerja；本周只作整词记，第 5 周再学前缀规则,动词;学习与工作\nms-0091,ms,ms-02,faham,懂；理解,Saya faham bahasa Melayu.,我懂马来语。,及物；常见宾语 bahasa Melayu,动词;学习与工作\nms-0092,ms,ms-02,tahu,知道,Saya tahu nama guru itu.,我知道那位老师的名字。,及物；常见宾语 nama,动词;学习与工作\nms-0093,ms,ms-02,apa,什么,Awak baca apa?,你读什么？,句末疑问词,疑问词\nms-0094,ms,ms-02,siapa,谁,Dia siapa?,他是谁？,询问人,疑问词\nms-0095,ms,ms-02,di mana,在哪里,Awak tinggal di mana?,你住在哪里？,di 表地点；作为固定词组记,疑问词\nms-0096,ms,ms-02,ke mana,去哪里,Awak pergi ke mana?,你去哪里？,ke 表方向；作为固定词组记,疑问词\nms-0097,ms,ms-02,dari mana,从哪里来,Awak dari mana?,你来自哪里？,dari 表来源；作为固定词组记,疑问词\nms-0098,ms,ms-02,bila,什么时候,Bila awak pergi ke Melaka?,你什么时候去马六甲？,询问时间,疑问词\nms-0099,ms,ms-02,mengapa,为什么,Mengapa awak suka buku itu?,你为什么喜欢那本书？,询问原因；同义 kenapa,疑问词\nms-0100,ms,ms-02,bagaimana,怎么样,Bagaimana khabar keluarga awak?,你的家人近况怎么样？,询问情况,疑问词\nms-0101,ms,ms-02,berapa,多少,Berapa orang pelajar ada di kelas?,班里有多少学生？,询问数量,疑问词\nms-0102,ms,ms-02,besar,大的,Rumah saya besar.,我的房子很大。,形容词，后置；作谓语时可不用系词,形容词\nms-0103,ms,ms-02,kecil,小的,Bilik saya kecil.,我的房间很小。,形容词，后置；作谓语时可不用系词,形容词\nms-0104,ms,ms-02,baru,新的,Ini buku baru saya.,这是我的新书。,形容词，后置；作谓语时可不用系词；ms-04 再识别副词义「刚」,形容词\nms-0105,ms,ms-02,lama,旧的,Itu komputer lama saya.,那是我的旧电脑。,形容词，后置；作谓语时可不用系词,形容词\nms-0106,ms,ms-02,baik,好的,Guru saya baik.,我的老师很好。,形容词，后置；作谓语时可不用系词,形容词\nms-0107,ms,ms-02,cantik,漂亮的,Bendera itu cantik.,那面旗帜很漂亮。,形容词，后置；作谓语时可不用系词,形容词\nms-0108,ms,ms-02,panjang,长的,Pensel ini panjang.,这支铅笔很长。,形容词，后置；作谓语时可不用系词,形容词\nms-0109,ms,ms-02,pendek,短的,Pensel itu pendek.,那支铅笔很短。,形容词，后置；作谓语时可不用系词,形容词\nms-0110,ms,ms-02,tinggi,高的,Abang saya tinggi.,我的哥哥个子高。,形容词，后置；作谓语时可不用系词,形容词\nms-0111,ms,ms-02,rendah,矮的；低的,Meja itu rendah.,那张桌子很矮。,形容词，后置；作谓语时可不用系词,形容词\nms-0112,ms,ms-02,murah,便宜的,Tiket bas ini murah.,这张公共汽车票很便宜。,形容词，后置；作谓语时可不用系词,形容词\nms-0113,ms,ms-02,mahal,贵的,Kamera itu mahal.,那台相机很贵。,形容词，后置；作谓语时可不用系词,形容词\nms-0114,ms,ms-02,panas,热的,Teh ini panas.,这杯茶很热。,形容词，后置；作谓语时可不用系词,形容词\nms-0115,ms,ms-02,sejuk,凉的,Teh itu sejuk.,那杯茶凉了。,形容词，后置；作谓语时可不用系词,形容词\nms-0116,ms,ms-02,sedap,好吃的,Mi ini sedap.,这些面条很好吃。,形容词，后置；作谓语时可不用系词,形容词\nms-0117,ms,ms-02,Malaysia,马来西亚,Saya dari Malaysia.,我来自马来西亚。,国家专名，首字母大写；地名一般不用量词,名词;国家与语言\nms-0118,ms,ms-02,China,中国,Kawan saya dari China.,我的朋友来自中国。,国家专名，首字母大写；地名一般不用量词,名词;国家与语言\nms-0119,ms,ms-02,England,英格兰,Dia dari England.,他来自英格兰。,国家或地区专名；此处专指英格兰；地名一般不用量词,名词;国家与语言\nms-0120,ms,ms-02,bahasa Melayu,马来语,Saya suka bahasa Melayu.,我喜欢马来语。,语言名称；bahasa 小写、Melayu 大写；一般不用量词；专名或语言名称不用事物量词,名词;国家与语言\nms-0121,ms,ms-02,bahasa Cina,汉语,Dia faham bahasa Cina.,他懂汉语。,语言名称；一般不用量词；专名或语言名称不用事物量词,名词;国家与语言\nms-0122,ms,ms-02,bahasa Inggeris,英语,Beliau faham bahasa Inggeris.,他懂英语。,语言名称；一般不用量词；专名或语言名称不用事物量词,名词;国家与语言\nms-0123,ms,ms-02,orang Cina,华人；中国人,Mei Ling orang Cina.,美玲是华人。,量词 orang；本句指族群,名词;国家与语言\nms-0124,ms,ms-02,orang Malaysia,马来西亚人,Ali orang Malaysia.,阿里是马来西亚人。,量词 orang,名词;国家与语言\nms-0125,ms,ms-02,doktor,医生,Ali doktor.,阿里是医生。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0126,ms,ms-02,jururawat,护士,Ali jururawat.,阿里是护士。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0127,ms,ms-02,polis,警察,Ali polis.,阿里是警察。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0128,ms,ms-02,jurutera,工程师,Ali jurutera.,阿里是工程师。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0129,ms,ms-02,peguam,律师,Ali peguam.,阿里是律师。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0130,ms,ms-02,petani,农民,Ali petani.,阿里是农民。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0131,ms,ms-02,kerani,文员,Ali kerani.,阿里是文员。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0132,ms,ms-02,pemandu,司机,Ali pemandu.,阿里是司机。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0133,ms,ms-02,dan,和,Saya suka teh dan kuih.,我喜欢茶和糕点。,并列连接词,连词\nms-0134,ms,ms-02,atau,或者,Awak suka teh atau mi?,你喜欢茶还是面条？,连接可选择的成分,连词\nms-0135,ms,ms-02,tetapi,但是,Bilik ini kecil tetapi cantik.,这个房间小但是漂亮。,表示转折,连词\nms-0136,ms,ms-02,sangat,很,Buku ini sangat baik.,这本书很好。,放在形容词前,副词\nms-0137,ms,ms-02,sekali,很；极了,Mi ini sedap sekali.,这些面条非常好吃。,表示程度时放形容词后,副词\nms-0138,ms,ms-02,juga,也,Saya juga pelajar.,我也是学生。,表示相同情况,副词\nms-0139,ms,ms-02,radio,收音机,Ini radio baru.,这是新的收音机。,量词 buah,名词;英语借词\nms-0140,ms,ms-02,televisyen,电视机,Ini televisyen baru.,这是新的电视机。,量词 buah,名词;英语借词\nms-0141,ms,ms-02,internet,互联网,Ada internet di hotel ini.,这家酒店有互联网。,一般不用量词；不可数的网络名称,名词;英语借词\nms-0142,ms,ms-02,e-mel,电子邮件,Ini e-mel baru.,这是新的电子邮件。,量词 buah,名词;英语借词\nms-0143,ms,ms-02,universiti,大学,Ini universiti baru.,这是新的大学。,量词 buah,名词;英语借词\nms-0144,ms,ms-02,kolej,学院,Ini kolej baru.,这是新的学院。,量词 buah,名词;英语借词\nms-0145,ms,ms-02,klinik,诊所,Ini klinik baru.,这是新的诊所。,量词 buah,名词;英语借词\nms-0146,ms,ms-02,muzium,博物馆,Ini muzium baru.,这是新的博物馆。,量词 buah,名词;英语借词\nms-0147,ms,ms-02,Siapakah guru anda?,谁是您的老师？,Siapakah guru anda?,谁是您的老师？,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0148,ms,ms-02,Adakah awak pelajar?,你是学生吗？,Adakah awak pelajar?,你是学生吗？,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0149,ms,ms-02,Saya dari Malaysia.,我来自马来西亚。,Saya dari Malaysia.,我来自马来西亚。,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0150,ms,ms-02,Saya boleh baca bahasa Melayu.,我会读马来语。,Saya boleh baca bahasa Melayu.,我会读马来语。,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0151,ms,ms-02,Saya bukan doktor.,我不是医生。,Saya bukan doktor.,我不是医生。,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0152,ms,ms-02,ialah,是（名词谓语前）,Ali ialah pelajar.,阿里是学生。,正式书面语的判断词；后接名词短语,助动词;补充\nms-0153,ms,ms-02,adalah,是（形容词或介词短语前）,Buku ini adalah sangat baik.,这本书很好。,正式书面语的判断词；本句可省，不接动词,助动词;补充\nms-0154,ms,ms-02,bukan,不是,Dia bukan guru saya.,他不是我的老师。,否定名词或代词,副词;补充\nms-0155,ms,ms-02,adakah,是否；是不是,Adakah itu rumah awak?,那是你的房子吗？,ada + -kah，作为整词记；引导是非问,疑问词;补充\nms-0156,ms,ms-02,boleh,能；可以,Saya boleh tulis e-mel.,我会写电子邮件。,后接动词,助动词;补充\nms-0157,ms,ms-02,pejabat,办公室,Ibu saya ada di pejabat.,我的母亲在办公室。,量词 buah,名词;补充\nms-0158,ms,ms-02,kerana,因为,Saya suka mi ini kerana sedap.,我喜欢这些面条，因为它们好吃。,连接原因,连词;补充\nms-0159,ms,ms-02,kenapa,为什么,Kenapa awak tidak minum teh?,你为什么不喝茶？,同义词 mengapa,疑问词;补充\nms-0160,ms,ms-02,dengan,和；与,Saya pergi ke sekolah dengan Ali.,我和阿里去学校。,引出同行的人,介词;补充\nms-0161,ms,ms-03,ekor,只；头（动物量词）,Saya ada dua ekor kucing.,我有两只猫。,用于动物,量词\nms-0162,ms,ms-03,buah,个；本；辆（一般事物量词）,Saya ada tiga buah buku.,我有三本书。,用于 buku、rumah 等,量词\nms-0163,ms,ms-03,batang,支；根,Saya ada dua batang pen.,我有两支笔。,用于 pen、pensel 等细长物,量词\nms-0164,ms,ms-03,helai,张；件（薄片量词）,Ada dua helai kertas di atas meja.,桌子上有两张纸。,用于 kertas、bendera 等,量词\nms-0165,ms,ms-03,biji,粒；个,Ada tiga biji telur di dalam mangkuk.,碗里有三个鸡蛋。,用于 telur、epal 等,量词\nms-0166,ms,ms-03,keping,张；片,Saya ada dua keping tiket.,我有两张票。,用于 tiket 等薄片,量词\nms-0167,ms,ms-03,pasang,双；对,Saya ada dua pasang kasut.,我有两双鞋。,用于成对的物品,量词\nms-0168,ms,ms-03,cawan,杯（茶杯的容量）,Saya minum satu cawan teh.,我喝一杯茶。,也作名词「茶杯」，量词 buah；此处计容量,量词\nms-0169,ms,ms-03,gelas,杯（玻璃杯的容量）,Saya minum satu gelas air.,我喝一杯水。,也作名词「玻璃杯」，量词 buah；此处计容量,量词\nms-0170,ms,ms-03,mangkuk,碗（容量）,Saya makan satu mangkuk mi.,我吃一碗面条。,也作名词「碗」，量词 buah；补充替换已学 orang,量词;补充\nms-0171,ms,ms-03,sebelas,十一,Ada sebelas buah buku di sekolah.,学校里有十一本书。,基数词；数字 11,数词\nms-0172,ms,ms-03,dua belas,十二,Ada dua belas buah buku di sekolah.,学校里有十二本书。,基数词；数字 12,数词\nms-0173,ms,ms-03,tiga belas,十三,Ada tiga belas buah buku di sekolah.,学校里有十三本书。,基数词；数字 13,数词\nms-0174,ms,ms-03,empat belas,十四,Ada empat belas buah buku di sekolah.,学校里有十四本书。,基数词；数字 14,数词\nms-0175,ms,ms-03,lima belas,十五,Ada lima belas buah buku di sekolah.,学校里有十五本书。,基数词；数字 15,数词\nms-0176,ms,ms-03,dua puluh,二十,Ada dua puluh buah buku di sekolah.,学校里有二十本书。,基数词；数字 20,数词\nms-0177,ms,ms-03,tiga puluh,三十,Ada tiga puluh buah buku di sekolah.,学校里有三十本书。,基数词；数字 30,数词\nms-0178,ms,ms-03,seratus,一百,Ada seratus buah buku di sekolah.,学校里有一百本书。,基数词；数字 100,数词\nms-0179,ms,ms-03,dua ratus,二百,Ada dua ratus buah buku di sekolah.,学校里有二百本书。,基数词；数字 200,数词\nms-0180,ms,ms-03,seribu,一千,Ada seribu buah buku di sekolah.,学校里有一千本书。,基数词；数字 1000,数词\nms-0181,ms,ms-03,pertama,第一,Ini buku pertama saya.,这是我的第一本书。,序数词，放在名词后,数词\nms-0182,ms,ms-03,kedua,第二,Ini bilik kedua.,这是第二个房间。,序数词，放在名词后,数词\nms-0183,ms,ms-03,ketiga,第三,Ali pelajar ketiga.,阿里是第三个学生。,序数词，放在名词后,数词\nms-0184,ms,ms-03,seorang,一个人（连量词）,Ada seorang guru di kelas.,班里有一位老师。,se- 表一；本课只记此整词，不开放 se- 的通用推导,数词\nms-0185,ms,ms-03,sebuah,一个；一本（连量词）,Saya ada sebuah buku.,我有一本书。,se- 表一；本课只记此整词，不开放 se- 的通用推导,数词\nms-0186,ms,ms-03,tauhu,豆腐,Ada tauhu di rumah saya.,我家里有豆腐。,量词 keping,名词;家居与食物;闽南语借词\nms-0187,ms,ms-03,tauge,豆芽,Ada tauge di rumah saya.,我家里有豆芽。,一般不用量词；按份数可用 pinggan,名词;家居与食物;闽南语借词\nms-0188,ms,ms-03,bihun,米粉,Ada bihun di rumah saya.,我家里有米粉。,量词 mangkuk,名词;家居与食物;闽南语借词\nms-0189,ms,ms-03,kicap,酱油,Ada kicap di rumah saya.,我家里有酱油。,量词 sudu,名词;家居与食物;闽南语借词\nms-0190,ms,ms-03,teko,茶壶,Ada teko di rumah saya.,我家里有茶壶。,量词 buah,名词;家居与食物;闽南语借词\nms-0191,ms,ms-03,nasi,米饭,Ada nasi di rumah saya.,我家里有米饭。,量词 pinggan,名词;家居与食物\nms-0192,ms,ms-03,air,水,Ada air di rumah saya.,我家里有水。,量词 gelas,名词;家居与食物\nms-0193,ms,ms-03,roti,面包,Ada roti di rumah saya.,我家里有面包。,量词 keping,名词;家居与食物\nms-0194,ms,ms-03,telur,鸡蛋,Ada telur di rumah saya.,我家里有鸡蛋。,量词 biji,名词;家居与食物\nms-0195,ms,ms-03,susu,奶,Ada susu di rumah saya.,我家里有奶。,量词 gelas,名词;家居与食物\nms-0196,ms,ms-03,kopi,咖啡,Ada kopi di rumah saya.,我家里有咖啡。,量词 cawan,名词;家居与食物\nms-0197,ms,ms-03,gula,糖,Ada gula di rumah saya.,我家里有糖。,量词 sudu,名词;家居与食物\nms-0198,ms,ms-03,garam,盐,Ada garam di rumah saya.,我家里有盐。,量词 sudu,名词;家居与食物\nms-0199,ms,ms-03,sayur,蔬菜,Ada sayur di rumah saya.,我家里有蔬菜。,一般不用量词；按份数可用 pinggan,名词;家居与食物\nms-0200,ms,ms-03,pisang,香蕉,Ada pisang di rumah saya.,我家里有香蕉。,量词 biji,名词;家居与食物\nms-0201,ms,ms-03,epal,苹果,Ada epal di rumah saya.,我家里有苹果。,量词 biji,名词;家居与食物\nms-0202,ms,ms-03,pinggan,盘子,Ada pinggan di rumah saya.,我家里有盘子。,量词 buah,名词;家居与食物\nms-0203,ms,ms-03,sudu,勺子,Ada sudu di rumah saya.,我家里有勺子。,量词 batang,名词;家居与食物\nms-0204,ms,ms-03,garpu,叉子,Ada garpu di rumah saya.,我家里有叉子。,量词 batang,名词;家居与食物\nms-0205,ms,ms-03,katil,床,Ada katil di rumah saya.,我家里有床。,量词 buah,名词;家居与食物\nms-0206,ms,ms-03,almari,柜子,Ada almari di rumah saya.,我家里有柜子。,量词 buah,名词;家居与食物\nms-0207,ms,ms-03,lampu,灯,Ada lampu di rumah saya.,我家里有灯。,量词 buah,名词;家居与食物\nms-0208,ms,ms-03,jam,钟表,Ada jam di rumah saya.,我家里有钟表。,量词 buah,名词;家居与食物\nms-0209,ms,ms-03,kasut,鞋,Ada kasut di rumah saya.,我家里有鞋。,量词 pasang,名词;家居与食物\nms-0210,ms,ms-03,bantal,枕头,Ada bantal di rumah saya.,我家里有枕头。,量词 biji,名词;家居与食物\nms-0211,ms,ms-03,kucing,猫,Ada dua ekor kucing di belakang rumah.,房子后面有两只猫。,量词 ekor,名词;动物\nms-0212,ms,ms-03,anjing,狗,Ada dua ekor anjing di belakang rumah.,房子后面有两只狗。,量词 ekor,名词;动物\nms-0213,ms,ms-03,ayam,鸡,Ada dua ekor ayam di belakang rumah.,房子后面有两只鸡。,量词 ekor,名词;动物\nms-0214,ms,ms-03,ikan,鱼,Ada dua ekor ikan di belakang rumah.,房子后面有两条鱼。,量词 ekor,名词;动物\nms-0215,ms,ms-03,burung,鸟,Ada dua ekor burung di belakang rumah.,房子后面有两只鸟。,量词 ekor,名词;动物\nms-0216,ms,ms-03,lembu,牛,Ada dua ekor lembu di belakang rumah.,房子后面有两头牛。,量词 ekor,名词;动物\nms-0217,ms,ms-03,semua,所有,Semua buku ini baru.,这些书都是新的。,表示全部,数词\nms-0218,ms,ms-03,banyak,许多,Saya ada banyak buku.,我有许多书。,表示数量多；本周不用重叠,数词\nms-0219,ms,ms-03,beberapa,几个；一些,Ada beberapa orang pelajar di kelas.,班里有几个学生。,后可接量词，不用重叠,数词\nms-0220,ms,ms-03,sedikit,少量,Ada sedikit gula di dalam teh ini.,这杯茶里有少量糖。,表示数量少,数词\nms-0221,ms,ms-03,para,诸位；众（用于人）,Para pelajar ada di sekolah.,学生们在学校。,表示一群人，后面不用重叠,数词\nms-0222,ms,ms-03,cukup,足够,Buku ini cukup untuk semua pelajar.,这些书够所有学生用。,形容词，后置；本句作谓语,形容词;补充\nms-0223,ms,ms-03,lebih,更；较,Rumah Ali lebih besar.,阿里的房子更大。,程度副词，放形容词前,副词;补充\nms-0224,ms,ms-03,kurang,不太；较少,Teh ini kurang panas.,这杯茶不太热。,程度副词，放形容词前,副词;补充\nms-0225,ms,ms-03,atas,上面,Buku ada di atas meja.,书在桌子上。,方位名词，一般不用量词；di atas 作为地点词组记,名词;方位\nms-0226,ms,ms-03,bawah,下面,Kucing ada di bawah kerusi.,猫在椅子下面。,方位名词，一般不用量词；di bawah 作为地点词组记,名词;方位\nms-0227,ms,ms-03,dalam,里面,Pen ada di dalam beg.,笔在包里。,方位名词，一般不用量词；di dalam 作为地点词组记,名词;方位\nms-0228,ms,ms-03,depan,前面,Ali ada di depan sekolah.,阿里在学校前面。,方位名词，一般不用量词；di depan 作为地点词组记,名词;方位\nms-0229,ms,ms-03,belakang,后面,Bilik saya di belakang kelas.,我的房间在教室后面。,方位名词，一般不用量词；di belakang 作为地点词组记,名词;方位\nms-0230,ms,ms-03,sebelah,旁边,Rumah Ali di sebelah rumah saya.,阿里的房子在我家旁边。,方位名词，一般不用量词；di sebelah 作为地点词组记,名词;方位\nms-0231,ms,ms-03,Tiada buku di sini.,这里没有书。,Tiada buku di sini.,这里没有书。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0232,ms,ms-03,Saya ada dua buah buku.,我有两本书。,Saya ada dua buah buku.,我有两本书。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0233,ms,ms-03,Buku-buku ini untuk pelajar.,这些书是给学生的。,Buku-buku ini untuk pelajar.,这些书是给学生的。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0234,ms,ms-03,Ini buku yang saya suka.,这是我喜欢的书。,Ini buku yang saya suka.,这是我喜欢的书。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0235,ms,ms-03,Ada seekor kucing di rumah.,家里有一只猫。,Ada seekor kucing di rumah.,家里有一只猫。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0236,ms,ms-03,lantai,地板,Lantai bilik saya baru.,我房间的地板是新的。,一般不用量词；按一面墙或一片地板描述,名词;家居;补充\nms-0237,ms,ms-03,dinding,墙壁,Dinding rumah saya tinggi.,我家的墙壁很高。,一般不用量词；按一面墙或一片地板描述,名词;家居;补充\nms-0238,ms,ms-03,tandas,厕所,Tandas ada di sebelah bilik ini.,厕所在这个房间旁边。,量词 buah,名词;家居;补充\nms-0239,ms,ms-03,dapur,厨房,Ada sebuah dapur di rumah saya.,我家里有一间厨房。,量词 buah,名词;家居;补充\nms-0240,ms,ms-03,bunga,花,Ada bunga di atas meja.,桌子上有花。,量词 kuntum,名词;家居;补充\nms-0241,ms,ms-04,sudah,已经,Saya sudah makan nasi.,我已经吃过米饭了。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0242,ms,ms-04,telah,已经（较正式）,Ali telah tulis e-mel.,阿里已经写了电子邮件。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0243,ms,ms-04,belum,还没有,Saya belum makan.,我还没吃饭。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0244,ms,ms-04,akan,将要,Esok saya akan pergi ke Melaka.,明天我将去马六甲。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0245,ms,ms-04,sedang,正在,Ibu sedang baca buku.,母亲正在读书。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0246,ms,ms-04,masih,仍然；还,Adik masih tidur.,弟弟还在睡觉。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0247,ms,ms-04,pernah,曾经,Saya pernah pergi ke Pulau Pinang.,我曾经去过槟城。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0248,ms,ms-04,baru sahaja,刚刚,Ali baru sahaja datang.,阿里刚刚到。,时间或体貌标记，放在动词前；动词不因时间而变形；baru 的副词义，本课用固定搭配补足，不重复建 baru 卡,助动词;时间;补充\nms-0249,ms,ms-04,sekarang,现在,Sekarang saya ada di rumah.,现在我在家。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0250,ms,ms-04,hari ini,今天,Hari ini saya akan baca buku.,今天我将读书。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0251,ms,ms-04,semalam,昨天,Semalam saya pergi ke bank.,昨天我去了银行。,印尼语作 kemarin；本课马来语 semalam 指昨天；时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0252,ms,ms-04,kelmarin,前天,Kelmarin Ali datang ke rumah saya.,前天阿里来了我家。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0253,ms,ms-04,esok,明天,Esok saya akan beli roti.,明天我将买面包。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0254,ms,ms-04,lusa,后天,Lusa kami akan pergi ke Melaka.,后天我们将去马六甲。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0255,ms,ms-04,pagi,早晨,Saya bangun pada pukul enam pagi.,我早晨六点起床。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0256,ms,ms-04,tengah hari,中午,Saya makan pada pukul dua belas tengah hari.,我中午十二点吃饭。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0257,ms,ms-04,petang,下午；傍晚,Saya balik pada pukul lima petang.,我下午五点回家。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0258,ms,ms-04,malam,晚上,Saya tidur pada pukul sepuluh malam.,我晚上十点睡觉。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0259,ms,ms-04,minggu ini,这周,Minggu ini saya masih di Kuala Lumpur.,这周我仍在吉隆坡。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0260,ms,ms-04,minggu depan,下周,Minggu depan saya akan pergi ke Johor Bahru.,下周我将去新山。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0261,ms,ms-04,minggu lepas,上周,Minggu lepas saya beli buku ini.,上周我买了这本书。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0262,ms,ms-04,bulan,月,Bulan ini saya akan pergi ke China.,这个月我将去中国。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0263,ms,ms-04,tahun,年,Tahun ini adik saya belajar di sekolah.,今年我的弟弟在学校学习。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0264,ms,ms-04,Isnin,星期一,\"Pada hari Isnin, saya baca buku.\",星期一，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0265,ms,ms-04,Selasa,星期二,\"Pada hari Selasa, saya baca buku.\",星期二，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0266,ms,ms-04,Rabu,星期三,\"Pada hari Rabu, saya baca buku.\",星期三，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0267,ms,ms-04,Khamis,星期四,\"Pada hari Khamis, saya baca buku.\",星期四，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0268,ms,ms-04,Jumaat,星期五,\"Pada hari Jumaat, saya baca buku.\",星期五，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0269,ms,ms-04,Sabtu,星期六,\"Pada hari Sabtu, saya baca buku.\",星期六，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0270,ms,ms-04,Ahad,星期日,\"Pada hari Ahad, saya baca buku.\",星期日，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0271,ms,ms-04,Januari,一月,\"Pada bulan Januari, saya ada di Malaysia.\",一月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0272,ms,ms-04,Februari,二月,\"Pada bulan Februari, saya ada di Malaysia.\",二月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0273,ms,ms-04,Mac,三月,\"Pada bulan Mac, saya ada di Malaysia.\",三月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0274,ms,ms-04,April,四月,\"Pada bulan April, saya ada di Malaysia.\",四月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0275,ms,ms-04,Mei,五月,\"Pada bulan Mei, saya ada di Malaysia.\",五月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0276,ms,ms-04,Jun,六月,\"Pada bulan Jun, saya ada di Malaysia.\",六月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0277,ms,ms-04,Julai,七月,\"Pada bulan Julai, saya ada di Malaysia.\",七月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0278,ms,ms-04,Ogos,八月,\"Pada bulan Ogos, saya ada di Malaysia.\",八月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0279,ms,ms-04,September,九月,\"Pada bulan September, saya ada di Malaysia.\",九月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0280,ms,ms-04,Oktober,十月,\"Pada bulan Oktober, saya ada di Malaysia.\",十月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0281,ms,ms-04,November,十一月,\"Pada bulan November, saya ada di Malaysia.\",十一月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0282,ms,ms-04,Disember,十二月,\"Pada bulan Disember, saya ada di Malaysia.\",十二月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0283,ms,ms-04,bangun,起床,Saya bangun pada pukul enam.,我六点起床。,不及物,动词;日常生活\nms-0284,ms,ms-04,tidur,睡觉,Adik sedang tidur.,弟弟正在睡觉。,不及物,动词;日常生活\nms-0285,ms,ms-04,mandi,洗澡,Saya mandi pada waktu pagi.,我早晨洗澡。,不及物,动词;日常生活\nms-0286,ms,ms-04,balik,回去；回家,Saya akan balik ke rumah.,我将回家。,不及物；目的地用 ke,动词;日常生活\nms-0287,ms,ms-04,datang,来,Ali akan datang esok.,阿里明天会来。,不及物；到达地点用 ke,动词;日常生活\nms-0288,ms,ms-04,tunggu,等,Saya tunggu bas.,我等公共汽车。,及物；常见宾语 bas、kawan,动词;日常生活\nms-0289,ms,ms-04,beli,买,Saya beli roti.,我买面包。,及物；常见宾语 roti、buku,动词;日常生活\nms-0290,ms,ms-04,jual,卖,Mereka jual kuih.,他们卖糕点。,及物；常见宾语 kuih、buku,动词;日常生活\nms-0291,ms,ms-04,buat,做,Saya buat nota.,我做笔记。,及物；常见宾语 nota,动词;日常生活\nms-0292,ms,ms-04,cari,找,Saya cari buku saya.,我找我的书。,及物；常见宾语 buku、pen,动词;日常生活\nms-0293,ms,ms-04,tengok,看,Saya tengok filem di rumah.,我在家看电影。,及物；常见宾语 filem；本周作整词记,动词;日常生活\nms-0294,ms,ms-04,lari,跑,Saya lari pada waktu pagi.,我早晨跑步。,不及物,动词;日常生活;补充\nms-0295,ms,ms-04,rehat,休息,Saya rehat di rumah.,我在家休息。,不及物,动词;日常生活;补充\nms-0296,ms,ms-04,masak,煮；做饭,Ibu masak nasi.,母亲煮米饭。,及物；常见宾语 nasi、mi,动词;日常生活;补充\nms-0297,ms,ms-04,cuci,洗,Saya cuci pinggan.,我洗盘子。,及物；常见宾语 pinggan、cawan,动词;日常生活;补充\nms-0298,ms,ms-04,aktiviti,活动,Aktiviti ini pada hari Sabtu.,这个活动在星期六。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0299,ms,ms-04,program,项目；活动安排,Program sekolah ini pada bulan Oktober.,学校的这个活动安排在十月。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0300,ms,ms-04,projek,项目,Projek ini belum siap.,这个项目尚未完成。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0301,ms,ms-04,idea,想法,Idea Ali sangat baik.,阿里的想法很好。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0302,ms,ms-04,nota,笔记,Saya tulis nota di kelas.,我在课堂上记笔记。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0303,ms,ms-04,fail,文件夹,Fail itu di atas meja.,那个文件夹在桌子上。,量词 buah,名词;英语借词\nms-0304,ms,ms-04,video,视频,Video ini sangat pendek.,这个视频很短。,量词 buah,名词;英语借词\nms-0305,ms,ms-04,muzik,音乐,Saya suka muzik ini.,我喜欢这段音乐。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0306,ms,ms-04,foto,照片,Foto keluarga saya di dalam bilik.,我的全家福在房间里。,量词 keping,名词;英语借词\nms-0307,ms,ms-04,filem,电影,Filem ini panjang sekali.,这部电影很长。,量词 buah,名词;英语借词\nms-0308,ms,ms-04,Saya belum siap.,我还没准备好。,Saya belum siap.,我还没准备好。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0309,ms,ms-04,Sekarang waktu rehat.,现在是休息时间。,Sekarang waktu rehat.,现在是休息时间。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0310,ms,ms-04,Esok saya akan pergi ke sekolah.,明天我将去学校。,Esok saya akan pergi ke sekolah.,明天我将去学校。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0311,ms,ms-04,Semalam saya sudah baca buku itu.,昨天我已经读了那本书。,Semalam saya sudah baca buku itu.,昨天我已经读了那本书。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0312,ms,ms-04,Hari ini saya sedang tulis nota.,今天我正在写笔记。,Hari ini saya sedang tulis nota.,今天我正在写笔记。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0313,ms,ms-04,pukul,点钟（报时用）,Saya datang pada pukul lapan.,我八点来。,报时标记，放在数字前；一般不用量词，不表示计时长度,名词;时间;补充\nms-0314,ms,ms-04,setengah,半,Saya balik pada pukul lima setengah.,我五点半回家。,数词，表示一半,数词;时间;补充\nms-0315,ms,ms-04,suku,四分之一；一刻钟,Saya datang pada pukul tiga suku.,我三点一刻来。,数词；报时为过十五分钟,数词;时间;补充\nms-0316,ms,ms-04,minit,分钟,Saya rehat lima belas minit.,我休息十五分钟。,计时单位，一般不用量词,名词;时间;补充\nms-0317,ms,ms-04,pada,在（某个时间）,Saya pergi pada hari Isnin.,我星期一去。,介词，引时间；地点用 di,介词;时间;补充\nms-0318,ms,ms-04,tarikh,日期,Tarikh program ini 5 Oktober 2026.,这个活动的日期是 2026 年 10 月 5 日。,一般不用量词；写作 tarikh + 日期,名词;时间;补充\nms-0319,ms,ms-04,hari,天；日,Saya ada di sini tiga hari.,我在这里待三天。,计时单位，一般不用量词,名词;时间;补充\nms-0320,ms,ms-04,minggu,周；星期,Saya ada di Melaka dua minggu.,我在马六甲待两周。,计时单位，一般不用量词,名词;时间;补充\n";


// 任务 M2：第 5–8 周；新增内容的词汇边界仍从当前 front 分周推导。
const M2_LESSONS=['ms-05','ms-06','ms-07','ms-08'];
const M2_READINGS=Array.from({length:8},(_,i)=>'ms-r'+String(i+7).padStart(2,'0'));
const ms2Rows=initialRows.filter(row=>M2_LESSONS.includes(row.lesson));
const ms2Expanded=ms2Rows.reduce((n,row)=>n+(row.tags.split(';').includes('phrase')?1:2),0);
const M2_TEXTS=()=>[
  ...ms2Rows.map(row=>({id:row.id,lesson:row.lesson,text:row.example})),
  ...M2_LESSONS.flatMap(id=>[...api.LESSONS[id].reading.sentences,...msExplanationSentences(api.LESSONS[id])].map(s=>({id,lesson:id,...s}))),
  ...M2_READINGS.flatMap(id=>api.READINGS[id].sentences.map(s=>({id,lesson:api.READINGS[id].afterLesson,...s})))
];
test('任务 M2：四课周次、日期、每日 20 分钟与教材指引符合参数表',()=>{
  const start=Date.UTC(2026,9,5);
  const short=date=>String(date.getUTCMonth()+1).padStart(2,'0')+'-'+String(date.getUTCDate()).padStart(2,'0');
  for(const [i,id] of M2_LESSONS.entries()) {
    const lesson=api.LESSONS[id],week=i+5;
    assert.equal(lesson.lang,'ms');assert.equal(lesson.week,week);
    assert.equal(lesson.dates,short(new Date(start+(week-1)*7*86400000))+' 至 '+short(new Date(start+((week-1)*7+6)*86400000)));
    assert.equal(lesson.dailyTime,'每天 20 分钟 + 每周 1 次系统块 30 分钟');
    for(const field of ['name','goal','writingTask']) assert(lesson[field]?.trim(),id+' '+field);
    assert.match(lesson.writingTask,/5 句/);
    const first=msWalk(parseNodes(lesson.explanation())).find(n=>n.tag==='p').textContent;
    assert(first.includes(lesson.dailyTime));
    assert(first.includes('配合《Complete Malay》的对应单元，单元以实际教材为准'));
  }
  assert.match(api.LESSONS['ms-05'].explanation(),/11-08 月度检查点 2/);
  assert.equal(initialState.settings.newPerDay.ms,10);
});
test('任务 M2：每课 80 条、共 320 条，id 连续，CSV 同步且全 ms front 不重复',()=>{
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8')));
  assert.deepEqual(csv,initialRows.filter(r=>r.lang==='ms'));
  assert.equal(ms2Rows.length,320);
  assert.deepEqual(csv.slice(0,640).map(r=>r.id),Array.from({length:640},(_,i)=>'ms-'+String(i+1).padStart(4,'0')));
  assert.deepEqual(ms2Rows.map(r=>r.id),Array.from({length:320},(_,i)=>'ms-'+String(i+321).padStart(4,'0')));
  assert.equal(new Set(csv.map(r=>r.front.toLowerCase())).size,csv.length);
  for(const id of M2_LESSONS) assert.equal(ms2Rows.filter(r=>r.lesson===id).length,80,id);
  assert.deepEqual(initialRows.filter(row=>row.lang==='ms').slice(320,640),ms2Rows);
});
test('任务 M2：分类配额及六种 meN- 变形覆盖完整，重复旧词以同类新词补足',()=>{
  const base=id=>ms2Rows.filter(r=>r.lesson===id);
  const count=(id,fn)=>base(id).filter(fn).length;
  assert.equal(count('ms-05',r=>r.tags.startsWith('动词;日常活动')&&!r.tags.includes('phrase')),25);
  assert.equal(count('ms-05',r=>r.tags.startsWith('副词;时间')),8);
  assert.equal(count('ms-05',r=>r.tags.startsWith('名词;活动与运动')),15);
  assert.equal(count('ms-05',r=>r.tags.startsWith('名词;身体与衣物')),10);
  const menRows=base('ms-06').filter(r=>/^meN- \+/.test(r.note)&&!r.tags.includes('phrase'));
  assert.equal(menRows.length,35);
  const groups=new Map();
  for(const row of menRows) {
    const root=row.note.match(/^meN- \+ ([a-z]+)/)[1];
    const prefix=msMenRule(root).prefix;
    groups.set(prefix,(groups.get(prefix)||0)+1);
  }
  assert.deepEqual([...groups.keys()].sort(),['me-','mem-','men-','meng-','menge-','meny-'].sort());
  for(const [prefix,n] of groups) assert(n>=4,prefix+' 至少 4 个，实际 '+n);
  assert.equal(count('ms-06',r=>r.tags.startsWith('名词;学习与工作')),20);
  assert.equal(count('ms-06',r=>/^(连词|副词);时间/.test(r.tags)),5);
  assert.equal(count('ms-07',r=>r.tags.startsWith('介词;城市')),16);
  assert.equal(count('ms-07',r=>r.tags.split(';')[1]==='方位'),12);
  assert.equal(count('ms-07',r=>r.tags.startsWith('名词;城市')&&!r.tags.includes('补充')),20);
  assert.equal(count('ms-07',r=>r.tags.startsWith('名词;交通')),8);
  assert.equal(count('ms-07',r=>r.tags.startsWith('动词;问路')&&r.tags.includes('phrase')),8);
  assert.equal(count('ms-08',r=>r.tags.startsWith('助动词;情态')),12);
  assert.equal(count('ms-08',r=>r.tags.split(';')[1]==='请求与礼貌'),10);
  assert.equal(count('ms-08',r=>r.tags.startsWith('名词;食物与需求')),20);
  assert.equal(count('ms-08',r=>/^meN- \+/.test(r.note)&&!r.tags.includes('phrase')),20);
  for(const id of ['ms-05','ms-06','ms-08']) assert.equal(count(id,r=>/[.!?]$/.test(r.front)),5);
  for(const front of ['belajar','bekerja','boleh','suka','tahu']) {
    assert.equal(initialRows.filter(r=>r.lang==='ms'&&r.front===front).length,1,front+' 不重复建卡');
    assert(!ms2Rows.some(r=>r.front===front));
  }
});
test('任务 M2：词类、中文、量词、后置与宾语注释齐全，拼写卡能挖空',()=>{
  const parts=new Set('名词 动词 形容词 代词 数词 量词 介词 连词 副词 助动词 语气词 疑问词 问候'.split(' '));
  for(const row of ms2Rows) {
    const tags=row.tags.split(';');
    assert(parts.has(tags[0]),row.id+' 词类');assert(!tags.includes('letter'));
    assert(row.back && row.example_zh && row.note,row.id+' 字段');
    assert(/[.!?]["”']?$/.test(row.example),row.id+' 完整句子');
    assert(row.example.toLowerCase().includes(row.front.toLowerCase()),row.id+' 例句原形');
    if(/[.!?]$/.test(row.front)) assert(tags.includes('phrase'),row.id);
    if(tags[0]==='名词') assert.match(row.note,/量词/,row.id);
    if(tags[0]==='形容词') assert.match(row.note,/形容词，后置/,row.id);
    if(tags[0]==='动词'&&/及物/.test(row.note)&&!/不及物/.test(row.note)) assert.match(row.note,/宾语/,row.id);
    assert.deepEqual(plain(api.expandCards([row])).map(c=>c.direction),tags.includes('phrase')?['r']:['r','p']);
    if(!tags.includes('phrase')) {
      assert(api.clozeExample(row).includes('____'),row.id);
      assert(!api.clozeExample(row).includes('此例句没有'),row.id);
    }
  }
});
test('任务 M2：马来西亚拼写、口语范围与印尼语对照位置正确',()=>{
  // 本轮没有教授 bisa 的毒液义，因此所有目标语正文均拒绝此词。
  const banned=new Set('karena uang kantor universitas bahwa senin delapan mau saja sepeda sepatu kamar bisa kemarin'.split(' '));
  const informal=new Set('aku kau engkau tak nak dah je ni tu'.split(' '));
  const items=[...M2_TEXTS(),...ms2Rows.map(r=>({id:r.id,text:r.front}))];
  for(const item of items) for(const word of msWords(item.text).map(w=>w.toLowerCase())) {
    assert(!banned.has(word),item.id+' 印尼语形式 '+word);
    assert(!informal.has(word),item.id+' 越课口语 '+word);
  }
  for(const row of ms2Rows) for(const word of msWords(row.note).map(w=>w.toLowerCase()))
    if(banned.has(word)) assert(row.note.includes('印尼语作'),row.id);
});
test('任务 M2：四课各 6 道语法或拼写题与 4 道共用阅读题，答案可判',()=>{
  for(const id of M2_LESSONS) {
    const lesson=api.LESSONS[id];assert.equal(lesson.exercises.length,10);
    assert.equal(lesson.reading.questions.length,4);
    assert(lesson.exercises.slice(0,6).every(q=>!q.prompt.startsWith('阅读：')));
    for(let i=0;i<4;i++) assert.equal(lesson.exercises[i+6],lesson.reading.questions[i]);
    for(const q of lesson.exercises) {
      assert(q.prompt&&typeof q.answer==='string'&&q.answer.trim(),id);
      if(q.options) {
        assert(q.options.includes(q.answer),id+' 选项包含答案');
        assert.equal(new Set(q.options).size,q.options.length);
      }
      if(q.prompt.includes('____')) assert(/[（(].+[）)]/.test(q.prompt),id+' 填空提示');
    }
  }
});
test('任务 M2：四篇课内阅读各 80–120 词、10–14 句，中文与题目完整',()=>{
  for(const id of M2_LESSONS) {
    const item=api.LESSONS[id].reading,words=msWordCount(item.sentences);
    assert(item.title.trim());assert(words>=80&&words<=120,id+' '+words);
    assert(item.sentences.length>=10&&item.sentences.length<=14,id);
    for(const s of item.sentences) assert(s.text&&/[\u4e00-\u9fff]/.test(s.zh)&&/[.!?]$/.test(s.text),id);
    for(const q of item.questions) assert(q.options?.includes(q.answer));
  }
});
test('任务 M2：八篇阅读连续追加，afterLesson、周次、体裁与精确篇幅符合任务书',()=>{
  const ids=Object.keys(api.READINGS);
  const start=ids.indexOf('ms-r07');
  assert.deepEqual(ids.slice(start,start+8),M2_READINGS);
  assert.equal(ids[start-1],'ms-r06');
  assert.deepEqual(Object.values(api.READINGS).filter(r=>r.lang==='ms').slice(0,14).map(r=>r.id),
    Array.from({length:14},(_,i)=>'ms-r'+String(i+1).padStart(2,'0')));
  const ranges=[[80,95,10,12],[80,95,10,12],[90,105,11,13],[85,100,10,12],[95,110,11,13],[95,115,12,14],[100,120,12,14],[100,120,11,13]];
  const genres=['日记','人物介绍','短故事','菜谱或日程','房间或城市描写','对话','邮件','通知或广告'];
  for(const [i,id] of M2_READINGS.entries()) {
    const item=api.READINGS[id],[min,max,smin,smax]=ranges[i],week=5+Math.floor(i/2);
    assert.equal(item.id,id);assert.equal(item.lang,'ms');assert.equal(item.week,week);
    assert.equal(item.afterLesson,'ms-0'+week);assert.equal(item.genre,genres[i]);
    assert(item.title&&/[\u4e00-\u9fff]/.test(item.title));
    assert.equal(item.words,msWordCount(item.sentences));
    assert(item.words>=min&&item.words<=max,id+' '+item.words);
    assert(item.sentences.length>=smin&&item.sentences.length<=smax,id);
    for(const s of item.sentences) assert(s.text&&/[\u4e00-\u9fff]/.test(s.zh)&&/[.!?]$/.test(s.text),id);
  }
  for(let i=0;i<8;i+=2) assert.notEqual(api.READINGS[M2_READINGS[i]].genre,api.READINGS[M2_READINGS[i+1]].genre);
});
test('任务 M2：阅读线各 3 道阅读题、1 道推断题、5 个已学关键词与 5 行复述',()=>{
  for(const id of M2_READINGS) {
    const item=api.READINGS[id];assert.equal(item.questions.length,4);
    assert(item.questions.slice(0,3).every(q=>q.prompt.startsWith('阅读：')));
    assert(item.questions[3].prompt.startsWith('推断：'));
    for(const q of item.questions) {
      assert(q.options.includes(q.answer));
      assert.equal(q.options.length,3);assert.equal(new Set(q.options).size,3);
    }
    assert.equal(item.keyWords.length,5);
    assert.equal(new Set(item.keyWords.map(k=>k.word)).size,5);
    for(const key of item.keyWords) {
      assert(key.word&&key.zh);
      assert.deepEqual(msVocabularyMisses(item.afterLesson,[{text:key.word}]),[],id+' 关键词 '+key.word);
      assert(item.sentences.some(s=>s.text.toLowerCase().includes(key.word.toLowerCase())),id+' 关键词出现在本文');
    }
    assert.equal(item.retell.length,5);
    assert(item.retell.every(s=>typeof s==='string'&&/[\u4e00-\u9fff]/.test(s)));
  }
});
test('任务 M2：所有新例句、课文、阅读线和讲解完整例句不超课次词汇范围',()=>{
  const misses=M2_TEXTS().flatMap(s=>msVocabularyMisses(s.lesson,[s]).map(m=>({...m,lesson:s.lesson})));
  assert.deepEqual(misses,[]);
});
test('任务 M2：ber-、meN- 按周开放，五类变形、单音节和保留例外可推导',()=>{
  for(const [root,form] of [['jalan','berjalan'],['renang','berenang'],['rehat','berehat'],['kerja','bekerja'],['ajar','belajar']]) {
    assert(!msForms(root,4).has(form),root+' 提前开放');
    assert(msForms(root,5).has(form),root+' 未推导');
  }
  for(const [root,form] of [
    ['lihat','melihat'],['masak','memasak'],['nanti','menanti'],['nganga','menganga'],['nyanyi','menyanyi'],['rasa','merasa'],
    ['baca','membaca'],['fokus','memfokus'],['veto','memveto'],['pakai','memakai'],
    ['cari','mencari'],['dengar','mendengar'],['jual','menjual'],['syampu','mensyampu'],['ziarah','menziarah'],['tulis','menulis'],['tunggu','menunggu'],
    ['ambil','mengambil'],['gali','menggali'],['ghaib','mengghaib'],['khusus','mengkhusus'],['hantar','menghantar'],['kira','mengira'],
    ['sapu','menyapu'],['sewa','menyewa'],['cat','mengecat'],['bom','mengebom'],['lap','mengelap'],['pam','mengepam'],
    ['proses','memproses'],['kritik','mengkritik'],['struktur','menstruktur']
  ]) {
    assert(!msForms(root,5).has(form),root+' 提前开放');
    assert(msForms(root,6).has(form),root+' → '+form);
  }
  assert(msForms('baca',6).has('membacanya'));
  assert(msForms('buku',5).has('buku-bukunya'));
  for(const [root,bad] of [['rehat','berrehat'],['kerja','berkerja'],['ajar','berajar'],['tulis','mentulis'],['pakai','mempakai'],['kira','mengkira'],['sapu','mensapu'],['nyanyi','menyanyi-nyanyinya']])
    assert(!msForms(root,8).has(bad),bad+' 不应生成');
});
test('任务 M2：meN- 动词 front 与 note 的词根、变形和首字母保留规则一致',()=>{
  const rows=ms2Rows.filter(r=>/^meN- \+/.test(r.note)&&!r.tags.includes('phrase'));
  assert.equal(rows.length,55);
  for(const row of rows) {
    const m=row.note.match(/^meN- \+ ([a-z]+) → ([a-z]+)，/);
    assert(m,row.id+' note 格式');
    const [,root,front]=m,rule=msMenRule(root);
    assert.equal(front,row.front,row.id+' note 与 front');
    assert.equal(msMenForm(root),row.front,row.id+' 变形');
    assert((rule.exception?msVocabulary(row.lesson):msForms(root,Number(row.lesson.slice(3)))).has(row.front),row.id+' msForms 反查');
    assert(row.note.includes(rule.prefix),row.id+' 变体说明');
    if(!rule.keep) assert(row.note.includes(root[0]+' 脱落'),row.id+' 脱落说明');
    if(rule.keep) assert(row.note.includes('保留'),row.id+' 保留说明');
  }
  for(const row of ms2Rows.filter(r=>r.lesson==='ms-05'&&/^ber- \+/.test(r.note)&&!r.tags.includes('phrase'))) {
    const root=row.note.match(/^ber- \+ ([a-z]+)/)[1];
    assert.equal(msBerForm(root),row.front);assert(msForms(root,5).has(row.front));
  }
  assert.equal(msMenRule('nyanyi').prefix,'me-');
  assert.equal(msMenRule('masak').prefix,'me-');
  assert(msMenRule('kaji').exception);assert(msMenRule('tadbir').exception);
});
test('任务 M2：未学词缀和未来词不能放行，指定整词不提前开放派生规则',()=>{
  for(const [root,form] of [['tulis','tuliskan'],['baca','dibaca'],['baca','pembaca'],['rumah','serumah'],['duduk','duduklah'],['bantu','bantuan'],['sihat','kesihatan'],['ambil','terambil'],['kirim','mengirimkan']])
    assert(!msForms(root,8).has(form),form+' 越课派生');
  assert(!msVocabulary('ms-05').has('membaca'));
  assert(!msVocabulary('ms-07').has('memesan'));
  assert(msVocabulary('ms-08').has('silalah'));assert(msVocabulary('ms-08').has('maafkan'));
  assert(!msVocabulary('ms-07').has('silalah'));
  assert(msVocabularyMisses('ms-05',[{text:'Membaca buku.'}]).length>0,'大写句首不能绕过词汇检查');
  assert(msVocabularyMisses('ms-08',[{text:'Duduklah di sini.'}]).length>0);
  assert(msVocabularyMisses('ms-08',[{text:'Saya mengirimkan surat.'}]).length>0);
  assert.deepEqual(msVocabularyMisses('ms-06',[{text:'Saya membaca bukunya di Kuala Lumpur.'}]),[]);
});
test('任务 M2：讲解 HTML 标签闭合、语法要点、五句提纲及自查完整',()=>{
  const required=[
    ['berjalan','berlari','bermain','bercakap','berbual','berkata','berdiri','berhenti','bertemu','bekerja','belajar','berenang','berbaju','berkereta','be-','bel-','selalu','sentiasa','biasanya','kadang-kadang','jarang','tidak pernah','setiap hari'],
    ['规则 1','规则 2','规则 3','规则 4','规则 5','menge-','mengebom','memproses','mengkaji','mentadbir','nyanyi','辅音簇','宾语','makan','minum'],
    ['daripada','kepada','pada','untuk','bagi','dengan','tentang','mengenai','oleh','sejak','hingga','sehingga','sampai','antara','tanpa','seperti','di atas','bawah','dalam','luar','depan','belakang','sebelah','tepi','tengah','di antara','Bagaimana hendak','Belok kiri','berhampiran'],
    ['boleh','dapat','mesti','harus','perlu','mahu','hendak','ingin','suka','tahu','pandai','sudah boleh','akan dapat','tolong','sila','minta','jangan','-lah','tidak boleh','belum boleh']
  ];
  for(const [i,id] of M2_LESSONS.entries()) {
    const lesson=api.LESSONS[id],markup=lesson.explanation(),stack=[];
    for(const m of markup.matchAll(/<(\/?)([a-z][a-z0-9]*)(?:\s[^>]*)?>/gi)) {
      if(voidTags.has(m[2])) continue;
      if(m[1]) assert.equal(stack.pop(),m[2],id+' 标签匹配');else stack.push(m[2]);
    }
    assert.equal(stack.length,0,id+' 闭合');
    assert(!/<script|\bon\w+=|javascript:/i.test(markup));
    const nodes=msWalk(parseNodes(markup));
    assert(nodes.filter(n=>n.tag==='h4').length>=7,id+' 独立语法小节');
    assert(msExplanationSentences(lesson).length>=3);
    for(const part of required[i]) assert(markup.includes(part),id+' '+part);
    assert(nodes.some(n=>n.tag==='ol'&&n.querySelectorAll('li').length===5));
    assert(nodes.some(n=>n.tag==='ul'&&n.querySelectorAll('li').length>=4));
    assert(markup.includes('自查')&&markup.includes('名词短语')&&markup.includes('词缀拼写'));
    for(const paragraph of nodes.filter(n=>n.tag==='p'&&n.getAttribute('lang')==='ms')) {
      const parent=nodes.find(n=>n.childNodes.includes(paragraph));
      const next=parent.childNodes[parent.childNodes.indexOf(paragraph)+1];
      assert(next instanceof ElementModel&&/[\u4e00-\u9fff]/.test(next.textContent),id+' 例句紧跟中文');
    }
  }
});
test('任务 M2：只追加，旧 ms、es、ru 行按 id 顺序原样保留',()=>{
  const oldMs=plain(api.parseCSV(M2_OLD_MS_CSV));
  const csvText=fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8');
  // 本轮 CSV 无多行字段；按 id 匹配原始行，逐行比较，避免字节偏移和哈希。
  const csvLines=new Map(csvText.trimEnd().split('\n').slice(1).map(line=>[line.split(',')[0],line]));
  for(const line of M2_OLD_MS_CSV.trimEnd().split('\n').slice(1)) assert.equal(csvLines.get(line.split(',')[0]),line);
  assert.deepEqual(initialRows.filter(r=>r.lang==='ms').slice(0,oldMs.length),oldMs);
  const rawRows=[...blocks[0][1].matchAll(/\n  \{\n[\s\S]*?\n  \}/g)].map(m=>m[0].slice(1));
  assert.equal(rawRows.length,initialRows.length);
  const rawById=new Map(rawRows.map(raw=>[JSON.parse(raw).id,raw]));
  const oldRows=initialRows.slice(0,initialRows.findIndex(r=>r.id==='ms-0321'));
  assert.equal(oldRows.length,3616+320);
  for(const lang of ['es','ru','ms']) {
    const oldCSV=lang==='ms'?oldMs:plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards',lang+'.csv'),'utf8')));
    assert.deepEqual(oldRows.filter(r=>r.lang===lang),oldCSV,lang+' 旧行逐字段及顺序');
    for(const row of oldCSV) assert.equal(rawById.get(row.id),JSON.stringify([row],null,2).slice(2,-2),row.id+' 原始行格式');
  }
  assert.deepEqual(Object.keys(api.LESSONS).filter(id=>id.startsWith('ms-')).slice(4,8),M2_LESSONS);
  assert.deepEqual(Object.keys(api.READINGS).filter(id=>id.startsWith('ms-')).slice(6,14),M2_READINGS);
});
test('任务 M2：渲染四课八篇、页内练习与中文开关不改变真实进度',()=>{
  const {api:a,document,cache}=createAPI(true,html);a.initialize();
  const before=plain(a.getData().state),beforeRows=plain(a.getData().rows),dirty=a.getData().dirty;
  const cacheBefore=[...cache.entries()];
  for(const id of M2_LESSONS) {
    a.openLesson(id);
    const page=document.getElementById('content').textContent;
    for(const field of ['name','dates','dailyTime','goal','writingTask']) assert(page.includes(a.LESSONS[id][field]),id+' '+field);
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);
    for(const form of document.querySelectorAll('[data-exercise]')) {
      form.elements.answer.value=a.LESSONS[id].exercises[Number(form.dataset.exercise)].answer;
      document.getElementById('app').listeners.submit[0]({target:form,preventDefault(){}});
    }
  }
  a.showReadings();
  assert.deepEqual(document.querySelectorAll('[data-reading]').map(n=>n.dataset.reading).filter(id=>M2_READINGS.includes(id)),M2_READINGS);
  for(const id of M2_READINGS) {
    a.openReadingItem(id);
    assert(document.getElementById('content').textContent.includes(a.READINGS[id].title));
    assert.equal(document.querySelectorAll('[data-question]').length,4);
    const translations=()=>document.querySelectorAll('details').filter(n=>n.querySelector('summary')?.textContent==='查看本句中文');
    assert.equal(translations().length,a.READINGS[id].sentences.length);
    assert(translations().every(n=>n.getAttribute('open')===null));
    a.toggleReadingZh();assert(translations().every(n=>n.getAttribute('open')!==null));
    a.toggleReadingZh();
  }
  assert.deepEqual(plain(a.getData().state),before);
  assert.deepEqual(plain(a.getData().rows),beforeRows);
  assert.equal(a.getData().dirty,dirty);
  assert.deepEqual([...cache.entries()],cacheBefore);
});

// M3 baseline: retain the literal old rows, without hashes or byte offsets.
const M3_OLD_MS_CSV=M2_OLD_MS_CSV+"ms-0321,ms,ms-05,berjalan,走路,Saya berjalan ke sekolah setiap hari.,我每天走路去学校。,ber- + jalan → berjalan；词根 jalan；ber- 常规形式；不及物,动词;日常活动\nms-0322,ms,ms-05,berlari,跑步,Ali berlari di padang pada waktu pagi.,阿里早晨在运动场跑步。,ber- + lari → berlari；词根 lari；ber- 常规形式；不及物,动词;日常活动\nms-0323,ms,ms-05,bermain,玩；参加运动,Adik bermain bola dengan kawan.,弟弟和朋友玩球。,ber- + main → bermain；词根 main；ber- 常规形式；不及物,动词;日常活动\nms-0324,ms,ms-05,bercakap,说话,Kami bercakap dalam bahasa Melayu.,我们用马来语说话。,ber- + cakap → bercakap；词根 cakap；ber- 常规形式；不及物,动词;日常活动\nms-0325,ms,ms-05,berbual,聊天,Ibu berbual dengan kakak di rumah.,母亲和姐姐在家聊天。,ber- + bual → berbual；词根 bual；ber- 常规形式；不及物,动词;日常活动\nms-0326,ms,ms-05,berkata,说,\"Ali berkata, \"\"Saya sudah siap.\"\"\",阿里说：“我已经准备好了。”,ber- + kata → berkata；词根 kata；ber- 常规形式；不及物,动词;日常活动\nms-0327,ms,ms-05,berdiri,站立,Guru berdiri di depan kelas.,老师站在班级前面。,ber- + diri → berdiri；词根 diri；ber- 常规形式；不及物,动词;日常活动\nms-0328,ms,ms-05,berhenti,停下,Bas itu berhenti di depan sekolah.,那辆巴士在学校前停下。,ber- + henti → berhenti；词根 henti；ber- 常规形式；不及物,动词;日常活动\nms-0329,ms,ms-05,bertemu,见面,Saya bertemu dengan Siti pada hari Ahad.,我星期日和西蒂见面。,ber- + temu → bertemu；词根 temu；ber- 常规形式；不及物,动词;日常活动\nms-0330,ms,ms-05,berenang,游泳,Kami berenang di kolam pada petang Sabtu.,我们星期六下午在泳池游泳。,ber- + renang → berenang；词根 renang；be- 变体；不及物,动词;日常活动\nms-0331,ms,ms-05,berbaju,穿着上衣,Ali berbaju biru hari ini.,阿里今天穿着蓝色上衣。,ber- + baju → berbaju；词根 baju；ber- 常规形式；不及物,动词;日常活动\nms-0332,ms,ms-05,berkereta,有汽车；乘汽车,Kami berkereta ke Melaka pada hari Ahad.,我们星期日乘汽车去马六甲。,ber- + kereta → berkereta；词根 kereta；ber- 常规形式；不及物,动词;日常活动\nms-0333,ms,ms-05,berehat,休息,Bapa berehat di rumah pada waktu malam.,父亲晚上在家休息。,ber- + rehat → berehat；词根 rehat；be- 变体；不及物,动词;日常活动\nms-0334,ms,ms-05,berbasikal,骑自行车,Saya berbasikal dengan abang setiap petang.,我每天下午和哥哥骑自行车。,ber- + basikal → berbasikal；词根 basikal；ber- 常规形式；不及物,动词;日常活动\nms-0335,ms,ms-05,bersukan,从事体育运动,Kami bersukan di sekolah pada hari Jumaat.,我们星期五在学校运动。,ber- + sukan → bersukan；词根 sukan；ber- 常规形式；不及物,动词;日常活动\nms-0336,ms,ms-05,bersenam,做体操；锻炼,Ibu bersenam selama dua puluh minit.,母亲锻炼二十分钟。,ber- + senam → bersenam；词根 senam；ber- 常规形式；不及物,动词;日常活动\nms-0337,ms,ms-05,berlatih,练习,Mereka berlatih badminton pada waktu petang.,他们下午练习羽毛球。,ber- + latih → berlatih；词根 latih；ber- 常规形式；不及物,动词;日常活动\nms-0338,ms,ms-05,berkebun,做园艺；种菜,Bapa berkebun di belakang rumah.,父亲在屋后种菜。,ber- + kebun → berkebun；词根 kebun；ber- 常规形式；不及物,动词;日常活动\nms-0339,ms,ms-05,berdoa,祈祷,Keluarga itu berdoa di rumah.,那家人在家祈祷。,ber- + doa → berdoa；词根 doa；ber- 常规形式；不及物,动词;日常活动\nms-0340,ms,ms-05,berjumpa,见到；碰面,Saya berjumpa dengan guru selepas kelas.,我课后与老师见面。,ber- + jumpa → berjumpa；词根 jumpa；ber- 常规形式；不及物,动词;日常活动\nms-0341,ms,ms-05,bertanya,询问,Pelajar bertanya kepada guru tentang buku itu.,学生向老师询问那本书。,ber- + tanya → bertanya；词根 tanya；ber- 常规形式；不及物,动词;日常活动\nms-0342,ms,ms-05,bercuti,休假,Kami bercuti di Pulau Pinang minggu ini.,我们这周在槟城度假。,ber- + cuti → bercuti；词根 cuti；ber- 常规形式；不及物,动词;日常活动\nms-0343,ms,ms-05,berkumpul,集合；聚集,Para pelajar berkumpul di padang sekolah.,学生们在学校运动场集合。,ber- + kumpul → berkumpul；词根 kumpul；ber- 常规形式；不及物,动词;日常活动\nms-0344,ms,ms-05,berpayung,撑伞,Siti berpayung kerana hujan.,西蒂因为下雨而撑伞。,ber- + payung → berpayung；词根 payung；ber- 常规形式；不及物,动词;日常活动\nms-0345,ms,ms-05,berkasut,穿着鞋,Abang berkasut hitam ke sekolah.,哥哥穿着黑鞋去学校。,ber- + kasut → berkasut；词根 kasut；ber- 常规形式；不及物,动词;日常活动\nms-0346,ms,ms-05,selalu,经常,Saya selalu berjalan ke sekolah.,我经常走路去学校。,频率副词，放在动作前,副词;时间\nms-0347,ms,ms-05,sentiasa,始终；总是,Ibu sentiasa bangun pada pukul enam.,母亲总是六点起床。,表示持续或一贯,副词;时间\nms-0348,ms,ms-05,biasanya,通常,Kami biasanya bersukan pada hari Sabtu.,我们通常星期六运动。,表示一般习惯,副词;时间\nms-0349,ms,ms-05,kadang-kadang,有时,Saya kadang-kadang berkereta ke pejabat.,我有时乘汽车去办公室。,频率副词，连字符不可省,副词;时间\nms-0350,ms,ms-05,jarang,很少,Bapa jarang bercuti pada bulan Disember.,父亲很少在十二月休假。,频率低，不等于从不,副词;时间\nms-0351,ms,ms-05,tidak pernah,从未,Saya tidak pernah berenang di kolam itu.,我从未在那个泳池游泳。,否定词与体貌标记组合,副词;时间\nms-0352,ms,ms-05,setiap hari,每天,Ali belajar bahasa Melayu setiap hari.,阿里每天学马来语。,固定时间短语，setiap 后用单数名词,副词;时间\nms-0353,ms,ms-05,sering,时常,Kami sering berbual pada waktu rehat.,我们时常在休息时间聊天。,频率副词,副词;时间\nms-0354,ms,ms-05,sukan,体育运动,Saya suka sukan di sekolah.,我喜欢学校的体育运动。,量词 种类用 jenis,名词;活动与运动\nms-0355,ms,ms-05,bola,球,Adik ada dua biji bola.,弟弟有两个球。,量词 biji,名词;活动与运动\nms-0356,ms,ms-05,bola sepak,足球运动,Abang bermain bola sepak pada hari Ahad.,哥哥星期日踢足球。,量词 比赛场次用 perlawanan,名词;活动与运动\nms-0357,ms,ms-05,badminton,羽毛球运动,Kami bermain badminton setiap petang.,我们每天下午打羽毛球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0358,ms,ms-05,tenis,网球运动,Siti bermain tenis dengan Ali.,西蒂和阿里打网球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0359,ms,ms-05,pingpong,乒乓球运动,Kami bermain pingpong di sekolah.,我们在学校打乒乓球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0360,ms,ms-05,hoki,曲棍球运动,Kakak bermain hoki pada hari Sabtu.,姐姐星期六打曲棍球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0361,ms,ms-05,golf,高尔夫球运动,Bapa jarang bermain golf.,父亲很少打高尔夫球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0362,ms,ms-05,yoga,瑜伽,Ibu belajar yoga di rumah.,母亲在家学瑜伽。,量词 通常不用量词,名词;活动与运动;梵语借词\nms-0363,ms,ms-05,senaman,锻炼；体操,Senaman ini baik untuk saya.,这种锻炼对我有益。,量词 套用 set,名词;活动与运动\nms-0364,ms,ms-05,latihan,练习；训练,Latihan badminton kami pada pukul lima.,我们的羽毛球训练在五点。,通常不用专用量词，可写 satu latihan（一项练习）,名词;活动与运动\nms-0365,ms,ms-05,padang,运动场；草地,Padang sekolah itu besar.,那所学校的运动场很大。,量词 buah,名词;活动与运动\nms-0366,ms,ms-05,kolam,池；泳池,Kami berenang di kolam besar itu.,我们在那个大泳池游泳。,量词 buah,名词;活动与运动\nms-0367,ms,ms-05,kelab,俱乐部,Kelab sukan itu ada dua puluh orang pelajar.,那个体育俱乐部有二十名学生。,量词 buah,名词;活动与运动;英语借词\nms-0368,ms,ms-05,hobi,爱好,Hobi saya ialah berkebun.,我的爱好是园艺。,量词 通常不用量词,名词;活动与运动;英语借词\nms-0369,ms,ms-05,tangan,手,Tangan saya kecil.,我的手很小。,量词 只用 belah，双手用 pasang,名词;身体与衣物\nms-0370,ms,ms-05,kaki,脚；腿,Kaki Ali panjang.,阿里的腿很长。,量词 只用 belah，双脚用 pasang,名词;身体与衣物\nms-0371,ms,ms-05,kepala,头,Kepala kucing itu kecil.,那只猫的头很小。,一般不另用量词，按所属的人或动物计数,名词;身体与衣物\nms-0372,ms,ms-05,mata,眼睛,Mata adik besar.,弟弟的眼睛很大。,量词 只用 belah，双眼用 pasang,名词;身体与衣物\nms-0373,ms,ms-05,baju,上衣,Saya ada tiga helai baju biru.,我有三件蓝色上衣。,量词 helai,名词;身体与衣物\nms-0374,ms,ms-05,seluar,裤子,Seluar abang panjang.,哥哥的裤子很长。,量词 helai,名词;身体与衣物\nms-0375,ms,ms-05,kemeja,衬衫,Kemeja bapa baru.,父亲的衬衫是新的。,量词 helai,名词;身体与衣物;葡语借词\nms-0376,ms,ms-05,stoking,袜子,Saya ada dua pasang stoking.,我有两双袜子。,量词 pasang,名词;身体与衣物;英语借词\nms-0377,ms,ms-05,topi,帽子,Topi Siti biru.,西蒂的帽子是蓝色的。,量词 顶用 buah,名词;身体与衣物\nms-0378,ms,ms-05,tudung,头巾,Tudung Aminah cantik.,阿米娜的头巾很漂亮。,量词 helai,名词;身体与衣物\nms-0379,ms,ms-05,Saya berjalan setiap pagi.,我每天早晨走路。,Saya berjalan setiap pagi.,我每天早晨走路。,ber- + jalan；不及物；时间短语在句尾,动词;日常活动;phrase\nms-0380,ms,ms-05,Kami biasanya bersenam bersama.,我们通常一起锻炼。,Kami biasanya bersenam bersama.,我们通常一起锻炼。,ber- + senam；不及物；频率词在动作前,动词;日常活动;phrase\nms-0381,ms,ms-05,Saya tidak pernah bermain golf.,我从未打过高尔夫球。,Saya tidak pernah bermain golf.,我从未打过高尔夫球。,ber- + main；不及物；golf 是活动补语,动词;日常活动;phrase\nms-0382,ms,ms-05,Ali sedang berehat di rumah.,阿里正在家休息。,Ali sedang berehat di rumah.,阿里正在家休息。,ber- + rehat；be- 变体；不及物,动词;日常活动;phrase\nms-0383,ms,ms-05,Kita bertemu selepas kelas.,我们课后见面。,Kita bertemu selepas kelas.,我们课后见面。,ber- + temu；不及物,动词;日常活动;phrase\nms-0384,ms,ms-05,kereta,汽车,Kereta bapa besar.,父亲的汽车很大。,量词 buah,名词;日常活动;补充\nms-0385,ms,ms-05,basikal,自行车,Basikal saya baru.,我的自行车是新的。,量词 buah,名词;日常活动;补充\nms-0386,ms,ms-05,payung,伞,Payung ini untuk Siti.,这把伞给西蒂。,量词 把用 kaki,名词;日常活动;补充\nms-0387,ms,ms-05,hujan,雨,Hari ini hujan.,今天下雨。,通常不用量词；hujan 也可直接表示下雨,名词;日常活动;补充\nms-0388,ms,ms-05,gim,健身房,Gim itu di sebelah sekolah.,那间健身房在学校旁边。,量词 buah,名词;日常活动;英语借词;补充\nms-0389,ms,ms-05,selepas,在……之后,Saya berehat selepas senaman.,我锻炼后休息。,后接时间或活动，表示先后,介词;日常活动;补充\nms-0390,ms,ms-05,sebelum,在……之前,Kami mandi sebelum makan.,我们吃饭前洗澡。,后接时间或活动,介词;日常活动;补充\nms-0391,ms,ms-05,selama,持续……时间,Ali berenang selama setengah jam.,阿里游泳半小时。,后接时长,介词;日常活动;补充\nms-0392,ms,ms-05,kepada,向；对某人,Siti bertanya kepada guru.,西蒂向老师提问。,引出动作所指向的人,介词;日常活动;补充\nms-0393,ms,ms-05,tentang,关于,Kami berbual tentang sukan.,我们谈论体育。,引出话题,介词;日常活动;补充\nms-0394,ms,ms-05,bersama,一起,Kami berjalan bersama ke sekolah.,我们一起走路去学校。,ber- + sama；词根 sama；本课作副词,副词;日常活动;补充\nms-0395,ms,ms-05,letih,疲倦的,Saya letih selepas bersukan.,我运动后很累。,形容词，后置,形容词;日常活动;补充\nms-0396,ms,ms-05,sihat,健康的,Keluarga kami sihat.,我们一家人都健康。,形容词，后置,形容词;日常活动;阿拉伯语借词;补充\nms-0397,ms,ms-05,biru,蓝色的,Baju biru itu baju saya.,那件蓝色上衣是我的上衣。,形容词，后置,形容词;日常活动;补充\nms-0398,ms,ms-05,hitam,黑色的,Kasut hitam itu baru.,那双黑鞋是新的。,形容词，后置,形容词;日常活动;补充\nms-0399,ms,ms-05,merah,红色的,Bola merah itu untuk adik.,那个红球给弟弟。,形容词，后置,形容词;日常活动;补充\nms-0400,ms,ms-05,putih,白色的,Kemeja putih itu baru.,那件白衬衫是新的。,形容词，后置,形容词;日常活动;补充\nms-0401,ms,ms-06,melihat,看见,Saya melihat Siti di sekolah.,我在学校看见西蒂。,meN- + lihat → melihat，me-；l 保留；词根 lihat；及物；常见宾语 buku、kawan,动词;学习与工作\nms-0402,ms,ms-06,memasak,烹煮,Ibu memasak nasi di dapur.,母亲在厨房煮饭。,meN- + masak → memasak，me-；m 保留；词根 masak；及物；常见宾语 nasi、sayur,动词;学习与工作\nms-0403,ms,ms-06,menanti,等候,Kami menanti bas di depan sekolah.,我们在学校前等巴士。,meN- + nanti → menanti，me-；n 保留；词根 nanti；及物；常见宾语 bas、kawan,动词;学习与工作\nms-0404,ms,ms-06,merasa,品尝,Bapa merasa kopi itu.,父亲尝了尝那杯咖啡。,meN- + rasa → merasa，me-；r 保留；词根 rasa；及物；常见宾语 sup、kopi,动词;学习与工作\nms-0405,ms,ms-06,menyanyi,唱歌,Adik menyanyi di dalam bilik.,弟弟在房间里唱歌。,meN- + nyanyi → menyanyi，me-；ny 保留，不是 s 脱落；词根 nyanyi；不及物，不直接带宾语,动词;学习与工作\nms-0406,ms,ms-06,membaca,阅读,Siti membaca surat Ali.,西蒂读阿里的信。,meN- + baca → membaca，mem-；b 保留；词根 baca；及物；常见宾语 buku、surat,动词;学习与工作\nms-0407,ms,ms-06,membeli,购买,Kami membeli beras di kedai.,我们在商店买米。,meN- + beli → membeli，mem-；b 保留；词根 beli；及物；常见宾语 beras、baju,动词;学习与工作\nms-0408,ms,ms-06,memakai,穿戴；使用,Ali memakai baju putih ke sekolah.,阿里穿白色上衣去学校。,meN- + pakai → memakai，mem-；p 脱落；词根 pakai；及物；常见宾语 baju、kasut,动词;学习与工作\nms-0409,ms,ms-06,memukul,敲打；击打,Siti memukul bola itu.,西蒂击打那个球。,meN- + pukul → memukul，mem-；p 脱落；词根 pukul；及物；常见宾语 bola、gendang,动词;学习与工作\nms-0410,ms,ms-06,memproses,处理,Kerani memproses borang itu.,办事员处理那张表格。,meN- + proses → memproses，mem-；pr 辅音簇保留；词根 proses；及物；常见宾语 borang、data,动词;学习与工作\nms-0411,ms,ms-06,membawa,携带,Saya membawa beg ke sekolah.,我带着书包去学校。,meN- + bawa → membawa，mem-；b 保留；词根 bawa；及物；常见宾语 beg、buku,动词;学习与工作\nms-0412,ms,ms-06,mencari,寻找,Ali mencari pen di dalam beg.,阿里在包里找笔。,meN- + cari → mencari，men-；c 保留；词根 cari；及物；常见宾语 buku、pen,动词;学习与工作\nms-0413,ms,ms-06,mendengar,听；听见,Kami mendengar berita di radio.,我们听广播里的新闻。,meN- + dengar → mendengar，men-；d 保留；词根 dengar；及物；常见宾语 muzik、berita,动词;学习与工作\nms-0414,ms,ms-06,menjual,售卖,Kedai itu menjual sayur dan roti.,那家店卖蔬菜和面包。,meN- + jual → menjual，men-；j 保留；词根 jual；及物；常见宾语 sayur、roti,动词;学习与工作\nms-0415,ms,ms-06,menulis,书写,Saya menulis surat kepada Siti.,我给西蒂写信。,meN- + tulis → menulis，men-；t 脱落；词根 tulis；及物；常见宾语 surat、nota,动词;学习与工作\nms-0416,ms,ms-06,menunggu,等候,Mei Ling menunggu Raju di sekolah.,美玲在学校等拉朱。,meN- + tunggu → menunggu，men-；t 脱落；词根 tunggu；及物；常见宾语 bas、kawan,动词;学习与工作\nms-0417,ms,ms-06,mentadbir,管理,Beliau mentadbir sekolah itu.,他管理那所学校。,meN- + tadbir → mentadbir，men-；借词 t 保留，不是词首辅音簇；词根 tadbir；及物；常见宾语 sekolah、pejabat,动词;学习与工作\nms-0418,ms,ms-06,mencuci,洗,Adik mencuci tangan dengan sabun.,弟弟用肥皂洗手。,meN- + cuci → mencuci，men-；c 保留；词根 cuci；及物；常见宾语 tangan、baju,动词;学习与工作\nms-0419,ms,ms-06,menjawab,回答,Guru menjawab soalan saya.,老师回答我的问题。,meN- + jawab → menjawab，men-；j 保留；词根 jawab；及物；常见宾语 soalan、surat,动词;学习与工作\nms-0420,ms,ms-06,mengambil,拿取,Saya mengambil buku di atas meja.,我拿桌上的书。,meN- + ambil → mengambil，meng-；元音 a 保留；词根 ambil；及物；常见宾语 buku、air,动词;学习与工作\nms-0421,ms,ms-06,mengajar,教,Siti mengajar bahasa Melayu di sekolah.,西蒂在学校教马来语。,meN- + ajar → mengajar，meng-；元音 a 保留；词根 ajar；及物；常见宾语 bahasa、pelajar,动词;学习与工作\nms-0422,ms,ms-06,menghantar,送；寄送,Ali menghantar surat kepada Mei Ling.,阿里给美玲寄信。,meN- + hantar → menghantar，meng-；h 保留；词根 hantar；及物；常见宾语 surat、anak,动词;学习与工作\nms-0423,ms,ms-06,mengira,计算；数,Kerani mengira wang di pejabat.,办事员在办公室数钱。,meN- + kira → mengira，meng-；k 脱落；词根 kira；及物；常见宾语 wang、buku,动词;学习与工作\nms-0424,ms,ms-06,mengirim,寄送,Saya mengirim e-mel kepada guru.,我给老师发电子邮件。,meN- + kirim → mengirim，meng-；k 脱落；词根 kirim；及物；常见宾语 surat、e-mel,动词;学习与工作\nms-0425,ms,ms-06,mengkaji,研究,Mereka mengkaji bahasa Melayu di universiti.,他们在大学研究马来语。,meN- + kaji → mengkaji，meng-；k 保留，词汇例外；词根 kaji；及物；常见宾语 bahasa、resipi,动词;学习与工作\nms-0426,ms,ms-06,menggali,挖掘,Bapa menggali lubang di belakang rumah.,父亲在屋后挖洞。,meN- + gali → menggali，meng-；g 保留；词根 gali；及物；常见宾语 lubang、tanah,动词;学习与工作\nms-0427,ms,ms-06,mengukur,测量,Kakak mengukur kain itu.,姐姐测量那块布。,meN- + ukur → mengukur，meng-；元音 u 保留；词根 ukur；及物；常见宾语 meja、kain,动词;学习与工作\nms-0428,ms,ms-06,menyapu,扫,Ali menyapu lantai rumah.,阿里扫家里的地板。,meN- + sapu → menyapu，meny-；s 脱落；词根 sapu；及物；常见宾语 lantai、bilik,动词;学习与工作\nms-0429,ms,ms-06,menyewa,租用,Kami menyewa basikal di Melaka.,我们在马六甲租自行车。,meN- + sewa → menyewa，meny-；s 脱落；词根 sewa；及物；常见宾语 rumah、basikal,动词;学习与工作\nms-0430,ms,ms-06,menyimpan,保存；收好,Ibu menyimpan wang di bank.,母亲把钱存进银行。,meN- + simpan → menyimpan，meny-；s 脱落；词根 simpan；及物；常见宾语 wang、buku,动词;学习与工作\nms-0431,ms,ms-06,menyusun,排列；整理,Saya menyusun buku di atas meja.,我整理桌上的书。,meN- + susun → menyusun，meny-；s 脱落；词根 susun；及物；常见宾语 buku、kerusi,动词;学习与工作\nms-0432,ms,ms-06,mengecat,涂漆,Bapa mengecat pintu dengan berus.,父亲用刷子给门涂漆。,meN- + cat → mengecat，menge-；单音节词根完整保留；词根 cat；及物；常见宾语 dinding、pintu,动词;学习与工作\nms-0433,ms,ms-06,mengepam,打气；抽水,Ali mengepam tayar basikal.,阿里给自行车轮胎打气。,meN- + pam → mengepam，menge-；单音节词根完整保留；词根 pam；及物；常见宾语 tayar、air,动词;学习与工作\nms-0434,ms,ms-06,mengelap,擦拭,Siti mengelap meja dengan kain.,西蒂用布擦桌子。,meN- + lap → mengelap，menge-；单音节词根完整保留；词根 lap；及物；常见宾语 meja、tingkap,动词;学习与工作\nms-0435,ms,ms-06,mengepos,邮寄,Kakak mengepos surat pada hari Isnin.,姐姐星期一寄信。,meN- + pos → mengepos，menge-；单音节词根完整保留；词根 pos；及物；常见宾语 surat、borang,动词;学习与工作\nms-0436,ms,ms-06,surat,信,Surat ini daripada Ali.,这封信来自阿里。,量词 封用 pucuk,名词;学习与工作\nms-0437,ms,ms-06,sampul,信封,Saya menyimpan surat di dalam sampul.,我把信收在信封里。,量词 个用 keping,名词;学习与工作\nms-0438,ms,ms-06,borang,表格,Siti membaca borang itu.,西蒂读那张表格。,量词 张用 helai,名词;学习与工作\nms-0439,ms,ms-06,berus,刷子,Bapa membawa berus ke rumah.,父亲把刷子带回家。,量词 把用 batang,名词;学习与工作\nms-0440,ms,ms-06,cat,油漆,Cat ini merah.,这种油漆是红色的。,量词 罐用 tin,名词;学习与工作;闽南语借词\nms-0441,ms,ms-06,pam,泵；打气筒,Pam basikal itu kecil.,那个自行车打气筒很小。,量词 buah,名词;学习与工作;英语借词\nms-0442,ms,ms-06,tayar,轮胎,Tayar kereta itu baru.,那辆汽车的轮胎是新的。,量词 个用 biji,名词;学习与工作;英语借词\nms-0443,ms,ms-06,baldi,桶,Saya membawa baldi ke dapur.,我把桶拿到厨房。,量词 buah,名词;学习与工作;葡语借词\nms-0444,ms,ms-06,kain,布,Ibu membeli kain biru.,母亲买蓝布。,量词 片用 helai,名词;学习与工作\nms-0445,ms,ms-06,sabun,肥皂,Sabun ini untuk mencuci tangan.,这块肥皂用来洗手。,量词 块用 buku,名词;学习与工作\nms-0446,ms,ms-06,ubat,药,Ibu membeli ubat di klinik.,母亲在诊所买药。,量词 片用 biji，液体用 botol,名词;学习与工作\nms-0447,ms,ms-06,wang,钱,Wang saya ada di dalam beg.,我的钱在包里。,量词 金额用 ringgit,名词;学习与工作\nms-0448,ms,ms-06,cerita,故事,Cerita Ali sangat panjang.,阿里的故事很长。,量词 篇用 buah,名词;学习与工作\nms-0449,ms,ms-06,berita,新闻；消息,Berita itu tentang sekolah kami.,那条新闻是关于我们学校的。,量词 条用 buah,名词;学习与工作\nms-0450,ms,ms-06,lagu,歌曲,Lagu ini dalam bahasa Melayu.,这首歌是马来语歌。,量词 首用 buah,名词;学习与工作\nms-0451,ms,ms-06,resipi,食谱,Saya membaca resipi ibu.,我读母亲的食谱。,通常不用专用量词，可写 satu resipi（一份食谱）,名词;学习与工作;英语借词\nms-0452,ms,ms-06,beras,生米,Beras ini untuk keluarga kami.,这些米给我们一家人。,量词 袋用 kampit,名词;学习与工作\nms-0453,ms,ms-06,bawang,洋葱；葱蒜类,Ibu membeli bawang di kedai.,母亲在商店买洋葱。,量词 个用 biji,名词;学习与工作\nms-0454,ms,ms-06,minyak,油,Minyak ini untuk memasak.,这种油用来烹饪。,量词 瓶用 botol,名词;学习与工作\nms-0455,ms,ms-06,periuk,锅,Periuk itu ada di dapur.,那口锅在厨房。,量词 口用 buah,名词;学习与工作\nms-0456,ms,ms-06,sambil,一边……一边……,Siti memasak sambil mendengar radio.,西蒂一边做饭一边听广播。,连接同时发生的动作,连词;时间\nms-0457,ms,ms-06,lalu,然后；于是,Ali mengambil pen lalu menulis surat.,阿里拿起笔，然后写信。,连接先后动作,连词;时间\nms-0458,ms,ms-06,kemudian,然后,\"Saya mencuci tangan, kemudian makan nasi.\",我洗手，然后吃饭。,连接叙述的先后,副词;时间\nms-0459,ms,ms-06,akhirnya,最后；终于,Akhirnya kami bertemu di sekolah.,最后我们在学校见面了。,表示过程的末尾,副词;时间\nms-0460,ms,ms-06,segera,立刻,Saya segera menjawab e-mel guru.,我立即回复老师的电子邮件。,副词，表示不拖延,副词;时间\nms-0461,ms,ms-06,Saya sedang membaca surat.,我正在读信。,Saya sedang membaca surat.,我正在读信。,meN- + baca → membaca，b 保留；宾语 surat,动词;学习与工作;phrase\nms-0462,ms,ms-06,Ibu memasak sambil menyanyi.,母亲一边做饭一边唱歌。,Ibu memasak sambil menyanyi.,母亲一边做饭一边唱歌。,me- + masak；me- + nyanyi；此处不带宾语,动词;学习与工作;phrase\nms-0463,ms,ms-06,Ali menulis dengan pen.,阿里用笔写字。,Ali menulis dengan pen.,阿里用笔写字。,meN- + tulis → menulis，t 脱落；宾语可为 surat，本句省略,动词;学习与工作;phrase\nms-0464,ms,ms-06,Kami menyusun buku bersama.,我们一起整理书。,Kami menyusun buku bersama.,我们一起整理书。,meN- + susun → menyusun，s 脱落；宾语 buku,动词;学习与工作;phrase\nms-0465,ms,ms-06,Siti mengelap meja itu.,西蒂擦那张桌子。,Siti mengelap meja itu.,西蒂擦那张桌子。,meN- + lap → mengelap，单音节；宾语 meja,动词;学习与工作;phrase\nms-0466,ms,ms-06,kedai,商店,Kedai itu menjual beras dan sayur.,那家店卖米和蔬菜。,量词 家用 buah,名词;日常用品;补充\nms-0467,ms,ms-06,soalan,问题,Soalan guru itu tentang resipi.,老师的那个问题是关于食谱的。,通常不用专用量词，可写 satu soalan（一题）,名词;日常用品;补充\nms-0468,ms,ms-06,lubang,洞,Lubang itu kecil.,那个洞很小。,量词 个用 buah,名词;日常用品;补充\nms-0469,ms,ms-06,cili,辣椒,Ibu mencuci cili di dapur.,母亲在厨房洗辣椒。,量词 个用 biji,名词;日常用品;补充\nms-0470,ms,ms-06,daging,肉,Saya memasak daging dengan bawang.,我用洋葱煮肉。,量词 块用 ketul,名词;日常用品;补充\nms-0471,ms,ms-06,timun,黄瓜,Kakak membeli timun di kedai.,姐姐在商店买黄瓜。,量词 条用 batang,名词;日常用品;补充\nms-0472,ms,ms-06,lobak,萝卜,Saya mencuci lobak sebelum memasak.,我做饭前洗萝卜。,量词 根用 batang,名词;日常用品;补充\nms-0473,ms,ms-06,limau,柑橘；青柠,Air limau itu sejuk.,那杯青柠汁是凉的。,量词 个用 biji,名词;日常用品;补充\nms-0474,ms,ms-06,madu,蜂蜜,Madu itu di dalam gelas.,蜂蜜在玻璃杯里。,量词 瓶用 botol,名词;日常用品;补充\nms-0475,ms,ms-06,botol,瓶子,Botol itu untuk susu.,那个瓶子用来装牛奶。,量词 buah,名词;日常用品;补充\nms-0476,ms,ms-06,daripada,来自某人；由某种材料；比,Surat ini daripada guru saya.,这封信来自我的老师。,人、来源、材料和比较；地点来源用 dari,介词;学习与工作;补充\nms-0477,ms,ms-06,bersih,干净的,Meja itu sudah bersih.,那张桌子已经干净了。,形容词，后置,形容词;日常用品;补充\nms-0478,ms,ms-06,kotor,脏的,Kain kotor itu di dalam baldi.,那块脏布在桶里。,形容词，后置,形容词;日常用品;补充\nms-0479,ms,ms-06,kering,干的,Baju itu sudah kering.,那件上衣已经干了。,形容词，后置,形容词;日常用品;补充\nms-0480,ms,ms-06,basah,湿的,Kain itu masih basah.,那块布还湿着。,形容词，后置,形容词;日常用品;补充\nms-0481,ms,ms-07,di,在,Saya bekerja di Kuala Lumpur.,我在吉隆坡工作。,后接地点，分写；本课不教被动前缀 di-,介词;城市\nms-0482,ms,ms-07,ke,到；向,Kami pergi ke stesen dengan bas.,我们坐巴士去车站。,后接方向或地点，分写,介词;城市\nms-0483,ms,ms-07,dari,从,Ali datang dari Johor Bahru.,阿里从新山来。,地点、方向或时间的起点,介词;城市\nms-0484,ms,ms-07,untuk,为了；给,Buku ini untuk adik saya.,这本书给我的弟弟。,表示用途或受益者,介词;城市\nms-0485,ms,ms-07,bagi,为；对于,Latihan ini baik bagi pelajar.,这个练习对学生有益。,表示对象或受益者,介词;城市\nms-0486,ms,ms-07,mengenai,关于,Kami berbual mengenai bandar Melaka.,我们谈论马六甲城。,用法近于 tentang；本课作为介词整词学习,介词;城市\nms-0487,ms,ms-07,oleh,由,Saya membaca cerita oleh Siti.,我读西蒂写的故事。,可在名词后标作者；被动句施事用法留待 ms-11,介词;城市\nms-0488,ms,ms-07,sejak,自从,Saya tinggal di sini sejak tahun 2020.,我自2020年起住在这里。,引出持续情况的起点,介词;城市\nms-0489,ms,ms-07,hingga,直到,Ali bekerja dari pagi hingga petang.,阿里从早到下午工作。,引出时间或空间终点,介词;城市\nms-0490,ms,ms-07,sehingga,直到,Kami menunggu sehingga pukul lima.,我们一直等到五点。,引出终点或限度,介词;城市\nms-0491,ms,ms-07,sampai,直到；到,Saya berjalan dari rumah sampai sekolah.,我从家一直走到学校。,本课作介词，引出终点,介词;城市\nms-0492,ms,ms-07,antara,在……之间,Kami berehat antara pukul dua dengan pukul tiga.,我们在两点到三点之间休息。,常用 antara A dengan B,介词;城市\nms-0493,ms,ms-07,tanpa,没有；不带,Dia pergi ke sekolah tanpa beg.,他没带书包就去学校。,后接缺少的事物或动作,介词;城市\nms-0494,ms,ms-07,seperti,像,Rumah ini seperti rumah saya.,这座房子像我的家。,引出相似的事物,介词;城市\nms-0495,ms,ms-07,terhadap,对；对于,Sikapnya terhadap pelajar sangat baik.,他对学生的态度很好。,常配态度、看法等名词,介词;城市;补充\nms-0496,ms,ms-07,menerusi,经由；通过,Kami membaca berita menerusi e-mel.,我们通过电子邮件读消息。,本课作介词整词学习，不开放 -i 派生,介词;城市;补充\nms-0497,ms,ms-07,di atas,在……上面,Buku saya di atas meja.,我的书在桌上。,di 分写，atas 表上方,介词;方位\nms-0498,ms,ms-07,di bawah,在……下面,Kucing itu di bawah kerusi.,那只猫在椅子下面。,di 分写，bawah 表下方,介词;方位\nms-0499,ms,ms-07,di dalam,在……里面,Wang saya di dalam beg.,我的钱在包里。,具体空间内部,介词;方位\nms-0500,ms,ms-07,di luar,在……外面,Ali menunggu di luar sekolah.,阿里在学校外等候。,luar 表外部,介词;方位\nms-0501,ms,ms-07,di depan,在……前面,Bas berhenti di depan stesen.,巴士在车站前停下。,depan 表前方,介词;方位\nms-0502,ms,ms-07,di belakang,在……后面,Taman itu di belakang rumah.,公园在屋后。,belakang 表后方,介词;方位\nms-0503,ms,ms-07,di sebelah,在……旁边,Klinik di sebelah bank.,诊所在银行旁边。,sebelah 表旁边,介词;方位\nms-0504,ms,ms-07,di tepi,在……边上,Mereka berdiri di tepi jalan.,他们站在路边。,tepi 表边缘,介词;方位\nms-0505,ms,ms-07,di tengah,在……中间,Meja itu di tengah bilik.,那张桌子在房间中间。,tengah 表中央,介词;方位\nms-0506,ms,ms-07,di antara,在……之间,Masjid itu di antara dua buah bangunan.,清真寺在两栋建筑之间。,具体空间位置；后接两个对象或复数,介词;方位\nms-0507,ms,ms-07,hadapan,前方,Ali berdiri di hadapan sekolah.,阿里站在学校前面。,量词 通常不用量词,名词;方位\nms-0508,ms,ms-07,hujung,尽头；末端,Pejabat pos itu di hujung jalan.,邮局在路的尽头。,量词 通常不用量词,名词;方位\nms-0509,ms,ms-07,stesen,车站,Stesen itu berhampiran rumah saya.,车站在我家附近。,量词 buah,名词;城市;英语借词\nms-0510,ms,ms-07,pejabat pos,邮局,Kami mengepos surat di pejabat pos.,我们在邮局寄信。,量词 buah,名词;城市\nms-0511,ms,ms-07,pasar,市场,Ibu membeli sayur di pasar.,母亲在市场买菜。,量词 buah,名词;城市\nms-0512,ms,ms-07,masjid,清真寺,Masjid itu di tengah bandar.,那座清真寺在市中心。,量词 buah,名词;城市;阿拉伯语借词\nms-0513,ms,ms-07,taman,公园,Kami bersenam di taman setiap pagi.,我们每天早晨在公园锻炼。,量词 座用 buah,名词;城市\nms-0514,ms,ms-07,jalan,道路,Jalan ini ke stesen.,这条路通往车站。,量词 条用 batang,名词;城市\nms-0515,ms,ms-07,jambatan,桥,Jambatan itu panjang.,那座桥很长。,量词 座用 buah,名词;城市\nms-0516,ms,ms-07,lapangan terbang,机场,Bas ini ke lapangan terbang.,这辆巴士开往机场。,量词 座用 buah,名词;城市\nms-0517,ms,ms-07,perpustakaan,图书馆,Siti membaca di perpustakaan.,西蒂在图书馆读书。,量词 座用 buah,名词;城市\nms-0518,ms,ms-07,balai polis,警察局,Balai polis itu di sebelah bank.,警察局在银行旁边。,量词 座用 buah,名词;城市\nms-0519,ms,ms-07,bandar,城市,Bandar Melaka ada banyak kedai.,马六甲城有许多商店。,量词 座用 buah,名词;城市\nms-0520,ms,ms-07,kampung,村庄,Kampung saya berhampiran Johor Bahru.,我的村庄在新山附近。,量词 座用 buah,名词;城市\nms-0521,ms,ms-07,bangunan,建筑物,Bangunan itu tinggi dan putih.,那栋建筑很高，是白色的。,量词 栋用 buah,名词;城市\nms-0522,ms,ms-07,kedai buku,书店,Saya membeli buku di kedai buku itu.,我在那家书店买书。,量词 家用 buah,名词;城市\nms-0523,ms,ms-07,kedai makan,小餐馆,Kami makan di kedai makan berhampiran stesen.,我们在车站附近的小餐馆吃饭。,量词 家用 buah,名词;城市\nms-0524,ms,ms-07,pasar raya,超市,Pasar raya itu menjual susu dan roti.,那家超市卖牛奶和面包。,量词 家用 buah,名词;城市\nms-0525,ms,ms-07,pusat bandar,市中心,Pejabat saya di pusat bandar.,我的办公室在市中心。,量词 个用 buah,名词;城市\nms-0526,ms,ms-07,hentian bas,巴士停靠站,Ali menunggu di hentian bas.,阿里在巴士站等候。,量词 个用 buah,名词;城市\nms-0527,ms,ms-07,pelabuhan,港口,Pelabuhan itu di Pulau Pinang.,那个港口在槟城。,量词 座用 buah,名词;城市\nms-0528,ms,ms-07,stadium,体育场,Kami bermain bola sepak di stadium.,我们在体育场踢足球。,量词 座用 buah,名词;城市;英语借词\nms-0529,ms,ms-07,kereta api,火车,Saya ke Kuala Lumpur dengan kereta api.,我乘火车去吉隆坡。,量词 列用 buah,名词;交通\nms-0530,ms,ms-07,motosikal,摩托车,Motosikal itu di depan rumah.,那辆摩托车在屋前。,量词 辆用 buah,名词;交通;英语借词\nms-0531,ms,ms-07,kapal terbang,飞机,Kapal terbang itu besar.,那架飞机很大。,量词 架用 buah,名词;交通\nms-0532,ms,ms-07,feri,渡轮,Kami ke Pulau Pinang dengan feri.,我们坐渡轮去槟城。,量词 艘用 buah,名词;交通;英语借词\nms-0533,ms,ms-07,lori,货车,Lori itu membawa beras ke kedai.,那辆货车把米运到商店。,量词 辆用 buah,名词;交通;英语借词\nms-0534,ms,ms-07,van,厢式车,Van sekolah itu sudah sampai.,学校的厢式车已经到了。,量词 辆用 buah,名词;交通;英语借词\nms-0535,ms,ms-07,beca,三轮车,Saya melihat beca di Melaka.,我在马六甲看见三轮车。,量词 辆用 buah,名词;交通;闽南语借词\nms-0536,ms,ms-07,bot,小船,Bot itu di sebelah jambatan.,那条小船在桥旁边。,量词 艘用 buah,名词;交通;英语借词\nms-0537,ms,ms-07,Jalan terus.,一直走。,Jalan terus.,一直走。,祈使表达；jalan 作不及物动词，terus 表继续,动词;问路;phrase\nms-0538,ms,ms-07,Belok kiri.,向左转。,Belok kiri.,向左转。,不及物指路动词 belok；左为 kiri,动词;问路;phrase\nms-0539,ms,ms-07,Belok kanan.,向右转。,Belok kanan.,向右转。,不及物指路动词 belok；右为 kanan,动词;问路;phrase\nms-0540,ms,ms-07,Bagaimana hendak ke stesen?,怎样去车站？,Bagaimana hendak ke stesen?,怎样去车站？,完整问路句，hendak 表意图,动词;问路;phrase\nms-0541,ms,ms-07,Di mana perpustakaan?,图书馆在哪里？,Di mana perpustakaan?,图书馆在哪里？,地点疑问句，di mana 分写,动词;问路;phrase\nms-0542,ms,ms-07,Ikut jalan ini.,沿这条路走。,Ikut jalan ini.,沿这条路走。,及物祈使动词 ikut；常见宾语 jalan,动词;问路;phrase\nms-0543,ms,ms-07,Berhenti di sini.,在这里停下。,Berhenti di sini.,在这里停下。,ber- + henti；不及物；祈使也保留 ber-,动词;问路;phrase\nms-0544,ms,ms-07,Berjalan ke sana.,走到那里去。,Berjalan ke sana.,走到那里去。,ber- + jalan；不及物,动词;问路;phrase\nms-0545,ms,ms-07,kiri,左边,Bank itu di sebelah kiri.,银行在左边。,量词 通常不用量词,名词;城市;补充\nms-0546,ms,ms-07,kanan,右边,Stesen itu di sebelah kanan.,车站在右边。,量词 通常不用量词,名词;城市;补充\nms-0547,ms,ms-07,utara,北方,Sekolah itu di utara bandar.,学校在城市北部。,量词 通常不用量词,名词;城市;补充\nms-0548,ms,ms-07,selatan,南方,Kampung itu di selatan Melaka.,那个村庄在马六甲南边。,量词 通常不用量词,名词;城市;补充\nms-0549,ms,ms-07,timur,东方,Masjid itu di timur kampung.,清真寺在村庄东边。,量词 通常不用量词,名词;城市;补充\nms-0550,ms,ms-07,barat,西方,Pelabuhan itu di barat bandar.,港口在城市西边。,量词 通常不用量词,名词;城市;补充\nms-0551,ms,ms-07,simpang,路口；岔路,Ali menunggu di simpang itu.,阿里在那个路口等候。,量词 个用 buah,名词;城市;补充\nms-0552,ms,ms-07,lampu isyarat,交通信号灯,Bas berhenti di lampu isyarat.,巴士在信号灯前停下。,量词 组用 set,名词;城市;补充\nms-0553,ms,ms-07,peta,地图,Saya melihat peta bandar Melaka.,我查看马六甲城的地图。,量词 张用 helai,名词;城市;补充\nms-0554,ms,ms-07,laluan,路线；通道,Laluan ini untuk basikal.,这条通道供自行车使用。,通常不用专用量词，可写 satu laluan（一条通道）,名词;城市;补充\nms-0555,ms,ms-07,sikap,态度,Sikap Ali terhadap kawan sangat baik.,阿里对朋友的态度很好。,量词 通常不用量词,名词;城市;补充\nms-0556,ms,ms-07,dekat,近的,Rumah saya dekat dengan sekolah.,我家离学校近。,形容词，后置；dekat dengan,形容词;城市;补充\nms-0557,ms,ms-07,jauh,远的,Stesen itu jauh dari kampung.,车站离村庄远。,形容词，后置；jauh dari,形容词;城市;补充\nms-0558,ms,ms-07,berhampiran,靠近,Rumah saya berhampiran stesen.,我家靠近车站。,ber- + hampir + -an；词根 hampir；本课按整词学，不开放 -an；不及物,动词;城市;补充\nms-0559,ms,ms-07,masuk,进入,Ali masuk ke dalam kedai.,阿里走进商店。,不及物；地点由 ke 引出,动词;城市;补充\nms-0560,ms,ms-07,keluar,出去；出来,Siti keluar dari perpustakaan.,西蒂从图书馆出来。,不及物；地点由 dari 引出,动词;城市;补充\nms-0561,ms,ms-08,dapat,能够；得以,Esok saya akan dapat bertemu dengan guru.,明天我将能见到老师。,表示有条件实现，放在动词前,助动词;情态\nms-0562,ms,ms-08,mesti,必须；一定要,Kita mesti mencuci tangan sebelum makan.,我们吃饭前必须洗手。,义务或要求，后接动词,助动词;情态\nms-0563,ms,ms-08,harus,应该；应当,Kita harus membantu keluarga.,我们应该帮助家人。,本课表示应当，后接动词,助动词;情态\nms-0564,ms,ms-08,perlu,需要,Saya perlu membeli roti.,我需要买面包。,必要性，后接动词或名词,助动词;情态\nms-0565,ms,ms-08,mahu,想要,Saya mahu minum air limau.,我想喝青柠汁。,意愿；标准书面形式,助动词;情态\nms-0566,ms,ms-08,hendak,想要；打算,Kami hendak makan di restoran.,我们打算在餐馆吃饭。,意愿或打算；标准书面形式,助动词;情态\nms-0567,ms,ms-08,ingin,希望；想要,Saya ingin belajar memasak rendang.,我想学做仁当。,较正式的意愿表达,助动词;情态\nms-0568,ms,ms-08,pandai,擅长；会,Siti pandai memasak nasi lemak.,西蒂擅长做椰浆饭。,本课作情态性谓语，后接动词；也可作形容词,助动词;情态\nms-0569,ms,ms-08,sanggup,愿意；肯,Ali sanggup membantu saya.,阿里愿意帮助我。,表示愿意承担某事,助动词;情态\nms-0570,ms,ms-08,mampu,有能力,Kami mampu membayar bil ini.,我们有能力支付这张账单。,能力或财力，后接动词,助动词;情态\nms-0571,ms,ms-08,patut,应该,Kita patut menunggu di luar.,我们应该在外面等候。,表示合适的做法,助动词;情态;补充\nms-0572,ms,ms-08,enggan,不愿意,Adik enggan minum susu itu.,弟弟不愿喝那杯牛奶。,否定意愿，不另加 tidak,助动词;情态;补充\nms-0573,ms,ms-08,tolong,请帮忙,Tolong buka pintu itu.,请帮忙打开那扇门。,请求时后接动词原形；作及物动词「帮助」时常见宾语 saya,动词;请求与礼貌\nms-0574,ms,ms-08,minta,要；请求,Saya minta segelas air.,我要一杯水。,及物；常见宾语 air、bantuan；本课作礼貌请求,动词;请求与礼貌\nms-0575,ms,ms-08,tolong bantu saya,请帮帮我,\"Ali, tolong bantu saya.\",阿里，请帮帮我。,请求表达；及物动词 bantu 的宾语 saya,动词;请求与礼貌;phrase\nms-0576,ms,ms-08,minta air,要水,Saya minta air panas.,我要热水。,及物动词 minta；常见宾语 air,动词;请求与礼貌;phrase\nms-0577,ms,ms-08,maafkan saya,请原谅我,\"Siti, maafkan saya.\",西蒂，请原谅我。,固定礼貌表达；maaf + -kan；宾语 saya；本课按整词学，-kan 在 ms-09 系统学,动词;请求与礼貌;phrase\nms-0578,ms,ms-08,sila,请,Sila duduk di sini.,请坐这里。,邀请或礼貌指示，后接动词,语气词;请求与礼貌\nms-0579,ms,ms-08,jangan,不要；禁止,Jangan masuk ke dapur.,不要进入厨房。,禁止词，放在动词前,语气词;请求与礼貌\nms-0580,ms,ms-08,silalah,请吧,Silalah duduk di sini.,请坐这里吧。,sila + -lah，连写；本课按整词记,语气词;请求与礼貌\nms-0581,ms,ms-08,sila tunggu sebentar,请稍等,\"Ali, sila tunggu sebentar.\",阿里，请稍等。,sila + 动词 tunggu；完整请求表达,语气词;请求与礼貌;phrase\nms-0582,ms,ms-08,jangan masuk,请勿进入,\"Adik, jangan masuk.\",弟弟，不要进去。,jangan + 动词 masuk；禁止表达,语气词;请求与礼貌;phrase\nms-0583,ms,ms-08,makanan,食物,Makanan di restoran ini sedap.,这家餐馆的食物很好吃。,通常不用专用量词；按份可用 pinggan 或 bungkus,名词;食物与需求\nms-0584,ms,ms-08,minuman,饮料,Minuman ini untuk Ali.,这杯饮料给阿里。,量词 杯用 gelas,名词;食物与需求\nms-0585,ms,ms-08,sarapan,早餐,Sarapan saya roti dan telur.,我的早餐是面包和鸡蛋。,量词 set（套餐）,名词;食物与需求\nms-0586,ms,ms-08,santan,椰浆,Ibu memasak nasi dengan santan.,母亲用椰浆煮饭。,量词 杯用 cawan,名词;食物与需求\nms-0587,ms,ms-08,tepung,面粉,Tepung itu untuk membuat roti canai.,那些面粉用来做印度煎饼。,量词 袋用 kampit,名词;食物与需求\nms-0588,ms,ms-08,mentega,黄油,Saya mahu roti dengan mentega.,我想要涂黄油的面包。,量词 块用 buku,名词;食物与需求;葡语借词\nms-0589,ms,ms-08,roti canai,印度煎饼,Saya memesan dua keping roti canai.,我点两张印度煎饼。,量词 张用 keping,名词;食物与需求\nms-0590,ms,ms-08,nasi lemak,椰浆饭,Siti membeli nasi lemak untuk sarapan.,西蒂买椰浆饭当早餐。,量词 份用 bungkus 或 pinggan,名词;食物与需求\nms-0591,ms,ms-08,satay,沙爹串,Kami makan satay di Melaka.,我们在马六甲吃沙爹。,量词 串用 cucuk,名词;食物与需求\nms-0592,ms,ms-08,rendang,仁当炖肉,Rendang ini sangat sedap.,这份仁当很好吃。,量词 份用 pinggan,名词;食物与需求\nms-0593,ms,ms-08,kari,咖喱,Ibu memasak kari ayam.,母亲煮咖喱鸡。,量词 碗用 mangkuk,名词;食物与需求\nms-0594,ms,ms-08,sup,汤,Saya minta semangkuk sup panas.,我要一碗热汤。,量词 碗用 mangkuk,名词;食物与需求;英语借词\nms-0595,ms,ms-08,jus,果汁,Jus epal ini untuk adik.,这杯苹果汁给弟弟。,量词 杯用 gelas,名词;食物与需求;英语借词\nms-0596,ms,ms-08,ais,冰,Saya mahu teh tanpa ais.,我要不加冰的茶。,量词 块用 ketul,名词;食物与需求;英语借词\nms-0597,ms,ms-08,menu,菜单,Menu itu di atas meja.,菜单在桌上。,量词 naskhah（纸本）；也可直接写 satu menu,名词;食物与需求;英语借词\nms-0598,ms,ms-08,harga,价格,Harga roti ini tiga ringgit.,这种面包的价格是三令吉。,量词 通常不用量词，金额用 ringgit,名词;食物与需求\nms-0599,ms,ms-08,bil,账单,Saya membayar bil di restoran.,我在餐馆付账。,量词 张用 helai,名词;食物与需求;英语借词\nms-0600,ms,ms-08,pesanan,订单；点单,Pesanan kami dua pinggan nasi lemak.,我们点的是两盘椰浆饭。,通常不用专用量词，可写 satu pesanan（一份订单）,名词;食物与需求\nms-0601,ms,ms-08,bantuan,帮助,Kami perlu bantuan guru.,我们需要老师的帮助。,量词 通常不用量词,名词;食物与需求\nms-0602,ms,ms-08,kebenaran,许可,Saya meminta kebenaran untuk keluar.,我请求外出的许可。,量词 通常不用量词,名词;食物与需求\nms-0603,ms,ms-08,meminta,请求,Ali meminta bantuan guru.,阿里请求老师帮助。,meN- + minta → meminta，me-；m 保留；词根 minta；及物；常见宾语 bantuan、kebenaran,动词;学习与工作\nms-0604,ms,ms-08,membantu,帮助,Saya membantu ibu di dapur.,我在厨房帮母亲。,meN- + bantu → membantu，mem-；b 保留；词根 bantu；及物；常见宾语 ibu、kawan,动词;学习与工作\nms-0605,ms,ms-08,membayar,支付,Bapa membayar bil dengan wang itu.,父亲用那些钱付账。,meN- + bayar → membayar，mem-；b 保留；词根 bayar；及物；常见宾语 bil、harga,动词;学习与工作\nms-0606,ms,ms-08,memesan,点餐；订购,Kami memesan makanan di restoran.,我们在餐馆点餐。,meN- + pesan → memesan，mem-；p 脱落；词根 pesan；及物；常见宾语 nasi、minuman,动词;学习与工作\nms-0607,ms,ms-08,menerima,收到；接受,Siti menerima surat daripada Ali.,西蒂收到阿里的信。,meN- + terima → menerima，men-；t 脱落；词根 terima；及物；常见宾语 surat、bantuan,动词;学习与工作\nms-0608,ms,ms-08,membuka,打开,Ali membuka tingkap bilik.,阿里打开房间的窗户。,meN- + buka → membuka，mem-；b 保留；词根 buka；及物；常见宾语 pintu、tingkap,动词;学习与工作\nms-0609,ms,ms-08,menutup,关上,Ibu menutup pintu dapur.,母亲关上厨房的门。,meN- + tutup → menutup，men-；t 脱落；词根 tutup；及物；常见宾语 pintu、kedai,动词;学习与工作\nms-0610,ms,ms-08,meminjam,借入,Saya meminjam buku daripada Siti.,我向西蒂借书。,meN- + pinjam → meminjam，mem-；p 脱落；词根 pinjam；及物；常见宾语 buku、pen,动词;学习与工作\nms-0611,ms,ms-08,menggoreng,油炸；炒,Bapa menggoreng ikan di dapur.,父亲在厨房煎鱼。,meN- + goreng → menggoreng，meng-；g 保留；词根 goreng；及物；常见宾语 ikan、telur,动词;学习与工作\nms-0612,ms,ms-08,merebus,用水煮,Saya merebus telur untuk sarapan.,我煮鸡蛋当早餐。,meN- + rebus → merebus，me-；r 保留；词根 rebus；及物；常见宾语 telur、mi,动词;学习与工作\nms-0613,ms,ms-08,memotong,切；剪,Ibu memotong sayur dengan pisau.,母亲用刀切菜。,meN- + potong → memotong，mem-；p 脱落；词根 potong；及物；常见宾语 sayur、kain,动词;学习与工作\nms-0614,ms,ms-08,mencampur,混合,Siti mencampur tepung dengan air.,西蒂把面粉和水混合。,meN- + campur → mencampur，men-；c 保留；词根 campur；及物；常见宾语 tepung、air,动词;学习与工作\nms-0615,ms,ms-08,menambah,添加,Saya menambah garam ke dalam sup.,我往汤里加盐。,meN- + tambah → menambah，men-；t 脱落；词根 tambah；及物；常见宾语 air、garam,动词;学习与工作\nms-0616,ms,ms-08,memilih,挑选,Raju memilih makanan pada menu.,拉朱从菜单上挑选食物。,meN- + pilih → memilih，mem-；p 脱落；词根 pilih；及物；常见宾语 makanan、buku,动词;学习与工作\nms-0617,ms,ms-08,mencuba,尝试,Kami mencuba resipi baru itu.,我们尝试那个新食谱。,meN- + cuba → mencuba，men-；c 保留；词根 cuba；及物；常见宾语 resipi、makanan,动词;学习与工作\nms-0618,ms,ms-08,memegang,拿着；握着,Adik memegang gelas dengan dua tangan.,弟弟用两只手握着玻璃杯。,meN- + pegang → memegang，mem-；p 脱落；词根 pegang；及物；常见宾语 gelas、beg,动词;学习与工作\nms-0619,ms,ms-08,menjemput,邀请,Siti menjemput kami ke rumahnya.,西蒂邀请我们去她家。,meN- + jemput → menjemput，men-；j 保留；词根 jemput；及物；常见宾语 kawan、guru,动词;学习与工作\nms-0620,ms,ms-08,menghidang,端上；摆出食物,Ibu menghidang nasi dan kari.,母亲端上米饭和咖喱。,meN- + hidang → menghidang，meng-；h 保留；词根 hidang；及物；常见宾语 nasi、makanan,动词;学习与工作\nms-0621,ms,ms-08,menolak,拒绝,Ali tidak menolak bantuan kami.,阿里没有拒绝我们的帮助。,meN- + tolak → menolak，men-；t 脱落；词根 tolak；及物；常见宾语 bantuan、pesanan,动词;学习与工作\nms-0622,ms,ms-08,mengangkat,举起；搬起,Kami mengangkat meja bersama.,我们一起搬桌子。,meN- + angkat → mengangkat，meng-；元音 a 保留；词根 angkat；及物；常见宾语 meja、beg,动词;学习与工作\nms-0623,ms,ms-08,Tolong tutup pintu.,请帮忙关门。,Tolong tutup pintu.,请帮忙关门。,及物请求动词 tutup；宾语 pintu；祈使中用词根,动词;请求与计划;phrase\nms-0624,ms,ms-08,Silalah duduk.,请坐吧。,Silalah duduk.,请坐吧。,sila + -lah；duduk 不及物,动词;请求与计划;phrase\nms-0625,ms,ms-08,Saya belum boleh keluar.,我还不能出去。,Saya belum boleh keluar.,我还不能出去。,belum 在 boleh 前；keluar 不及物,动词;请求与计划;phrase\nms-0626,ms,ms-08,Kita mesti datang awal.,我们必须早到。,Kita mesti datang awal.,我们必须早到。,mesti 在动作前；datang 不及物,动词;请求与计划;phrase\nms-0627,ms,ms-08,Saya ingin memesan minuman.,我想点饮料。,Saya ingin memesan minuman.,我想点饮料。,meN- + pesan → memesan，p 脱落；宾语 minuman,动词;请求与计划;phrase\nms-0628,ms,ms-08,ringgit,令吉,Bil ini dua puluh ringgit.,这张账单是二十令吉。,量词 货币单位，本身作量词,名词;日常需求;补充\nms-0629,ms,ms-08,sen,仙；分币,Harga kuih ini lima puluh sen.,这块糕点的价格是五十仙。,量词 货币单位，本身作量词,名词;日常需求;英语借词;补充\nms-0630,ms,ms-08,pisau,刀,Pisau itu di atas meja dapur.,刀在厨房桌上。,量词 把用 bilah,名词;日常需求;补充\nms-0631,ms,ms-08,tisu,纸巾,Saya perlu tisu untuk tangan.,我需要纸巾擦手。,量词 张用 helai,名词;日常需求;英语借词;补充\nms-0632,ms,ms-08,duduk,坐,Sila duduk di sebelah saya.,请坐在我旁边。,不及物；地点由 di 引出,动词;日常需求;补充\nms-0633,ms,ms-08,buka,打开,Tolong buka tingkap itu.,请帮忙打开那扇窗。,及物；常见宾语 pintu、tingkap；祈使可用词根,动词;日常需求;补充\nms-0634,ms,ms-08,tutup,关上,Sila tutup pintu itu.,请关上那扇门。,及物；常见宾语 pintu、kedai；祈使用词根,动词;日常需求;补充\nms-0635,ms,ms-08,sebentar,一会儿,Sila tunggu sebentar di sini.,请在这里稍等。,表示短时间,副词;时间;补充\nms-0636,ms,ms-08,awal,早,Saya datang awal hari ini.,我今天来得早。,本课作时间副词,副词;时间;补充\nms-0637,ms,ms-08,segelas,一杯,Saya minta segelas air panas.,我要一杯热水。,se- + gelas，本课按完整数量表达记，不开放 se- 推导,量词;食物;补充\nms-0638,ms,ms-08,semangkuk,一碗,Ibu menghidang semangkuk sup.,母亲端上一碗汤。,se- + mangkuk，本课按完整数量表达记，不开放 se- 推导,量词;食物;补充\nms-0639,ms,ms-08,lapar,饿的,Saya lapar dan mahu makan.,我饿了，想吃饭。,形容词，后置,形容词;食物;补充\nms-0640,ms,ms-08,dahaga,渴的,Ali dahaga dan perlu air.,阿里渴了，需要水。,形容词，后置,形容词;食物;补充\n";
const M3_OLD_PROGRESS={"cards":{"es-0001:r":{"due":"2026-09-11","ivl":4,"ease":2.6,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0002:r":{"due":"2026-09-11","ivl":4,"ease":2.6,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0003:r":{"due":"2026-09-11","ivl":4,"ease":2.6,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0004:r":{"due":"2026-09-11","ivl":4,"ease":2.6,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0005:r":{"due":"2026-09-11","ivl":4,"ease":2.6,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0006:r":{"due":"2026-09-11","ivl":4,"ease":2.6,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0007:r":{"due":"2026-09-11","ivl":4,"ease":2.6,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0008:r":{"due":"2026-09-11","ivl":4,"ease":2.6,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0009:r":{"due":"2026-09-11","ivl":4,"ease":2.6,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0010:r":{"due":"2026-09-11","ivl":4,"ease":2.6,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0011:r":{"due":"2026-09-11","ivl":4,"ease":2.6,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0012:r":{"due":"2026-09-11","ivl":4,"ease":2.6,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0013:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0014:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"es-0015:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"ru-0001:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"ru-0002:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"ru-0003:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"ru-0004:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"ru-0005:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"ru-0006:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"ru-0007:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"ru-0008:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"ru-0009:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"},"ru-0010:r":{"due":"2026-09-08","ivl":1,"ease":2.5,"reps":1,"lapses":0,"last":"2026-09-07","first":"2026-09-07"}},"log":[{"t":"2026-09-07T04:00:07.567Z","card":"es-0001:r","grade":5},{"t":"2026-09-07T04:00:17.145Z","card":"es-0002:r","grade":5},{"t":"2026-09-07T04:00:24.249Z","card":"es-0003:r","grade":5},{"t":"2026-09-07T04:00:29.752Z","card":"es-0004:r","grade":5},{"t":"2026-09-07T04:00:35.774Z","card":"es-0005:r","grade":5},{"t":"2026-09-07T04:00:40.665Z","card":"es-0006:r","grade":5},{"t":"2026-09-07T04:00:48.333Z","card":"es-0007:r","grade":5},{"t":"2026-09-07T04:00:52.006Z","card":"es-0008:r","grade":5},{"t":"2026-09-07T04:03:36.337Z","card":"es-0009:r","grade":5},{"t":"2026-09-07T04:03:39.485Z","card":"es-0010:r","grade":5},{"t":"2026-09-07T04:03:45.718Z","card":"es-0011:r","grade":5},{"t":"2026-09-07T04:03:47.833Z","card":"es-0012:r","grade":5},{"t":"2026-09-07T04:03:59.508Z","card":"es-0013:r","grade":4},{"t":"2026-09-07T04:04:07.565Z","card":"es-0014:r","grade":4},{"t":"2026-09-07T04:04:11.973Z","card":"es-0015:r","grade":4},{"t":"2026-09-07T04:04:23.285Z","card":"ru-0001:r","grade":4},{"t":"2026-09-07T04:06:12.511Z","card":"ru-0002:r","grade":4},{"t":"2026-09-07T04:06:22.331Z","card":"ru-0003:r","grade":4},{"t":"2026-09-07T04:06:27.348Z","card":"ru-0004:r","grade":4},{"t":"2026-09-07T04:06:38.334Z","card":"ru-0005:r","grade":4},{"t":"2026-09-07T04:06:44.753Z","card":"ru-0006:r","grade":4},{"t":"2026-09-07T04:06:52.439Z","card":"ru-0007:r","grade":4},{"t":"2026-09-07T04:07:01.487Z","card":"ru-0008:r","grade":4},{"t":"2026-09-07T04:07:26.139Z","card":"ru-0009:r","grade":4},{"t":"2026-09-07T04:07:38.718Z","card":"ru-0010:r","grade":4}]};

// 任务 M3：第 9–12 周；所有允许词形均从当前 front 与该词的构词注释推导。
const M3_LESSONS=['ms-09','ms-10','ms-11','ms-12'];
const M3_READINGS=Array.from({length:8},(_,i)=>'ms-r'+String(i+15).padStart(2,'0'));
const ms3Rows=initialRows.filter(r=>M3_LESSONS.includes(r.lesson));
const ms3Expanded=ms3Rows.reduce((n,r)=>n+(r.tags.split(';').includes('phrase')?1:2),0);
const ms3LangSentences=lesson=>msWalk(parseNodes(lesson.explanation()))
  .filter(n=>['p','span'].includes(n.tag)&&n.getAttribute('lang')==='ms'&&/[.!?]$/.test(n.textContent.trim()))
  .map(n=>({text:n.textContent}));
const M3_TEXTS=()=>[
  ...ms3Rows.map(r=>({id:r.id,lesson:r.lesson,text:r.example})),
  ...M3_LESSONS.flatMap(id=>[...api.LESSONS[id].reading.sentences,...ms3LangSentences(api.LESSONS[id])]
    .map(s=>({id,lesson:id,...s}))),
  ...M3_READINGS.flatMap(id=>api.READINGS[id].sentences.map(s=>({id,lesson:api.READINGS[id].afterLesson,...s})))
];
test('任务 M3：四课周次、日期、时长、目标、写作与第十周起复盘提示',()=>{
  const start=Date.UTC(2026,9,5);
  const short=d=>String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
  for(const [i,id] of M3_LESSONS.entries()){
    const l=api.LESSONS[id],week=i+9;
    assert.equal(l.lang,'ms');assert.equal(l.week,week);
    assert.equal(l.dates,short(new Date(start+(week-1)*7*86400000))+' 至 '+short(new Date(start+((week-1)*7+6)*86400000)));
    assert.equal(l.dailyTime,'每天 20 分钟 + 每周 1 次系统块 30 分钟');
    for(const field of ['name','goal','writingTask']) assert(l[field]?.trim(),id+' '+field);
    assert.match(l.writingTask,/5 句/);
    const first=msWalk(parseNodes(l.explanation())).find(n=>n.tag==='p').textContent;
    assert(first.includes(l.dailyTime));
    assert(first.includes('配合《Complete Malay》的对应单元，单元以实际教材为准'));
    assert.equal(first.includes('时间分配以复盘结果为准'),week>=10);
  }
  assert.equal(initialState.settings.newPerDay.ms,10);
});
test('任务 M3：280 条连续 id、逐字段 CSV 同步、全语言 front 唯一与末尾追加',()=>{
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8')));
  assert.deepEqual(csv,initialRows.filter(r=>r.lang==='ms'));
  assert.deepEqual(csv.map(r=>r.id),Array.from({length:csv.length},(_,i)=>'ms-'+String(i+1).padStart(4,'0')));
  assert.equal(ms3Rows.length,280);
  assert.equal(new Set(csv.map(r=>r.front.toLowerCase())).size,csv.length);
  assert.deepEqual(ms3Rows.map(r=>r.id),Array.from({length:280},(_,i)=>'ms-'+String(i+641).padStart(4,'0')));
  assert.deepEqual(initialRows.slice(initialRows.findIndex(r=>r.id==='ms-0641'),initialRows.findIndex(r=>r.id==='ms-0920')+1),ms3Rows);
  for(const [i,id] of M3_LESSONS.entries()) assert.equal(ms3Rows.filter(r=>r.lesson===id).length,[80,80,80,40][i]);
  assert.deepEqual(Object.keys(api.LESSONS).filter(id=>M3_LESSONS.includes(id)),M3_LESSONS);
});
test('任务 M3：词类配额、补充标签及五组后缀对比完整',()=>{
  const base=id=>ms3Rows.filter(r=>r.lesson===id&&!r.tags.split(';').includes('补充'));
  const count=(id,tag)=>base(id).filter(r=>r.tags.split(';').includes(tag)).length;
  for(const [id,counts] of Object.entries({
    'ms-09':{'-kan 动词':30,'日常事务':25,'连接与程度':5,'phrase':5},
    'ms-10':{'-i 动词':25,'-kan／-i 对比':10,'参观与联系':25,'phrase':5},
    'ms-11':{'di- 被动':20,'新闻与公共事务':25,'公共事务动词':15,'新闻连接':5,'phrase':5},
    'ms-12':{'ter- 形式':12,'复习与学习':15,'phrase':8}
  })) for(const [tag,n] of Object.entries(counts)) assert.equal(count(id,tag),n,id+' '+tag);
  for(const [i,id] of M3_LESSONS.entries()) assert.equal(ms3Rows.filter(r=>r.lesson===id&&r.tags.split(';').includes('补充')).length,[15,15,10,5][i]);
  for(const root of ['datang','jauh','tempat','hadiah','siram'])
    for(const suffix of ['kan','i']) assert(ms3Rows.some(r=>r.lesson==='ms-10'&&r.note.startsWith('meN- + '+root+' + -'+suffix+' →')),root+' '+suffix);
});
test('任务 M3：词类、完整原形例句、量词与宾语注释，短语仅识别',()=>{
  const kinds=new Set('名词 动词 形容词 代词 数词 量词 介词 连词 副词 助动词 语气词 疑问词 问候'.split(' '));
  for(const r of ms3Rows){
    const tags=r.tags.split(';');
    assert(kinds.has(tags[0]),r.id);assert(!tags.includes('letter'));
    assert(/[\u4e00-\u9fff]/.test(r.back+r.example_zh));assert(r.note.trim());
    assert(/[.!?]$/.test(r.example),r.id+' 完整句');
    assert(r.example.toLowerCase().includes(r.front.toLowerCase()),r.id+' 例句原形');
    if(/[.!?]$/.test(r.front))assert(tags.includes('phrase'),r.id);
    if(tags[0]==='名词'&&!tags.includes('phrase'))assert.match(r.note,/量词/,r.id);
    if(tags[0]==='形容词')assert.match(r.note,/形容词，后置/,r.id);
    if(tags[0]==='动词'&&/及物/.test(r.note)&&!/不及物/.test(r.note))assert.match(r.note,/宾语/,r.id);
    assert.equal(api.expandCards([r]).length,tags.includes('phrase')?1:2,r.id);
    if(!tags.includes('phrase'))assert(api.clozeExample(r).includes('____'),r.id+' 挖空');
  }
  assert.deepEqual(M3_LESSONS.map(id=>api.expandCards(ms3Rows.filter(r=>r.lesson===id)).length),[155,155,155,72]);
});
test('任务 M3：马来西亚拼写与口语范围，印尼语只能作明确注释对照',()=>{
  const banned=new Set('karena uang kantor universitas bahwa senin delapan mau saja sepeda sepatu kamar bisa kemarin'.split(' '));
  const informal=new Set('aku kau engkau tak nak dah je ni tu'.split(' '));
  for(const s of [...M3_TEXTS(),...ms3Rows.map(r=>({id:r.id,text:r.front}))])
    for(const word of msWords(s.text).map(w=>w.toLowerCase())){
      assert(!banned.has(word),s.id+' 印尼语 '+word);
      assert(!informal.has(word),s.id+' 口语 '+word);
    }
  for(const r of ms3Rows)for(const w of msWords(r.note).map(w=>w.toLowerCase()))
    if(banned.has(w))assert(r.note.includes('印尼语作'),r.id);
});
test('任务 M3：每课六道语法或拼写与四道共用阅读题，答案可判',()=>{
  for(const id of M3_LESSONS){
    const l=api.LESSONS[id];assert.equal(l.exercises.length,10);
    assert.equal(l.reading.questions.length,4);
    assert.deepEqual(l.exercises.slice(6),l.reading.questions);
    for(let i=0;i<4;i++)assert.strictEqual(l.exercises[i+6],l.reading.questions[i]);
    assert(l.exercises.slice(0,6).every(q=>!q.prompt.startsWith('阅读')));
    assert(l.exercises.slice(6).every(q=>q.prompt.startsWith('阅读')));
    for(const q of l.exercises){
      assert(q.prompt&&typeof q.answer==='string'&&q.answer.trim());
      if(q.options){assert(q.options.includes(q.answer));assert.equal(new Set(q.options).size,q.options.length);}
      if(q.prompt.includes('____'))assert(/[（(].+[）)]/.test(q.prompt),id+' 填空提示');
    }
  }
});
test('任务 M3：四篇课文均为 120–170 词、12–16 句且中文逐句完整',()=>{
  for(const id of M3_LESSONS){
    const r=api.LESSONS[id].reading,n=msWordCount(r.sentences);
    assert(r.title);assert(n>=120&&n<=170,id+' '+n);
    assert(r.sentences.length>=12&&r.sentences.length<=16,id);
    for(const s of r.sentences)assert(s.text&&/[\u4e00-\u9fff]/.test(s.zh)&&/[.!?]$/.test(s.text));
  }
  assert.match(api.LESSONS['ms-12'].reading.title,/自测材料/);
});
test('任务 M3：八篇阅读线连续追加，周次、体裁、词数与句数符合各篇区间',()=>{
  const ids=Object.keys(api.READINGS),start=ids.indexOf('ms-r15');
  assert.equal(ids[start-1],'ms-r14');assert.deepEqual(ids.slice(start,start+8),M3_READINGS);
  assert.deepEqual(Object.values(api.READINGS).filter(r=>r.lang==='ms'&&r.week<=12).map(r=>r.id),Array.from({length:22},(_,i)=>'ms-r'+String(i+1).padStart(2,'0')));
  const ranges=[[120,135,12,14],[120,140,13,15],[130,150,13,15],[125,145,12,14],[140,160,13,15],[130,150,12,14],[150,170,14,16],[150,170,14,16]];
  const genres=['日常生活','对话','短故事','邮件','简单新闻','通知或广告','人物介绍','说明文'];
  for(const [i,id] of M3_READINGS.entries()){
    const r=api.READINGS[id],week=9+Math.floor(i/2),[min,max,smin,smax]=ranges[i];
    assert.equal(r.id,id);assert.equal(r.lang,'ms');assert.equal(r.week,week);
    assert.equal(r.afterLesson,'ms-'+String(week).padStart(2,'0'));assert.equal(r.genre,genres[i]);
    assert(/[\u4e00-\u9fff]/.test(r.title));
    assert.equal(r.words,msWordCount(r.sentences));assert(r.words>=min&&r.words<=max,id+' '+r.words);
    assert(r.sentences.length>=smin&&r.sentences.length<=smax,id);
    for(const s of r.sentences)assert(s.text&&/[\u4e00-\u9fff]/.test(s.zh)&&/[.!?][”"]?$/.test(s.text),id);
    if(i%2)assert.notEqual(r.genre,api.READINGS[M3_READINGS[i-1]].genre);
  }
});
test('任务 M3：阅读线三道阅读题、一道推断题、五个已学关键词与五行复述',()=>{
  for(const id of M3_READINGS){
    const r=api.READINGS[id],allowed=msVocabulary(r.afterLesson);
    assert.equal(r.questions.length,4);
    assert.equal(r.questions.filter(q=>q.prompt.startsWith('阅读')).length,3);
    assert.equal(r.questions.filter(q=>q.prompt.startsWith('推断')).length,1);
    for(const q of r.questions){assert(q.options.length>=3);assert(q.options.includes(q.answer));assert.equal(new Set(q.options).size,q.options.length);}
    assert.equal(r.keyWords.length,5);assert.equal(new Set(r.keyWords.map(k=>k.word)).size,5);
    const article=msWords(r.sentences.map(s=>s.text).join(' ')).map(w=>w.toLowerCase());
    for(const k of r.keyWords){
      assert(/[\u4e00-\u9fff]/.test(k.zh));
      assert(msWords(k.word).every(w=>allowed.has(w.toLowerCase())),id+' '+k.word);
      assert(article.includes(k.word.toLowerCase()),id+' 关键词须出现在本文 '+k.word);
    }
    assert.equal(r.retell.length,5);assert(r.retell.every(s=>/[\u4e00-\u9fff]/.test(s)));
  }
});
test('任务 M3：所有新例句、课文、阅读线及讲解例句不超课次词汇范围',()=>{
  const misses=M3_TEXTS().flatMap(s=>msVocabularyMisses(s.lesson,[s]).map(m=>({...m,lesson:s.lesson})));
  assert.deepEqual(misses,[]);
});
test('任务 M3：后缀及被动按周开放，组合拼写、双 k、后附与反例受约束',()=>{
  for(const [root,form,week] of [
    ['masuk','memasukkan',9],['beli','membelikan',9],['letak','meletakkan',9],
    ['kunjung','mengunjungi',10],['tempat','menempati',10],
    ['baca','dibaca',11],['masuk','dimasukkan',11],['kunjung','dikunjungi',11],
    ['buka','terbuka',12],['angkat','terangkat',12],['tulis','tertulis',12]
  ]){
    assert(!msForms(root,week-1).has(form),form+' 提前开放');
    assert(msForms(root,week).has(form),form+' 未推导');
  }
  assert(msForms('masuk',11).has('dimasukkannya'));
  assert(msForms('tulis',11).has('ditulisnya'));
  assert(msForms('menyusun',11).has('disusun'));
  assert(msForms('menyelesaikan',12).has('selesaikan'));
  assert(msForms('mengunjungi',12).has('kunjungi'));
  for(const [root,bad] of [
    ['masuk','memasukan'],['letak','meletakan'],['menulis','dimenulis'],
    ['masuk','memasukkani'],['masuk','memasukikan'],['memasukkan','memasukkankan'],
    ['baca','pembaca'],['bantu','bantuan'],['sihat','kesihatan'],['rumah','serumah'],
    ['kaji','mengkaji'],['punya','mempunyai']
  ])assert(!msForms(root,12).has(bad),bad+' 不应推导');
  assert(msVocabulary('ms-09').has('mengkaji'),'已学例外整词仍允许');
  assert(!msVocabulary('ms-09').has('mengunjungi'),'未来词不可提前');
  assert(msVocabularyMisses('ms-10',[{text:'Buku itu dibaca oleh Ali.'}]).length);
  assert(msVocabularyMisses('ms-11',[{text:'Pintu itu terbuka.'}]).length);
  assert(msVocabularyMisses('ms-09',[{text:'Memasuki muzium.'}]).length,'大写句首不能绕过');
});
test('任务 M3：新 meN- 词缀注释与实际词形一致，特殊形式按整词学习',()=>{
  for(const r of ms3Rows.filter(r=>r.note.startsWith('meN- + '))){
    const m=r.note.match(/^meN- \+ ([a-z]+)(?: \+ -(kan|i))? → ([a-z]+)/);
    assert(m,r.id);
    const [,root,suffix='',front]=m;assert.equal(front,r.front,r.id);
    if(r.note.includes('特殊形式')){
      assert.equal(front,'mengetahui');assert.match(r.note,/整词记忆/);continue;
    }
    assert.equal(msMenForm(root)+suffix,front,r.id);
    assert(msForms(root,Number(r.lesson.slice(3))).has(front),r.id);
    const rule=msMenRule(root);
    assert(r.note.includes(rule.prefix),r.id);
    if(!rule.keep)assert(r.note.includes(root[0]+' 脱落'),r.id);
    if(rule.keep)assert(r.note.includes('保留'),r.id);
  }
});
test('任务 M3：二十张 di- 卡注明已学或规则可推导的主动形',()=>{
  const rows=ms3Rows.filter(r=>r.lesson==='ms-11'&&r.tags.includes('di- 被动'));
  const allowed=msVocabulary('ms-10');assert.equal(rows.length,20);
  for(const r of rows){
    const active=r.note.match(/主动形 ([a-z]+)/)?.[1];
    const stem=r.note.match(/^di- \+ ([a-z]+)(?: \+ -(kan|i))?/);
    assert(active&&stem,r.id);
    assert(allowed.has(active),r.id+' 主动形未学 '+active);
    assert.equal(r.front,'di'+stem[1]+(stem[2]||''),r.id);
    assert.equal(active,msMenForm(stem[1])+(stem[2]||''),r.id);
  }
});
test('任务 M3：讲解 HTML 闭合、中文提纲、自查和各周语法与自测完整',()=>{
  const required=[
    ['membesarkan','menjalankan','memasukkan','membelikan','membuatkan','memberikan','mengatakan','menggunakan','menyediakan','menjelaskan','menyebabkan','mendapatkan','meletakkan','kk','12-06 月度检查点 3','探索段自测','50 词'],
    ['mengunjungi','memasuki','menaiki','menyukai','mencintai','menghadiri','mengikuti','menyertai','memiliki','mengetahui','mendatangkan','mendatangi','menjauhkan','menjauhi','menempatkan','menempati','不能同时'],
    ['di- + 词根','oleh','施事可以省略','diberikan','dikunjungi','前缀 di- 连写','介词 di 分写','新闻','说明文','主动转被动'],
    ['Buku itu saya baca.','Surat ini awak tulis?','Buku itu belum saya baca.','terjatuh','tertidur','terlupa','terangkat','terbaca','terbuka','tertutup','最高级义留到 ms-16','第 5–11 周','80 词','阅读复述']
  ];
  for(const [i,id] of M3_LESSONS.entries()){
    const l=api.LESSONS[id],markup=l.explanation(),stack=[];
    for(const m of markup.matchAll(/<(\/?)([a-z][a-z0-9]*)(?:\s[^>]*)?>/gi)){
      if(voidTags.has(m[2]))continue;
      if(m[1])assert.equal(stack.pop(),m[2],id);else stack.push(m[2]);
    }
    assert.equal(stack.length,0);assert(!/<script|\bon\w+=|javascript:/i.test(markup));
    const nodes=msWalk(parseNodes(markup));
    assert(nodes.filter(n=>n.tag==='h4').length>=7);
    assert(ms3LangSentences(l).length>=3);
    assert(nodes.some(n=>n.tag==='ol'&&n.querySelectorAll('li').length===5));
    assert(nodes.some(n=>n.tag==='ul'&&n.querySelectorAll('li').length>=4));
    assert(markup.includes('名词短语')&&markup.includes('词缀拼写')&&markup.includes('自查'));
    for(const s of required[i])assert(markup.includes(s),id+' '+s);
    for(const p of nodes.filter(n=>n.tag==='p'&&n.getAttribute('lang')==='ms')){
      const parent=nodes.find(n=>n.childNodes.includes(p)),next=parent.childNodes[parent.childNodes.indexOf(p)+1];
      assert(next instanceof ElementModel&&/[\u4e00-\u9fff]/.test(next.textContent),id+' 中文跟随例句');
    }
  }
  const table=msWalk(parseNodes(api.LESSONS['ms-12'].explanation())).find(n=>n.tag==='table');
  assert.equal(table.querySelectorAll('tr').length,8);
  for(let week=5;week<=11;week++)assert(table.querySelectorAll('tr').some(r=>r.querySelector('td')?.textContent===String(week)));
});
test('任务 M3：旧 ms／es／ru 及其他语言原行原序保留，cards 与 log 不变',()=>{
  const oldMs=plain(api.parseCSV(M3_OLD_MS_CSV));
  const csvText=fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8');
  const csvLines=new Map(csvText.trimEnd().split('\n').slice(1).map(line=>[line.split(',')[0],line]));
  for(const line of M3_OLD_MS_CSV.trimEnd().split('\n').slice(1))assert.equal(csvLines.get(line.split(',')[0]),line);
  assert.deepEqual(initialRows.filter(r=>r.lang==='ms').slice(0,640),oldMs);
  const rawRows=[...blocks[0][1].matchAll(/\n  \{\n[\s\S]*?\n  \}/g)].map(m=>m[0].slice(1));
  assert.equal(rawRows.length,initialRows.length);
  const rawById=new Map(rawRows.map(raw=>[JSON.parse(raw).id,raw]));
  const oldRows=initialRows.slice(0,initialRows.findIndex(r=>r.id==='ms-0641'));
  assert.equal(oldRows.length,5077);
  for(const lang of ['es','ru','ms','uz','kk']){
    const csv=lang==='ms'?oldMs:plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards',lang+'.csv'),'utf8')));
    assert.deepEqual(oldRows.filter(r=>r.lang===lang),csv,lang+' 旧行原序');
    for(const r of csv)assert.equal(rawById.get(r.id),JSON.stringify([r],null,2).slice(2,-2),r.id+' 原始行');
  }
  assert.deepEqual({cards:initialState.cards,log:initialState.log},M3_OLD_PROGRESS);
});
test('任务 M3：渲染四课八篇、课内作答和中文开关均不改变用户进度或缓存',()=>{
  const {api:a,document,cache}=createAPI(true,html);a.initialize();
  const before=plain(a.getData().state),beforeRows=plain(a.getData().rows),dirty=a.getData().dirty,cacheBefore=[...cache.entries()];
  for(const id of M3_LESSONS){
    a.openLesson(id);
    const page=document.getElementById('content').textContent;
    for(const field of ['name','dates','dailyTime','goal','writingTask'])assert(page.includes(a.LESSONS[id][field]),id+' '+field);
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);
    for(const form of document.querySelectorAll('[data-exercise]')){
      form.elements.answer.value=a.LESSONS[id].exercises[Number(form.dataset.exercise)].answer;
      document.getElementById('app').listeners.submit[0]({target:form,preventDefault(){}});
    }
  }
  a.showReadings();
  assert.deepEqual(document.querySelectorAll('[data-reading]').map(n=>n.dataset.reading).filter(id=>M3_READINGS.includes(id)),M3_READINGS);
  for(const id of M3_READINGS){
    a.openReadingItem(id);
    assert(document.getElementById('content').textContent.includes(a.READINGS[id].title));
    assert.equal(document.querySelectorAll('[data-question]').length,4);
    const zh=()=>document.querySelectorAll('details').filter(n=>n.querySelector('summary')?.textContent==='查看本句中文');
    assert.equal(zh().length,a.READINGS[id].sentences.length);
    assert(zh().every(n=>n.getAttribute('open')===null));
    a.toggleReadingZh();assert(zh().every(n=>n.getAttribute('open')!==null));a.toggleReadingZh();

  }
  assert.deepEqual(plain(a.getData().state),before);assert.deepEqual(plain(a.getData().rows),beforeRows);
  assert.equal(a.getData().dirty,dirty);assert.deepEqual([...cache.entries()],cacheBefore);
});

// 任务 M4 的旧行原文；不使用固定哈希或字节偏移。
const M4_OLD_MS_CSV="id,lang,lesson,front,back,example,example_zh,note,tags\nms-0001,ms,ms-01,saya,我,Saya pelajar.,我是学生。,第一人称单数,代词\nms-0002,ms,ms-01,awak,你,Awak guru.,你是老师。,常用于熟悉的人；正式称呼可用 anda,代词\nms-0003,ms,ms-01,anda,您；你,Anda pelajar.,您是学生。,较正式的第二人称,代词\nms-0004,ms,ms-01,dia,他；她,Dia guru.,他是老师。,不分性别,代词\nms-0005,ms,ms-01,beliau,他；她（敬称）,Beliau guru saya.,他是我的老师。,用于值得尊敬的人,代词\nms-0006,ms,ms-01,kami,我们（不含听话人）,Kami pelajar.,我们是学生。,不含听话人,代词\nms-0007,ms,ms-01,kita,我们（含听话人）,Kita keluarga.,我们是一家人。,包含听话人,代词\nms-0008,ms,ms-01,mereka,他们；她们,Mereka kawan saya.,他们是我的朋友。,第三人称复数,代词\nms-0009,ms,ms-01,ini,这；这个,Buku ini buku saya.,这本书是我的书。,指示词；作定语时放名词后,代词\nms-0010,ms,ms-01,itu,那；那个,Rumah itu rumah saya.,那所房子是我的家。,指示词；作定语时放名词后,代词\nms-0011,ms,ms-01,Ini rumah.,这是房子。,Ini rumah.,这是房子。,无系词句；整句识别,代词;phrase\nms-0012,ms,ms-01,Itu sekolah.,那是学校。,Itu sekolah.,那是学校。,无系词句；整句识别,代词;phrase\nms-0013,ms,ms-01,selamat pagi,早上好,\"Selamat pagi, Ali!\",早上好，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0014,ms,ms-01,selamat tengah hari,中午好,\"Selamat tengah hari, Siti!\",中午好，西蒂！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0015,ms,ms-01,selamat petang,下午好,\"Selamat petang, Ali!\",下午好，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0016,ms,ms-01,selamat malam,晚上好,\"Selamat malam, Siti!\",晚上好，西蒂！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0017,ms,ms-01,Apa khabar?,你好吗？,Apa khabar?,你好吗？,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0018,ms,ms-01,khabar baik,很好（回答问候）,\"Khabar baik, terima kasih.\",很好，谢谢。,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0019,ms,ms-01,terima kasih,谢谢,\"Terima kasih, Ali!\",谢谢你，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0020,ms,ms-01,sama-sama,不客气,\"Sama-sama, Siti!\",不客气，西蒂！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0021,ms,ms-01,maaf,对不起,\"Maaf, Ali!\",对不起，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0022,ms,ms-01,selamat tinggal,再见（对留下的人说）,\"Selamat tinggal, Siti!\",再见，西蒂！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0023,ms,ms-01,selamat jalan,再见（对离开的人说）,\"Selamat jalan, Ali!\",再见，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0024,ms,ms-01,ya,是；对,\"Ya, ini buku saya.\",是的，这是我的书。,礼貌用语；作为完整交际话语识别,语气词;问候\nms-0025,ms,ms-01,tidak,不；不是,\"Tidak, itu buku Ali.\",不，那是阿里的书。,可单独作否定回答；否定谓语的区别见 ms-02,语气词;问候\nms-0026,ms,ms-01,satu,一,Ini satu buku.,这是一本书。,基数词；置于名词前，本周先认数字,数词\nms-0027,ms,ms-01,dua,二,Ini dua buku.,这是二本书。,基数词；置于名词前，本周先认数字,数词\nms-0028,ms,ms-01,tiga,三,Ini tiga buku.,这是三本书。,基数词；置于名词前，本周先认数字,数词\nms-0029,ms,ms-01,empat,四,Ini empat buku.,这是四本书。,基数词；置于名词前，本周先认数字,数词\nms-0030,ms,ms-01,lima,五,Ini lima buku.,这是五本书。,基数词；置于名词前，本周先认数字,数词\nms-0031,ms,ms-01,enam,六,Ini enam buku.,这是六本书。,基数词；置于名词前，本周先认数字,数词\nms-0032,ms,ms-01,tujuh,七,Ini tujuh buku.,这是七本书。,基数词；置于名词前，本周先认数字,数词\nms-0033,ms,ms-01,lapan,八,Ini lapan buku.,这是八本书。,基数词；置于名词前，本周先认数字,数词\nms-0034,ms,ms-01,sembilan,九,Ini sembilan buku.,这是九本书。,基数词；置于名词前，本周先认数字,数词\nms-0035,ms,ms-01,sepuluh,十,Ini sepuluh buku.,这是十本书。,基数词；置于名词前，本周先认数字,数词\nms-0036,ms,ms-01,buku,书,Ini buku saya.,这是我的书。,量词 buah,名词;教室\nms-0037,ms,ms-01,meja,桌子,Ini meja saya.,这是我的桌子。,量词 buah,名词;教室\nms-0038,ms,ms-01,kerusi,椅子,Ini kerusi saya.,这是我的椅子。,量词 buah,名词;教室\nms-0039,ms,ms-01,pen,笔,Ini pen saya.,这是我的笔。,量词 batang,名词;教室\nms-0040,ms,ms-01,pensel,铅笔,Ini pensel saya.,这是我的铅笔。,量词 batang,名词;教室\nms-0041,ms,ms-01,kertas,纸,Ini kertas saya.,这是我的纸。,量词 helai,名词;教室\nms-0042,ms,ms-01,beg,包,Ini beg saya.,这是我的包。,量词 buah,名词;教室\nms-0043,ms,ms-01,bilik,房间,Ini bilik saya.,这是我的房间。,量词 buah,名词;教室\nms-0044,ms,ms-01,pintu,门,Ini pintu saya.,这是我的门。,量词 buah,名词;教室\nms-0045,ms,ms-01,tingkap,窗户,Ini tingkap saya.,这是我的窗户。,量词 buah,名词;教室\nms-0046,ms,ms-01,rumah,房子；家,Ini rumah saya.,这是我的房子。,量词 buah,名词;教室\nms-0047,ms,ms-01,sekolah,学校,Ini sekolah saya.,这是我的学校。,量词 buah,名词;教室\nms-0048,ms,ms-01,kelas,班级,Ini kelas saya.,这是我的班级。,量词 buah,名词;教室\nms-0049,ms,ms-01,guru,老师,Ini guru saya.,这是我的老师。,量词 orang,名词;教室\nms-0050,ms,ms-01,pelajar,学生,Ini pelajar saya.,这是我的学生。,量词 orang,名词;教室\nms-0051,ms,ms-01,orang,人,Dia orang Malaysia.,他是马来西亚人。,量词 orang；ms-03 也用作人的量词,名词;家庭\nms-0052,ms,ms-01,lelaki,男子,Lelaki itu bapa saya.,那个男子是我的父亲。,量词 orang,名词;家庭\nms-0053,ms,ms-01,perempuan,女子,Perempuan itu ibu saya.,那个女子是我的母亲。,量词 orang,名词;家庭\nms-0054,ms,ms-01,kawan,朋友,Ali kawan saya.,阿里是我的朋友。,量词 orang,名词;家庭\nms-0055,ms,ms-01,keluarga,家庭；家人,Ini keluarga saya.,这是我的家人。,量词 buah；指家庭时使用，家人按 orang 计数,名词;家庭\nms-0056,ms,ms-01,ibu,母亲,Ibu saya guru.,我的母亲是老师。,量词 orang,名词;家庭\nms-0057,ms,ms-01,bapa,父亲,Bapa saya guru.,我的父亲是老师。,量词 orang,名词;家庭\nms-0058,ms,ms-01,abang,哥哥,Abang saya pelajar.,我的哥哥是学生。,量词 orang,名词;家庭\nms-0059,ms,ms-01,kakak,姐姐,Kakak saya pelajar.,我的姐姐是学生。,量词 orang,名词;家庭\nms-0060,ms,ms-01,adik,弟弟；妹妹,Adik saya pelajar.,我的弟弟是学生。,量词 orang,名词;家庭\nms-0061,ms,ms-01,komputer,电脑,Itu komputer Ali.,那是阿里的电脑。,量词 buah,名词;城市;英语借词\nms-0062,ms,ms-01,telefon,电话；手机,Itu telefon Ali.,那是阿里的电话。,量词 buah,名词;城市;英语借词\nms-0063,ms,ms-01,bas,公共汽车,Itu bas.,那是公共汽车。,量词 buah,名词;城市;英语借词\nms-0064,ms,ms-01,teksi,出租车,Itu teksi.,那是出租车。,量词 buah,名词;城市;英语借词\nms-0065,ms,ms-01,hospital,医院,Itu hospital.,那是医院。,量词 buah,名词;城市;英语借词\nms-0066,ms,ms-01,restoran,餐馆,Itu restoran.,那是餐馆。,量词 buah,名词;城市;英语借词\nms-0067,ms,ms-01,hotel,酒店,Itu hotel.,那是酒店。,量词 buah,名词;城市;英语借词\nms-0068,ms,ms-01,bank,银行,Itu bank.,那是银行。,量词 buah,名词;城市;英语借词\nms-0069,ms,ms-01,kamera,相机,Itu kamera Ali.,那是阿里的相机。,量词 buah,名词;城市;英语借词\nms-0070,ms,ms-01,tiket,票,Itu tiket Ali.,那是阿里的票。,量词 keping,名词;城市;英语借词\nms-0071,ms,ms-01,gereja,教堂,Ini gereja.,这是教堂。,量词 buah,名词;身边事物;葡语借词\nms-0072,ms,ms-01,bendera,旗帜,Ini bendera.,这是旗帜。,量词 helai,名词;身边事物;葡语借词\nms-0073,ms,ms-01,keju,奶酪,Ini keju.,这是奶酪。,量词 keping,名词;身边事物;葡语借词\nms-0074,ms,ms-01,teh,茶,Ini teh.,这是茶。,量词 cawan,名词;身边事物;闽南语借词\nms-0075,ms,ms-01,mi,面条,Ini mi.,这是面条。,量词 mangkuk,名词;身边事物;闽南语借词\nms-0076,ms,ms-01,kuih,糕点,Ini kuih.,这是糕点。,量词 biji,名词;身边事物;闽南语借词\nms-0077,ms,ms-01,Saya pelajar.,我是学生。,Saya pelajar.,我是学生。,整句识别；名字 Ali 可换成自己的名字,代词;phrase\nms-0078,ms,ms-01,Ini buku saya.,这是我的书。,Ini buku saya.,这是我的书。,整句识别；名字 Ali 可换成自己的名字,代词;phrase\nms-0079,ms,ms-01,Nama saya Ali.,我的名字是阿里。,Nama saya Ali.,我的名字是阿里。,整句识别；名字 Ali 可换成自己的名字,名词;phrase\nms-0080,ms,ms-01,Terima kasih banyak.,非常感谢。,Terima kasih banyak.,非常感谢。,整句识别；名字 Ali 可换成自己的名字,问候;phrase\nms-0081,ms,ms-02,baca,读,Saya baca buku.,我读书。,及物；常见宾语 buku,动词;学习与工作\nms-0082,ms,ms-02,makan,吃,Saya makan mi.,我吃面条。,及物；常见宾语 mi、kuih,动词;学习与工作\nms-0083,ms,ms-02,minum,喝,Saya minum teh.,我喝茶。,及物；常见宾语 teh,动词;学习与工作\nms-0084,ms,ms-02,tulis,写,Saya tulis nama saya.,我写我的名字。,及物；常见宾语 nama、e-mel,动词;学习与工作\nms-0085,ms,ms-02,pergi,去,Saya pergi ke sekolah.,我去学校。,不及物；目的地用 ke,动词;学习与工作\nms-0086,ms,ms-02,ada,有；在,Saya ada komputer.,我有电脑。,表示拥有或存在；后接 buku、komputer 等事物,动词;学习与工作\nms-0087,ms,ms-02,suka,喜欢,Saya suka bahasa Melayu.,我喜欢马来语。,及物；常见宾语 bahasa Melayu、mi,动词;学习与工作\nms-0088,ms,ms-02,tinggal,住,Saya tinggal di Melaka.,我住在马六甲。,不及物；住处用 di,动词;学习与工作\nms-0089,ms,ms-02,belajar,学习,Saya belajar bahasa Melayu.,我学习马来语。,bel- + ajar；词根 ajar；本周只作整词记，第 5 周再学前缀规则；常见学习内容（宾语）bahasa Melayu,动词;学习与工作\nms-0090,ms,ms-02,bekerja,工作,Ibu saya bekerja di bank.,我的母亲在银行工作。,be- + kerja；词根 kerja；本周只作整词记，第 5 周再学前缀规则,动词;学习与工作\nms-0091,ms,ms-02,faham,懂；理解,Saya faham bahasa Melayu.,我懂马来语。,及物；常见宾语 bahasa Melayu,动词;学习与工作\nms-0092,ms,ms-02,tahu,知道,Saya tahu nama guru itu.,我知道那位老师的名字。,及物；常见宾语 nama,动词;学习与工作\nms-0093,ms,ms-02,apa,什么,Awak baca apa?,你读什么？,句末疑问词,疑问词\nms-0094,ms,ms-02,siapa,谁,Dia siapa?,他是谁？,询问人,疑问词\nms-0095,ms,ms-02,di mana,在哪里,Awak tinggal di mana?,你住在哪里？,di 表地点；作为固定词组记,疑问词\nms-0096,ms,ms-02,ke mana,去哪里,Awak pergi ke mana?,你去哪里？,ke 表方向；作为固定词组记,疑问词\nms-0097,ms,ms-02,dari mana,从哪里来,Awak dari mana?,你来自哪里？,dari 表来源；作为固定词组记,疑问词\nms-0098,ms,ms-02,bila,什么时候,Bila awak pergi ke Melaka?,你什么时候去马六甲？,询问时间,疑问词\nms-0099,ms,ms-02,mengapa,为什么,Mengapa awak suka buku itu?,你为什么喜欢那本书？,询问原因；同义 kenapa,疑问词\nms-0100,ms,ms-02,bagaimana,怎么样,Bagaimana khabar keluarga awak?,你的家人近况怎么样？,询问情况,疑问词\nms-0101,ms,ms-02,berapa,多少,Berapa orang pelajar ada di kelas?,班里有多少学生？,询问数量,疑问词\nms-0102,ms,ms-02,besar,大的,Rumah saya besar.,我的房子很大。,形容词，后置；作谓语时可不用系词,形容词\nms-0103,ms,ms-02,kecil,小的,Bilik saya kecil.,我的房间很小。,形容词，后置；作谓语时可不用系词,形容词\nms-0104,ms,ms-02,baru,新的,Ini buku baru saya.,这是我的新书。,形容词，后置；作谓语时可不用系词；ms-04 再识别副词义「刚」,形容词\nms-0105,ms,ms-02,lama,旧的,Itu komputer lama saya.,那是我的旧电脑。,形容词，后置；作谓语时可不用系词,形容词\nms-0106,ms,ms-02,baik,好的,Guru saya baik.,我的老师很好。,形容词，后置；作谓语时可不用系词,形容词\nms-0107,ms,ms-02,cantik,漂亮的,Bendera itu cantik.,那面旗帜很漂亮。,形容词，后置；作谓语时可不用系词,形容词\nms-0108,ms,ms-02,panjang,长的,Pensel ini panjang.,这支铅笔很长。,形容词，后置；作谓语时可不用系词,形容词\nms-0109,ms,ms-02,pendek,短的,Pensel itu pendek.,那支铅笔很短。,形容词，后置；作谓语时可不用系词,形容词\nms-0110,ms,ms-02,tinggi,高的,Abang saya tinggi.,我的哥哥个子高。,形容词，后置；作谓语时可不用系词,形容词\nms-0111,ms,ms-02,rendah,矮的；低的,Meja itu rendah.,那张桌子很矮。,形容词，后置；作谓语时可不用系词,形容词\nms-0112,ms,ms-02,murah,便宜的,Tiket bas ini murah.,这张公共汽车票很便宜。,形容词，后置；作谓语时可不用系词,形容词\nms-0113,ms,ms-02,mahal,贵的,Kamera itu mahal.,那台相机很贵。,形容词，后置；作谓语时可不用系词,形容词\nms-0114,ms,ms-02,panas,热的,Teh ini panas.,这杯茶很热。,形容词，后置；作谓语时可不用系词,形容词\nms-0115,ms,ms-02,sejuk,凉的,Teh itu sejuk.,那杯茶凉了。,形容词，后置；作谓语时可不用系词,形容词\nms-0116,ms,ms-02,sedap,好吃的,Mi ini sedap.,这些面条很好吃。,形容词，后置；作谓语时可不用系词,形容词\nms-0117,ms,ms-02,Malaysia,马来西亚,Saya dari Malaysia.,我来自马来西亚。,国家专名，首字母大写；地名一般不用量词,名词;国家与语言\nms-0118,ms,ms-02,China,中国,Kawan saya dari China.,我的朋友来自中国。,国家专名，首字母大写；地名一般不用量词,名词;国家与语言\nms-0119,ms,ms-02,England,英格兰,Dia dari England.,他来自英格兰。,国家或地区专名；此处专指英格兰；地名一般不用量词,名词;国家与语言\nms-0120,ms,ms-02,bahasa Melayu,马来语,Saya suka bahasa Melayu.,我喜欢马来语。,语言名称；bahasa 小写、Melayu 大写；一般不用量词；专名或语言名称不用事物量词,名词;国家与语言\nms-0121,ms,ms-02,bahasa Cina,汉语,Dia faham bahasa Cina.,他懂汉语。,语言名称；一般不用量词；专名或语言名称不用事物量词,名词;国家与语言\nms-0122,ms,ms-02,bahasa Inggeris,英语,Beliau faham bahasa Inggeris.,他懂英语。,语言名称；一般不用量词；专名或语言名称不用事物量词,名词;国家与语言\nms-0123,ms,ms-02,orang Cina,华人；中国人,Mei Ling orang Cina.,美玲是华人。,量词 orang；本句指族群,名词;国家与语言\nms-0124,ms,ms-02,orang Malaysia,马来西亚人,Ali orang Malaysia.,阿里是马来西亚人。,量词 orang,名词;国家与语言\nms-0125,ms,ms-02,doktor,医生,Ali doktor.,阿里是医生。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0126,ms,ms-02,jururawat,护士,Ali jururawat.,阿里是护士。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0127,ms,ms-02,polis,警察,Ali polis.,阿里是警察。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0128,ms,ms-02,jurutera,工程师,Ali jurutera.,阿里是工程师。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0129,ms,ms-02,peguam,律师,Ali peguam.,阿里是律师。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0130,ms,ms-02,petani,农民,Ali petani.,阿里是农民。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0131,ms,ms-02,kerani,文员,Ali kerani.,阿里是文员。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0132,ms,ms-02,pemandu,司机,Ali pemandu.,阿里是司机。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0133,ms,ms-02,dan,和,Saya suka teh dan kuih.,我喜欢茶和糕点。,并列连接词,连词\nms-0134,ms,ms-02,atau,或者,Awak suka teh atau mi?,你喜欢茶还是面条？,连接可选择的成分,连词\nms-0135,ms,ms-02,tetapi,但是,Bilik ini kecil tetapi cantik.,这个房间小但是漂亮。,表示转折,连词\nms-0136,ms,ms-02,sangat,很,Buku ini sangat baik.,这本书很好。,放在形容词前,副词\nms-0137,ms,ms-02,sekali,很；极了,Mi ini sedap sekali.,这些面条非常好吃。,表示程度时放形容词后,副词\nms-0138,ms,ms-02,juga,也,Saya juga pelajar.,我也是学生。,表示相同情况,副词\nms-0139,ms,ms-02,radio,收音机,Ini radio baru.,这是新的收音机。,量词 buah,名词;英语借词\nms-0140,ms,ms-02,televisyen,电视机,Ini televisyen baru.,这是新的电视机。,量词 buah,名词;英语借词\nms-0141,ms,ms-02,internet,互联网,Ada internet di hotel ini.,这家酒店有互联网。,一般不用量词；不可数的网络名称,名词;英语借词\nms-0142,ms,ms-02,e-mel,电子邮件,Ini e-mel baru.,这是新的电子邮件。,量词 buah,名词;英语借词\nms-0143,ms,ms-02,universiti,大学,Ini universiti baru.,这是新的大学。,量词 buah,名词;英语借词\nms-0144,ms,ms-02,kolej,学院,Ini kolej baru.,这是新的学院。,量词 buah,名词;英语借词\nms-0145,ms,ms-02,klinik,诊所,Ini klinik baru.,这是新的诊所。,量词 buah,名词;英语借词\nms-0146,ms,ms-02,muzium,博物馆,Ini muzium baru.,这是新的博物馆。,量词 buah,名词;英语借词\nms-0147,ms,ms-02,Siapakah guru anda?,谁是您的老师？,Siapakah guru anda?,谁是您的老师？,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0148,ms,ms-02,Adakah awak pelajar?,你是学生吗？,Adakah awak pelajar?,你是学生吗？,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0149,ms,ms-02,Saya dari Malaysia.,我来自马来西亚。,Saya dari Malaysia.,我来自马来西亚。,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0150,ms,ms-02,Saya boleh baca bahasa Melayu.,我会读马来语。,Saya boleh baca bahasa Melayu.,我会读马来语。,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0151,ms,ms-02,Saya bukan doktor.,我不是医生。,Saya bukan doktor.,我不是医生。,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0152,ms,ms-02,ialah,是（名词谓语前）,Ali ialah pelajar.,阿里是学生。,正式书面语的判断词；后接名词短语,助动词;补充\nms-0153,ms,ms-02,adalah,是（形容词或介词短语前）,Buku ini adalah sangat baik.,这本书很好。,正式书面语的判断词；本句可省，不接动词,助动词;补充\nms-0154,ms,ms-02,bukan,不是,Dia bukan guru saya.,他不是我的老师。,否定名词或代词,副词;补充\nms-0155,ms,ms-02,adakah,是否；是不是,Adakah itu rumah awak?,那是你的房子吗？,ada + -kah，作为整词记；引导是非问,疑问词;补充\nms-0156,ms,ms-02,boleh,能；可以,Saya boleh tulis e-mel.,我会写电子邮件。,后接动词,助动词;补充\nms-0157,ms,ms-02,pejabat,办公室,Ibu saya ada di pejabat.,我的母亲在办公室。,量词 buah,名词;补充\nms-0158,ms,ms-02,kerana,因为,Saya suka mi ini kerana sedap.,我喜欢这些面条，因为它们好吃。,连接原因,连词;补充\nms-0159,ms,ms-02,kenapa,为什么,Kenapa awak tidak minum teh?,你为什么不喝茶？,同义词 mengapa,疑问词;补充\nms-0160,ms,ms-02,dengan,和；与,Saya pergi ke sekolah dengan Ali.,我和阿里去学校。,引出同行的人,介词;补充\nms-0161,ms,ms-03,ekor,只；头（动物量词）,Saya ada dua ekor kucing.,我有两只猫。,用于动物,量词\nms-0162,ms,ms-03,buah,个；本；辆（一般事物量词）,Saya ada tiga buah buku.,我有三本书。,用于 buku、rumah 等,量词\nms-0163,ms,ms-03,batang,支；根,Saya ada dua batang pen.,我有两支笔。,用于 pen、pensel 等细长物,量词\nms-0164,ms,ms-03,helai,张；件（薄片量词）,Ada dua helai kertas di atas meja.,桌子上有两张纸。,用于 kertas、bendera 等,量词\nms-0165,ms,ms-03,biji,粒；个,Ada tiga biji telur di dalam mangkuk.,碗里有三个鸡蛋。,用于 telur、epal 等,量词\nms-0166,ms,ms-03,keping,张；片,Saya ada dua keping tiket.,我有两张票。,用于 tiket 等薄片,量词\nms-0167,ms,ms-03,pasang,双；对,Saya ada dua pasang kasut.,我有两双鞋。,用于成对的物品,量词\nms-0168,ms,ms-03,cawan,杯（茶杯的容量）,Saya minum satu cawan teh.,我喝一杯茶。,也作名词「茶杯」，量词 buah；此处计容量,量词\nms-0169,ms,ms-03,gelas,杯（玻璃杯的容量）,Saya minum satu gelas air.,我喝一杯水。,也作名词「玻璃杯」，量词 buah；此处计容量,量词\nms-0170,ms,ms-03,mangkuk,碗（容量）,Saya makan satu mangkuk mi.,我吃一碗面条。,也作名词「碗」，量词 buah；补充替换已学 orang,量词;补充\nms-0171,ms,ms-03,sebelas,十一,Ada sebelas buah buku di sekolah.,学校里有十一本书。,基数词；数字 11,数词\nms-0172,ms,ms-03,dua belas,十二,Ada dua belas buah buku di sekolah.,学校里有十二本书。,基数词；数字 12,数词\nms-0173,ms,ms-03,tiga belas,十三,Ada tiga belas buah buku di sekolah.,学校里有十三本书。,基数词；数字 13,数词\nms-0174,ms,ms-03,empat belas,十四,Ada empat belas buah buku di sekolah.,学校里有十四本书。,基数词；数字 14,数词\nms-0175,ms,ms-03,lima belas,十五,Ada lima belas buah buku di sekolah.,学校里有十五本书。,基数词；数字 15,数词\nms-0176,ms,ms-03,dua puluh,二十,Ada dua puluh buah buku di sekolah.,学校里有二十本书。,基数词；数字 20,数词\nms-0177,ms,ms-03,tiga puluh,三十,Ada tiga puluh buah buku di sekolah.,学校里有三十本书。,基数词；数字 30,数词\nms-0178,ms,ms-03,seratus,一百,Ada seratus buah buku di sekolah.,学校里有一百本书。,基数词；数字 100,数词\nms-0179,ms,ms-03,dua ratus,二百,Ada dua ratus buah buku di sekolah.,学校里有二百本书。,基数词；数字 200,数词\nms-0180,ms,ms-03,seribu,一千,Ada seribu buah buku di sekolah.,学校里有一千本书。,基数词；数字 1000,数词\nms-0181,ms,ms-03,pertama,第一,Ini buku pertama saya.,这是我的第一本书。,序数词，放在名词后,数词\nms-0182,ms,ms-03,kedua,第二,Ini bilik kedua.,这是第二个房间。,序数词，放在名词后,数词\nms-0183,ms,ms-03,ketiga,第三,Ali pelajar ketiga.,阿里是第三个学生。,序数词，放在名词后,数词\nms-0184,ms,ms-03,seorang,一个人（连量词）,Ada seorang guru di kelas.,班里有一位老师。,se- 表一；本课只记此整词，不开放 se- 的通用推导,数词\nms-0185,ms,ms-03,sebuah,一个；一本（连量词）,Saya ada sebuah buku.,我有一本书。,se- 表一；本课只记此整词，不开放 se- 的通用推导,数词\nms-0186,ms,ms-03,tauhu,豆腐,Ada tauhu di rumah saya.,我家里有豆腐。,量词 keping,名词;家居与食物;闽南语借词\nms-0187,ms,ms-03,tauge,豆芽,Ada tauge di rumah saya.,我家里有豆芽。,一般不用量词；按份数可用 pinggan,名词;家居与食物;闽南语借词\nms-0188,ms,ms-03,bihun,米粉,Ada bihun di rumah saya.,我家里有米粉。,量词 mangkuk,名词;家居与食物;闽南语借词\nms-0189,ms,ms-03,kicap,酱油,Ada kicap di rumah saya.,我家里有酱油。,量词 sudu,名词;家居与食物;闽南语借词\nms-0190,ms,ms-03,teko,茶壶,Ada teko di rumah saya.,我家里有茶壶。,量词 buah,名词;家居与食物;闽南语借词\nms-0191,ms,ms-03,nasi,米饭,Ada nasi di rumah saya.,我家里有米饭。,量词 pinggan,名词;家居与食物\nms-0192,ms,ms-03,air,水,Ada air di rumah saya.,我家里有水。,量词 gelas,名词;家居与食物\nms-0193,ms,ms-03,roti,面包,Ada roti di rumah saya.,我家里有面包。,量词 keping,名词;家居与食物\nms-0194,ms,ms-03,telur,鸡蛋,Ada telur di rumah saya.,我家里有鸡蛋。,量词 biji,名词;家居与食物\nms-0195,ms,ms-03,susu,奶,Ada susu di rumah saya.,我家里有奶。,量词 gelas,名词;家居与食物\nms-0196,ms,ms-03,kopi,咖啡,Ada kopi di rumah saya.,我家里有咖啡。,量词 cawan,名词;家居与食物\nms-0197,ms,ms-03,gula,糖,Ada gula di rumah saya.,我家里有糖。,量词 sudu,名词;家居与食物\nms-0198,ms,ms-03,garam,盐,Ada garam di rumah saya.,我家里有盐。,量词 sudu,名词;家居与食物\nms-0199,ms,ms-03,sayur,蔬菜,Ada sayur di rumah saya.,我家里有蔬菜。,一般不用量词；按份数可用 pinggan,名词;家居与食物\nms-0200,ms,ms-03,pisang,香蕉,Ada pisang di rumah saya.,我家里有香蕉。,量词 biji,名词;家居与食物\nms-0201,ms,ms-03,epal,苹果,Ada epal di rumah saya.,我家里有苹果。,量词 biji,名词;家居与食物\nms-0202,ms,ms-03,pinggan,盘子,Ada pinggan di rumah saya.,我家里有盘子。,量词 buah,名词;家居与食物\nms-0203,ms,ms-03,sudu,勺子,Ada sudu di rumah saya.,我家里有勺子。,量词 batang,名词;家居与食物\nms-0204,ms,ms-03,garpu,叉子,Ada garpu di rumah saya.,我家里有叉子。,量词 batang,名词;家居与食物\nms-0205,ms,ms-03,katil,床,Ada katil di rumah saya.,我家里有床。,量词 buah,名词;家居与食物\nms-0206,ms,ms-03,almari,柜子,Ada almari di rumah saya.,我家里有柜子。,量词 buah,名词;家居与食物\nms-0207,ms,ms-03,lampu,灯,Ada lampu di rumah saya.,我家里有灯。,量词 buah,名词;家居与食物\nms-0208,ms,ms-03,jam,钟表,Ada jam di rumah saya.,我家里有钟表。,量词 buah,名词;家居与食物\nms-0209,ms,ms-03,kasut,鞋,Ada kasut di rumah saya.,我家里有鞋。,量词 pasang,名词;家居与食物\nms-0210,ms,ms-03,bantal,枕头,Ada bantal di rumah saya.,我家里有枕头。,量词 biji,名词;家居与食物\nms-0211,ms,ms-03,kucing,猫,Ada dua ekor kucing di belakang rumah.,房子后面有两只猫。,量词 ekor,名词;动物\nms-0212,ms,ms-03,anjing,狗,Ada dua ekor anjing di belakang rumah.,房子后面有两只狗。,量词 ekor,名词;动物\nms-0213,ms,ms-03,ayam,鸡,Ada dua ekor ayam di belakang rumah.,房子后面有两只鸡。,量词 ekor,名词;动物\nms-0214,ms,ms-03,ikan,鱼,Ada dua ekor ikan di belakang rumah.,房子后面有两条鱼。,量词 ekor,名词;动物\nms-0215,ms,ms-03,burung,鸟,Ada dua ekor burung di belakang rumah.,房子后面有两只鸟。,量词 ekor,名词;动物\nms-0216,ms,ms-03,lembu,牛,Ada dua ekor lembu di belakang rumah.,房子后面有两头牛。,量词 ekor,名词;动物\nms-0217,ms,ms-03,semua,所有,Semua buku ini baru.,这些书都是新的。,表示全部,数词\nms-0218,ms,ms-03,banyak,许多,Saya ada banyak buku.,我有许多书。,表示数量多；本周不用重叠,数词\nms-0219,ms,ms-03,beberapa,几个；一些,Ada beberapa orang pelajar di kelas.,班里有几个学生。,后可接量词，不用重叠,数词\nms-0220,ms,ms-03,sedikit,少量,Ada sedikit gula di dalam teh ini.,这杯茶里有少量糖。,表示数量少,数词\nms-0221,ms,ms-03,para,诸位；众（用于人）,Para pelajar ada di sekolah.,学生们在学校。,表示一群人，后面不用重叠,数词\nms-0222,ms,ms-03,cukup,足够,Buku ini cukup untuk semua pelajar.,这些书够所有学生用。,形容词，后置；本句作谓语,形容词;补充\nms-0223,ms,ms-03,lebih,更；较,Rumah Ali lebih besar.,阿里的房子更大。,程度副词，放形容词前,副词;补充\nms-0224,ms,ms-03,kurang,不太；较少,Teh ini kurang panas.,这杯茶不太热。,程度副词，放形容词前,副词;补充\nms-0225,ms,ms-03,atas,上面,Buku ada di atas meja.,书在桌子上。,方位名词，一般不用量词；di atas 作为地点词组记,名词;方位\nms-0226,ms,ms-03,bawah,下面,Kucing ada di bawah kerusi.,猫在椅子下面。,方位名词，一般不用量词；di bawah 作为地点词组记,名词;方位\nms-0227,ms,ms-03,dalam,里面,Pen ada di dalam beg.,笔在包里。,方位名词，一般不用量词；di dalam 作为地点词组记,名词;方位\nms-0228,ms,ms-03,depan,前面,Ali ada di depan sekolah.,阿里在学校前面。,方位名词，一般不用量词；di depan 作为地点词组记,名词;方位\nms-0229,ms,ms-03,belakang,后面,Bilik saya di belakang kelas.,我的房间在教室后面。,方位名词，一般不用量词；di belakang 作为地点词组记,名词;方位\nms-0230,ms,ms-03,sebelah,旁边,Rumah Ali di sebelah rumah saya.,阿里的房子在我家旁边。,方位名词，一般不用量词；di sebelah 作为地点词组记,名词;方位\nms-0231,ms,ms-03,Tiada buku di sini.,这里没有书。,Tiada buku di sini.,这里没有书。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0232,ms,ms-03,Saya ada dua buah buku.,我有两本书。,Saya ada dua buah buku.,我有两本书。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0233,ms,ms-03,Buku-buku ini untuk pelajar.,这些书是给学生的。,Buku-buku ini untuk pelajar.,这些书是给学生的。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0234,ms,ms-03,Ini buku yang saya suka.,这是我喜欢的书。,Ini buku yang saya suka.,这是我喜欢的书。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0235,ms,ms-03,Ada seekor kucing di rumah.,家里有一只猫。,Ada seekor kucing di rumah.,家里有一只猫。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0236,ms,ms-03,lantai,地板,Lantai bilik saya baru.,我房间的地板是新的。,一般不用量词；按一面墙或一片地板描述,名词;家居;补充\nms-0237,ms,ms-03,dinding,墙壁,Dinding rumah saya tinggi.,我家的墙壁很高。,一般不用量词；按一面墙或一片地板描述,名词;家居;补充\nms-0238,ms,ms-03,tandas,厕所,Tandas ada di sebelah bilik ini.,厕所在这个房间旁边。,量词 buah,名词;家居;补充\nms-0239,ms,ms-03,dapur,厨房,Ada sebuah dapur di rumah saya.,我家里有一间厨房。,量词 buah,名词;家居;补充\nms-0240,ms,ms-03,bunga,花,Ada bunga di atas meja.,桌子上有花。,量词 kuntum,名词;家居;补充\nms-0241,ms,ms-04,sudah,已经,Saya sudah makan nasi.,我已经吃过米饭了。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0242,ms,ms-04,telah,已经（较正式）,Ali telah tulis e-mel.,阿里已经写了电子邮件。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0243,ms,ms-04,belum,还没有,Saya belum makan.,我还没吃饭。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0244,ms,ms-04,akan,将要,Esok saya akan pergi ke Melaka.,明天我将去马六甲。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0245,ms,ms-04,sedang,正在,Ibu sedang baca buku.,母亲正在读书。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0246,ms,ms-04,masih,仍然；还,Adik masih tidur.,弟弟还在睡觉。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0247,ms,ms-04,pernah,曾经,Saya pernah pergi ke Pulau Pinang.,我曾经去过槟城。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0248,ms,ms-04,baru sahaja,刚刚,Ali baru sahaja datang.,阿里刚刚到。,时间或体貌标记，放在动词前；动词不因时间而变形；baru 的副词义，本课用固定搭配补足，不重复建 baru 卡,助动词;时间;补充\nms-0249,ms,ms-04,sekarang,现在,Sekarang saya ada di rumah.,现在我在家。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0250,ms,ms-04,hari ini,今天,Hari ini saya akan baca buku.,今天我将读书。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0251,ms,ms-04,semalam,昨天,Semalam saya pergi ke bank.,昨天我去了银行。,印尼语作 kemarin；本课马来语 semalam 指昨天；时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0252,ms,ms-04,kelmarin,前天,Kelmarin Ali datang ke rumah saya.,前天阿里来了我家。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0253,ms,ms-04,esok,明天,Esok saya akan beli roti.,明天我将买面包。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0254,ms,ms-04,lusa,后天,Lusa kami akan pergi ke Melaka.,后天我们将去马六甲。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0255,ms,ms-04,pagi,早晨,Saya bangun pada pukul enam pagi.,我早晨六点起床。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0256,ms,ms-04,tengah hari,中午,Saya makan pada pukul dua belas tengah hari.,我中午十二点吃饭。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0257,ms,ms-04,petang,下午；傍晚,Saya balik pada pukul lima petang.,我下午五点回家。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0258,ms,ms-04,malam,晚上,Saya tidur pada pukul sepuluh malam.,我晚上十点睡觉。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0259,ms,ms-04,minggu ini,这周,Minggu ini saya masih di Kuala Lumpur.,这周我仍在吉隆坡。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0260,ms,ms-04,minggu depan,下周,Minggu depan saya akan pergi ke Johor Bahru.,下周我将去新山。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0261,ms,ms-04,minggu lepas,上周,Minggu lepas saya beli buku ini.,上周我买了这本书。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0262,ms,ms-04,bulan,月,Bulan ini saya akan pergi ke China.,这个月我将去中国。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0263,ms,ms-04,tahun,年,Tahun ini adik saya belajar di sekolah.,今年我的弟弟在学校学习。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0264,ms,ms-04,Isnin,星期一,\"Pada hari Isnin, saya baca buku.\",星期一，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0265,ms,ms-04,Selasa,星期二,\"Pada hari Selasa, saya baca buku.\",星期二，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0266,ms,ms-04,Rabu,星期三,\"Pada hari Rabu, saya baca buku.\",星期三，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0267,ms,ms-04,Khamis,星期四,\"Pada hari Khamis, saya baca buku.\",星期四，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0268,ms,ms-04,Jumaat,星期五,\"Pada hari Jumaat, saya baca buku.\",星期五，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0269,ms,ms-04,Sabtu,星期六,\"Pada hari Sabtu, saya baca buku.\",星期六，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0270,ms,ms-04,Ahad,星期日,\"Pada hari Ahad, saya baca buku.\",星期日，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0271,ms,ms-04,Januari,一月,\"Pada bulan Januari, saya ada di Malaysia.\",一月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0272,ms,ms-04,Februari,二月,\"Pada bulan Februari, saya ada di Malaysia.\",二月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0273,ms,ms-04,Mac,三月,\"Pada bulan Mac, saya ada di Malaysia.\",三月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0274,ms,ms-04,April,四月,\"Pada bulan April, saya ada di Malaysia.\",四月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0275,ms,ms-04,Mei,五月,\"Pada bulan Mei, saya ada di Malaysia.\",五月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0276,ms,ms-04,Jun,六月,\"Pada bulan Jun, saya ada di Malaysia.\",六月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0277,ms,ms-04,Julai,七月,\"Pada bulan Julai, saya ada di Malaysia.\",七月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0278,ms,ms-04,Ogos,八月,\"Pada bulan Ogos, saya ada di Malaysia.\",八月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0279,ms,ms-04,September,九月,\"Pada bulan September, saya ada di Malaysia.\",九月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0280,ms,ms-04,Oktober,十月,\"Pada bulan Oktober, saya ada di Malaysia.\",十月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0281,ms,ms-04,November,十一月,\"Pada bulan November, saya ada di Malaysia.\",十一月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0282,ms,ms-04,Disember,十二月,\"Pada bulan Disember, saya ada di Malaysia.\",十二月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0283,ms,ms-04,bangun,起床,Saya bangun pada pukul enam.,我六点起床。,不及物,动词;日常生活\nms-0284,ms,ms-04,tidur,睡觉,Adik sedang tidur.,弟弟正在睡觉。,不及物,动词;日常生活\nms-0285,ms,ms-04,mandi,洗澡,Saya mandi pada waktu pagi.,我早晨洗澡。,不及物,动词;日常生活\nms-0286,ms,ms-04,balik,回去；回家,Saya akan balik ke rumah.,我将回家。,不及物；目的地用 ke,动词;日常生活\nms-0287,ms,ms-04,datang,来,Ali akan datang esok.,阿里明天会来。,不及物；到达地点用 ke,动词;日常生活\nms-0288,ms,ms-04,tunggu,等,Saya tunggu bas.,我等公共汽车。,及物；常见宾语 bas、kawan,动词;日常生活\nms-0289,ms,ms-04,beli,买,Saya beli roti.,我买面包。,及物；常见宾语 roti、buku,动词;日常生活\nms-0290,ms,ms-04,jual,卖,Mereka jual kuih.,他们卖糕点。,及物；常见宾语 kuih、buku,动词;日常生活\nms-0291,ms,ms-04,buat,做,Saya buat nota.,我做笔记。,及物；常见宾语 nota,动词;日常生活\nms-0292,ms,ms-04,cari,找,Saya cari buku saya.,我找我的书。,及物；常见宾语 buku、pen,动词;日常生活\nms-0293,ms,ms-04,tengok,看,Saya tengok filem di rumah.,我在家看电影。,及物；常见宾语 filem；本周作整词记,动词;日常生活\nms-0294,ms,ms-04,lari,跑,Saya lari pada waktu pagi.,我早晨跑步。,不及物,动词;日常生活;补充\nms-0295,ms,ms-04,rehat,休息,Saya rehat di rumah.,我在家休息。,不及物,动词;日常生活;补充\nms-0296,ms,ms-04,masak,煮；做饭,Ibu masak nasi.,母亲煮米饭。,及物；常见宾语 nasi、mi,动词;日常生活;补充\nms-0297,ms,ms-04,cuci,洗,Saya cuci pinggan.,我洗盘子。,及物；常见宾语 pinggan、cawan,动词;日常生活;补充\nms-0298,ms,ms-04,aktiviti,活动,Aktiviti ini pada hari Sabtu.,这个活动在星期六。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0299,ms,ms-04,program,项目；活动安排,Program sekolah ini pada bulan Oktober.,学校的这个活动安排在十月。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0300,ms,ms-04,projek,项目,Projek ini belum siap.,这个项目尚未完成。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0301,ms,ms-04,idea,想法,Idea Ali sangat baik.,阿里的想法很好。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0302,ms,ms-04,nota,笔记,Saya tulis nota di kelas.,我在课堂上记笔记。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0303,ms,ms-04,fail,文件夹,Fail itu di atas meja.,那个文件夹在桌子上。,量词 buah,名词;英语借词\nms-0304,ms,ms-04,video,视频,Video ini sangat pendek.,这个视频很短。,量词 buah,名词;英语借词\nms-0305,ms,ms-04,muzik,音乐,Saya suka muzik ini.,我喜欢这段音乐。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0306,ms,ms-04,foto,照片,Foto keluarga saya di dalam bilik.,我的全家福在房间里。,量词 keping,名词;英语借词\nms-0307,ms,ms-04,filem,电影,Filem ini panjang sekali.,这部电影很长。,量词 buah,名词;英语借词\nms-0308,ms,ms-04,Saya belum siap.,我还没准备好。,Saya belum siap.,我还没准备好。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0309,ms,ms-04,Sekarang waktu rehat.,现在是休息时间。,Sekarang waktu rehat.,现在是休息时间。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0310,ms,ms-04,Esok saya akan pergi ke sekolah.,明天我将去学校。,Esok saya akan pergi ke sekolah.,明天我将去学校。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0311,ms,ms-04,Semalam saya sudah baca buku itu.,昨天我已经读了那本书。,Semalam saya sudah baca buku itu.,昨天我已经读了那本书。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0312,ms,ms-04,Hari ini saya sedang tulis nota.,今天我正在写笔记。,Hari ini saya sedang tulis nota.,今天我正在写笔记。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0313,ms,ms-04,pukul,点钟（报时用）,Saya datang pada pukul lapan.,我八点来。,报时标记，放在数字前；一般不用量词，不表示计时长度,名词;时间;补充\nms-0314,ms,ms-04,setengah,半,Saya balik pada pukul lima setengah.,我五点半回家。,数词，表示一半,数词;时间;补充\nms-0315,ms,ms-04,suku,四分之一；一刻钟,Saya datang pada pukul tiga suku.,我三点一刻来。,数词；报时为过十五分钟,数词;时间;补充\nms-0316,ms,ms-04,minit,分钟,Saya rehat lima belas minit.,我休息十五分钟。,计时单位，一般不用量词,名词;时间;补充\nms-0317,ms,ms-04,pada,在（某个时间）,Saya pergi pada hari Isnin.,我星期一去。,介词，引时间；地点用 di,介词;时间;补充\nms-0318,ms,ms-04,tarikh,日期,Tarikh program ini 5 Oktober 2026.,这个活动的日期是 2026 年 10 月 5 日。,一般不用量词；写作 tarikh + 日期,名词;时间;补充\nms-0319,ms,ms-04,hari,天；日,Saya ada di sini tiga hari.,我在这里待三天。,计时单位，一般不用量词,名词;时间;补充\nms-0320,ms,ms-04,minggu,周；星期,Saya ada di Melaka dua minggu.,我在马六甲待两周。,计时单位，一般不用量词,名词;时间;补充\nms-0321,ms,ms-05,berjalan,走路,Saya berjalan ke sekolah setiap hari.,我每天走路去学校。,ber- + jalan → berjalan；词根 jalan；ber- 常规形式；不及物,动词;日常活动\nms-0322,ms,ms-05,berlari,跑步,Ali berlari di padang pada waktu pagi.,阿里早晨在运动场跑步。,ber- + lari → berlari；词根 lari；ber- 常规形式；不及物,动词;日常活动\nms-0323,ms,ms-05,bermain,玩；参加运动,Adik bermain bola dengan kawan.,弟弟和朋友玩球。,ber- + main → bermain；词根 main；ber- 常规形式；不及物,动词;日常活动\nms-0324,ms,ms-05,bercakap,说话,Kami bercakap dalam bahasa Melayu.,我们用马来语说话。,ber- + cakap → bercakap；词根 cakap；ber- 常规形式；不及物,动词;日常活动\nms-0325,ms,ms-05,berbual,聊天,Ibu berbual dengan kakak di rumah.,母亲和姐姐在家聊天。,ber- + bual → berbual；词根 bual；ber- 常规形式；不及物,动词;日常活动\nms-0326,ms,ms-05,berkata,说,\"Ali berkata, \"\"Saya sudah siap.\"\"\",阿里说：“我已经准备好了。”,ber- + kata → berkata；词根 kata；ber- 常规形式；不及物,动词;日常活动\nms-0327,ms,ms-05,berdiri,站立,Guru berdiri di depan kelas.,老师站在班级前面。,ber- + diri → berdiri；词根 diri；ber- 常规形式；不及物,动词;日常活动\nms-0328,ms,ms-05,berhenti,停下,Bas itu berhenti di depan sekolah.,那辆巴士在学校前停下。,ber- + henti → berhenti；词根 henti；ber- 常规形式；不及物,动词;日常活动\nms-0329,ms,ms-05,bertemu,见面,Saya bertemu dengan Siti pada hari Ahad.,我星期日和西蒂见面。,ber- + temu → bertemu；词根 temu；ber- 常规形式；不及物,动词;日常活动\nms-0330,ms,ms-05,berenang,游泳,Kami berenang di kolam pada petang Sabtu.,我们星期六下午在泳池游泳。,ber- + renang → berenang；词根 renang；be- 变体；不及物,动词;日常活动\nms-0331,ms,ms-05,berbaju,穿着上衣,Ali berbaju biru hari ini.,阿里今天穿着蓝色上衣。,ber- + baju → berbaju；词根 baju；ber- 常规形式；不及物,动词;日常活动\nms-0332,ms,ms-05,berkereta,有汽车；乘汽车,Kami berkereta ke Melaka pada hari Ahad.,我们星期日乘汽车去马六甲。,ber- + kereta → berkereta；词根 kereta；ber- 常规形式；不及物,动词;日常活动\nms-0333,ms,ms-05,berehat,休息,Bapa berehat di rumah pada waktu malam.,父亲晚上在家休息。,ber- + rehat → berehat；词根 rehat；be- 变体；不及物,动词;日常活动\nms-0334,ms,ms-05,berbasikal,骑自行车,Saya berbasikal dengan abang setiap petang.,我每天下午和哥哥骑自行车。,ber- + basikal → berbasikal；词根 basikal；ber- 常规形式；不及物,动词;日常活动\nms-0335,ms,ms-05,bersukan,从事体育运动,Kami bersukan di sekolah pada hari Jumaat.,我们星期五在学校运动。,ber- + sukan → bersukan；词根 sukan；ber- 常规形式；不及物,动词;日常活动\nms-0336,ms,ms-05,bersenam,做体操；锻炼,Ibu bersenam selama dua puluh minit.,母亲锻炼二十分钟。,ber- + senam → bersenam；词根 senam；ber- 常规形式；不及物,动词;日常活动\nms-0337,ms,ms-05,berlatih,练习,Mereka berlatih badminton pada waktu petang.,他们下午练习羽毛球。,ber- + latih → berlatih；词根 latih；ber- 常规形式；不及物,动词;日常活动\nms-0338,ms,ms-05,berkebun,做园艺；种菜,Bapa berkebun di belakang rumah.,父亲在屋后种菜。,ber- + kebun → berkebun；词根 kebun；ber- 常规形式；不及物,动词;日常活动\nms-0339,ms,ms-05,berdoa,祈祷,Keluarga itu berdoa di rumah.,那家人在家祈祷。,ber- + doa → berdoa；词根 doa；ber- 常规形式；不及物,动词;日常活动\nms-0340,ms,ms-05,berjumpa,见到；碰面,Saya berjumpa dengan guru selepas kelas.,我课后与老师见面。,ber- + jumpa → berjumpa；词根 jumpa；ber- 常规形式；不及物,动词;日常活动\nms-0341,ms,ms-05,bertanya,询问,Pelajar bertanya kepada guru tentang buku itu.,学生向老师询问那本书。,ber- + tanya → bertanya；词根 tanya；ber- 常规形式；不及物,动词;日常活动\nms-0342,ms,ms-05,bercuti,休假,Kami bercuti di Pulau Pinang minggu ini.,我们这周在槟城度假。,ber- + cuti → bercuti；词根 cuti；ber- 常规形式；不及物,动词;日常活动\nms-0343,ms,ms-05,berkumpul,集合；聚集,Para pelajar berkumpul di padang sekolah.,学生们在学校运动场集合。,ber- + kumpul → berkumpul；词根 kumpul；ber- 常规形式；不及物,动词;日常活动\nms-0344,ms,ms-05,berpayung,撑伞,Siti berpayung kerana hujan.,西蒂因为下雨而撑伞。,ber- + payung → berpayung；词根 payung；ber- 常规形式；不及物,动词;日常活动\nms-0345,ms,ms-05,berkasut,穿着鞋,Abang berkasut hitam ke sekolah.,哥哥穿着黑鞋去学校。,ber- + kasut → berkasut；词根 kasut；ber- 常规形式；不及物,动词;日常活动\nms-0346,ms,ms-05,selalu,经常,Saya selalu berjalan ke sekolah.,我经常走路去学校。,频率副词，放在动作前,副词;时间\nms-0347,ms,ms-05,sentiasa,始终；总是,Ibu sentiasa bangun pada pukul enam.,母亲总是六点起床。,表示持续或一贯,副词;时间\nms-0348,ms,ms-05,biasanya,通常,Kami biasanya bersukan pada hari Sabtu.,我们通常星期六运动。,表示一般习惯,副词;时间\nms-0349,ms,ms-05,kadang-kadang,有时,Saya kadang-kadang berkereta ke pejabat.,我有时乘汽车去办公室。,频率副词，连字符不可省,副词;时间\nms-0350,ms,ms-05,jarang,很少,Bapa jarang bercuti pada bulan Disember.,父亲很少在十二月休假。,频率低，不等于从不,副词;时间\nms-0351,ms,ms-05,tidak pernah,从未,Saya tidak pernah berenang di kolam itu.,我从未在那个泳池游泳。,否定词与体貌标记组合,副词;时间\nms-0352,ms,ms-05,setiap hari,每天,Ali belajar bahasa Melayu setiap hari.,阿里每天学马来语。,固定时间短语，setiap 后用单数名词,副词;时间\nms-0353,ms,ms-05,sering,时常,Kami sering berbual pada waktu rehat.,我们时常在休息时间聊天。,频率副词,副词;时间\nms-0354,ms,ms-05,sukan,体育运动,Saya suka sukan di sekolah.,我喜欢学校的体育运动。,量词 种类用 jenis,名词;活动与运动\nms-0355,ms,ms-05,bola,球,Adik ada dua biji bola.,弟弟有两个球。,量词 biji,名词;活动与运动\nms-0356,ms,ms-05,bola sepak,足球运动,Abang bermain bola sepak pada hari Ahad.,哥哥星期日踢足球。,量词 比赛场次用 perlawanan,名词;活动与运动\nms-0357,ms,ms-05,badminton,羽毛球运动,Kami bermain badminton setiap petang.,我们每天下午打羽毛球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0358,ms,ms-05,tenis,网球运动,Siti bermain tenis dengan Ali.,西蒂和阿里打网球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0359,ms,ms-05,pingpong,乒乓球运动,Kami bermain pingpong di sekolah.,我们在学校打乒乓球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0360,ms,ms-05,hoki,曲棍球运动,Kakak bermain hoki pada hari Sabtu.,姐姐星期六打曲棍球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0361,ms,ms-05,golf,高尔夫球运动,Bapa jarang bermain golf.,父亲很少打高尔夫球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0362,ms,ms-05,yoga,瑜伽,Ibu belajar yoga di rumah.,母亲在家学瑜伽。,量词 通常不用量词,名词;活动与运动;梵语借词\nms-0363,ms,ms-05,senaman,锻炼；体操,Senaman ini baik untuk saya.,这种锻炼对我有益。,量词 套用 set,名词;活动与运动\nms-0364,ms,ms-05,latihan,练习；训练,Latihan badminton kami pada pukul lima.,我们的羽毛球训练在五点。,通常不用专用量词，可写 satu latihan（一项练习）,名词;活动与运动\nms-0365,ms,ms-05,padang,运动场；草地,Padang sekolah itu besar.,那所学校的运动场很大。,量词 buah,名词;活动与运动\nms-0366,ms,ms-05,kolam,池；泳池,Kami berenang di kolam besar itu.,我们在那个大泳池游泳。,量词 buah,名词;活动与运动\nms-0367,ms,ms-05,kelab,俱乐部,Kelab sukan itu ada dua puluh orang pelajar.,那个体育俱乐部有二十名学生。,量词 buah,名词;活动与运动;英语借词\nms-0368,ms,ms-05,hobi,爱好,Hobi saya ialah berkebun.,我的爱好是园艺。,量词 通常不用量词,名词;活动与运动;英语借词\nms-0369,ms,ms-05,tangan,手,Tangan saya kecil.,我的手很小。,量词 只用 belah，双手用 pasang,名词;身体与衣物\nms-0370,ms,ms-05,kaki,脚；腿,Kaki Ali panjang.,阿里的腿很长。,量词 只用 belah，双脚用 pasang,名词;身体与衣物\nms-0371,ms,ms-05,kepala,头,Kepala kucing itu kecil.,那只猫的头很小。,一般不另用量词，按所属的人或动物计数,名词;身体与衣物\nms-0372,ms,ms-05,mata,眼睛,Mata adik besar.,弟弟的眼睛很大。,量词 只用 belah，双眼用 pasang,名词;身体与衣物\nms-0373,ms,ms-05,baju,上衣,Saya ada tiga helai baju biru.,我有三件蓝色上衣。,量词 helai,名词;身体与衣物\nms-0374,ms,ms-05,seluar,裤子,Seluar abang panjang.,哥哥的裤子很长。,量词 helai,名词;身体与衣物\nms-0375,ms,ms-05,kemeja,衬衫,Kemeja bapa baru.,父亲的衬衫是新的。,量词 helai,名词;身体与衣物;葡语借词\nms-0376,ms,ms-05,stoking,袜子,Saya ada dua pasang stoking.,我有两双袜子。,量词 pasang,名词;身体与衣物;英语借词\nms-0377,ms,ms-05,topi,帽子,Topi Siti biru.,西蒂的帽子是蓝色的。,量词 顶用 buah,名词;身体与衣物\nms-0378,ms,ms-05,tudung,头巾,Tudung Aminah cantik.,阿米娜的头巾很漂亮。,量词 helai,名词;身体与衣物\nms-0379,ms,ms-05,Saya berjalan setiap pagi.,我每天早晨走路。,Saya berjalan setiap pagi.,我每天早晨走路。,ber- + jalan；不及物；时间短语在句尾,动词;日常活动;phrase\nms-0380,ms,ms-05,Kami biasanya bersenam bersama.,我们通常一起锻炼。,Kami biasanya bersenam bersama.,我们通常一起锻炼。,ber- + senam；不及物；频率词在动作前,动词;日常活动;phrase\nms-0381,ms,ms-05,Saya tidak pernah bermain golf.,我从未打过高尔夫球。,Saya tidak pernah bermain golf.,我从未打过高尔夫球。,ber- + main；不及物；golf 是活动补语,动词;日常活动;phrase\nms-0382,ms,ms-05,Ali sedang berehat di rumah.,阿里正在家休息。,Ali sedang berehat di rumah.,阿里正在家休息。,ber- + rehat；be- 变体；不及物,动词;日常活动;phrase\nms-0383,ms,ms-05,Kita bertemu selepas kelas.,我们课后见面。,Kita bertemu selepas kelas.,我们课后见面。,ber- + temu；不及物,动词;日常活动;phrase\nms-0384,ms,ms-05,kereta,汽车,Kereta bapa besar.,父亲的汽车很大。,量词 buah,名词;日常活动;补充\nms-0385,ms,ms-05,basikal,自行车,Basikal saya baru.,我的自行车是新的。,量词 buah,名词;日常活动;补充\nms-0386,ms,ms-05,payung,伞,Payung ini untuk Siti.,这把伞给西蒂。,量词 把用 kaki,名词;日常活动;补充\nms-0387,ms,ms-05,hujan,雨,Hari ini hujan.,今天下雨。,通常不用量词；hujan 也可直接表示下雨,名词;日常活动;补充\nms-0388,ms,ms-05,gim,健身房,Gim itu di sebelah sekolah.,那间健身房在学校旁边。,量词 buah,名词;日常活动;英语借词;补充\nms-0389,ms,ms-05,selepas,在……之后,Saya berehat selepas senaman.,我锻炼后休息。,后接时间或活动，表示先后,介词;日常活动;补充\nms-0390,ms,ms-05,sebelum,在……之前,Kami mandi sebelum makan.,我们吃饭前洗澡。,后接时间或活动,介词;日常活动;补充\nms-0391,ms,ms-05,selama,持续……时间,Ali berenang selama setengah jam.,阿里游泳半小时。,后接时长,介词;日常活动;补充\nms-0392,ms,ms-05,kepada,向；对某人,Siti bertanya kepada guru.,西蒂向老师提问。,引出动作所指向的人,介词;日常活动;补充\nms-0393,ms,ms-05,tentang,关于,Kami berbual tentang sukan.,我们谈论体育。,引出话题,介词;日常活动;补充\nms-0394,ms,ms-05,bersama,一起,Kami berjalan bersama ke sekolah.,我们一起走路去学校。,ber- + sama；词根 sama；本课作副词,副词;日常活动;补充\nms-0395,ms,ms-05,letih,疲倦的,Saya letih selepas bersukan.,我运动后很累。,形容词，后置,形容词;日常活动;补充\nms-0396,ms,ms-05,sihat,健康的,Keluarga kami sihat.,我们一家人都健康。,形容词，后置,形容词;日常活动;阿拉伯语借词;补充\nms-0397,ms,ms-05,biru,蓝色的,Baju biru itu baju saya.,那件蓝色上衣是我的上衣。,形容词，后置,形容词;日常活动;补充\nms-0398,ms,ms-05,hitam,黑色的,Kasut hitam itu baru.,那双黑鞋是新的。,形容词，后置,形容词;日常活动;补充\nms-0399,ms,ms-05,merah,红色的,Bola merah itu untuk adik.,那个红球给弟弟。,形容词，后置,形容词;日常活动;补充\nms-0400,ms,ms-05,putih,白色的,Kemeja putih itu baru.,那件白衬衫是新的。,形容词，后置,形容词;日常活动;补充\nms-0401,ms,ms-06,melihat,看见,Saya melihat Siti di sekolah.,我在学校看见西蒂。,meN- + lihat → melihat，me-；l 保留；词根 lihat；及物；常见宾语 buku、kawan,动词;学习与工作\nms-0402,ms,ms-06,memasak,烹煮,Ibu memasak nasi di dapur.,母亲在厨房煮饭。,meN- + masak → memasak，me-；m 保留；词根 masak；及物；常见宾语 nasi、sayur,动词;学习与工作\nms-0403,ms,ms-06,menanti,等候,Kami menanti bas di depan sekolah.,我们在学校前等巴士。,meN- + nanti → menanti，me-；n 保留；词根 nanti；及物；常见宾语 bas、kawan,动词;学习与工作\nms-0404,ms,ms-06,merasa,品尝,Bapa merasa kopi itu.,父亲尝了尝那杯咖啡。,meN- + rasa → merasa，me-；r 保留；词根 rasa；及物；常见宾语 sup、kopi,动词;学习与工作\nms-0405,ms,ms-06,menyanyi,唱歌,Adik menyanyi di dalam bilik.,弟弟在房间里唱歌。,meN- + nyanyi → menyanyi，me-；ny 保留，不是 s 脱落；词根 nyanyi；不及物，不直接带宾语,动词;学习与工作\nms-0406,ms,ms-06,membaca,阅读,Siti membaca surat Ali.,西蒂读阿里的信。,meN- + baca → membaca，mem-；b 保留；词根 baca；及物；常见宾语 buku、surat,动词;学习与工作\nms-0407,ms,ms-06,membeli,购买,Kami membeli beras di kedai.,我们在商店买米。,meN- + beli → membeli，mem-；b 保留；词根 beli；及物；常见宾语 beras、baju,动词;学习与工作\nms-0408,ms,ms-06,memakai,穿戴；使用,Ali memakai baju putih ke sekolah.,阿里穿白色上衣去学校。,meN- + pakai → memakai，mem-；p 脱落；词根 pakai；及物；常见宾语 baju、kasut,动词;学习与工作\nms-0409,ms,ms-06,memukul,敲打；击打,Siti memukul bola itu.,西蒂击打那个球。,meN- + pukul → memukul，mem-；p 脱落；词根 pukul；及物；常见宾语 bola、gendang,动词;学习与工作\nms-0410,ms,ms-06,memproses,处理,Kerani memproses borang itu.,办事员处理那张表格。,meN- + proses → memproses，mem-；pr 辅音簇保留；词根 proses；及物；常见宾语 borang、data,动词;学习与工作\nms-0411,ms,ms-06,membawa,携带,Saya membawa beg ke sekolah.,我带着书包去学校。,meN- + bawa → membawa，mem-；b 保留；词根 bawa；及物；常见宾语 beg、buku,动词;学习与工作\nms-0412,ms,ms-06,mencari,寻找,Ali mencari pen di dalam beg.,阿里在包里找笔。,meN- + cari → mencari，men-；c 保留；词根 cari；及物；常见宾语 buku、pen,动词;学习与工作\nms-0413,ms,ms-06,mendengar,听；听见,Kami mendengar berita di radio.,我们听广播里的新闻。,meN- + dengar → mendengar，men-；d 保留；词根 dengar；及物；常见宾语 muzik、berita,动词;学习与工作\nms-0414,ms,ms-06,menjual,售卖,Kedai itu menjual sayur dan roti.,那家店卖蔬菜和面包。,meN- + jual → menjual，men-；j 保留；词根 jual；及物；常见宾语 sayur、roti,动词;学习与工作\nms-0415,ms,ms-06,menulis,书写,Saya menulis surat kepada Siti.,我给西蒂写信。,meN- + tulis → menulis，men-；t 脱落；词根 tulis；及物；常见宾语 surat、nota,动词;学习与工作\nms-0416,ms,ms-06,menunggu,等候,Mei Ling menunggu Raju di sekolah.,美玲在学校等拉朱。,meN- + tunggu → menunggu，men-；t 脱落；词根 tunggu；及物；常见宾语 bas、kawan,动词;学习与工作\nms-0417,ms,ms-06,mentadbir,管理,Beliau mentadbir sekolah itu.,他管理那所学校。,meN- + tadbir → mentadbir，men-；借词 t 保留，不是词首辅音簇；词根 tadbir；及物；常见宾语 sekolah、pejabat,动词;学习与工作\nms-0418,ms,ms-06,mencuci,洗,Adik mencuci tangan dengan sabun.,弟弟用肥皂洗手。,meN- + cuci → mencuci，men-；c 保留；词根 cuci；及物；常见宾语 tangan、baju,动词;学习与工作\nms-0419,ms,ms-06,menjawab,回答,Guru menjawab soalan saya.,老师回答我的问题。,meN- + jawab → menjawab，men-；j 保留；词根 jawab；及物；常见宾语 soalan、surat,动词;学习与工作\nms-0420,ms,ms-06,mengambil,拿取,Saya mengambil buku di atas meja.,我拿桌上的书。,meN- + ambil → mengambil，meng-；元音 a 保留；词根 ambil；及物；常见宾语 buku、air,动词;学习与工作\nms-0421,ms,ms-06,mengajar,教,Siti mengajar bahasa Melayu di sekolah.,西蒂在学校教马来语。,meN- + ajar → mengajar，meng-；元音 a 保留；词根 ajar；及物；常见宾语 bahasa、pelajar,动词;学习与工作\nms-0422,ms,ms-06,menghantar,送；寄送,Ali menghantar surat kepada Mei Ling.,阿里给美玲寄信。,meN- + hantar → menghantar，meng-；h 保留；词根 hantar；及物；常见宾语 surat、anak,动词;学习与工作\nms-0423,ms,ms-06,mengira,计算；数,Kerani mengira wang di pejabat.,办事员在办公室数钱。,meN- + kira → mengira，meng-；k 脱落；词根 kira；及物；常见宾语 wang、buku,动词;学习与工作\nms-0424,ms,ms-06,mengirim,寄送,Saya mengirim e-mel kepada guru.,我给老师发电子邮件。,meN- + kirim → mengirim，meng-；k 脱落；词根 kirim；及物；常见宾语 surat、e-mel,动词;学习与工作\nms-0425,ms,ms-06,mengkaji,研究,Mereka mengkaji bahasa Melayu di universiti.,他们在大学研究马来语。,meN- + kaji → mengkaji，meng-；k 保留，词汇例外；词根 kaji；及物；常见宾语 bahasa、resipi,动词;学习与工作\nms-0426,ms,ms-06,menggali,挖掘,Bapa menggali lubang di belakang rumah.,父亲在屋后挖洞。,meN- + gali → menggali，meng-；g 保留；词根 gali；及物；常见宾语 lubang、tanah,动词;学习与工作\nms-0427,ms,ms-06,mengukur,测量,Kakak mengukur kain itu.,姐姐测量那块布。,meN- + ukur → mengukur，meng-；元音 u 保留；词根 ukur；及物；常见宾语 meja、kain,动词;学习与工作\nms-0428,ms,ms-06,menyapu,扫,Ali menyapu lantai rumah.,阿里扫家里的地板。,meN- + sapu → menyapu，meny-；s 脱落；词根 sapu；及物；常见宾语 lantai、bilik,动词;学习与工作\nms-0429,ms,ms-06,menyewa,租用,Kami menyewa basikal di Melaka.,我们在马六甲租自行车。,meN- + sewa → menyewa，meny-；s 脱落；词根 sewa；及物；常见宾语 rumah、basikal,动词;学习与工作\nms-0430,ms,ms-06,menyimpan,保存；收好,Ibu menyimpan wang di bank.,母亲把钱存进银行。,meN- + simpan → menyimpan，meny-；s 脱落；词根 simpan；及物；常见宾语 wang、buku,动词;学习与工作\nms-0431,ms,ms-06,menyusun,排列；整理,Saya menyusun buku di atas meja.,我整理桌上的书。,meN- + susun → menyusun，meny-；s 脱落；词根 susun；及物；常见宾语 buku、kerusi,动词;学习与工作\nms-0432,ms,ms-06,mengecat,涂漆,Bapa mengecat pintu dengan berus.,父亲用刷子给门涂漆。,meN- + cat → mengecat，menge-；单音节词根完整保留；词根 cat；及物；常见宾语 dinding、pintu,动词;学习与工作\nms-0433,ms,ms-06,mengepam,打气；抽水,Ali mengepam tayar basikal.,阿里给自行车轮胎打气。,meN- + pam → mengepam，menge-；单音节词根完整保留；词根 pam；及物；常见宾语 tayar、air,动词;学习与工作\nms-0434,ms,ms-06,mengelap,擦拭,Siti mengelap meja dengan kain.,西蒂用布擦桌子。,meN- + lap → mengelap，menge-；单音节词根完整保留；词根 lap；及物；常见宾语 meja、tingkap,动词;学习与工作\nms-0435,ms,ms-06,mengepos,邮寄,Kakak mengepos surat pada hari Isnin.,姐姐星期一寄信。,meN- + pos → mengepos，menge-；单音节词根完整保留；词根 pos；及物；常见宾语 surat、borang,动词;学习与工作\nms-0436,ms,ms-06,surat,信,Surat ini daripada Ali.,这封信来自阿里。,量词 封用 pucuk,名词;学习与工作\nms-0437,ms,ms-06,sampul,信封,Saya menyimpan surat di dalam sampul.,我把信收在信封里。,量词 个用 keping,名词;学习与工作\nms-0438,ms,ms-06,borang,表格,Siti membaca borang itu.,西蒂读那张表格。,量词 张用 helai,名词;学习与工作\nms-0439,ms,ms-06,berus,刷子,Bapa membawa berus ke rumah.,父亲把刷子带回家。,量词 把用 batang,名词;学习与工作\nms-0440,ms,ms-06,cat,油漆,Cat ini merah.,这种油漆是红色的。,量词 罐用 tin,名词;学习与工作;闽南语借词\nms-0441,ms,ms-06,pam,泵；打气筒,Pam basikal itu kecil.,那个自行车打气筒很小。,量词 buah,名词;学习与工作;英语借词\nms-0442,ms,ms-06,tayar,轮胎,Tayar kereta itu baru.,那辆汽车的轮胎是新的。,量词 个用 biji,名词;学习与工作;英语借词\nms-0443,ms,ms-06,baldi,桶,Saya membawa baldi ke dapur.,我把桶拿到厨房。,量词 buah,名词;学习与工作;葡语借词\nms-0444,ms,ms-06,kain,布,Ibu membeli kain biru.,母亲买蓝布。,量词 片用 helai,名词;学习与工作\nms-0445,ms,ms-06,sabun,肥皂,Sabun ini untuk mencuci tangan.,这块肥皂用来洗手。,量词 块用 buku,名词;学习与工作\nms-0446,ms,ms-06,ubat,药,Ibu membeli ubat di klinik.,母亲在诊所买药。,量词 片用 biji，液体用 botol,名词;学习与工作\nms-0447,ms,ms-06,wang,钱,Wang saya ada di dalam beg.,我的钱在包里。,量词 金额用 ringgit,名词;学习与工作\nms-0448,ms,ms-06,cerita,故事,Cerita Ali sangat panjang.,阿里的故事很长。,量词 篇用 buah,名词;学习与工作\nms-0449,ms,ms-06,berita,新闻；消息,Berita itu tentang sekolah kami.,那条新闻是关于我们学校的。,量词 条用 buah,名词;学习与工作\nms-0450,ms,ms-06,lagu,歌曲,Lagu ini dalam bahasa Melayu.,这首歌是马来语歌。,量词 首用 buah,名词;学习与工作\nms-0451,ms,ms-06,resipi,食谱,Saya membaca resipi ibu.,我读母亲的食谱。,通常不用专用量词，可写 satu resipi（一份食谱）,名词;学习与工作;英语借词\nms-0452,ms,ms-06,beras,生米,Beras ini untuk keluarga kami.,这些米给我们一家人。,量词 袋用 kampit,名词;学习与工作\nms-0453,ms,ms-06,bawang,洋葱；葱蒜类,Ibu membeli bawang di kedai.,母亲在商店买洋葱。,量词 个用 biji,名词;学习与工作\nms-0454,ms,ms-06,minyak,油,Minyak ini untuk memasak.,这种油用来烹饪。,量词 瓶用 botol,名词;学习与工作\nms-0455,ms,ms-06,periuk,锅,Periuk itu ada di dapur.,那口锅在厨房。,量词 口用 buah,名词;学习与工作\nms-0456,ms,ms-06,sambil,一边……一边……,Siti memasak sambil mendengar radio.,西蒂一边做饭一边听广播。,连接同时发生的动作,连词;时间\nms-0457,ms,ms-06,lalu,然后；于是,Ali mengambil pen lalu menulis surat.,阿里拿起笔，然后写信。,连接先后动作,连词;时间\nms-0458,ms,ms-06,kemudian,然后,\"Saya mencuci tangan, kemudian makan nasi.\",我洗手，然后吃饭。,连接叙述的先后,副词;时间\nms-0459,ms,ms-06,akhirnya,最后；终于,Akhirnya kami bertemu di sekolah.,最后我们在学校见面了。,表示过程的末尾,副词;时间\nms-0460,ms,ms-06,segera,立刻,Saya segera menjawab e-mel guru.,我立即回复老师的电子邮件。,副词，表示不拖延,副词;时间\nms-0461,ms,ms-06,Saya sedang membaca surat.,我正在读信。,Saya sedang membaca surat.,我正在读信。,meN- + baca → membaca，b 保留；宾语 surat,动词;学习与工作;phrase\nms-0462,ms,ms-06,Ibu memasak sambil menyanyi.,母亲一边做饭一边唱歌。,Ibu memasak sambil menyanyi.,母亲一边做饭一边唱歌。,me- + masak；me- + nyanyi；此处不带宾语,动词;学习与工作;phrase\nms-0463,ms,ms-06,Ali menulis dengan pen.,阿里用笔写字。,Ali menulis dengan pen.,阿里用笔写字。,meN- + tulis → menulis，t 脱落；宾语可为 surat，本句省略,动词;学习与工作;phrase\nms-0464,ms,ms-06,Kami menyusun buku bersama.,我们一起整理书。,Kami menyusun buku bersama.,我们一起整理书。,meN- + susun → menyusun，s 脱落；宾语 buku,动词;学习与工作;phrase\nms-0465,ms,ms-06,Siti mengelap meja itu.,西蒂擦那张桌子。,Siti mengelap meja itu.,西蒂擦那张桌子。,meN- + lap → mengelap，单音节；宾语 meja,动词;学习与工作;phrase\nms-0466,ms,ms-06,kedai,商店,Kedai itu menjual beras dan sayur.,那家店卖米和蔬菜。,量词 家用 buah,名词;日常用品;补充\nms-0467,ms,ms-06,soalan,问题,Soalan guru itu tentang resipi.,老师的那个问题是关于食谱的。,通常不用专用量词，可写 satu soalan（一题）,名词;日常用品;补充\nms-0468,ms,ms-06,lubang,洞,Lubang itu kecil.,那个洞很小。,量词 个用 buah,名词;日常用品;补充\nms-0469,ms,ms-06,cili,辣椒,Ibu mencuci cili di dapur.,母亲在厨房洗辣椒。,量词 个用 biji,名词;日常用品;补充\nms-0470,ms,ms-06,daging,肉,Saya memasak daging dengan bawang.,我用洋葱煮肉。,量词 块用 ketul,名词;日常用品;补充\nms-0471,ms,ms-06,timun,黄瓜,Kakak membeli timun di kedai.,姐姐在商店买黄瓜。,量词 条用 batang,名词;日常用品;补充\nms-0472,ms,ms-06,lobak,萝卜,Saya mencuci lobak sebelum memasak.,我做饭前洗萝卜。,量词 根用 batang,名词;日常用品;补充\nms-0473,ms,ms-06,limau,柑橘；青柠,Air limau itu sejuk.,那杯青柠汁是凉的。,量词 个用 biji,名词;日常用品;补充\nms-0474,ms,ms-06,madu,蜂蜜,Madu itu di dalam gelas.,蜂蜜在玻璃杯里。,量词 瓶用 botol,名词;日常用品;补充\nms-0475,ms,ms-06,botol,瓶子,Botol itu untuk susu.,那个瓶子用来装牛奶。,量词 buah,名词;日常用品;补充\nms-0476,ms,ms-06,daripada,来自某人；由某种材料；比,Surat ini daripada guru saya.,这封信来自我的老师。,人、来源、材料和比较；地点来源用 dari,介词;学习与工作;补充\nms-0477,ms,ms-06,bersih,干净的,Meja itu sudah bersih.,那张桌子已经干净了。,形容词，后置,形容词;日常用品;补充\nms-0478,ms,ms-06,kotor,脏的,Kain kotor itu di dalam baldi.,那块脏布在桶里。,形容词，后置,形容词;日常用品;补充\nms-0479,ms,ms-06,kering,干的,Baju itu sudah kering.,那件上衣已经干了。,形容词，后置,形容词;日常用品;补充\nms-0480,ms,ms-06,basah,湿的,Kain itu masih basah.,那块布还湿着。,形容词，后置,形容词;日常用品;补充\nms-0481,ms,ms-07,di,在,Saya bekerja di Kuala Lumpur.,我在吉隆坡工作。,后接地点，分写；本课不教被动前缀 di-,介词;城市\nms-0482,ms,ms-07,ke,到；向,Kami pergi ke stesen dengan bas.,我们坐巴士去车站。,后接方向或地点，分写,介词;城市\nms-0483,ms,ms-07,dari,从,Ali datang dari Johor Bahru.,阿里从新山来。,地点、方向或时间的起点,介词;城市\nms-0484,ms,ms-07,untuk,为了；给,Buku ini untuk adik saya.,这本书给我的弟弟。,表示用途或受益者,介词;城市\nms-0485,ms,ms-07,bagi,为；对于,Latihan ini baik bagi pelajar.,这个练习对学生有益。,表示对象或受益者,介词;城市\nms-0486,ms,ms-07,mengenai,关于,Kami berbual mengenai bandar Melaka.,我们谈论马六甲城。,用法近于 tentang；本课作为介词整词学习,介词;城市\nms-0487,ms,ms-07,oleh,由,Saya membaca cerita oleh Siti.,我读西蒂写的故事。,可在名词后标作者；被动句施事用法留待 ms-11,介词;城市\nms-0488,ms,ms-07,sejak,自从,Saya tinggal di sini sejak tahun 2020.,我自2020年起住在这里。,引出持续情况的起点,介词;城市\nms-0489,ms,ms-07,hingga,直到,Ali bekerja dari pagi hingga petang.,阿里从早到下午工作。,引出时间或空间终点,介词;城市\nms-0490,ms,ms-07,sehingga,直到,Kami menunggu sehingga pukul lima.,我们一直等到五点。,引出终点或限度,介词;城市\nms-0491,ms,ms-07,sampai,直到；到,Saya berjalan dari rumah sampai sekolah.,我从家一直走到学校。,本课作介词，引出终点,介词;城市\nms-0492,ms,ms-07,antara,在……之间,Kami berehat antara pukul dua dengan pukul tiga.,我们在两点到三点之间休息。,常用 antara A dengan B,介词;城市\nms-0493,ms,ms-07,tanpa,没有；不带,Dia pergi ke sekolah tanpa beg.,他没带书包就去学校。,后接缺少的事物或动作,介词;城市\nms-0494,ms,ms-07,seperti,像,Rumah ini seperti rumah saya.,这座房子像我的家。,引出相似的事物,介词;城市\nms-0495,ms,ms-07,terhadap,对；对于,Sikapnya terhadap pelajar sangat baik.,他对学生的态度很好。,常配态度、看法等名词,介词;城市;补充\nms-0496,ms,ms-07,menerusi,经由；通过,Kami membaca berita menerusi e-mel.,我们通过电子邮件读消息。,本课作介词整词学习，不开放 -i 派生,介词;城市;补充\nms-0497,ms,ms-07,di atas,在……上面,Buku saya di atas meja.,我的书在桌上。,di 分写，atas 表上方,介词;方位\nms-0498,ms,ms-07,di bawah,在……下面,Kucing itu di bawah kerusi.,那只猫在椅子下面。,di 分写，bawah 表下方,介词;方位\nms-0499,ms,ms-07,di dalam,在……里面,Wang saya di dalam beg.,我的钱在包里。,具体空间内部,介词;方位\nms-0500,ms,ms-07,di luar,在……外面,Ali menunggu di luar sekolah.,阿里在学校外等候。,luar 表外部,介词;方位\nms-0501,ms,ms-07,di depan,在……前面,Bas berhenti di depan stesen.,巴士在车站前停下。,depan 表前方,介词;方位\nms-0502,ms,ms-07,di belakang,在……后面,Taman itu di belakang rumah.,公园在屋后。,belakang 表后方,介词;方位\nms-0503,ms,ms-07,di sebelah,在……旁边,Klinik di sebelah bank.,诊所在银行旁边。,sebelah 表旁边,介词;方位\nms-0504,ms,ms-07,di tepi,在……边上,Mereka berdiri di tepi jalan.,他们站在路边。,tepi 表边缘,介词;方位\nms-0505,ms,ms-07,di tengah,在……中间,Meja itu di tengah bilik.,那张桌子在房间中间。,tengah 表中央,介词;方位\nms-0506,ms,ms-07,di antara,在……之间,Masjid itu di antara dua buah bangunan.,清真寺在两栋建筑之间。,具体空间位置；后接两个对象或复数,介词;方位\nms-0507,ms,ms-07,hadapan,前方,Ali berdiri di hadapan sekolah.,阿里站在学校前面。,量词 通常不用量词,名词;方位\nms-0508,ms,ms-07,hujung,尽头；末端,Pejabat pos itu di hujung jalan.,邮局在路的尽头。,量词 通常不用量词,名词;方位\nms-0509,ms,ms-07,stesen,车站,Stesen itu berhampiran rumah saya.,车站在我家附近。,量词 buah,名词;城市;英语借词\nms-0510,ms,ms-07,pejabat pos,邮局,Kami mengepos surat di pejabat pos.,我们在邮局寄信。,量词 buah,名词;城市\nms-0511,ms,ms-07,pasar,市场,Ibu membeli sayur di pasar.,母亲在市场买菜。,量词 buah,名词;城市\nms-0512,ms,ms-07,masjid,清真寺,Masjid itu di tengah bandar.,那座清真寺在市中心。,量词 buah,名词;城市;阿拉伯语借词\nms-0513,ms,ms-07,taman,公园,Kami bersenam di taman setiap pagi.,我们每天早晨在公园锻炼。,量词 座用 buah,名词;城市\nms-0514,ms,ms-07,jalan,道路,Jalan ini ke stesen.,这条路通往车站。,量词 条用 batang,名词;城市\nms-0515,ms,ms-07,jambatan,桥,Jambatan itu panjang.,那座桥很长。,量词 座用 buah,名词;城市\nms-0516,ms,ms-07,lapangan terbang,机场,Bas ini ke lapangan terbang.,这辆巴士开往机场。,量词 座用 buah,名词;城市\nms-0517,ms,ms-07,perpustakaan,图书馆,Siti membaca di perpustakaan.,西蒂在图书馆读书。,量词 座用 buah,名词;城市\nms-0518,ms,ms-07,balai polis,警察局,Balai polis itu di sebelah bank.,警察局在银行旁边。,量词 座用 buah,名词;城市\nms-0519,ms,ms-07,bandar,城市,Bandar Melaka ada banyak kedai.,马六甲城有许多商店。,量词 座用 buah,名词;城市\nms-0520,ms,ms-07,kampung,村庄,Kampung saya berhampiran Johor Bahru.,我的村庄在新山附近。,量词 座用 buah,名词;城市\nms-0521,ms,ms-07,bangunan,建筑物,Bangunan itu tinggi dan putih.,那栋建筑很高，是白色的。,量词 栋用 buah,名词;城市\nms-0522,ms,ms-07,kedai buku,书店,Saya membeli buku di kedai buku itu.,我在那家书店买书。,量词 家用 buah,名词;城市\nms-0523,ms,ms-07,kedai makan,小餐馆,Kami makan di kedai makan berhampiran stesen.,我们在车站附近的小餐馆吃饭。,量词 家用 buah,名词;城市\nms-0524,ms,ms-07,pasar raya,超市,Pasar raya itu menjual susu dan roti.,那家超市卖牛奶和面包。,量词 家用 buah,名词;城市\nms-0525,ms,ms-07,pusat bandar,市中心,Pejabat saya di pusat bandar.,我的办公室在市中心。,量词 个用 buah,名词;城市\nms-0526,ms,ms-07,hentian bas,巴士停靠站,Ali menunggu di hentian bas.,阿里在巴士站等候。,量词 个用 buah,名词;城市\nms-0527,ms,ms-07,pelabuhan,港口,Pelabuhan itu di Pulau Pinang.,那个港口在槟城。,量词 座用 buah,名词;城市\nms-0528,ms,ms-07,stadium,体育场,Kami bermain bola sepak di stadium.,我们在体育场踢足球。,量词 座用 buah,名词;城市;英语借词\nms-0529,ms,ms-07,kereta api,火车,Saya ke Kuala Lumpur dengan kereta api.,我乘火车去吉隆坡。,量词 列用 buah,名词;交通\nms-0530,ms,ms-07,motosikal,摩托车,Motosikal itu di depan rumah.,那辆摩托车在屋前。,量词 辆用 buah,名词;交通;英语借词\nms-0531,ms,ms-07,kapal terbang,飞机,Kapal terbang itu besar.,那架飞机很大。,量词 架用 buah,名词;交通\nms-0532,ms,ms-07,feri,渡轮,Kami ke Pulau Pinang dengan feri.,我们坐渡轮去槟城。,量词 艘用 buah,名词;交通;英语借词\nms-0533,ms,ms-07,lori,货车,Lori itu membawa beras ke kedai.,那辆货车把米运到商店。,量词 辆用 buah,名词;交通;英语借词\nms-0534,ms,ms-07,van,厢式车,Van sekolah itu sudah sampai.,学校的厢式车已经到了。,量词 辆用 buah,名词;交通;英语借词\nms-0535,ms,ms-07,beca,三轮车,Saya melihat beca di Melaka.,我在马六甲看见三轮车。,量词 辆用 buah,名词;交通;闽南语借词\nms-0536,ms,ms-07,bot,小船,Bot itu di sebelah jambatan.,那条小船在桥旁边。,量词 艘用 buah,名词;交通;英语借词\nms-0537,ms,ms-07,Jalan terus.,一直走。,Jalan terus.,一直走。,祈使表达；jalan 作不及物动词，terus 表继续,动词;问路;phrase\nms-0538,ms,ms-07,Belok kiri.,向左转。,Belok kiri.,向左转。,不及物指路动词 belok；左为 kiri,动词;问路;phrase\nms-0539,ms,ms-07,Belok kanan.,向右转。,Belok kanan.,向右转。,不及物指路动词 belok；右为 kanan,动词;问路;phrase\nms-0540,ms,ms-07,Bagaimana hendak ke stesen?,怎样去车站？,Bagaimana hendak ke stesen?,怎样去车站？,完整问路句，hendak 表意图,动词;问路;phrase\nms-0541,ms,ms-07,Di mana perpustakaan?,图书馆在哪里？,Di mana perpustakaan?,图书馆在哪里？,地点疑问句，di mana 分写,动词;问路;phrase\nms-0542,ms,ms-07,Ikut jalan ini.,沿这条路走。,Ikut jalan ini.,沿这条路走。,及物祈使动词 ikut；常见宾语 jalan,动词;问路;phrase\nms-0543,ms,ms-07,Berhenti di sini.,在这里停下。,Berhenti di sini.,在这里停下。,ber- + henti；不及物；祈使也保留 ber-,动词;问路;phrase\nms-0544,ms,ms-07,Berjalan ke sana.,走到那里去。,Berjalan ke sana.,走到那里去。,ber- + jalan；不及物,动词;问路;phrase\nms-0545,ms,ms-07,kiri,左边,Bank itu di sebelah kiri.,银行在左边。,量词 通常不用量词,名词;城市;补充\nms-0546,ms,ms-07,kanan,右边,Stesen itu di sebelah kanan.,车站在右边。,量词 通常不用量词,名词;城市;补充\nms-0547,ms,ms-07,utara,北方,Sekolah itu di utara bandar.,学校在城市北部。,量词 通常不用量词,名词;城市;补充\nms-0548,ms,ms-07,selatan,南方,Kampung itu di selatan Melaka.,那个村庄在马六甲南边。,量词 通常不用量词,名词;城市;补充\nms-0549,ms,ms-07,timur,东方,Masjid itu di timur kampung.,清真寺在村庄东边。,量词 通常不用量词,名词;城市;补充\nms-0550,ms,ms-07,barat,西方,Pelabuhan itu di barat bandar.,港口在城市西边。,量词 通常不用量词,名词;城市;补充\nms-0551,ms,ms-07,simpang,路口；岔路,Ali menunggu di simpang itu.,阿里在那个路口等候。,量词 个用 buah,名词;城市;补充\nms-0552,ms,ms-07,lampu isyarat,交通信号灯,Bas berhenti di lampu isyarat.,巴士在信号灯前停下。,量词 组用 set,名词;城市;补充\nms-0553,ms,ms-07,peta,地图,Saya melihat peta bandar Melaka.,我查看马六甲城的地图。,量词 张用 helai,名词;城市;补充\nms-0554,ms,ms-07,laluan,路线；通道,Laluan ini untuk basikal.,这条通道供自行车使用。,通常不用专用量词，可写 satu laluan（一条通道）,名词;城市;补充\nms-0555,ms,ms-07,sikap,态度,Sikap Ali terhadap kawan sangat baik.,阿里对朋友的态度很好。,量词 通常不用量词,名词;城市;补充\nms-0556,ms,ms-07,dekat,近的,Rumah saya dekat dengan sekolah.,我家离学校近。,形容词，后置；dekat dengan,形容词;城市;补充\nms-0557,ms,ms-07,jauh,远的,Stesen itu jauh dari kampung.,车站离村庄远。,形容词，后置；jauh dari,形容词;城市;补充\nms-0558,ms,ms-07,berhampiran,靠近,Rumah saya berhampiran stesen.,我家靠近车站。,ber- + hampir + -an；词根 hampir；本课按整词学，不开放 -an；不及物,动词;城市;补充\nms-0559,ms,ms-07,masuk,进入,Ali masuk ke dalam kedai.,阿里走进商店。,不及物；地点由 ke 引出,动词;城市;补充\nms-0560,ms,ms-07,keluar,出去；出来,Siti keluar dari perpustakaan.,西蒂从图书馆出来。,不及物；地点由 dari 引出,动词;城市;补充\nms-0561,ms,ms-08,dapat,能够；得以,Esok saya akan dapat bertemu dengan guru.,明天我将能见到老师。,表示有条件实现，放在动词前,助动词;情态\nms-0562,ms,ms-08,mesti,必须；一定要,Kita mesti mencuci tangan sebelum makan.,我们吃饭前必须洗手。,义务或要求，后接动词,助动词;情态\nms-0563,ms,ms-08,harus,应该；应当,Kita harus membantu keluarga.,我们应该帮助家人。,本课表示应当，后接动词,助动词;情态\nms-0564,ms,ms-08,perlu,需要,Saya perlu membeli roti.,我需要买面包。,必要性，后接动词或名词,助动词;情态\nms-0565,ms,ms-08,mahu,想要,Saya mahu minum air limau.,我想喝青柠汁。,意愿；标准书面形式,助动词;情态\nms-0566,ms,ms-08,hendak,想要；打算,Kami hendak makan di restoran.,我们打算在餐馆吃饭。,意愿或打算；标准书面形式,助动词;情态\nms-0567,ms,ms-08,ingin,希望；想要,Saya ingin belajar memasak rendang.,我想学做仁当。,较正式的意愿表达,助动词;情态\nms-0568,ms,ms-08,pandai,擅长；会,Siti pandai memasak nasi lemak.,西蒂擅长做椰浆饭。,本课作情态性谓语，后接动词；也可作形容词,助动词;情态\nms-0569,ms,ms-08,sanggup,愿意；肯,Ali sanggup membantu saya.,阿里愿意帮助我。,表示愿意承担某事,助动词;情态\nms-0570,ms,ms-08,mampu,有能力,Kami mampu membayar bil ini.,我们有能力支付这张账单。,能力或财力，后接动词,助动词;情态\nms-0571,ms,ms-08,patut,应该,Kita patut menunggu di luar.,我们应该在外面等候。,表示合适的做法,助动词;情态;补充\nms-0572,ms,ms-08,enggan,不愿意,Adik enggan minum susu itu.,弟弟不愿喝那杯牛奶。,否定意愿，不另加 tidak,助动词;情态;补充\nms-0573,ms,ms-08,tolong,请帮忙,Tolong buka pintu itu.,请帮忙打开那扇门。,请求时后接动词原形；作及物动词「帮助」时常见宾语 saya,动词;请求与礼貌\nms-0574,ms,ms-08,minta,要；请求,Saya minta segelas air.,我要一杯水。,及物；常见宾语 air、bantuan；本课作礼貌请求,动词;请求与礼貌\nms-0575,ms,ms-08,tolong bantu saya,请帮帮我,\"Ali, tolong bantu saya.\",阿里，请帮帮我。,请求表达；及物动词 bantu 的宾语 saya,动词;请求与礼貌;phrase\nms-0576,ms,ms-08,minta air,要水,Saya minta air panas.,我要热水。,及物动词 minta；常见宾语 air,动词;请求与礼貌;phrase\nms-0577,ms,ms-08,maafkan saya,请原谅我,\"Siti, maafkan saya.\",西蒂，请原谅我。,固定礼貌表达；maaf + -kan；宾语 saya；本课按整词学，-kan 在 ms-09 系统学,动词;请求与礼貌;phrase\nms-0578,ms,ms-08,sila,请,Sila duduk di sini.,请坐这里。,邀请或礼貌指示，后接动词,语气词;请求与礼貌\nms-0579,ms,ms-08,jangan,不要；禁止,Jangan masuk ke dapur.,不要进入厨房。,禁止词，放在动词前,语气词;请求与礼貌\nms-0580,ms,ms-08,silalah,请吧,Silalah duduk di sini.,请坐这里吧。,sila + -lah，连写；本课按整词记,语气词;请求与礼貌\nms-0581,ms,ms-08,sila tunggu sebentar,请稍等,\"Ali, sila tunggu sebentar.\",阿里，请稍等。,sila + 动词 tunggu；完整请求表达,语气词;请求与礼貌;phrase\nms-0582,ms,ms-08,jangan masuk,请勿进入,\"Adik, jangan masuk.\",弟弟，不要进去。,jangan + 动词 masuk；禁止表达,语气词;请求与礼貌;phrase\nms-0583,ms,ms-08,makanan,食物,Makanan di restoran ini sedap.,这家餐馆的食物很好吃。,通常不用专用量词；按份可用 pinggan 或 bungkus,名词;食物与需求\nms-0584,ms,ms-08,minuman,饮料,Minuman ini untuk Ali.,这杯饮料给阿里。,量词 杯用 gelas,名词;食物与需求\nms-0585,ms,ms-08,sarapan,早餐,Sarapan saya roti dan telur.,我的早餐是面包和鸡蛋。,量词 set（套餐）,名词;食物与需求\nms-0586,ms,ms-08,santan,椰浆,Ibu memasak nasi dengan santan.,母亲用椰浆煮饭。,量词 杯用 cawan,名词;食物与需求\nms-0587,ms,ms-08,tepung,面粉,Tepung itu untuk membuat roti canai.,那些面粉用来做印度煎饼。,量词 袋用 kampit,名词;食物与需求\nms-0588,ms,ms-08,mentega,黄油,Saya mahu roti dengan mentega.,我想要涂黄油的面包。,量词 块用 buku,名词;食物与需求;葡语借词\nms-0589,ms,ms-08,roti canai,印度煎饼,Saya memesan dua keping roti canai.,我点两张印度煎饼。,量词 张用 keping,名词;食物与需求\nms-0590,ms,ms-08,nasi lemak,椰浆饭,Siti membeli nasi lemak untuk sarapan.,西蒂买椰浆饭当早餐。,量词 份用 bungkus 或 pinggan,名词;食物与需求\nms-0591,ms,ms-08,satay,沙爹串,Kami makan satay di Melaka.,我们在马六甲吃沙爹。,量词 串用 cucuk,名词;食物与需求\nms-0592,ms,ms-08,rendang,仁当炖肉,Rendang ini sangat sedap.,这份仁当很好吃。,量词 份用 pinggan,名词;食物与需求\nms-0593,ms,ms-08,kari,咖喱,Ibu memasak kari ayam.,母亲煮咖喱鸡。,量词 碗用 mangkuk,名词;食物与需求\nms-0594,ms,ms-08,sup,汤,Saya minta semangkuk sup panas.,我要一碗热汤。,量词 碗用 mangkuk,名词;食物与需求;英语借词\nms-0595,ms,ms-08,jus,果汁,Jus epal ini untuk adik.,这杯苹果汁给弟弟。,量词 杯用 gelas,名词;食物与需求;英语借词\nms-0596,ms,ms-08,ais,冰,Saya mahu teh tanpa ais.,我要不加冰的茶。,量词 块用 ketul,名词;食物与需求;英语借词\nms-0597,ms,ms-08,menu,菜单,Menu itu di atas meja.,菜单在桌上。,量词 naskhah（纸本）；也可直接写 satu menu,名词;食物与需求;英语借词\nms-0598,ms,ms-08,harga,价格,Harga roti ini tiga ringgit.,这种面包的价格是三令吉。,量词 通常不用量词，金额用 ringgit,名词;食物与需求\nms-0599,ms,ms-08,bil,账单,Saya membayar bil di restoran.,我在餐馆付账。,量词 张用 helai,名词;食物与需求;英语借词\nms-0600,ms,ms-08,pesanan,订单；点单,Pesanan kami dua pinggan nasi lemak.,我们点的是两盘椰浆饭。,通常不用专用量词，可写 satu pesanan（一份订单）,名词;食物与需求\nms-0601,ms,ms-08,bantuan,帮助,Kami perlu bantuan guru.,我们需要老师的帮助。,量词 通常不用量词,名词;食物与需求\nms-0602,ms,ms-08,kebenaran,许可,Saya meminta kebenaran untuk keluar.,我请求外出的许可。,量词 通常不用量词,名词;食物与需求\nms-0603,ms,ms-08,meminta,请求,Ali meminta bantuan guru.,阿里请求老师帮助。,meN- + minta → meminta，me-；m 保留；词根 minta；及物；常见宾语 bantuan、kebenaran,动词;学习与工作\nms-0604,ms,ms-08,membantu,帮助,Saya membantu ibu di dapur.,我在厨房帮母亲。,meN- + bantu → membantu，mem-；b 保留；词根 bantu；及物；常见宾语 ibu、kawan,动词;学习与工作\nms-0605,ms,ms-08,membayar,支付,Bapa membayar bil dengan wang itu.,父亲用那些钱付账。,meN- + bayar → membayar，mem-；b 保留；词根 bayar；及物；常见宾语 bil、harga,动词;学习与工作\nms-0606,ms,ms-08,memesan,点餐；订购,Kami memesan makanan di restoran.,我们在餐馆点餐。,meN- + pesan → memesan，mem-；p 脱落；词根 pesan；及物；常见宾语 nasi、minuman,动词;学习与工作\nms-0607,ms,ms-08,menerima,收到；接受,Siti menerima surat daripada Ali.,西蒂收到阿里的信。,meN- + terima → menerima，men-；t 脱落；词根 terima；及物；常见宾语 surat、bantuan,动词;学习与工作\nms-0608,ms,ms-08,membuka,打开,Ali membuka tingkap bilik.,阿里打开房间的窗户。,meN- + buka → membuka，mem-；b 保留；词根 buka；及物；常见宾语 pintu、tingkap,动词;学习与工作\nms-0609,ms,ms-08,menutup,关上,Ibu menutup pintu dapur.,母亲关上厨房的门。,meN- + tutup → menutup，men-；t 脱落；词根 tutup；及物；常见宾语 pintu、kedai,动词;学习与工作\nms-0610,ms,ms-08,meminjam,借入,Saya meminjam buku daripada Siti.,我向西蒂借书。,meN- + pinjam → meminjam，mem-；p 脱落；词根 pinjam；及物；常见宾语 buku、pen,动词;学习与工作\nms-0611,ms,ms-08,menggoreng,油炸；炒,Bapa menggoreng ikan di dapur.,父亲在厨房煎鱼。,meN- + goreng → menggoreng，meng-；g 保留；词根 goreng；及物；常见宾语 ikan、telur,动词;学习与工作\nms-0612,ms,ms-08,merebus,用水煮,Saya merebus telur untuk sarapan.,我煮鸡蛋当早餐。,meN- + rebus → merebus，me-；r 保留；词根 rebus；及物；常见宾语 telur、mi,动词;学习与工作\nms-0613,ms,ms-08,memotong,切；剪,Ibu memotong sayur dengan pisau.,母亲用刀切菜。,meN- + potong → memotong，mem-；p 脱落；词根 potong；及物；常见宾语 sayur、kain,动词;学习与工作\nms-0614,ms,ms-08,mencampur,混合,Siti mencampur tepung dengan air.,西蒂把面粉和水混合。,meN- + campur → mencampur，men-；c 保留；词根 campur；及物；常见宾语 tepung、air,动词;学习与工作\nms-0615,ms,ms-08,menambah,添加,Saya menambah garam ke dalam sup.,我往汤里加盐。,meN- + tambah → menambah，men-；t 脱落；词根 tambah；及物；常见宾语 air、garam,动词;学习与工作\nms-0616,ms,ms-08,memilih,挑选,Raju memilih makanan pada menu.,拉朱从菜单上挑选食物。,meN- + pilih → memilih，mem-；p 脱落；词根 pilih；及物；常见宾语 makanan、buku,动词;学习与工作\nms-0617,ms,ms-08,mencuba,尝试,Kami mencuba resipi baru itu.,我们尝试那个新食谱。,meN- + cuba → mencuba，men-；c 保留；词根 cuba；及物；常见宾语 resipi、makanan,动词;学习与工作\nms-0618,ms,ms-08,memegang,拿着；握着,Adik memegang gelas dengan dua tangan.,弟弟用两只手握着玻璃杯。,meN- + pegang → memegang，mem-；p 脱落；词根 pegang；及物；常见宾语 gelas、beg,动词;学习与工作\nms-0619,ms,ms-08,menjemput,邀请,Siti menjemput kami ke rumahnya.,西蒂邀请我们去她家。,meN- + jemput → menjemput，men-；j 保留；词根 jemput；及物；常见宾语 kawan、guru,动词;学习与工作\nms-0620,ms,ms-08,menghidang,端上；摆出食物,Ibu menghidang nasi dan kari.,母亲端上米饭和咖喱。,meN- + hidang → menghidang，meng-；h 保留；词根 hidang；及物；常见宾语 nasi、makanan,动词;学习与工作\nms-0621,ms,ms-08,menolak,拒绝,Ali tidak menolak bantuan kami.,阿里没有拒绝我们的帮助。,meN- + tolak → menolak，men-；t 脱落；词根 tolak；及物；常见宾语 bantuan、pesanan,动词;学习与工作\nms-0622,ms,ms-08,mengangkat,举起；搬起,Kami mengangkat meja bersama.,我们一起搬桌子。,meN- + angkat → mengangkat，meng-；元音 a 保留；词根 angkat；及物；常见宾语 meja、beg,动词;学习与工作\nms-0623,ms,ms-08,Tolong tutup pintu.,请帮忙关门。,Tolong tutup pintu.,请帮忙关门。,及物请求动词 tutup；宾语 pintu；祈使中用词根,动词;请求与计划;phrase\nms-0624,ms,ms-08,Silalah duduk.,请坐吧。,Silalah duduk.,请坐吧。,sila + -lah；duduk 不及物,动词;请求与计划;phrase\nms-0625,ms,ms-08,Saya belum boleh keluar.,我还不能出去。,Saya belum boleh keluar.,我还不能出去。,belum 在 boleh 前；keluar 不及物,动词;请求与计划;phrase\nms-0626,ms,ms-08,Kita mesti datang awal.,我们必须早到。,Kita mesti datang awal.,我们必须早到。,mesti 在动作前；datang 不及物,动词;请求与计划;phrase\nms-0627,ms,ms-08,Saya ingin memesan minuman.,我想点饮料。,Saya ingin memesan minuman.,我想点饮料。,meN- + pesan → memesan，p 脱落；宾语 minuman,动词;请求与计划;phrase\nms-0628,ms,ms-08,ringgit,令吉,Bil ini dua puluh ringgit.,这张账单是二十令吉。,量词 货币单位，本身作量词,名词;日常需求;补充\nms-0629,ms,ms-08,sen,仙；分币,Harga kuih ini lima puluh sen.,这块糕点的价格是五十仙。,量词 货币单位，本身作量词,名词;日常需求;英语借词;补充\nms-0630,ms,ms-08,pisau,刀,Pisau itu di atas meja dapur.,刀在厨房桌上。,量词 把用 bilah,名词;日常需求;补充\nms-0631,ms,ms-08,tisu,纸巾,Saya perlu tisu untuk tangan.,我需要纸巾擦手。,量词 张用 helai,名词;日常需求;英语借词;补充\nms-0632,ms,ms-08,duduk,坐,Sila duduk di sebelah saya.,请坐在我旁边。,不及物；地点由 di 引出,动词;日常需求;补充\nms-0633,ms,ms-08,buka,打开,Tolong buka tingkap itu.,请帮忙打开那扇窗。,及物；常见宾语 pintu、tingkap；祈使可用词根,动词;日常需求;补充\nms-0634,ms,ms-08,tutup,关上,Sila tutup pintu itu.,请关上那扇门。,及物；常见宾语 pintu、kedai；祈使用词根,动词;日常需求;补充\nms-0635,ms,ms-08,sebentar,一会儿,Sila tunggu sebentar di sini.,请在这里稍等。,表示短时间,副词;时间;补充\nms-0636,ms,ms-08,awal,早,Saya datang awal hari ini.,我今天来得早。,本课作时间副词,副词;时间;补充\nms-0637,ms,ms-08,segelas,一杯,Saya minta segelas air panas.,我要一杯热水。,se- + gelas，本课按完整数量表达记，不开放 se- 推导,量词;食物;补充\nms-0638,ms,ms-08,semangkuk,一碗,Ibu menghidang semangkuk sup.,母亲端上一碗汤。,se- + mangkuk，本课按完整数量表达记，不开放 se- 推导,量词;食物;补充\nms-0639,ms,ms-08,lapar,饿的,Saya lapar dan mahu makan.,我饿了，想吃饭。,形容词，后置,形容词;食物;补充\nms-0640,ms,ms-08,dahaga,渴的,Ali dahaga dan perlu air.,阿里渴了，需要水。,形容词，后置,形容词;食物;补充\nms-0641,ms,ms-09,membesarkan,扩大,Mereka membesarkan dapur rumah itu.,他们扩建那所房子的厨房。,meN- + besar + -kan → membesarkan，mem-，词根首字母保留；词根 besar；及物动词，常见宾语 dapur,动词;-kan 动词\nms-0642,ms,ms-09,menjalankan,开展,Guru menjalankan program membaca di sekolah.,老师在学校开展阅读活动。,meN- + jalan + -kan → menjalankan，men-，词根首字母保留；词根 jalan；及物动词，常见宾语 program,动词;-kan 动词\nms-0643,ms,ms-09,memasukkan,放入,Siti memasukkan buku ke dalam beg.,西蒂把书放进包里。,meN- + masuk + -kan → memasukkan，me-，词根首字母保留；词根 masuk；及物动词，常见宾语 buku；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0644,ms,ms-09,membelikan,替某人买,Ali membelikan ibunya satu helai baju.,阿里替母亲买了一件衣服。,meN- + beli + -kan → membelikan，mem-，词根首字母保留；词根 beli；及物动词，常见宾语 ibu、baju,动词;-kan 动词\nms-0645,ms,ms-09,membuatkan,替某人做,Ibu membuatkan adik sarapan.,母亲替弟弟做早餐。,meN- + buat + -kan → membuatkan，mem-，词根首字母保留；词根 buat；及物动词，常见宾语 adik、sarapan,动词;-kan 动词\nms-0646,ms,ms-09,memberikan,给予,Guru memberikan buku kepada saya.,老师把书给我。,meN- + beri + -kan → memberikan，mem-，词根首字母保留；词根 beri；及物动词，常见宾语 buku,动词;-kan 动词\nms-0647,ms,ms-09,mengatakan,说；表示,Ali mengatakan bahawa dia letih.,阿里说他累了。,meN- + kata + -kan → mengatakan，meng-，k 脱落；词根 kata；及物动词，常见宾语 bahawa 引出的内容,动词;-kan 动词\nms-0648,ms,ms-09,menggunakan,使用,Kami menggunakan komputer di perpustakaan.,我们在图书馆使用电脑。,meN- + guna + -kan → menggunakan，meng-，词根首字母保留；词根 guna；及物动词，常见宾语 komputer,动词;-kan 动词\nms-0649,ms,ms-09,menyediakan,准备；提供,Siti menyediakan makanan untuk kami.,西蒂为我们准备食物。,meN- + sedia + -kan → menyediakan，meny-，s 脱落；词根 sedia；及物动词，常见宾语 makanan,动词;-kan 动词\nms-0650,ms,ms-09,menjelaskan,解释,Guru menjelaskan soalan itu kepada pelajar.,老师向学生解释那道题。,meN- + jelas + -kan → menjelaskan，men-，词根首字母保留；词根 jelas；及物动词，常见宾语 soalan,动词;-kan 动词\nms-0651,ms,ms-09,menyebabkan,造成,Hujan menyebabkan jalan itu basah.,雨使那条路变湿了。,meN- + sebab + -kan → menyebabkan，meny-，s 脱落；词根 sebab；及物动词，常见宾语 jalan basah 等结果,动词;-kan 动词\nms-0652,ms,ms-09,mendapatkan,获得,Saya mendapatkan maklumat daripada guru.,我从老师那里获得信息。,meN- + dapat + -kan → mendapatkan，men-，词根首字母保留；词根 dapat；及物动词，常见宾语 maklumat,动词;-kan 动词\nms-0653,ms,ms-09,meletakkan,放置,Ali meletakkan cawan di atas meja.,阿里把杯子放在桌上。,meN- + letak + -kan → meletakkan，me-，词根首字母保留；词根 letak；及物动词，常见宾语 cawan；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0654,ms,ms-09,menghantarkan,送去,Saya menghantarkan makanan ke rumah Siti.,我把食物送到西蒂家。,meN- + hantar + -kan → menghantarkan，meng-，词根首字母保留；词根 hantar；及物动词，常见宾语 makanan,动词;-kan 动词\nms-0655,ms,ms-09,mengeluarkan,取出,Dia mengeluarkan wang dari beg.,他从包里取出钱。,meN- + keluar + -kan → mengeluarkan，meng-，k 脱落；词根 keluar；及物动词，常见宾语 wang,动词;-kan 动词\nms-0656,ms,ms-09,membersihkan,清洁,Kami membersihkan bilik sebelum kelas.,我们在上课前打扫房间。,meN- + bersih + -kan → membersihkan，mem-，词根首字母保留；词根 bersih；及物动词，常见宾语 bilik,动词;-kan 动词\nms-0657,ms,ms-09,mengeringkan,弄干,Ibu mengeringkan kain di luar rumah.,母亲在屋外晾干布。,meN- + kering + -kan → mengeringkan，meng-，k 脱落；词根 kering；及物动词，常见宾语 kain,动词;-kan 动词\nms-0658,ms,ms-09,memanaskan,加热,Siti memanaskan sup di dapur.,西蒂在厨房里热汤。,meN- + panas + -kan → memanaskan，mem-，p 脱落；词根 panas；及物动词，常见宾语 sup,动词;-kan 动词\nms-0659,ms,ms-09,menyejukkan,冷却,Saya menyejukkan air sebelum minum.,我把水放凉后再喝。,meN- + sejuk + -kan → menyejukkan，meny-，s 脱落；词根 sejuk；及物动词，常见宾语 air；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0660,ms,ms-09,memendekkan,缩短,Guru memendekkan waktu rehat hari ini.,老师今天缩短了休息时间。,meN- + pendek + -kan → memendekkan，mem-，p 脱落；词根 pendek；及物动词，常见宾语 waktu；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0661,ms,ms-09,memanjangkan,延长,Kami memanjangkan waktu membaca.,我们延长阅读时间。,meN- + panjang + -kan → memanjangkan，mem-，p 脱落；词根 panjang；及物动词，常见宾语 waktu,动词;-kan 动词\nms-0662,ms,ms-09,menghabiskan,用完；吃完,Adik menghabiskan nasi di dalam mangkuk.,弟弟吃完碗里的饭。,meN- + habis + -kan → menghabiskan，meng-，词根首字母保留；词根 habis；及物动词，常见宾语 nasi,动词;-kan 动词\nms-0663,ms,ms-09,menyampaikan,传达,Guru menyampaikan pesanan kepada ibu.,老师向母亲传达消息。,meN- + sampai + -kan → menyampaikan，meny-，s 脱落；词根 sampai；及物动词，常见宾语 pesanan,动词;-kan 动词\nms-0664,ms,ms-09,menunjukkan,指给看,Ali menunjukkan alamat itu kepada saya.,阿里把那个地址指给我看。,meN- + tunjuk + -kan → menunjukkan，men-，t 脱落；词根 tunjuk；及物动词，常见宾语 alamat；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0665,ms,ms-09,mengingatkan,提醒,Ibu mengingatkan saya tentang janji itu.,母亲提醒我那次约定。,meN- + ingat + -kan → mengingatkan，meng-，词根首字母保留；词根 ingat；及物动词，常见宾语 saya、janji,动词;-kan 动词\nms-0666,ms,ms-09,menyimpankan,留存,Saya menyimpankan wang untuk adik.,我替弟弟存钱。,meN- + simpan + -kan → menyimpankan，meny-，s 脱落；词根 simpan；及物动词，常见宾语 wang,动词;-kan 动词\nms-0667,ms,ms-09,menerangkan,说明,Guru menerangkan maksud perkataan itu.,老师说明那个词的意思。,meN- + terang + -kan → menerangkan，men-，t 脱落；词根 terang；及物动词，常见宾语 maksud,动词;-kan 动词\nms-0668,ms,ms-09,menyelesaikan,完成；解决,Kami menyelesaikan tugas sebelum petang.,我们在下午前完成任务。,meN- + selesai + -kan → menyelesaikan，meny-，s 脱落；词根 selesai；及物动词，常见宾语 tugas,动词;-kan 动词\nms-0669,ms,ms-09,menukarkan,更换,Dia menukarkan wang di bank.,他在银行兑换钱。,meN- + tukar + -kan → menukarkan，men-，t 脱落；词根 tukar；及物动词，常见宾语 wang,动词;-kan 动词\nms-0670,ms,ms-09,memulangkan,归还,Saya memulangkan buku kepada Ali.,我把书还给阿里。,meN- + pulang + -kan → memulangkan，mem-，p 脱落；词根 pulang；及物动词，常见宾语 buku,动词;-kan 动词\nms-0671,ms,ms-09,maklumat,信息,Maklumat ini ada di dalam buku.,这条信息在书里。,一般不用量词,名词;日常事务\nms-0672,ms,ms-09,alamat,地址,Saya menulis alamat sekolah pada sampul.,我把学校地址写在信封上。,一般不用量词,名词;日常事务\nms-0673,ms,ms-09,janji,约定,Saya ada janji dengan Siti esok.,我明天和西蒂有约。,一般不用量词,名词;日常事务\nms-0674,ms,ms-09,tugas,任务,Tugas saya ialah membersihkan kelas.,我的任务是打扫教室。,一般不用量词,名词;日常事务\nms-0675,ms,ms-09,hadiah,礼物,Ali memberikan hadiah kepada ibunya.,阿里给母亲礼物。,量词 buah,名词;日常事务\nms-0676,ms,ms-09,kotak,盒子,Kotak kecil itu untuk hadiah ibu.,那个小盒子用来装母亲的礼物。,量词 buah,名词;日常事务\nms-0677,ms,ms-09,bakul,篮子,Siti memasukkan sayur ke dalam bakul.,西蒂把蔬菜放进篮子里。,量词 buah,名词;日常事务\nms-0678,ms,ms-09,dulang,托盘,Ibu meletakkan cawan di atas dulang.,母亲把杯子放到托盘上。,量词 buah,名词;日常事务\nms-0679,ms,ms-09,bekas,容器,Bekas makanan itu bersih dan kering.,那个食品容器干净又干燥。,量词 buah,名词;日常事务\nms-0680,ms,ms-09,kunci,钥匙,Kunci rumah ada di dalam beg saya.,家门钥匙在我的包里。,量词 batang,名词;日常事务\nms-0681,ms,ms-09,rak,架子,Ali menyusun buku di atas rak.,阿里把书摆在架子上。,量词 buah,名词;日常事务\nms-0682,ms,ms-09,laci,抽屉,Pen saya ada di dalam laci meja.,我的笔在书桌抽屉里。,量词 buah,名词;日常事务\nms-0683,ms,ms-09,tuala,毛巾,Saya membeli satu helai tuala biru.,我买了一条蓝毛巾。,量词 helai,名词;日常事务\nms-0684,ms,ms-09,selimut,毯子,Adik tidur dengan selimut merah.,弟弟盖着红毯子睡觉。,量词 helai,名词;日常事务\nms-0685,ms,ms-09,cadar,床单,Ibu mencuci cadar pada pagi ini.,母亲今天早晨洗床单。,量词 helai,名词;日常事务\nms-0686,ms,ms-09,cermin,镜子,Cermin itu di sebelah tingkap.,那面镜子在窗户旁边。,量词 keping,名词;日常事务\nms-0687,ms,ms-09,tali,绳子,Tali ini panjang dan basah.,这根绳子又长又湿。,量词 utas,名词;日常事务\nms-0688,ms,ms-09,plastik,塑料,Bekas ini daripada plastik.,这个容器是塑料做的。,一般不用量词；数量按物品计,名词;日常事务\nms-0689,ms,ms-09,kaca,玻璃,Cawan ini daripada kaca.,这个杯子是玻璃做的。,一般不用量词；片状可用 keping,名词;日常事务\nms-0690,ms,ms-09,kayu,木材,Meja itu daripada kayu.,那张桌子是木制的。,量词 batang（长条）,名词;日常事务\nms-0691,ms,ms-09,alat,工具,Bapa menyimpan alat di dalam kotak.,父亲把工具放在盒子里。,量词 buah,名词;日常事务\nms-0692,ms,ms-09,bahan,材料,Kami menyediakan bahan untuk projek sekolah.,我们准备学校项目所需的材料。,一般不用量词,名词;日常事务\nms-0693,ms,ms-09,tujuan,目的,Tujuan program ini ialah belajar bersama.,这个活动的目的是一起学习。,一般不用量词,名词;日常事务\nms-0694,ms,ms-09,hasil,成果,Hasil projek itu sangat baik.,那个项目的成果很好。,一般不用量词,名词;日常事务\nms-0695,ms,ms-09,masalah,问题；困难,Kami menjelaskan masalah itu kepada guru.,我们向老师说明那个问题。,一般不用量词,名词;日常事务\nms-0696,ms,ms-09,bahawa,（引出陈述内容）,Siti mengatakan bahawa dia akan datang.,西蒂说她会来。,引出内容从句,连词;连接与程度\nms-0697,ms,ms-09,supaya,以便,Saya membuka tingkap supaya bilik sejuk.,我打开窗户，让房间凉快。,引出目的,连词;连接与程度\nms-0698,ms,ms-09,jika,如果,\"Jika hujan, kita belajar di rumah.\",如果下雨，我们就在家学习。,引出条件,连词;连接与程度\nms-0699,ms,ms-09,hampir,几乎,Saya hampir menghabiskan nasi itu.,我快吃完那些饭了。,放在动词前,副词;连接与程度\nms-0700,ms,ms-09,semula,重新,Ali membaca surat itu semula.,阿里重新读那封信。,常放在动词或宾语后,副词;连接与程度\nms-0701,ms,ms-09,Sila masukkan buku ke dalam beg.,请把书放进包里。,Sila masukkan buku ke dalam beg.,请把书放进包里。,整句识别；请求句保留 -kan,动词;句型;phrase\nms-0702,ms,ms-09,Tolong jelaskan soalan ini.,请解释这道题。,Tolong jelaskan soalan ini.,请解释这道题。,整句识别；请求句保留 -kan,动词;句型;phrase\nms-0703,ms,ms-09,Saya akan memulangkan buku esok.,我明天会还书。,Saya akan memulangkan buku esok.,我明天会还书。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0704,ms,ms-09,Ibu membelikan saya kasut baru.,母亲替我买了新鞋。,Ibu membelikan saya kasut baru.,母亲替我买了新鞋。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0705,ms,ms-09,Kami menyediakan makanan bersama.,我们一起准备食物。,Kami menyediakan makanan bersama.,我们一起准备食物。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0706,ms,ms-09,maksud,意思,Maksud perkataan ini jelas.,这个词的意思很清楚。,一般不用量词,名词;日常事务;补充\nms-0707,ms,ms-09,perkataan,词,Saya menulis perkataan baru di dalam buku.,我把新词写在本子里。,一般不用量词,名词;日常事务;补充\nms-0708,ms,ms-09,langkah,步骤,Guru menerangkan langkah pertama kepada kami.,老师向我们说明第一步。,一般不用量词,名词;日常事务;补充\nms-0709,ms,ms-09,contoh,例子,Guru memberikan contoh yang baik.,老师给出一个好例子。,一般不用量词,名词;日常事务;补充\nms-0710,ms,ms-09,sebab,原因,Sebab Ali belum datang ialah hujan.,阿里还没来的原因是下雨。,一般不用量词,名词;日常事务;补充\nms-0711,ms,ms-09,jelas,清楚,Alamat pada surat ini jelas.,这封信上的地址很清楚。,形容词，后置,形容词;日常事务;补充\nms-0712,ms,ms-09,penting,重要,Maklumat ini sangat penting untuk kita.,这个信息对我们很重要。,形容词，后置,形容词;日常事务;补充\nms-0713,ms,ms-09,mudah,容易,Tugas ini mudah bagi saya.,这项任务对我来说很容易。,形容词，后置,形容词;日常事务;补充\nms-0714,ms,ms-09,sukar,困难,Soalan itu sukar bagi adik.,那道题对弟弟来说很难。,形容词，后置,形容词;日常事务;补充\nms-0715,ms,ms-09,penuh,满,Bakul itu penuh dengan sayur.,那个篮子里装满了蔬菜。,形容词，后置,形容词;日常事务;补充\nms-0716,ms,ms-09,kosong,空,Kotak kosong itu di bawah meja.,那个空盒子在桌子下面。,形容词，后置,形容词;日常事务;补充\nms-0717,ms,ms-09,ringan,轻,Beg kecil ini sangat ringan.,这个小包很轻。,形容词，后置,形容词;日常事务;补充\nms-0718,ms,ms-09,berat,重,Kotak buku itu berat sekali.,那个装书的盒子很重。,形容词，后置,形容词;日常事务;补充\nms-0719,ms,ms-09,selamat,安全,Jalan ini selamat untuk kita.,这条路对我们来说是安全的。,形容词，后置,形容词;日常事务;补充\nms-0720,ms,ms-09,senang hati,高兴；开心,Ibu senang hati menerima hadiah itu.,母亲高兴地收下那份礼物。,形容词，后置；马来西亚 senang 单用多指「容易」，表示高兴要说 senang hati；印尼语 senang 单用即表示高兴,形容词;日常事务;补充\nms-0721,ms,ms-10,mengunjungi,拜访；参观,Kami mengunjungi muzium di Melaka.,我们参观马六甲的博物馆。,meN- + kunjung + -i → mengunjungi，meng-，k 脱落；词根 kunjung；及物动词，常见宾语 muzium,动词;-i 动词\nms-0722,ms,ms-10,memasuki,进入,Pelajar memasuki kelas pada pukul lapan.,学生们八点进入教室。,meN- + masuk + -i → memasuki，me-，词根首字母保留；词根 masuk；及物动词，常见宾语 kelas,动词;-i 动词\nms-0723,ms,ms-10,menaiki,登上；乘坐,Saya menaiki bas ke bandar.,我乘公共汽车去城里。,meN- + naik + -i → menaiki，me-，词根首字母保留；词根 naik；及物动词，常见宾语 bas,动词;-i 动词\nms-0724,ms,ms-10,menyukai,喜欢,Adik menyukai buku cerita ini.,弟弟喜欢这本故事书。,meN- + suka + -i → menyukai，meny-，s 脱落；词根 suka；及物动词，常见宾语 buku,动词;-i 动词\nms-0725,ms,ms-10,mencintai,爱,Kami mencintai negara Malaysia.,我们爱马来西亚这个国家。,meN- + cinta + -i → mencintai，men-，词根首字母保留；词根 cinta；及物动词，常见宾语 negara,动词;-i 动词\nms-0726,ms,ms-10,menghadiri,出席,Ibu menghadiri mesyuarat di sekolah.,母亲出席学校的会议。,meN- + hadir + -i → menghadiri，meng-，词根首字母保留；词根 hadir；及物动词，常见宾语 mesyuarat,动词;-i 动词\nms-0727,ms,ms-10,mengikuti,跟随；参加,Saya mengikuti kelas bahasa Melayu.,我参加马来语课。,meN- + ikut + -i → mengikuti，meng-，词根首字母保留；词根 ikut；及物动词，常见宾语 kelas,动词;-i 动词\nms-0728,ms,ms-10,menyertai,参加,Ali menyertai lawatan ke Pulau Pinang.,阿里参加去槟城的参观活动。,meN- + serta + -i → menyertai，meny-，s 脱落；词根 serta；及物动词，常见宾语 lawatan,动词;-i 动词\nms-0729,ms,ms-10,memiliki,拥有,Siti memiliki sebuah basikal merah.,西蒂拥有一辆红自行车。,meN- + milik + -i → memiliki，me-，词根首字母保留；词根 milik；及物动词，常见宾语 basikal,动词;-i 动词\nms-0730,ms,ms-10,mengetahui,知道,Guru mengetahui alamat rumah saya.,老师知道我家的地址。,meN- + tahu + -i → mengetahui；词根 tahu；特殊形式，整词记忆；常见宾语 alamat,动词;-i 动词\nms-0731,ms,ms-10,menghormati,尊重,Kita mesti menghormati guru dan ibu bapa.,我们必须尊重老师和父母。,meN- + hormat + -i → menghormati，meng-，词根首字母保留；词根 hormat；及物动词，常见宾语 guru,动词;-i 动词\nms-0732,ms,ms-10,menikmati,享受,Mereka menikmati makanan di restoran itu.,他们在那家餐馆享用美食。,meN- + nikmat + -i → menikmati，me-，词根首字母保留；词根 nikmat；及物动词，常见宾语 makanan,动词;-i 动词\nms-0733,ms,ms-10,melayani,对待；接待,Ali melayani tetamu dengan baik.,阿里好好地招待客人。,meN- + layan + -i → melayani，me-，词根首字母保留；词根 layan；及物动词，常见宾语 tetamu,动词;-i 动词\nms-0734,ms,ms-10,mengakhiri,结束,Guru mengakhiri kelas pada pukul lima.,老师五点结束课程。,meN- + akhir + -i → mengakhiri，meng-，词根首字母保留；词根 akhir；及物动词，常见宾语 kelas,动词;-i 动词\nms-0735,ms,ms-10,mengulangi,重复,Saya mengulangi perkataan itu dengan jelas.,我清楚地重复那个词。,meN- + ulang + -i → mengulangi，meng-，词根首字母保留；词根 ulang；及物动词，常见宾语 perkataan,动词;-i 动词\nms-0736,ms,ms-10,mengatasi,克服；解决,Kami mengatasi masalah itu bersama.,我们一起解决那个问题。,meN- + atas + -i → mengatasi，meng-，词根首字母保留；词根 atas；及物动词，常见宾语 masalah,动词;-i 动词\nms-0737,ms,ms-10,mendekati,靠近,Jangan mendekati sungai yang dalam.,不要靠近水深的河流。,meN- + dekat + -i → mendekati，men-，词根首字母保留；词根 dekat；及物动词，常见宾语 sungai,动词;-i 动词\nms-0738,ms,ms-10,menghubungi,联系,Saya menghubungi kakak dengan telefon.,我用电话联系姐姐。,meN- + hubung + -i → menghubungi，meng-，词根首字母保留；词根 hubung；及物动词，常见宾语 kakak,动词;-i 动词\nms-0739,ms,ms-10,menemani,陪伴,Siti menemani ibunya ke pasar.,西蒂陪母亲去市场。,meN- + teman + -i → menemani，men-，t 脱落；词根 teman；及物动词，常见宾语 ibu,动词;-i 动词\nms-0740,ms,ms-10,merawati,照料,Jururawat merawati adik di hospital.,护士在医院照料弟弟。,meN- + rawat + -i → merawati，me-，词根首字母保留；词根 rawat；及物动词，常见宾语 adik,动词;-i 动词\nms-0741,ms,ms-10,mengubati,医治,Doktor mengubati orang yang sakit.,医生医治病人。,meN- + ubat + -i → mengubati，meng-，词根首字母保留；词根 ubat；及物动词，常见宾语 orang sakit,动词;-i 动词\nms-0742,ms,ms-10,melindungi,保护,Payung ini melindungi kita daripada hujan.,这把伞保护我们不受雨淋。,meN- + lindung + -i → melindungi，me-，词根首字母保留；词根 lindung；及物动词，常见宾语 kita,动词;-i 动词\nms-0743,ms,ms-10,melengkapi,补全,Pelajar melengkapi nota dengan contoh.,学生用例子补全笔记。,meN- + lengkap + -i → melengkapi，me-，词根首字母保留；词根 lengkap；及物动词，常见宾语 nota,动词;-i 动词\nms-0744,ms,ms-10,menyelidiki,调查研究,Pelajar menyelidiki sejarah bandar itu.,学生研究那座城市的历史。,meN- + selidik + -i → menyelidiki，meny-，s 脱落；词根 selidik；及物动词，常见宾语 sejarah,动词;-i 动词\nms-0745,ms,ms-10,menguasai,掌握,Saya mahu menguasai bahasa Melayu.,我想掌握马来语。,meN- + kuasa + -i → menguasai，meng-，k 脱落；词根 kuasa；及物动词，常见宾语 bahasa,动词;-i 动词\nms-0746,ms,ms-10,mendatangkan,带来,Program itu mendatangkan hasil yang baik.,那个活动带来良好的成果。,meN- + datang + -kan → mendatangkan，men-，词根首字母保留；词根 datang；及物动词，常见宾语 hasil,动词;-kan／-i 对比\nms-0747,ms,ms-10,menjauhkan,使远离,Ibu menjauhkan adik daripada sungai.,母亲让弟弟远离河流。,meN- + jauh + -kan → menjauhkan，men-，词根首字母保留；词根 jauh；及物动词，常见宾语 adik,动词;-kan／-i 对比\nms-0748,ms,ms-10,menempatkan,安置,Guru menempatkan pelajar di bilik baru.,老师把学生安置在新房间。,meN- + tempat + -kan → menempatkan，men-，t 脱落；词根 tempat；及物动词，常见宾语 pelajar,动词;-kan／-i 对比\nms-0749,ms,ms-10,menghadiahkan,赠送（物品）,Ali menghadiahkan buku kepada Siti.,阿里把书赠给西蒂。,meN- + hadiah + -kan → menghadiahkan，meng-，词根首字母保留；词根 hadiah；及物动词，常见宾语 buku,动词;-kan／-i 对比\nms-0750,ms,ms-10,menyiramkan,浇洒（液体）,Ibu menyiramkan air pada pokok bunga.,母亲把水浇在花木上。,meN- + siram + -kan → menyiramkan，meny-，s 脱落；词根 siram；及物动词，常见宾语 air,动词;-kan／-i 对比\nms-0751,ms,ms-10,mendatangi,来到；登门拜访,Mereka mendatangi rumah Ali untuk bertemu dengannya.,他们到阿里家去见他。,meN- + datang + -i → mendatangi，men-，词根首字母保留；词根 datang；及物动词，常见宾语 rumah,动词;-kan／-i 对比\nms-0752,ms,ms-10,menjauhi,避开；远离,Kita mesti menjauhi sungai itu.,我们必须远离那条河。,meN- + jauh + -i → menjauhi，men-，词根首字母保留；词根 jauh；及物动词，常见宾语 sungai,动词;-kan／-i 对比\nms-0753,ms,ms-10,menempati,占用；居住于,Kami menempati bilik di tingkat dua.,我们住在二楼的房间。,meN- + tempat + -i → menempati，men-，t 脱落；词根 tempat；及物动词，常见宾语 bilik,动词;-kan／-i 对比\nms-0754,ms,ms-10,menghadiahi,赠给（某人）,Ali menghadiahi Siti sebuah buku.,阿里赠给西蒂一本书。,meN- + hadiah + -i → menghadiahi，meng-，词根首字母保留；词根 hadiah；及物动词，常见宾语 Siti,动词;-kan／-i 对比\nms-0755,ms,ms-10,menyirami,浇灌（植物）,Ibu menyirami pokok bunga di kebun.,母亲浇灌园圃里的花木。,meN- + siram + -i → menyirami，meny-，s 脱落；词根 siram；及物动词，常见宾语 pokok,动词;-kan／-i 对比\nms-0756,ms,ms-10,negara,国家,Malaysia ialah negara saya.,马来西亚是我的国家。,量词 buah,名词;参观与联系\nms-0757,ms,ms-10,mesyuarat,会议,Mesyuarat itu pada hari Jumaat.,那场会议在星期五。,一般不用量词,名词;参观与联系\nms-0758,ms,ms-10,lawatan,参观；访问,Lawatan ke Melaka itu pada minggu depan.,去马六甲的参观活动在下周。,一般不用量词,名词;参观与联系\nms-0759,ms,ms-10,tetamu,客人,Kami menyediakan makanan untuk tetamu.,我们为客人准备食物。,量词 orang,名词;参观与联系\nms-0760,ms,ms-10,sungai,河流,Sungai itu dekat dengan kampung kami.,那条河靠近我们的村子。,量词 batang,名词;参观与联系\nms-0761,ms,ms-10,sejarah,历史,Saya membaca buku tentang sejarah Malaysia.,我读关于马来西亚历史的书。,一般不用量词,名词;参观与联系\nms-0762,ms,ms-10,tingkat,楼层,Bilik kami di tingkat tiga.,我们的房间在三楼。,一般不用量词,名词;参观与联系\nms-0763,ms,ms-10,tangga,楼梯,Tangga itu di sebelah pintu.,楼梯在门旁边。,量词 buah,名词;参观与联系\nms-0764,ms,ms-10,pantai,海滩,Mereka berjalan di pantai pada petang itu.,他们那天下午在海滩散步。,一般不用量词,名词;参观与联系\nms-0765,ms,ms-10,pulau,岛屿,Pulau itu kecil dan cantik.,那个岛又小又漂亮。,量词 buah,名词;参观与联系\nms-0766,ms,ms-10,bukit,小山,Kami melihat bukit dari tingkap hotel.,我们从酒店窗户看小山。,量词 buah,名词;参观与联系\nms-0767,ms,ms-10,gunung,山；高山,Gunung itu jauh dari bandar.,那座山远离城市。,量词 buah,名词;参观与联系\nms-0768,ms,ms-10,hutan,森林,Hutan itu dekat dengan sungai.,那片森林靠近河流。,一般不用量词,名词;参观与联系\nms-0769,ms,ms-10,ladang,农场,Petani bekerja di ladang pada pagi ini.,农民今天早晨在农场工作。,量词 buah,名词;参观与联系\nms-0770,ms,ms-10,kebun,园圃,Ibu menanam bunga di kebun.,母亲在园圃里种花。,量词 buah,名词;参观与联系\nms-0771,ms,ms-10,pokok,树,Ada pokok besar di depan rumah.,房子前面有棵大树。,量词 batang,名词;参观与联系\nms-0772,ms,ms-10,daun,叶子,Daun itu jatuh di atas meja.,那片叶子落在桌上。,量词 helai,名词;参观与联系\nms-0773,ms,ms-10,akar,根,Akar pokok itu panjang.,那棵树的根很长。,一般不用量词,名词;参观与联系\nms-0774,ms,ms-10,tanah,土壤,Tanah di kebun itu basah.,园圃里的土壤是湿的。,一般不用量词,名词;参观与联系\nms-0775,ms,ms-10,pasir,沙,Pasir di pantai itu panas.,海滩上的沙很热。,一般不用量词,名词;参观与联系\nms-0776,ms,ms-10,angin,风,Angin di pantai itu sejuk.,海滩上的风很凉爽。,一般不用量词,名词;参观与联系\nms-0777,ms,ms-10,cuaca,天气,Cuaca hari ini baik untuk lawatan.,今天的天气适合参观。,一般不用量词,名词;参观与联系\nms-0778,ms,ms-10,pengalaman,经历,Saya menulis tentang pengalaman di Melaka.,我写在马六甲的经历。,一般不用量词；整词学习,名词;参观与联系\nms-0779,ms,ms-10,peluang,机会,Kami ada peluang untuk bertemu dengan guru.,我们有机会和老师见面。,一般不用量词,名词;参观与联系\nms-0780,ms,ms-10,rancangan,计划,Rancangan kami ialah mengunjungi muzium esok.,我们的计划是明天参观博物馆。,一般不用量词；整词学习,名词;参观与联系\nms-0781,ms,ms-10,Saya ingin menyertai lawatan ini.,我想参加这次参观活动。,Saya ingin menyertai lawatan ini.,我想参加这次参观活动。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0782,ms,ms-10,Sila hubungi saya esok.,请明天联系我。,Sila hubungi saya esok.,请明天联系我。,整句识别；请求句保留 -i,动词;句型;phrase\nms-0783,ms,ms-10,Kami akan menghadiri mesyuarat itu.,我们会出席那场会议。,Kami akan menghadiri mesyuarat itu.,我们会出席那场会议。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0784,ms,ms-10,Ali menghadiahi ibunya satu helai baju.,阿里送给母亲一件衣服。,Ali menghadiahi ibunya satu helai baju.,阿里送给母亲一件衣服。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0785,ms,ms-10,Jangan menjauhi kawan tanpa sebab.,不要无缘无故疏远朋友。,Jangan menjauhi kawan tanpa sebab.,不要无缘无故疏远朋友。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0786,ms,ms-10,cara,方法,Cara ini mudah untuk pelajar baru.,这个方法对新学生来说很容易。,一般不用量词,名词;参观与联系;补充\nms-0787,ms,ms-10,tempat,地方,Tempat itu dekat dengan muzium.,那个地方靠近博物馆。,一般不用量词,名词;参观与联系;补充\nms-0788,ms,ms-10,masa,时间,Kami perlu masa untuk membaca buku ini.,我们需要时间读这本书。,一般不用量词,名词;参观与联系;补充\nms-0789,ms,ms-10,catatan,记录,Saya menulis catatan tentang lawatan itu.,我写下那次参观的记录。,一般不用量词；整词学习,名词;参观与联系;补充\nms-0790,ms,ms-10,sakit,生病的；痛的,Adik sakit dan perlu berehat di rumah.,弟弟病了，需要在家休息。,形容词，后置,形容词;参观与联系;补充\nms-0791,ms,ms-10,gembira,快乐,Kami gembira dapat bertemu dengan Siti.,我们很高兴能见到西蒂。,形容词，后置,形容词;参观与联系;补充\nms-0792,ms,ms-10,tenang,平静,Tempat ini tenang pada waktu pagi.,这个地方早晨很安静。,形容词，后置,形容词;参观与联系;补充\nms-0793,ms,ms-10,indah,美丽,Pantai di pulau itu sangat indah.,那个岛上的海滩很美。,形容词，后置,形容词;参观与联系;补充\nms-0794,ms,ms-10,sibuk,忙碌,Guru sibuk menyediakan bahan untuk kelas.,老师忙着准备上课材料。,形容词，后置,形容词;参观与联系;补充\nms-0795,ms,ms-10,perlahan,慢慢地,Ali berjalan dengan perlahan di tangga.,阿里在楼梯上慢慢走。,常用 dengan perlahan,副词;参观与联系;补充\nms-0796,ms,ms-10,menanam,种植,Ibu menanam pokok di kebun.,母亲在园圃里种树。,meN- + tanam → menanam，men-，t 脱落；词根 tanam；及物动词，常见宾语 pokok,动词;参观与联系;补充\nms-0797,ms,ms-10,jatuh,落下；跌倒,Daun itu jatuh ke dalam sungai.,那片叶子落进河里。,不及物动词；词根 jatuh,动词;参观与联系;补充\nms-0798,ms,ms-10,walaupun,虽然,\"Walaupun hujan, kami masih pergi ke muzium.\",虽然下雨，我们仍去博物馆。,引出让步,连词;参观与联系;补充\nms-0799,ms,ms-10,manakala,而（对照）,Ali membaca manakala Siti menulis nota.,阿里阅读，而西蒂记笔记。,连接对照内容,连词;参观与联系;补充\nms-0800,ms,ms-10,sama ada,是否；是……还是,Saya belum tahu sama ada Ali akan datang.,我还不知道阿里是否会来。,引出尚未确定的情况,连词;参观与联系;补充\nms-0801,ms,ms-11,dibaca,被阅读,Buku itu dibaca oleh Ali.,那本书由阿里阅读。,di- + baca；词根 baca；主动形 membaca；及物动词的被动形，常见宾语 buku 在被动句中作主语,动词;di- 被动\nms-0802,ms,ms-11,ditulis,被书写,Surat itu ditulis oleh Siti.,那封信由西蒂书写。,di- + tulis；词根 tulis；主动形 menulis；及物动词的被动形，常见宾语 surat 在被动句中作主语,动词;di- 被动\nms-0803,ms,ms-11,dibuka,被打开,Pintu perpustakaan dibuka pada pukul lapan.,图书馆的门八点打开。,di- + buka；词根 buka；主动形 membuka；及物动词的被动形，常见宾语 pintu 在被动句中作主语,动词;di- 被动\nms-0804,ms,ms-11,ditutup,被关闭,Tingkap itu ditutup oleh guru.,那扇窗由老师关上。,di- + tutup；词根 tutup；主动形 menutup；及物动词的被动形，常见宾语 tingkap 在被动句中作主语,动词;di- 被动\nms-0805,ms,ms-11,dibeli,被购买,Beras itu dibeli oleh ibu.,那些米由母亲购买。,di- + beli；词根 beli；主动形 membeli；及物动词的被动形，常见宾语 beras 在被动句中作主语,动词;di- 被动\nms-0806,ms,ms-11,dijual,被出售,Makanan ini dijual di pasar.,这些食物在市场上出售。,di- + jual；词根 jual；主动形 menjual；及物动词的被动形，常见宾语 makanan 在被动句中作主语,动词;di- 被动\nms-0807,ms,ms-11,dihantar,被送去,Surat itu dihantar ke pejabat semalam.,那封信昨天被送到办公室。,di- + hantar；词根 hantar；主动形 menghantar；及物动词的被动形，常见宾语 surat 在被动句中作主语,动词;di- 被动\nms-0808,ms,ms-11,dipilih,被选中,Buku ini dipilih oleh para pelajar.,这本书由学生们选中。,di- + pilih；词根 pilih；主动形 memilih；及物动词的被动形，常见宾语 buku 在被动句中作主语,动词;di- 被动\nms-0809,ms,ms-11,dibawa,被携带,Kotak itu dibawa ke dalam kelas.,那个盒子被搬进教室。,di- + bawa；词根 bawa；主动形 membawa；及物动词的被动形，常见宾语 kotak 在被动句中作主语,动词;di- 被动\nms-0810,ms,ms-11,disimpan,被存放,Alat itu disimpan di dalam almari.,那个工具存放在柜子里。,di- + simpan；词根 simpan；主动形 menyimpan；及物动词的被动形，常见宾语 alat 在被动句中作主语,动词;di- 被动\nms-0811,ms,ms-11,diberikan,被给予,Hadiah itu diberikan kepada Raju.,那份礼物给了拉朱。,di- + beri + -kan；词根 beri；主动形 memberikan；及物动词的被动形，常见宾语 hadiah 在被动句中作主语,动词;di- 被动\nms-0812,ms,ms-11,digunakan,被使用,Bilik itu digunakan untuk mesyuarat.,那个房间用于开会。,di- + guna + -kan；词根 guna；主动形 menggunakan；及物动词的被动形，常见宾语 bilik 在被动句中作主语,动词;di- 被动\nms-0813,ms,ms-11,disediakan,被准备；被提供,Makanan disediakan oleh Siti pada pagi ini.,食物今天早晨由西蒂准备。,di- + sedia + -kan；词根 sedia；主动形 menyediakan；及物动词的被动形，常见宾语 makanan 在被动句中作主语,动词;di- 被动\nms-0814,ms,ms-11,dijelaskan,被解释,Tujuan program dijelaskan oleh guru.,活动目的由老师解释。,di- + jelas + -kan；词根 jelas；主动形 menjelaskan；及物动词的被动形，常见宾语 tujuan 在被动句中作主语,动词;di- 被动\nms-0815,ms,ms-11,dibersihkan,被清洁,Dewan itu dibersihkan sebelum mesyuarat.,礼堂在会议前被打扫。,di- + bersih + -kan；词根 bersih；主动形 membersihkan；及物动词的被动形，常见宾语 dewan 在被动句中作主语,动词;di- 被动\nms-0816,ms,ms-11,diletakkan,被放置,Notis diletakkan di sebelah pintu.,通知贴放在门旁边。,di- + letak + -kan；词根 letak；主动形 meletakkan；及物动词的被动形，常见宾语 notis 在被动句中作主语,动词;di- 被动\nms-0817,ms,ms-11,dimasukkan,被放入,Borang itu dimasukkan ke dalam kotak.,那张表格被放进盒子里。,di- + masuk + -kan；词根 masuk；主动形 memasukkan；及物动词的被动形，常见宾语 borang 在被动句中作主语,动词;di- 被动\nms-0818,ms,ms-11,dikunjungi,被参观；被拜访,Muzium ini dikunjungi oleh pelajar sekolah.,这座博物馆有学校的学生来参观。,di- + kunjung + -i；词根 kunjung；主动形 mengunjungi；及物动词的被动形，常见宾语 muzium 在被动句中作主语,动词;di- 被动\nms-0819,ms,ms-11,dihadiri,被出席,Mesyuarat itu dihadiri oleh penduduk kampung.,那场会议有村民出席。,di- + hadir + -i；词根 hadir；主动形 menghadiri；及物动词的被动形，常见宾语 mesyuarat 在被动句中作主语,动词;di- 被动\nms-0820,ms,ms-11,diikuti,被参加；被跟随,Program itu diikuti oleh ramai pelajar.,那个活动有许多学生参加。,di- + ikut + -i；词根 ikut；主动形 mengikuti；及物动词的被动形，常见宾语 program 在被动句中作主语,动词;di- 被动\nms-0821,ms,ms-11,dewan,礼堂；大厅,Mesyuarat itu diadakan di dewan sekolah.,那场会议在学校礼堂举行。,量词 buah,名词;新闻与公共事务\nms-0822,ms,ms-11,notis,通知,Notis itu dibaca oleh semua guru.,所有老师都读了那则通知。,一般不用量词,名词;新闻与公共事务\nms-0823,ms,ms-11,penduduk,居民,Penduduk kampung berkumpul di dewan.,村民聚集在礼堂里。,量词 orang；整词学习,名词;新闻与公共事务\nms-0824,ms,ms-11,kerajaan,政府,Kerajaan menyediakan bantuan untuk sekolah.,政府为学校提供帮助。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0825,ms,ms-11,pegawai,官员；职员,Pegawai itu sedang membaca laporan.,那名职员正在读报告。,量词 orang；整词学习,名词;新闻与公共事务\nms-0826,ms,ms-11,menteri,部长,Menteri itu mengunjungi sekolah kami.,那位部长访问我们的学校。,量词 orang,名词;新闻与公共事务\nms-0827,ms,ms-11,ketua,负责人；领队,Ketua program memberikan maklumat kepada kami.,活动负责人向我们提供信息。,量词 orang,名词;新闻与公共事务\nms-0828,ms,ms-11,ahli,成员,Ahli kelab menghadiri mesyuarat petang ini.,俱乐部成员今天下午出席会议。,量词 orang,名词;新闻与公共事务\nms-0829,ms,ms-11,jawatankuasa,委员会,Jawatankuasa sekolah akan mengadakan mesyuarat esok.,学校委员会明天将召开会议。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0830,ms,ms-11,masyarakat,社会；社群,Program ini untuk masyarakat di bandar itu.,这个活动面向那座城市的社群。,一般不用量词,名词;新闻与公共事务\nms-0831,ms,ms-11,orang ramai,公众,Perpustakaan ini dibuka kepada orang ramai.,这座图书馆向公众开放。,一般不用量词；集合称呼,名词;新闻与公共事务\nms-0832,ms,ms-11,kesihatan,健康,Program kesihatan itu diadakan di klinik.,那个健康活动在诊所举行。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0833,ms,ms-11,keselamatan,安全,Keselamatan pelajar penting bagi sekolah.,学生安全对学校很重要。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0834,ms,ms-11,kebersihan,清洁；卫生,Kebersihan dewan mesti dijaga.,礼堂卫生必须得到维护。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0835,ms,ms-11,kemudahan,设施,Kemudahan di sekolah ini untuk semua pelajar.,这所学校的设施供所有学生使用。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0836,ms,ms-11,perkhidmatan,服务,Perkhidmatan bas itu bermula pada pukul enam.,那项公交服务六点开始。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0837,ms,ms-11,pengumuman,公告,Pengumuman itu dibuat oleh ketua program.,那则公告由活动负责人发布。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0838,ms,ms-11,laporan,报告,Laporan itu ditulis oleh pegawai sekolah.,那份报告由学校职员撰写。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0839,ms,ms-11,akhbar,报纸,Bapa membaca akhbar setiap pagi.,父亲每天早晨读报。,量词 naskhah,名词;新闻与公共事务\nms-0840,ms,ms-11,wartawan,记者,Wartawan itu bertanya tentang program sekolah.,那名记者询问学校活动的情况。,量词 orang,名词;新闻与公共事务\nms-0841,ms,ms-11,pembaca,读者,Pembaca akhbar itu mahu maklumat yang jelas.,那份报纸的读者想要清楚的信息。,量词 orang；整词学习,名词;新闻与公共事务\nms-0842,ms,ms-11,tajuk,标题,Tajuk berita ini pendek dan jelas.,这则新闻的标题简短清楚。,一般不用量词,名词;新闻与公共事务\nms-0843,ms,ms-11,peristiwa,事件,Wartawan melaporkan peristiwa itu dalam akhbar.,记者在报纸上报道那个事件。,一般不用量词,名词;新闻与公共事务\nms-0844,ms,ms-11,majlis,仪式；活动,Majlis sekolah bermula pada pukul sembilan.,学校的仪式九点开始。,一般不用量词,名词;新闻与公共事务\nms-0845,ms,ms-11,sukarelawan,志愿者,Sukarelawan membantu penduduk di dewan.,志愿者在礼堂帮助居民。,量词 orang,名词;新闻与公共事务\nms-0846,ms,ms-11,mengadakan,举办,Sekolah mengadakan program membaca pada hari Sabtu.,学校星期六举办阅读活动。,meN- + ada + -kan → mengadakan，meng-，词根首字母保留；词根 ada；及物动词，常见宾语 program,动词;公共事务动词\nms-0847,ms,ms-11,melaporkan,报道,Wartawan melaporkan berita dari Johor Bahru.,记者报道来自新山的新闻。,meN- + lapor + -kan → melaporkan，me-，词根首字母保留；词根 lapor；及物动词，常见宾语 berita,动词;公共事务动词\nms-0848,ms,ms-11,mengumumkan,宣布,Ketua mengumumkan tarikh mesyuarat itu.,负责人宣布那场会议的日期。,meN- + umum + -kan → mengumumkan，meng-，词根首字母保留；词根 umum；及物动词，常见宾语 tarikh,动词;公共事务动词\nms-0849,ms,ms-11,melaksanakan,执行,Jawatankuasa melaksanakan rancangan itu bersama.,委员会一起执行那个计划。,meN- + laksana + -kan → melaksanakan，me-，词根首字母保留；词根 laksana；及物动词，常见宾语 rancangan,动词;公共事务动词\nms-0850,ms,ms-11,membincangkan,讨论,Kami membincangkan masalah kebersihan sekolah.,我们讨论学校卫生问题。,meN- + bincang + -kan → membincangkan，mem-，词根首字母保留；词根 bincang；及物动词，常见宾语 masalah,动词;公共事务动词\nms-0851,ms,ms-11,menguruskan,办理；管理,Pegawai menguruskan borang untuk program itu.,职员办理那个活动的表格。,meN- + urus + -kan → menguruskan，meng-，词根首字母保留；词根 urus；及物动词，常见宾语 borang,动词;公共事务动词\nms-0852,ms,ms-11,mengesahkan,确认,Guru mengesahkan nama pelajar pada borang.,老师确认表格上的学生姓名。,meN- + sah + -kan → mengesahkan，menge-，单音节词根 sah 保留；及物动词，常见宾语 nama,动词;公共事务动词\nms-0853,ms,ms-11,membenarkan,允许,Guru membenarkan kami menggunakan bilik ini.,老师允许我们使用这个房间。,meN- + benar + -kan → membenarkan，mem-，词根首字母保留；词根 benar；及物动词，常见宾语 kami + 动作,动词;公共事务动词\nms-0854,ms,ms-11,menjaga,照顾；维护,Kami menjaga kebersihan taman.,我们维护公园的卫生。,meN- + jaga → menjaga，men-，词根首字母保留；词根 jaga；及物动词，常见宾语 kebersihan,动词;公共事务动词\nms-0855,ms,ms-11,memeriksa,检查,Pegawai memeriksa alat di dewan.,职员检查礼堂里的工具。,meN- + periksa → memeriksa，mem-，p 脱落；词根 periksa；及物动词，常见宾语 alat,动词;公共事务动词\nms-0856,ms,ms-11,melapor,报告；报到,Sukarelawan melapor kepada ketua sebelum bekerja.,志愿者工作前向负责人报到。,meN- + lapor → melapor，me-，词根首字母保留；词根 lapor；常作不及物，用 kepada 引出报告对象,动词;公共事务动词\nms-0857,ms,ms-11,mencatat,记录,Wartawan mencatat nama ketua program.,记者记录活动负责人的姓名。,meN- + catat → mencatat，men-，词根首字母保留；词根 catat；及物动词，常见宾语 nama,动词;公共事务动词\nms-0858,ms,ms-11,menyokong,支持,Penduduk menyokong program membaca itu.,居民支持那个阅读活动。,meN- + sokong → menyokong，meny-，s 脱落；词根 sokong；及物动词，常见宾语 program,动词;公共事务动词\nms-0859,ms,ms-11,bermula,开始,Majlis itu bermula pada pukul sepuluh.,那个仪式十点开始。,ber- + mula；词根 mula；不及物动词,动词;公共事务动词\nms-0860,ms,ms-11,berakhir,结束,Mesyuarat berakhir sebelum tengah hari.,会议在中午前结束。,ber- + akhir；词根 akhir；不及物动词,动词;公共事务动词\nms-0861,ms,ms-11,serta,以及,Guru serta pelajar membersihkan dewan.,老师和学生打扫礼堂。,连接并列成分,连词;新闻连接\nms-0862,ms,ms-11,namun,然而,\"Hujan turun, namun majlis itu masih berjalan.\",下雨了，然而活动仍在进行。,连接转折,连词;新闻连接\nms-0863,ms,ms-11,maka,于是,\"Dewan sudah penuh, maka kami menunggu di luar.\",礼堂已经满了，于是我们在外面等候。,连接结果,连词;新闻连接\nms-0864,ms,ms-11,agar,以便,Notis ditulis dengan jelas agar semua orang faham.,通知写得很清楚，以便所有人理解。,引出目的,连词;新闻连接\nms-0865,ms,ms-11,iaitu,即；也就是,\"Kami bertemu ketua program, iaitu Raju.\",我们见到了活动负责人，也就是拉朱。,引出具体说明,连词;新闻连接\nms-0866,ms,ms-11,Buku itu dibaca oleh Ali.,那本书由阿里阅读。,Buku itu dibaca oleh Ali.,那本书由阿里阅读。,整句识别；第三人称施事被动,动词;句型;phrase\nms-0867,ms,ms-11,Makanan disediakan di dewan.,食物在礼堂供应。,Makanan disediakan di dewan.,食物在礼堂供应。,整句识别；前缀 di- 连写，介词 di 分写,动词;句型;phrase\nms-0868,ms,ms-11,Sila baca notis ini.,请阅读这则通知。,Sila baca notis ini.,请阅读这则通知。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0869,ms,ms-11,Majlis itu akan diadakan esok.,那个活动将在明天举行。,Majlis itu akan diadakan esok.,那个活动将在明天举行。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0870,ms,ms-11,Borang mesti dihantar sebelum Jumaat.,表格必须在星期五前送交。,Borang mesti dihantar sebelum Jumaat.,表格必须在星期五前送交。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0871,ms,ms-11,ramai,众多（人）,Ramai pelajar membaca di perpustakaan.,许多学生在图书馆阅读。,形容词，后置；表示人多时常放在名词前，如 ramai pelajar；也可作谓语，如 Pelajar di sini ramai,形容词;公共事务;补充\nms-0872,ms,ms-11,rasmi,正式,Surat rasmi itu ditulis oleh ketua.,那封正式信函由负责人撰写。,形容词，后置,形容词;公共事务;补充\nms-0873,ms,ms-11,awam,公共,Perpustakaan awam itu dekat dengan stesen.,那座公共图书馆靠近车站。,形容词，后置,形容词;公共事务;补充\nms-0874,ms,ms-11,percuma,免费的,Buku percuma itu untuk semua pelajar.,那些免费书籍供所有学生领取。,形容词，后置,形容词;公共事务;补充\nms-0875,ms,ms-11,taraf,水平,Taraf kebersihan sekolah ini baik.,这所学校的卫生水平良好。,一般不用量词,名词;公共事务;补充\nms-0876,ms,ms-11,turun,落下；下降,Hujan turun sejak pagi.,雨从早晨开始下。,不及物动词；词根 turun,动词;公共事务;补充\nms-0877,ms,ms-11,secara,以……方式,Guru menjelaskan tugas secara jelas.,老师清楚地说明任务。,后接方式词；整词学习,副词;公共事务;补充\nms-0878,ms,ms-11,naskhah,册；份（出版物）,Dua naskhah akhbar itu di atas meja.,那两份报纸在桌上。,量词 作为计量名词，量词本身不再加量词,量词;公共事务;补充\nms-0879,ms,ms-11,jumlah,总数,Jumlah pelajar dalam kelas ini dua puluh orang.,这个班的学生总数是二十人。,一般不用量词,名词;公共事务;补充\nms-0880,ms,ms-11,jadual,时间表,Jadual program itu diletakkan di depan dewan.,活动时间表贴放在礼堂前面。,一般不用量词,名词;公共事务;补充\nms-0881,ms,ms-12,terjatuh,跌倒；意外掉落,Ali terjatuh di tangga semalam.,阿里昨天在楼梯上跌倒了。,ter- + jatuh；词根 jatuh；意外；不及物,动词;ter- 形式\nms-0882,ms,ms-12,tertidur,不知不觉睡着,Adik tertidur selepas membaca buku itu.,弟弟读完那本书后不知不觉睡着了。,ter- + tidur；词根 tidur；意外；不及物,动词;ter- 形式\nms-0883,ms,ms-12,terlupa,忘记,Saya terlupa membawa pen ke kelas.,我忘了带笔去上课。,ter- + lupa；词根 lupa；意外；常接动作内容,动词;ter- 形式\nms-0884,ms,ms-12,terangkat,抬得动,Kotak berat itu tidak terangkat oleh Ali.,阿里抬不动那个重盒子。,ter- + angkat；词根 angkat；能力；常见宾语 kotak 在此作主语,动词;ter- 形式\nms-0885,ms,ms-12,terbaca,读得清；能读,Tulisan kecil itu tidak terbaca oleh ibu.,母亲读不清那些小字。,ter- + baca；词根 baca；能力；常见宾语 tulisan 在此作主语,动词;ter- 形式\nms-0886,ms,ms-12,terbuka,开着的,Pintu bilik itu masih terbuka.,那个房间的门仍开着。,ter- + buka；词根 buka；状态；不及物,动词;ter- 形式\nms-0887,ms,ms-12,tertutup,关着的,Tingkap dapur itu tertutup sejak pagi.,厨房的窗户从早晨起就关着。,ter- + tutup；词根 tutup；状态；不及物,动词;ter- 形式\nms-0888,ms,ms-12,tertinggal,被落下；遗留,Buku saya tertinggal di sekolah.,我的书落在学校了。,ter- + tinggal；词根 tinggal；意外；状态,动词;ter- 形式\nms-0889,ms,ms-12,terambil,误拿,Ali terambil buku Siti kerana warnanya sama.,阿里因书的颜色相同而误拿了西蒂的书。,ter- + ambil；词根 ambil；意外；及物，常见宾语 buku,动词;ter- 形式\nms-0890,ms,ms-12,terdengar,无意间听到,Saya terdengar suara guru dari luar kelas.,我从教室外无意间听到老师的声音。,ter- + dengar；词根 dengar；意外；及物，常见宾语 suara,动词;ter- 形式\nms-0891,ms,ms-12,tertulis,写在上面的,Nama Raju tertulis pada kotak itu.,拉朱的名字写在那个盒子上。,ter- + tulis；词根 tulis；状态；常见宾语 nama 在此作主语,动词;ter- 形式\nms-0892,ms,ms-12,tersusun,排列整齐的,Buku-buku itu tersusun di atas rak.,那些书整齐地摆在架子上。,ter- + susun；词根 susun；状态；常见宾语 buku 在此作主语,动词;ter- 形式\nms-0893,ms,ms-12,imbuhan,词缀,Imbuhan ini ada di depan kata dasar.,这个词缀在词根前面。,一般不用量词；整词学习,名词;复习与学习\nms-0894,ms,ms-12,awalan,前缀,Awalan ini mengubah maksud perkataan.,这个前缀改变词的意思。,一般不用量词；整词学习,名词;复习与学习\nms-0895,ms,ms-12,akhiran,后缀,Akhiran ini ada di hujung perkataan.,这个后缀在词的末尾。,一般不用量词；整词学习,名词;复习与学习\nms-0896,ms,ms-12,kata dasar,词根,Kata dasar itu belum saya tulis.,那个词根我还没写。,一般不用量词,名词;复习与学习\nms-0897,ms,ms-12,ayat,句子,Ayat ini sudah saya baca.,这个句子我已经读过了。,一般不用量词,名词;复习与学习\nms-0898,ms,ms-12,ejaan,拼写,Ejaan perkataan ini mesti kita periksa.,这个词的拼写我们必须检查。,一般不用量词；整词学习,名词;复习与学习\nms-0899,ms,ms-12,makna,意义,Makna ayat itu jelas bagi saya.,那个句子的意义对我来说很清楚。,一般不用量词,名词;复习与学习\nms-0900,ms,ms-12,subjek,主语,Subjek ayat ini ialah Ali.,这个句子的主语是阿里。,一般不用量词,名词;复习与学习\nms-0901,ms,ms-12,objek,宾语,Objek dalam ayat itu ialah buku.,那个句子中的宾语是书。,一般不用量词,名词;复习与学习\nms-0902,ms,ms-12,pelaku,施事；动作执行者,Pelaku dalam ayat ini ialah Siti.,这个句子中的施事是西蒂。,量词 orang；整词学习,名词;复习与学习\nms-0903,ms,ms-12,jawapan,答案,Jawapan itu sudah saya tulis.,那个答案我已经写好了。,一般不用量词；整词学习,名词;复习与学习\nms-0904,ms,ms-12,kesalahan,错误,Kesalahan ejaan itu perlu kita catat.,那个拼写错误我们需要记下来。,一般不用量词；整词学习,名词;复习与学习\nms-0905,ms,ms-12,ulang kaji,复习,Ulang kaji perlu dibuat setiap minggu.,复习需要每周进行。,学习活动名词，一般不用量词；分写 ulang kaji,名词;复习与学习\nms-0906,ms,ms-12,ujian,测验,Ujian ini untuk semua pelajar di kelas.,这项测验面向班里所有学生。,一般不用量词；整词学习,名词;复习与学习\nms-0907,ms,ms-12,tulisan,文字；书写,Tulisan pada kertas itu sangat kecil.,那张纸上的字很小。,一般不用量词；整词学习,名词;复习与学习\nms-0908,ms,ms-12,Buku itu saya baca.,那本书由我来读。,Buku itu saya baca.,那本书由我来读。,整句识别；宾语前置，第一人称施事紧接光杆动词,动词;句型;phrase\nms-0909,ms,ms-12,Surat ini awak tulis?,这封信是你写的吗？,Surat ini awak tulis?,这封信是你写的吗？,整句识别；第二人称施事被动,动词;句型;phrase\nms-0910,ms,ms-12,Buku itu belum saya baca.,那本书我还没读。,Buku itu belum saya baca.,那本书我还没读。,整句识别；belum 在施事代词前,动词;句型;phrase\nms-0911,ms,ms-12,Tugas ini akan kami selesaikan.,这项任务我们会完成。,Tugas ini akan kami selesaikan.,这项任务我们会完成。,整句识别；去掉 meN-，保留 -kan,动词;句型;phrase\nms-0912,ms,ms-12,Muzium itu sudah kita kunjungi.,那座博物馆我们已经参观过。,Muzium itu sudah kita kunjungi.,那座博物馆我们已经参观过。,整句识别；去掉 meN-，保留 -i,动词;句型;phrase\nms-0913,ms,ms-12,Pintu itu jangan awak buka.,那扇门你不要打开。,Pintu itu jangan awak buka.,那扇门你不要打开。,整句识别；jangan 在施事代词前,动词;句型;phrase\nms-0914,ms,ms-12,Kotak itu tidak terangkat oleh Raju.,拉朱抬不动那个盒子。,Kotak itu tidak terangkat oleh Raju.,拉朱抬不动那个盒子。,整句识别；ter- 表能力，第三人称施事,动词;句型;phrase\nms-0915,ms,ms-12,Saya tertidur semasa membaca.,我读书时不知不觉睡着了。,Saya tertidur semasa membaca.,我读书时不知不觉睡着了。,整句识别；ter- 表意外,动词;句型;phrase\nms-0916,ms,ms-12,suara,声音；嗓音,Suara guru itu jelas dari belakang kelas.,从教室后面也能清楚听见老师的声音。,一般不用量词,名词;复习与学习;补充\nms-0917,ms,ms-12,warna,颜色,Warna buku Ali sama dengan warna buku Siti.,阿里和西蒂的书颜色相同。,一般不用量词,名词;复习与学习;补充\nms-0918,ms,ms-12,sama,相同,Dua buku ini sama warnanya.,这两本书的颜色相同。,形容词，后置,形容词;复习与学习;补充\nms-0919,ms,ms-12,semasa,在……期间,Jangan berbual semasa guru menerangkan ayat.,老师说明句子时不要聊天。,引出同时发生的动作,连词;复习与学习;补充\nms-0920,ms,ms-12,mengubah,改变,Imbuhan boleh mengubah makna kata dasar.,词缀可以改变词根的意义。,meN- + ubah → mengubah，meng-，词根首字母保留；词根 ubah；及物动词，常见宾语 makna,动词;复习与学习;补充\n";
const M4_OLD_PROGRESS={"cards": {"es-0001:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0002:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0003:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0004:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0005:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0006:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0007:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0008:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0009:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0010:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0011:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0012:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0013:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0014:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0015:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0001:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0002:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0003:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0004:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0005:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0006:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0007:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0008:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0009:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0010:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}}, "log": [{"t": "2026-09-07T04:00:07.567Z", "card": "es-0001:r", "grade": 5}, {"t": "2026-09-07T04:00:17.145Z", "card": "es-0002:r", "grade": 5}, {"t": "2026-09-07T04:00:24.249Z", "card": "es-0003:r", "grade": 5}, {"t": "2026-09-07T04:00:29.752Z", "card": "es-0004:r", "grade": 5}, {"t": "2026-09-07T04:00:35.774Z", "card": "es-0005:r", "grade": 5}, {"t": "2026-09-07T04:00:40.665Z", "card": "es-0006:r", "grade": 5}, {"t": "2026-09-07T04:00:48.333Z", "card": "es-0007:r", "grade": 5}, {"t": "2026-09-07T04:00:52.006Z", "card": "es-0008:r", "grade": 5}, {"t": "2026-09-07T04:03:36.337Z", "card": "es-0009:r", "grade": 5}, {"t": "2026-09-07T04:03:39.485Z", "card": "es-0010:r", "grade": 5}, {"t": "2026-09-07T04:03:45.718Z", "card": "es-0011:r", "grade": 5}, {"t": "2026-09-07T04:03:47.833Z", "card": "es-0012:r", "grade": 5}, {"t": "2026-09-07T04:03:59.508Z", "card": "es-0013:r", "grade": 4}, {"t": "2026-09-07T04:04:07.565Z", "card": "es-0014:r", "grade": 4}, {"t": "2026-09-07T04:04:11.973Z", "card": "es-0015:r", "grade": 4}, {"t": "2026-09-07T04:04:23.285Z", "card": "ru-0001:r", "grade": 4}, {"t": "2026-09-07T04:06:12.511Z", "card": "ru-0002:r", "grade": 4}, {"t": "2026-09-07T04:06:22.331Z", "card": "ru-0003:r", "grade": 4}, {"t": "2026-09-07T04:06:27.348Z", "card": "ru-0004:r", "grade": 4}, {"t": "2026-09-07T04:06:38.334Z", "card": "ru-0005:r", "grade": 4}, {"t": "2026-09-07T04:06:44.753Z", "card": "ru-0006:r", "grade": 4}, {"t": "2026-09-07T04:06:52.439Z", "card": "ru-0007:r", "grade": 4}, {"t": "2026-09-07T04:07:01.487Z", "card": "ru-0008:r", "grade": 4}, {"t": "2026-09-07T04:07:26.139Z", "card": "ru-0009:r", "grade": 4}, {"t": "2026-09-07T04:07:38.718Z", "card": "ru-0010:r", "grade": 4}]};

const M4_LESSONS=['ms-13','ms-14','ms-15','ms-16'];
const M4_READINGS=Array.from({length:8},(_,i)=>'ms-r'+String(i+23).padStart(2,'0'));
const ms4Rows=initialRows.filter(r=>M4_LESSONS.includes(r.lesson));
const M4_TEXTS=()=>[
  ...ms4Rows.map(r=>({id:r.id,lesson:r.lesson,text:r.example})),
  ...M4_LESSONS.flatMap(id=>[...api.LESSONS[id].reading.sentences,...ms3LangSentences(api.LESSONS[id])].map(s=>({id,lesson:id,...s}))),
  ...M4_READINGS.flatMap(id=>api.READINGS[id].sentences.map(s=>({id,lesson:api.READINGS[id].afterLesson,...s})))
];
test('任务 M4：四课周次、跨年日期、时长、目标与写作要求',()=>{
  const short=d=>String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
  for(const [i,id] of M4_LESSONS.entries()){
    const l=api.LESSONS[id],week=i+13,start=new Date(Date.UTC(2026,9,5+(week-1)*7)),end=new Date(+start+6*86400000);
    const date=(start.getUTCFullYear()>2026?start.getUTCFullYear()+' 年 ':'')+short(start)+' 至 '+(end.getUTCFullYear()!==start.getUTCFullYear()?end.getUTCFullYear()+' 年 ':'')+short(end);
    assert.equal(l.lang,'ms');assert.equal(l.week,week);assert.equal(l.dates,date);
    assert.equal(l.dailyTime,'每天 20 分钟 + 每周 1 次系统块 30 分钟');
    for(const field of ['name','goal','writingTask'])assert(l[field]?.trim(),id+' '+field);
    assert.match(l.writingTask,/5 句/);
    const first=msWalk(parseNodes(l.explanation())).find(n=>n.tag==='p').textContent;
    for(const phrase of [l.dailyTime,'配合《Complete Malay》的对应单元，单元以实际教材为准','时间分配以复盘结果为准'])assert(first.includes(phrase),id+' '+phrase);
  }
  assert.match(api.LESSONS['ms-16'].writingTask,/100 词/);
});
test('任务 M4：320 条预分配 id、四课各 80 条、CSV 同源与连续追加',()=>{
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8')));
  assert.equal(ms4Rows.length,320);
  assert.deepEqual(ms4Rows.map(r=>r.id),Array.from({length:320},(_,i)=>'ms-'+String(921+i).padStart(4,'0')));
  assert.deepEqual(csv.filter(r=>M4_LESSONS.includes(r.lesson)),ms4Rows);
  const first=initialRows.findIndex(r=>r.id==='ms-0921');assert.equal(initialRows[first-1].id,'ms-0920');
  assert.deepEqual(initialRows.slice(first,first+320),ms4Rows);
  const lessonIds=Object.keys(api.LESSONS),start=lessonIds.indexOf('ms-13');
  assert.equal(lessonIds[start-1],'ms-12');assert.deepEqual(lessonIds.slice(start,start+4),M4_LESSONS);
  for(const id of M4_LESSONS)assert.equal(ms4Rows.filter(r=>r.lesson===id).length,80,id);
  const fronts=csv.map(r=>r.front.toLowerCase());assert.equal(new Set(fronts).size,fronts.length);
});
test('任务 M4：主题配额与五条整句、补充词标签',()=>{
  const quotas={
    'ms-13':{'peN- 名词':30,'职业与工作场所':25,'职业动词':15,'phrase':5,'补充':5},
    'ms-14':{'-an 名词':20,'peN-an 名词':15,'per-an 名词':15,'派生名词相关动词':15,'phrase':5,'补充':10},
    'ms-15':{'ke-an 形式':30,'社会与公共主题':20,'公共事务动词':15,'公共事务连接':5,'phrase':5,'补充':5},
    'ms-16':{'比较与程度':12,'外貌与性格':30,'物品与属性':20,'描述与比较动词':8,'phrase':5,'补充':5}
  };
  for(const [id,tags] of Object.entries(quotas))for(const [tag,n] of Object.entries(tags))assert.equal(ms4Rows.filter(r=>r.lesson===id&&r.tags.split(';').includes(tag)).length,n,id+' '+tag);
});
test('任务 M4：词类、原形例句、量词、形容词与及物宾语注释及 620 张卡',()=>{
  const parts=new Set('名词 动词 形容词 代词 数词 量词 介词 连词 副词 助动词 语气词 疑问词 问候'.split(' '));
  for(const r of ms4Rows){
    const tags=r.tags.split(';');assert(parts.has(tags[0]),r.id);assert(!tags.includes('letter'));
    assert(r.back&&r.example_zh&&r.note,r.id);assert(/[.!?]$/.test(r.example),r.id);
    assert(r.example.toLowerCase().includes(r.front.toLowerCase()),r.id+' 原形');
    if(/[.!?]$/.test(r.front))assert(tags.includes('phrase'),r.id);
    if(tags[0]==='名词')assert.match(r.note,/量词/,r.id);
    if(tags[0]==='形容词')assert.match(r.note,/形容词，后置/,r.id);
    if(tags[0]==='动词'&&/及物/.test(r.note)&&!/不及物/.test(r.note))assert.match(r.note,/宾语/,r.id);
    assert.deepEqual(plain(api.expandCards([r]).map(c=>c.direction)),tags.includes('phrase')?['r']:['r','p']);
    if(!tags.includes('phrase')){assert(api.clozeExample(r).includes('____'),r.id);assert(!api.clozeExample(r).includes('此例句没有'),r.id);}
  }
  assert.deepEqual(M4_LESSONS.map(id=>api.expandCards(ms4Rows.filter(r=>r.lesson===id)).length),[155,155,155,155]);
});
test('任务 M4：马来西亚拼写、口语范围及 note 的印尼语对照标记',()=>{
  const banned=new Set('karena uang kantor universitas bahwa senin delapan mau saja sepeda sepatu kamar bisa kemarin'.split(' '));
  const informal=new Set('aku kau engkau tak nak dah je ni tu'.split(' '));
  // 本轮不教 bisa 的毒液义，因此正文和卡面均拒绝该词。
  for(const item of [...ms4Rows.map(r=>({id:r.id,text:r.front})),...M4_TEXTS()])for(const word of msWords(item.text).map(w=>w.toLowerCase())){
    assert(!banned.has(word),item.id+' 印尼语 '+word);assert(!informal.has(word),item.id+' 口语 '+word);
  }
  for(const r of ms4Rows)for(const word of msWords(r.note).map(w=>w.toLowerCase()))if(banned.has(word))assert(r.note.includes('印尼语作'),r.id);
});
test('任务 M4：每课六道语法或拼写加四道共用阅读题，答案可判',()=>{
  for(const id of M4_LESSONS){
    const l=api.LESSONS[id];assert.equal(l.exercises.length,10);assert.equal(l.reading.questions.length,4);
    assert(l.exercises.slice(0,6).every(q=>!q.prompt.startsWith('阅读：')));
    for(let i=0;i<4;i++)assert.equal(l.exercises[i+6],l.reading.questions[i],id+' 共用题对象');
    for(const q of l.exercises){
      assert(q.prompt&&q.answer);assert.equal(typeof q.answer,'string');
      if(q.options){assert(q.options.includes(q.answer));assert.equal(new Set(q.options).size,q.options.length);}
      if(q.prompt.includes('____'))assert(/[（(].+[）)]/.test(q.prompt),id+' 填空提示');
    }
  }
});
test('任务 M4：四篇课文 170–230 词、14–18 句、中文逐句完整',()=>{
  for(const id of M4_LESSONS){
    const r=api.LESSONS[id].reading,n=msWordCount(r.sentences);assert(r.title);
    assert(n>=170&&n<=230,id+' '+n+' 词');assert(r.sentences.length>=14&&r.sentences.length<=18,id);
    for(const s of r.sentences){assert(/[.!?]$/.test(s.text),id);assert(/[。？！]$/.test(s.zh),id);}
  }
});
test('任务 M4：八篇阅读编号、周次、原序追加、体裁和各篇精确篇幅',()=>{
  const ids=Object.keys(api.READINGS),start=ids.indexOf('ms-r23');assert.equal(ids[start-1],'ms-r22');assert.deepEqual(ids.slice(start,start+8),M4_READINGS);
  const ranges=[[170,190,14,16],[170,190,14,16],[180,200,15,17],[180,200,14,16],[195,215,15,17],[195,215,16,18],[210,230,16,18],[210,230,16,18]];
  const genres=['人物介绍','日记','说明文','邮件','简单新闻','短故事','房间或城市描写','对话'];
  for(const [i,id] of M4_READINGS.entries()){
    const r=api.READINGS[id],week=13+Math.floor(i/2),[min,max,smin,smax]=ranges[i],n=msWordCount(r.sentences);
    assert.equal(r.id,id);assert.equal(r.lang,'ms');assert.equal(r.week,week);assert.equal(r.afterLesson,'ms-'+week);assert.equal(r.genre,genres[i]);
    assert.equal(r.words,n);assert(n>=min&&n<=max,id+' '+n+' 词');assert(r.sentences.length>=smin&&r.sentences.length<=smax,id+' 句数');
    for(const s of r.sentences)assert(s.text&&s.zh&&/[.!?]$/.test(s.text)&&/[。？！]$/.test(s.zh),id+' 逐句翻译');
    if(i%2)assert.notEqual(r.genre,api.READINGS[M4_READINGS[i-1]].genre);
  }
});
test('任务 M4：每篇三道阅读题一道推断题、五个已学关键词与五行复述',()=>{
  for(const id of M4_READINGS){
    const r=api.READINGS[id],allowed=msVocabulary(r.afterLesson);assert.equal(r.questions.length,4);
    assert(r.questions.slice(0,3).every(q=>q.prompt.startsWith('阅读：')));assert(r.questions[3].prompt.startsWith('推断：'));
    for(const q of r.questions){assert(q.options.includes(q.answer));assert.equal(new Set(q.options).size,q.options.length);}
    assert.equal(r.keyWords.length,5);assert.equal(new Set(r.keyWords.map(k=>k.word)).size,5);
    for(const k of r.keyWords){assert(k.zh);assert(msWords(k.word).every(w=>allowed.has(w.toLowerCase())),id+' '+k.word);}
    assert.equal(r.retell.length,5);assert(r.retell.every(x=>/[\u3400-\u9fff]/.test(x)));
  }
});
test('任务 M4：例句、课文、阅读线与讲解例句均不超课次词汇范围',()=>{
  const misses=[];
  for(const id of M4_LESSONS)misses.push(...msVocabularyMisses(id,M4_TEXTS().filter(s=>s.lesson===id)));
  assert.deepEqual(misses,[]);
});
test('任务 M4：peN-、名词后缀、ke-an、se- 分周开放与组合、反例',()=>{
  for(const [root,week,form] of [
    ['baca',13,'pembaca'],['tulis',13,'penulis'],['sapu',13,'penyapu'],['nyanyi',13,'penyanyi'],['cat',13,'pengecat'],['ajar',13,'pelajar'],['kerja',13,'pekerja'],['tani',13,'petani'],
    ['baca',14,'bacaan'],['jawab',14,'jawapan'],['tulis',14,'penulisan'],['ajar',14,'pengajaran'],['ajar',14,'pembelajaran'],['ajar',14,'pelajaran'],['kerja',14,'pekerjaan'],['rancang',14,'perancangan'],['rumah',14,'perumahan'],
    ['bersih',15,'kebersihan'],['hujan',15,'kehujanan'],['tinggi',16,'setinggi']
  ]){assert(!msForms(root,week-1).has(form),form+' 提前开放');assert(msForms(root,week).has(form),form+' 未生成');}
  assert(msForms('menulis',14).has('penulisan'));assert(msForms('menerbitkan',14).has('penerbitan'));
  assert(msForms('tulis',14).has('penulisannya'));assert(msForms('besar',16).has('terbesar'));
  assert(msForms('baca',13).has('pembaca-pembacanya'));
  for(const [root,bad] of [['tulis','pentulis'],['sapu','pensapu'],['nyanyi','penynyi'],['cat','pencat']])assert(!msForms(root,16).has(bad));
  for(const [root,bad] of [['jawab','jawaban'],['tani','penani'],['rancang','perrancangan'],['kerja','perkerjaan'],['menulis','penuliskanan'],['menerbitkan','penerbitkanan'],['besar','palingterbesar'],['tulis','penuliskanan']])assert(!msForms(root,16).has(bad),bad);
  assert(msVocabularyMisses('ms-13',[{text:'Saya suka kebudayaan.'}]).length>0);
  assert(msVocabularyMisses('ms-15',[{text:'Meja ini setinggi meja itu.'}]).length>0);
  assert(msVocabularyMisses('ms-16',[{text:'Saya menggunakan superkomputer.'}]).length>0);
});
test('任务 M4：新派生卡的构词注释与 front 一致，施事卡含对应动词',()=>{
  for(const r of ms4Rows){
    const active=r.note.match(/^meN- \+ ([a-z]+)(?: \+ -(kan|i))? → ([a-z]+)/);
    if(active&&!r.tags.split(';').includes('phrase')&&!r.note.includes('特殊形式'))assert.equal(msMenForm(active[1])+(active[2]||''),r.front,r.id);
    if(r.tags.split(';').includes('peN- 名词')){assert.match(r.note,/词根/);assert.match(r.note,/对应.*动词/);}
  }
  const word=f=>ms4Rows.find(r=>r.front===f);
  assert.match(word('penyanyi').note,/ny 保留/);
  assert.match(word('kelihatan').note,/不是普通后置形容词/);
  assert.match(word('kebesaran').note,/并非简单的「太大」/);
});
test('任务 M4：讲解 HTML 可解析且标签闭合、至少三组例句和五句提纲',()=>{
  for(const id of M4_LESSONS){
    const markup=api.LESSONS[id].explanation(),nodes=msWalk(parseNodes(markup)),stack=[];
    for(const m of markup.matchAll(/<\/?([a-z][\w-]*)\b[^>]*>/gi)){
      const tag=m[1].toLowerCase();if(voidTags.has(tag))continue;
      if(m[0].startsWith('</'))assert.equal(stack.pop(),tag,id+' 标签闭合');else stack.push(tag);
    }
    assert.equal(stack.length,0);assert(nodes.filter(n=>n.tag==='h4').length>=5);
    assert(ms3LangSentences(api.LESSONS[id]).length>=3);
    assert(nodes.some(n=>n.tag==='ol'&&n.querySelectorAll('li').length===5));
    for(const text of ['自查','名词短语语序','写作提纲'])assert(markup.includes(text),id+' '+text);
  }
});
test('任务 M4：旧 ms 与其他语言逐行原样、原序及 cards／log 保留',()=>{
  const oldMs=plain(api.parseCSV(M4_OLD_MS_CSV));
  const csvText=fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8');
  assert.deepEqual(csvText.trimEnd().split('\n').slice(0,oldMs.length+1),M4_OLD_MS_CSV.trimEnd().split('\n'));
  const oldRows=initialRows.slice(0,initialRows.findIndex(r=>r.id==='ms-0921'));
  const rawRows=[...blocks[0][1].matchAll(/\n  \{\n[\s\S]*?\n  \}/g)].map(m=>m[0].slice(1));
  const byId=new Map(rawRows.map(raw=>[JSON.parse(raw).id,raw]));
  for(const lang of api.LANGS){
    const csv=lang==='ms'?oldMs:plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards',lang+'.csv'),'utf8')));
    assert.deepEqual(oldRows.filter(r=>r.lang===lang),csv,lang+' 原序');
    for(const r of csv)assert.equal(byId.get(r.id),JSON.stringify([r],null,2).slice(2,-2),r.id+' 原始行');
  }
  assert.deepEqual({cards:initialState.cards,log:initialState.log},M4_OLD_PROGRESS);
});
test('任务 M4：浏览四课八篇与课内作答、中文开关不改进度或缓存',()=>{
  const {api:a,document,cache}=createAPI(true,html);a.initialize();
  const before=plain(a.getData().state),rows=plain(a.getData().rows),dirty=a.getData().dirty,cacheBefore=[...cache.entries()];
  for(const id of M4_LESSONS){
    a.openLesson(id);const page=document.getElementById('content').textContent;
    for(const f of ['name','dates','dailyTime','goal','writingTask'])assert(page.includes(a.LESSONS[id][f]),id+' '+f);
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);
    for(const form of document.querySelectorAll('[data-exercise]')){form.elements.answer.value=a.LESSONS[id].exercises[Number(form.dataset.exercise)].answer;document.getElementById('app').listeners.submit[0]({target:form,preventDefault(){}});}
  }
  a.showReadings();assert.deepEqual(document.querySelectorAll('[data-reading]').map(n=>n.dataset.reading).filter(id=>M4_READINGS.includes(id)),M4_READINGS);
  for(const id of M4_READINGS){
    a.openReadingItem(id);assert(document.getElementById('content').textContent.includes(a.READINGS[id].title));
    assert.equal(document.querySelectorAll('[data-question]').length,4);
    const zh=()=>document.querySelectorAll('details').filter(n=>n.querySelector('summary')?.textContent==='查看本句中文');
    assert.equal(zh().length,a.READINGS[id].sentences.length);assert(zh().every(n=>n.getAttribute('open')===null));
    a.toggleReadingZh();assert(zh().every(n=>n.getAttribute('open')!==null));a.toggleReadingZh();
  }
  assert.deepEqual(plain(a.getData().state),before);assert.deepEqual(plain(a.getData().rows),rows);assert.equal(a.getData().dirty,dirty);assert.deepEqual([...cache.entries()],cacheBefore);
});
test('任务 M4：四课语法要点与 ajar 词族、序数和比较结构覆盖',()=>{
  const required=[
    ['pe-','pem-','pen-','peng-','peny-','penge-','pelajar','pembaca','penulis','pengajar','penyanyi','pengecat','pemain','pembuka','pemalas','pekerja','peniaga','petani','pelari','ajar'],
    ['makanan','minuman','bacaan','tulisan','pakaian','jawapan','pilihan','pembacaan','penulisan','pengajaran','pembelajaran','pembangunan','perpustakaan','perjalanan','pekerjaan','persahabatan','perniagaan','pelajaran'],
    ['kebersihan','kesihatan','kebaikan','keselamatan','kemajuan','kerajaan','kebudayaan','kehujanan','kelaparan','kecurian','kesejukan','kebesaran','kepanasan','kelihatan','kedengaran','kedua-dua'],
    ['lebih','kurang','daripada','paling','terbesar','termahal','sebesar','setinggi','sama','dengan','semakin','sangat','amat','terlalu','agak','cukup','sekali','100 词']
  ];
  for(const [i,id] of M4_LESSONS.entries())for(const word of required[i])assert(api.LESSONS[id].explanation().includes(word),id+' '+word);
});


// 任务 M5：第 17–20 周；完整课程按课次检查，保留本轮固定 id 区间。
const M5_OLD_MS_CSV=M3_OLD_MS_CSV+"ms-0641,ms,ms-09,membesarkan,扩大,Mereka membesarkan dapur rumah itu.,他们扩建那所房子的厨房。,meN- + besar + -kan → membesarkan，mem-，词根首字母保留；词根 besar；及物动词，常见宾语 dapur,动词;-kan 动词\nms-0642,ms,ms-09,menjalankan,开展,Guru menjalankan program membaca di sekolah.,老师在学校开展阅读活动。,meN- + jalan + -kan → menjalankan，men-，词根首字母保留；词根 jalan；及物动词，常见宾语 program,动词;-kan 动词\nms-0643,ms,ms-09,memasukkan,放入,Siti memasukkan buku ke dalam beg.,西蒂把书放进包里。,meN- + masuk + -kan → memasukkan，me-，词根首字母保留；词根 masuk；及物动词，常见宾语 buku；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0644,ms,ms-09,membelikan,替某人买,Ali membelikan ibunya satu helai baju.,阿里替母亲买了一件衣服。,meN- + beli + -kan → membelikan，mem-，词根首字母保留；词根 beli；及物动词，常见宾语 ibu、baju,动词;-kan 动词\nms-0645,ms,ms-09,membuatkan,替某人做,Ibu membuatkan adik sarapan.,母亲替弟弟做早餐。,meN- + buat + -kan → membuatkan，mem-，词根首字母保留；词根 buat；及物动词，常见宾语 adik、sarapan,动词;-kan 动词\nms-0646,ms,ms-09,memberikan,给予,Guru memberikan buku kepada saya.,老师把书给我。,meN- + beri + -kan → memberikan，mem-，词根首字母保留；词根 beri；及物动词，常见宾语 buku,动词;-kan 动词\nms-0647,ms,ms-09,mengatakan,说；表示,Ali mengatakan bahawa dia letih.,阿里说他累了。,meN- + kata + -kan → mengatakan，meng-，k 脱落；词根 kata；及物动词，常见宾语 bahawa 引出的内容,动词;-kan 动词\nms-0648,ms,ms-09,menggunakan,使用,Kami menggunakan komputer di perpustakaan.,我们在图书馆使用电脑。,meN- + guna + -kan → menggunakan，meng-，词根首字母保留；词根 guna；及物动词，常见宾语 komputer,动词;-kan 动词\nms-0649,ms,ms-09,menyediakan,准备；提供,Siti menyediakan makanan untuk kami.,西蒂为我们准备食物。,meN- + sedia + -kan → menyediakan，meny-，s 脱落；词根 sedia；及物动词，常见宾语 makanan,动词;-kan 动词\nms-0650,ms,ms-09,menjelaskan,解释,Guru menjelaskan soalan itu kepada pelajar.,老师向学生解释那道题。,meN- + jelas + -kan → menjelaskan，men-，词根首字母保留；词根 jelas；及物动词，常见宾语 soalan,动词;-kan 动词\nms-0651,ms,ms-09,menyebabkan,造成,Hujan menyebabkan jalan itu basah.,雨使那条路变湿了。,meN- + sebab + -kan → menyebabkan，meny-，s 脱落；词根 sebab；及物动词，常见宾语 jalan basah 等结果,动词;-kan 动词\nms-0652,ms,ms-09,mendapatkan,获得,Saya mendapatkan maklumat daripada guru.,我从老师那里获得信息。,meN- + dapat + -kan → mendapatkan，men-，词根首字母保留；词根 dapat；及物动词，常见宾语 maklumat,动词;-kan 动词\nms-0653,ms,ms-09,meletakkan,放置,Ali meletakkan cawan di atas meja.,阿里把杯子放在桌上。,meN- + letak + -kan → meletakkan，me-，词根首字母保留；词根 letak；及物动词，常见宾语 cawan；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0654,ms,ms-09,menghantarkan,送去,Saya menghantarkan makanan ke rumah Siti.,我把食物送到西蒂家。,meN- + hantar + -kan → menghantarkan，meng-，词根首字母保留；词根 hantar；及物动词，常见宾语 makanan,动词;-kan 动词\nms-0655,ms,ms-09,mengeluarkan,取出,Dia mengeluarkan wang dari beg.,他从包里取出钱。,meN- + keluar + -kan → mengeluarkan，meng-，k 脱落；词根 keluar；及物动词，常见宾语 wang,动词;-kan 动词\nms-0656,ms,ms-09,membersihkan,清洁,Kami membersihkan bilik sebelum kelas.,我们在上课前打扫房间。,meN- + bersih + -kan → membersihkan，mem-，词根首字母保留；词根 bersih；及物动词，常见宾语 bilik,动词;-kan 动词\nms-0657,ms,ms-09,mengeringkan,弄干,Ibu mengeringkan kain di luar rumah.,母亲在屋外晾干布。,meN- + kering + -kan → mengeringkan，meng-，k 脱落；词根 kering；及物动词，常见宾语 kain,动词;-kan 动词\nms-0658,ms,ms-09,memanaskan,加热,Siti memanaskan sup di dapur.,西蒂在厨房里热汤。,meN- + panas + -kan → memanaskan，mem-，p 脱落；词根 panas；及物动词，常见宾语 sup,动词;-kan 动词\nms-0659,ms,ms-09,menyejukkan,冷却,Saya menyejukkan air sebelum minum.,我把水放凉后再喝。,meN- + sejuk + -kan → menyejukkan，meny-，s 脱落；词根 sejuk；及物动词，常见宾语 air；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0660,ms,ms-09,memendekkan,缩短,Guru memendekkan waktu rehat hari ini.,老师今天缩短了休息时间。,meN- + pendek + -kan → memendekkan，mem-，p 脱落；词根 pendek；及物动词，常见宾语 waktu；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0661,ms,ms-09,memanjangkan,延长,Kami memanjangkan waktu membaca.,我们延长阅读时间。,meN- + panjang + -kan → memanjangkan，mem-，p 脱落；词根 panjang；及物动词，常见宾语 waktu,动词;-kan 动词\nms-0662,ms,ms-09,menghabiskan,用完；吃完,Adik menghabiskan nasi di dalam mangkuk.,弟弟吃完碗里的饭。,meN- + habis + -kan → menghabiskan，meng-，词根首字母保留；词根 habis；及物动词，常见宾语 nasi,动词;-kan 动词\nms-0663,ms,ms-09,menyampaikan,传达,Guru menyampaikan pesanan kepada ibu.,老师向母亲传达消息。,meN- + sampai + -kan → menyampaikan，meny-，s 脱落；词根 sampai；及物动词，常见宾语 pesanan,动词;-kan 动词\nms-0664,ms,ms-09,menunjukkan,指给看,Ali menunjukkan alamat itu kepada saya.,阿里把那个地址指给我看。,meN- + tunjuk + -kan → menunjukkan，men-，t 脱落；词根 tunjuk；及物动词，常见宾语 alamat；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0665,ms,ms-09,mengingatkan,提醒,Ibu mengingatkan saya tentang janji itu.,母亲提醒我那次约定。,meN- + ingat + -kan → mengingatkan，meng-，词根首字母保留；词根 ingat；及物动词，常见宾语 saya、janji,动词;-kan 动词\nms-0666,ms,ms-09,menyimpankan,留存,Saya menyimpankan wang untuk adik.,我替弟弟存钱。,meN- + simpan + -kan → menyimpankan，meny-，s 脱落；词根 simpan；及物动词，常见宾语 wang,动词;-kan 动词\nms-0667,ms,ms-09,menerangkan,说明,Guru menerangkan maksud perkataan itu.,老师说明那个词的意思。,meN- + terang + -kan → menerangkan，men-，t 脱落；词根 terang；及物动词，常见宾语 maksud,动词;-kan 动词\nms-0668,ms,ms-09,menyelesaikan,完成；解决,Kami menyelesaikan tugas sebelum petang.,我们在下午前完成任务。,meN- + selesai + -kan → menyelesaikan，meny-，s 脱落；词根 selesai；及物动词，常见宾语 tugas,动词;-kan 动词\nms-0669,ms,ms-09,menukarkan,更换,Dia menukarkan wang di bank.,他在银行兑换钱。,meN- + tukar + -kan → menukarkan，men-，t 脱落；词根 tukar；及物动词，常见宾语 wang,动词;-kan 动词\nms-0670,ms,ms-09,memulangkan,归还,Saya memulangkan buku kepada Ali.,我把书还给阿里。,meN- + pulang + -kan → memulangkan，mem-，p 脱落；词根 pulang；及物动词，常见宾语 buku,动词;-kan 动词\nms-0671,ms,ms-09,maklumat,信息,Maklumat ini ada di dalam buku.,这条信息在书里。,一般不用量词,名词;日常事务\nms-0672,ms,ms-09,alamat,地址,Saya menulis alamat sekolah pada sampul.,我把学校地址写在信封上。,一般不用量词,名词;日常事务\nms-0673,ms,ms-09,janji,约定,Saya ada janji dengan Siti esok.,我明天和西蒂有约。,一般不用量词,名词;日常事务\nms-0674,ms,ms-09,tugas,任务,Tugas saya ialah membersihkan kelas.,我的任务是打扫教室。,一般不用量词,名词;日常事务\nms-0675,ms,ms-09,hadiah,礼物,Ali memberikan hadiah kepada ibunya.,阿里给母亲礼物。,量词 buah,名词;日常事务\nms-0676,ms,ms-09,kotak,盒子,Kotak kecil itu untuk hadiah ibu.,那个小盒子用来装母亲的礼物。,量词 buah,名词;日常事务\nms-0677,ms,ms-09,bakul,篮子,Siti memasukkan sayur ke dalam bakul.,西蒂把蔬菜放进篮子里。,量词 buah,名词;日常事务\nms-0678,ms,ms-09,dulang,托盘,Ibu meletakkan cawan di atas dulang.,母亲把杯子放到托盘上。,量词 buah,名词;日常事务\nms-0679,ms,ms-09,bekas,容器,Bekas makanan itu bersih dan kering.,那个食品容器干净又干燥。,量词 buah,名词;日常事务\nms-0680,ms,ms-09,kunci,钥匙,Kunci rumah ada di dalam beg saya.,家门钥匙在我的包里。,量词 batang,名词;日常事务\nms-0681,ms,ms-09,rak,架子,Ali menyusun buku di atas rak.,阿里把书摆在架子上。,量词 buah,名词;日常事务\nms-0682,ms,ms-09,laci,抽屉,Pen saya ada di dalam laci meja.,我的笔在书桌抽屉里。,量词 buah,名词;日常事务\nms-0683,ms,ms-09,tuala,毛巾,Saya membeli satu helai tuala biru.,我买了一条蓝毛巾。,量词 helai,名词;日常事务\nms-0684,ms,ms-09,selimut,毯子,Adik tidur dengan selimut merah.,弟弟盖着红毯子睡觉。,量词 helai,名词;日常事务\nms-0685,ms,ms-09,cadar,床单,Ibu mencuci cadar pada pagi ini.,母亲今天早晨洗床单。,量词 helai,名词;日常事务\nms-0686,ms,ms-09,cermin,镜子,Cermin itu di sebelah tingkap.,那面镜子在窗户旁边。,量词 keping,名词;日常事务\nms-0687,ms,ms-09,tali,绳子,Tali ini panjang dan basah.,这根绳子又长又湿。,量词 utas,名词;日常事务\nms-0688,ms,ms-09,plastik,塑料,Bekas ini daripada plastik.,这个容器是塑料做的。,一般不用量词；数量按物品计,名词;日常事务\nms-0689,ms,ms-09,kaca,玻璃,Cawan ini daripada kaca.,这个杯子是玻璃做的。,一般不用量词；片状可用 keping,名词;日常事务\nms-0690,ms,ms-09,kayu,木材,Meja itu daripada kayu.,那张桌子是木制的。,量词 batang（长条）,名词;日常事务\nms-0691,ms,ms-09,alat,工具,Bapa menyimpan alat di dalam kotak.,父亲把工具放在盒子里。,量词 buah,名词;日常事务\nms-0692,ms,ms-09,bahan,材料,Kami menyediakan bahan untuk projek sekolah.,我们准备学校项目所需的材料。,一般不用量词,名词;日常事务\nms-0693,ms,ms-09,tujuan,目的,Tujuan program ini ialah belajar bersama.,这个活动的目的是一起学习。,一般不用量词,名词;日常事务\nms-0694,ms,ms-09,hasil,成果,Hasil projek itu sangat baik.,那个项目的成果很好。,一般不用量词,名词;日常事务\nms-0695,ms,ms-09,masalah,问题；困难,Kami menjelaskan masalah itu kepada guru.,我们向老师说明那个问题。,一般不用量词,名词;日常事务\nms-0696,ms,ms-09,bahawa,（引出陈述内容）,Siti mengatakan bahawa dia akan datang.,西蒂说她会来。,引出内容从句,连词;连接与程度\nms-0697,ms,ms-09,supaya,以便,Saya membuka tingkap supaya bilik sejuk.,我打开窗户，让房间凉快。,引出目的,连词;连接与程度\nms-0698,ms,ms-09,jika,如果,\"Jika hujan, kita belajar di rumah.\",如果下雨，我们就在家学习。,引出条件,连词;连接与程度\nms-0699,ms,ms-09,hampir,几乎,Saya hampir menghabiskan nasi itu.,我快吃完那些饭了。,放在动词前,副词;连接与程度\nms-0700,ms,ms-09,semula,重新,Ali membaca surat itu semula.,阿里重新读那封信。,常放在动词或宾语后,副词;连接与程度\nms-0701,ms,ms-09,Sila masukkan buku ke dalam beg.,请把书放进包里。,Sila masukkan buku ke dalam beg.,请把书放进包里。,整句识别；请求句保留 -kan,动词;句型;phrase\nms-0702,ms,ms-09,Tolong jelaskan soalan ini.,请解释这道题。,Tolong jelaskan soalan ini.,请解释这道题。,整句识别；请求句保留 -kan,动词;句型;phrase\nms-0703,ms,ms-09,Saya akan memulangkan buku esok.,我明天会还书。,Saya akan memulangkan buku esok.,我明天会还书。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0704,ms,ms-09,Ibu membelikan saya kasut baru.,母亲替我买了新鞋。,Ibu membelikan saya kasut baru.,母亲替我买了新鞋。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0705,ms,ms-09,Kami menyediakan makanan bersama.,我们一起准备食物。,Kami menyediakan makanan bersama.,我们一起准备食物。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0706,ms,ms-09,maksud,意思,Maksud perkataan ini jelas.,这个词的意思很清楚。,一般不用量词,名词;日常事务;补充\nms-0707,ms,ms-09,perkataan,词,Saya menulis perkataan baru di dalam buku.,我把新词写在本子里。,一般不用量词,名词;日常事务;补充\nms-0708,ms,ms-09,langkah,步骤,Guru menerangkan langkah pertama kepada kami.,老师向我们说明第一步。,一般不用量词,名词;日常事务;补充\nms-0709,ms,ms-09,contoh,例子,Guru memberikan contoh yang baik.,老师给出一个好例子。,一般不用量词,名词;日常事务;补充\nms-0710,ms,ms-09,sebab,原因,Sebab Ali belum datang ialah hujan.,阿里还没来的原因是下雨。,一般不用量词,名词;日常事务;补充\nms-0711,ms,ms-09,jelas,清楚,Alamat pada surat ini jelas.,这封信上的地址很清楚。,形容词，后置,形容词;日常事务;补充\nms-0712,ms,ms-09,penting,重要,Maklumat ini sangat penting untuk kita.,这个信息对我们很重要。,形容词，后置,形容词;日常事务;补充\nms-0713,ms,ms-09,mudah,容易,Tugas ini mudah bagi saya.,这项任务对我来说很容易。,形容词，后置,形容词;日常事务;补充\nms-0714,ms,ms-09,sukar,困难,Soalan itu sukar bagi adik.,那道题对弟弟来说很难。,形容词，后置,形容词;日常事务;补充\nms-0715,ms,ms-09,penuh,满,Bakul itu penuh dengan sayur.,那个篮子里装满了蔬菜。,形容词，后置,形容词;日常事务;补充\nms-0716,ms,ms-09,kosong,空,Kotak kosong itu di bawah meja.,那个空盒子在桌子下面。,形容词，后置,形容词;日常事务;补充\nms-0717,ms,ms-09,ringan,轻,Beg kecil ini sangat ringan.,这个小包很轻。,形容词，后置,形容词;日常事务;补充\nms-0718,ms,ms-09,berat,重,Kotak buku itu berat sekali.,那个装书的盒子很重。,形容词，后置,形容词;日常事务;补充\nms-0719,ms,ms-09,selamat,安全,Jalan ini selamat untuk kita.,这条路对我们来说是安全的。,形容词，后置,形容词;日常事务;补充\nms-0720,ms,ms-09,senang hati,高兴；开心,Ibu senang hati menerima hadiah itu.,母亲高兴地收下那份礼物。,形容词，后置；马来西亚 senang 单用多指「容易」，表示高兴要说 senang hati；印尼语 senang 单用即表示高兴,形容词;日常事务;补充\nms-0721,ms,ms-10,mengunjungi,拜访；参观,Kami mengunjungi muzium di Melaka.,我们参观马六甲的博物馆。,meN- + kunjung + -i → mengunjungi，meng-，k 脱落；词根 kunjung；及物动词，常见宾语 muzium,动词;-i 动词\nms-0722,ms,ms-10,memasuki,进入,Pelajar memasuki kelas pada pukul lapan.,学生们八点进入教室。,meN- + masuk + -i → memasuki，me-，词根首字母保留；词根 masuk；及物动词，常见宾语 kelas,动词;-i 动词\nms-0723,ms,ms-10,menaiki,登上；乘坐,Saya menaiki bas ke bandar.,我乘公共汽车去城里。,meN- + naik + -i → menaiki，me-，词根首字母保留；词根 naik；及物动词，常见宾语 bas,动词;-i 动词\nms-0724,ms,ms-10,menyukai,喜欢,Adik menyukai buku cerita ini.,弟弟喜欢这本故事书。,meN- + suka + -i → menyukai，meny-，s 脱落；词根 suka；及物动词，常见宾语 buku,动词;-i 动词\nms-0725,ms,ms-10,mencintai,爱,Kami mencintai negara Malaysia.,我们爱马来西亚这个国家。,meN- + cinta + -i → mencintai，men-，词根首字母保留；词根 cinta；及物动词，常见宾语 negara,动词;-i 动词\nms-0726,ms,ms-10,menghadiri,出席,Ibu menghadiri mesyuarat di sekolah.,母亲出席学校的会议。,meN- + hadir + -i → menghadiri，meng-，词根首字母保留；词根 hadir；及物动词，常见宾语 mesyuarat,动词;-i 动词\nms-0727,ms,ms-10,mengikuti,跟随；参加,Saya mengikuti kelas bahasa Melayu.,我参加马来语课。,meN- + ikut + -i → mengikuti，meng-，词根首字母保留；词根 ikut；及物动词，常见宾语 kelas,动词;-i 动词\nms-0728,ms,ms-10,menyertai,参加,Ali menyertai lawatan ke Pulau Pinang.,阿里参加去槟城的参观活动。,meN- + serta + -i → menyertai，meny-，s 脱落；词根 serta；及物动词，常见宾语 lawatan,动词;-i 动词\nms-0729,ms,ms-10,memiliki,拥有,Siti memiliki sebuah basikal merah.,西蒂拥有一辆红自行车。,meN- + milik + -i → memiliki，me-，词根首字母保留；词根 milik；及物动词，常见宾语 basikal,动词;-i 动词\nms-0730,ms,ms-10,mengetahui,知道,Guru mengetahui alamat rumah saya.,老师知道我家的地址。,meN- + tahu + -i → mengetahui；词根 tahu；特殊形式，整词记忆；常见宾语 alamat,动词;-i 动词\nms-0731,ms,ms-10,menghormati,尊重,Kita mesti menghormati guru dan ibu bapa.,我们必须尊重老师和父母。,meN- + hormat + -i → menghormati，meng-，词根首字母保留；词根 hormat；及物动词，常见宾语 guru,动词;-i 动词\nms-0732,ms,ms-10,menikmati,享受,Mereka menikmati makanan di restoran itu.,他们在那家餐馆享用美食。,meN- + nikmat + -i → menikmati，me-，词根首字母保留；词根 nikmat；及物动词，常见宾语 makanan,动词;-i 动词\nms-0733,ms,ms-10,melayani,对待；接待,Ali melayani tetamu dengan baik.,阿里好好地招待客人。,meN- + layan + -i → melayani，me-，词根首字母保留；词根 layan；及物动词，常见宾语 tetamu,动词;-i 动词\nms-0734,ms,ms-10,mengakhiri,结束,Guru mengakhiri kelas pada pukul lima.,老师五点结束课程。,meN- + akhir + -i → mengakhiri，meng-，词根首字母保留；词根 akhir；及物动词，常见宾语 kelas,动词;-i 动词\nms-0735,ms,ms-10,mengulangi,重复,Saya mengulangi perkataan itu dengan jelas.,我清楚地重复那个词。,meN- + ulang + -i → mengulangi，meng-，词根首字母保留；词根 ulang；及物动词，常见宾语 perkataan,动词;-i 动词\nms-0736,ms,ms-10,mengatasi,克服；解决,Kami mengatasi masalah itu bersama.,我们一起解决那个问题。,meN- + atas + -i → mengatasi，meng-，词根首字母保留；词根 atas；及物动词，常见宾语 masalah,动词;-i 动词\nms-0737,ms,ms-10,mendekati,靠近,Jangan mendekati sungai yang dalam.,不要靠近水深的河流。,meN- + dekat + -i → mendekati，men-，词根首字母保留；词根 dekat；及物动词，常见宾语 sungai,动词;-i 动词\nms-0738,ms,ms-10,menghubungi,联系,Saya menghubungi kakak dengan telefon.,我用电话联系姐姐。,meN- + hubung + -i → menghubungi，meng-，词根首字母保留；词根 hubung；及物动词，常见宾语 kakak,动词;-i 动词\nms-0739,ms,ms-10,menemani,陪伴,Siti menemani ibunya ke pasar.,西蒂陪母亲去市场。,meN- + teman + -i → menemani，men-，t 脱落；词根 teman；及物动词，常见宾语 ibu,动词;-i 动词\nms-0740,ms,ms-10,merawati,照料,Jururawat merawati adik di hospital.,护士在医院照料弟弟。,meN- + rawat + -i → merawati，me-，词根首字母保留；词根 rawat；及物动词，常见宾语 adik,动词;-i 动词\nms-0741,ms,ms-10,mengubati,医治,Doktor mengubati orang yang sakit.,医生医治病人。,meN- + ubat + -i → mengubati，meng-，词根首字母保留；词根 ubat；及物动词，常见宾语 orang sakit,动词;-i 动词\nms-0742,ms,ms-10,melindungi,保护,Payung ini melindungi kita daripada hujan.,这把伞保护我们不受雨淋。,meN- + lindung + -i → melindungi，me-，词根首字母保留；词根 lindung；及物动词，常见宾语 kita,动词;-i 动词\nms-0743,ms,ms-10,melengkapi,补全,Pelajar melengkapi nota dengan contoh.,学生用例子补全笔记。,meN- + lengkap + -i → melengkapi，me-，词根首字母保留；词根 lengkap；及物动词，常见宾语 nota,动词;-i 动词\nms-0744,ms,ms-10,menyelidiki,调查研究,Pelajar menyelidiki sejarah bandar itu.,学生研究那座城市的历史。,meN- + selidik + -i → menyelidiki，meny-，s 脱落；词根 selidik；及物动词，常见宾语 sejarah,动词;-i 动词\nms-0745,ms,ms-10,menguasai,掌握,Saya mahu menguasai bahasa Melayu.,我想掌握马来语。,meN- + kuasa + -i → menguasai，meng-，k 脱落；词根 kuasa；及物动词，常见宾语 bahasa,动词;-i 动词\nms-0746,ms,ms-10,mendatangkan,带来,Program itu mendatangkan hasil yang baik.,那个活动带来良好的成果。,meN- + datang + -kan → mendatangkan，men-，词根首字母保留；词根 datang；及物动词，常见宾语 hasil,动词;-kan／-i 对比\nms-0747,ms,ms-10,menjauhkan,使远离,Ibu menjauhkan adik daripada sungai.,母亲让弟弟远离河流。,meN- + jauh + -kan → menjauhkan，men-，词根首字母保留；词根 jauh；及物动词，常见宾语 adik,动词;-kan／-i 对比\nms-0748,ms,ms-10,menempatkan,安置,Guru menempatkan pelajar di bilik baru.,老师把学生安置在新房间。,meN- + tempat + -kan → menempatkan，men-，t 脱落；词根 tempat；及物动词，常见宾语 pelajar,动词;-kan／-i 对比\nms-0749,ms,ms-10,menghadiahkan,赠送（物品）,Ali menghadiahkan buku kepada Siti.,阿里把书赠给西蒂。,meN- + hadiah + -kan → menghadiahkan，meng-，词根首字母保留；词根 hadiah；及物动词，常见宾语 buku,动词;-kan／-i 对比\nms-0750,ms,ms-10,menyiramkan,浇洒（液体）,Ibu menyiramkan air pada pokok bunga.,母亲把水浇在花木上。,meN- + siram + -kan → menyiramkan，meny-，s 脱落；词根 siram；及物动词，常见宾语 air,动词;-kan／-i 对比\nms-0751,ms,ms-10,mendatangi,来到；登门拜访,Mereka mendatangi rumah Ali untuk bertemu dengannya.,他们到阿里家去见他。,meN- + datang + -i → mendatangi，men-，词根首字母保留；词根 datang；及物动词，常见宾语 rumah,动词;-kan／-i 对比\nms-0752,ms,ms-10,menjauhi,避开；远离,Kita mesti menjauhi sungai itu.,我们必须远离那条河。,meN- + jauh + -i → menjauhi，men-，词根首字母保留；词根 jauh；及物动词，常见宾语 sungai,动词;-kan／-i 对比\nms-0753,ms,ms-10,menempati,占用；居住于,Kami menempati bilik di tingkat dua.,我们住在二楼的房间。,meN- + tempat + -i → menempati，men-，t 脱落；词根 tempat；及物动词，常见宾语 bilik,动词;-kan／-i 对比\nms-0754,ms,ms-10,menghadiahi,赠给（某人）,Ali menghadiahi Siti sebuah buku.,阿里赠给西蒂一本书。,meN- + hadiah + -i → menghadiahi，meng-，词根首字母保留；词根 hadiah；及物动词，常见宾语 Siti,动词;-kan／-i 对比\nms-0755,ms,ms-10,menyirami,浇灌（植物）,Ibu menyirami pokok bunga di kebun.,母亲浇灌园圃里的花木。,meN- + siram + -i → menyirami，meny-，s 脱落；词根 siram；及物动词，常见宾语 pokok,动词;-kan／-i 对比\nms-0756,ms,ms-10,negara,国家,Malaysia ialah negara saya.,马来西亚是我的国家。,量词 buah,名词;参观与联系\nms-0757,ms,ms-10,mesyuarat,会议,Mesyuarat itu pada hari Jumaat.,那场会议在星期五。,一般不用量词,名词;参观与联系\nms-0758,ms,ms-10,lawatan,参观；访问,Lawatan ke Melaka itu pada minggu depan.,去马六甲的参观活动在下周。,一般不用量词,名词;参观与联系\nms-0759,ms,ms-10,tetamu,客人,Kami menyediakan makanan untuk tetamu.,我们为客人准备食物。,量词 orang,名词;参观与联系\nms-0760,ms,ms-10,sungai,河流,Sungai itu dekat dengan kampung kami.,那条河靠近我们的村子。,量词 batang,名词;参观与联系\nms-0761,ms,ms-10,sejarah,历史,Saya membaca buku tentang sejarah Malaysia.,我读关于马来西亚历史的书。,一般不用量词,名词;参观与联系\nms-0762,ms,ms-10,tingkat,楼层,Bilik kami di tingkat tiga.,我们的房间在三楼。,一般不用量词,名词;参观与联系\nms-0763,ms,ms-10,tangga,楼梯,Tangga itu di sebelah pintu.,楼梯在门旁边。,量词 buah,名词;参观与联系\nms-0764,ms,ms-10,pantai,海滩,Mereka berjalan di pantai pada petang itu.,他们那天下午在海滩散步。,一般不用量词,名词;参观与联系\nms-0765,ms,ms-10,pulau,岛屿,Pulau itu kecil dan cantik.,那个岛又小又漂亮。,量词 buah,名词;参观与联系\nms-0766,ms,ms-10,bukit,小山,Kami melihat bukit dari tingkap hotel.,我们从酒店窗户看小山。,量词 buah,名词;参观与联系\nms-0767,ms,ms-10,gunung,山；高山,Gunung itu jauh dari bandar.,那座山远离城市。,量词 buah,名词;参观与联系\nms-0768,ms,ms-10,hutan,森林,Hutan itu dekat dengan sungai.,那片森林靠近河流。,一般不用量词,名词;参观与联系\nms-0769,ms,ms-10,ladang,农场,Petani bekerja di ladang pada pagi ini.,农民今天早晨在农场工作。,量词 buah,名词;参观与联系\nms-0770,ms,ms-10,kebun,园圃,Ibu menanam bunga di kebun.,母亲在园圃里种花。,量词 buah,名词;参观与联系\nms-0771,ms,ms-10,pokok,树,Ada pokok besar di depan rumah.,房子前面有棵大树。,量词 batang,名词;参观与联系\nms-0772,ms,ms-10,daun,叶子,Daun itu jatuh di atas meja.,那片叶子落在桌上。,量词 helai,名词;参观与联系\nms-0773,ms,ms-10,akar,根,Akar pokok itu panjang.,那棵树的根很长。,一般不用量词,名词;参观与联系\nms-0774,ms,ms-10,tanah,土壤,Tanah di kebun itu basah.,园圃里的土壤是湿的。,一般不用量词,名词;参观与联系\nms-0775,ms,ms-10,pasir,沙,Pasir di pantai itu panas.,海滩上的沙很热。,一般不用量词,名词;参观与联系\nms-0776,ms,ms-10,angin,风,Angin di pantai itu sejuk.,海滩上的风很凉爽。,一般不用量词,名词;参观与联系\nms-0777,ms,ms-10,cuaca,天气,Cuaca hari ini baik untuk lawatan.,今天的天气适合参观。,一般不用量词,名词;参观与联系\nms-0778,ms,ms-10,pengalaman,经历,Saya menulis tentang pengalaman di Melaka.,我写在马六甲的经历。,一般不用量词；整词学习,名词;参观与联系\nms-0779,ms,ms-10,peluang,机会,Kami ada peluang untuk bertemu dengan guru.,我们有机会和老师见面。,一般不用量词,名词;参观与联系\nms-0780,ms,ms-10,rancangan,计划,Rancangan kami ialah mengunjungi muzium esok.,我们的计划是明天参观博物馆。,一般不用量词；整词学习,名词;参观与联系\nms-0781,ms,ms-10,Saya ingin menyertai lawatan ini.,我想参加这次参观活动。,Saya ingin menyertai lawatan ini.,我想参加这次参观活动。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0782,ms,ms-10,Sila hubungi saya esok.,请明天联系我。,Sila hubungi saya esok.,请明天联系我。,整句识别；请求句保留 -i,动词;句型;phrase\nms-0783,ms,ms-10,Kami akan menghadiri mesyuarat itu.,我们会出席那场会议。,Kami akan menghadiri mesyuarat itu.,我们会出席那场会议。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0784,ms,ms-10,Ali menghadiahi ibunya satu helai baju.,阿里送给母亲一件衣服。,Ali menghadiahi ibunya satu helai baju.,阿里送给母亲一件衣服。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0785,ms,ms-10,Jangan menjauhi kawan tanpa sebab.,不要无缘无故疏远朋友。,Jangan menjauhi kawan tanpa sebab.,不要无缘无故疏远朋友。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0786,ms,ms-10,cara,方法,Cara ini mudah untuk pelajar baru.,这个方法对新学生来说很容易。,一般不用量词,名词;参观与联系;补充\nms-0787,ms,ms-10,tempat,地方,Tempat itu dekat dengan muzium.,那个地方靠近博物馆。,一般不用量词,名词;参观与联系;补充\nms-0788,ms,ms-10,masa,时间,Kami perlu masa untuk membaca buku ini.,我们需要时间读这本书。,一般不用量词,名词;参观与联系;补充\nms-0789,ms,ms-10,catatan,记录,Saya menulis catatan tentang lawatan itu.,我写下那次参观的记录。,一般不用量词；整词学习,名词;参观与联系;补充\nms-0790,ms,ms-10,sakit,生病的；痛的,Adik sakit dan perlu berehat di rumah.,弟弟病了，需要在家休息。,形容词，后置,形容词;参观与联系;补充\nms-0791,ms,ms-10,gembira,快乐,Kami gembira dapat bertemu dengan Siti.,我们很高兴能见到西蒂。,形容词，后置,形容词;参观与联系;补充\nms-0792,ms,ms-10,tenang,平静,Tempat ini tenang pada waktu pagi.,这个地方早晨很安静。,形容词，后置,形容词;参观与联系;补充\nms-0793,ms,ms-10,indah,美丽,Pantai di pulau itu sangat indah.,那个岛上的海滩很美。,形容词，后置,形容词;参观与联系;补充\nms-0794,ms,ms-10,sibuk,忙碌,Guru sibuk menyediakan bahan untuk kelas.,老师忙着准备上课材料。,形容词，后置,形容词;参观与联系;补充\nms-0795,ms,ms-10,perlahan,慢慢地,Ali berjalan dengan perlahan di tangga.,阿里在楼梯上慢慢走。,常用 dengan perlahan,副词;参观与联系;补充\nms-0796,ms,ms-10,menanam,种植,Ibu menanam pokok di kebun.,母亲在园圃里种树。,meN- + tanam → menanam，men-，t 脱落；词根 tanam；及物动词，常见宾语 pokok,动词;参观与联系;补充\nms-0797,ms,ms-10,jatuh,落下；跌倒,Daun itu jatuh ke dalam sungai.,那片叶子落进河里。,不及物动词；词根 jatuh,动词;参观与联系;补充\nms-0798,ms,ms-10,walaupun,虽然,\"Walaupun hujan, kami masih pergi ke muzium.\",虽然下雨，我们仍去博物馆。,引出让步,连词;参观与联系;补充\nms-0799,ms,ms-10,manakala,而（对照）,Ali membaca manakala Siti menulis nota.,阿里阅读，而西蒂记笔记。,连接对照内容,连词;参观与联系;补充\nms-0800,ms,ms-10,sama ada,是否；是……还是,Saya belum tahu sama ada Ali akan datang.,我还不知道阿里是否会来。,引出尚未确定的情况,连词;参观与联系;补充\nms-0801,ms,ms-11,dibaca,被阅读,Buku itu dibaca oleh Ali.,那本书由阿里阅读。,di- + baca；词根 baca；主动形 membaca；及物动词的被动形，常见宾语 buku 在被动句中作主语,动词;di- 被动\nms-0802,ms,ms-11,ditulis,被书写,Surat itu ditulis oleh Siti.,那封信由西蒂书写。,di- + tulis；词根 tulis；主动形 menulis；及物动词的被动形，常见宾语 surat 在被动句中作主语,动词;di- 被动\nms-0803,ms,ms-11,dibuka,被打开,Pintu perpustakaan dibuka pada pukul lapan.,图书馆的门八点打开。,di- + buka；词根 buka；主动形 membuka；及物动词的被动形，常见宾语 pintu 在被动句中作主语,动词;di- 被动\nms-0804,ms,ms-11,ditutup,被关闭,Tingkap itu ditutup oleh guru.,那扇窗由老师关上。,di- + tutup；词根 tutup；主动形 menutup；及物动词的被动形，常见宾语 tingkap 在被动句中作主语,动词;di- 被动\nms-0805,ms,ms-11,dibeli,被购买,Beras itu dibeli oleh ibu.,那些米由母亲购买。,di- + beli；词根 beli；主动形 membeli；及物动词的被动形，常见宾语 beras 在被动句中作主语,动词;di- 被动\nms-0806,ms,ms-11,dijual,被出售,Makanan ini dijual di pasar.,这些食物在市场上出售。,di- + jual；词根 jual；主动形 menjual；及物动词的被动形，常见宾语 makanan 在被动句中作主语,动词;di- 被动\nms-0807,ms,ms-11,dihantar,被送去,Surat itu dihantar ke pejabat semalam.,那封信昨天被送到办公室。,di- + hantar；词根 hantar；主动形 menghantar；及物动词的被动形，常见宾语 surat 在被动句中作主语,动词;di- 被动\nms-0808,ms,ms-11,dipilih,被选中,Buku ini dipilih oleh para pelajar.,这本书由学生们选中。,di- + pilih；词根 pilih；主动形 memilih；及物动词的被动形，常见宾语 buku 在被动句中作主语,动词;di- 被动\nms-0809,ms,ms-11,dibawa,被携带,Kotak itu dibawa ke dalam kelas.,那个盒子被搬进教室。,di- + bawa；词根 bawa；主动形 membawa；及物动词的被动形，常见宾语 kotak 在被动句中作主语,动词;di- 被动\nms-0810,ms,ms-11,disimpan,被存放,Alat itu disimpan di dalam almari.,那个工具存放在柜子里。,di- + simpan；词根 simpan；主动形 menyimpan；及物动词的被动形，常见宾语 alat 在被动句中作主语,动词;di- 被动\nms-0811,ms,ms-11,diberikan,被给予,Hadiah itu diberikan kepada Raju.,那份礼物给了拉朱。,di- + beri + -kan；词根 beri；主动形 memberikan；及物动词的被动形，常见宾语 hadiah 在被动句中作主语,动词;di- 被动\nms-0812,ms,ms-11,digunakan,被使用,Bilik itu digunakan untuk mesyuarat.,那个房间用于开会。,di- + guna + -kan；词根 guna；主动形 menggunakan；及物动词的被动形，常见宾语 bilik 在被动句中作主语,动词;di- 被动\nms-0813,ms,ms-11,disediakan,被准备；被提供,Makanan disediakan oleh Siti pada pagi ini.,食物今天早晨由西蒂准备。,di- + sedia + -kan；词根 sedia；主动形 menyediakan；及物动词的被动形，常见宾语 makanan 在被动句中作主语,动词;di- 被动\nms-0814,ms,ms-11,dijelaskan,被解释,Tujuan program dijelaskan oleh guru.,活动目的由老师解释。,di- + jelas + -kan；词根 jelas；主动形 menjelaskan；及物动词的被动形，常见宾语 tujuan 在被动句中作主语,动词;di- 被动\nms-0815,ms,ms-11,dibersihkan,被清洁,Dewan itu dibersihkan sebelum mesyuarat.,礼堂在会议前被打扫。,di- + bersih + -kan；词根 bersih；主动形 membersihkan；及物动词的被动形，常见宾语 dewan 在被动句中作主语,动词;di- 被动\nms-0816,ms,ms-11,diletakkan,被放置,Notis diletakkan di sebelah pintu.,通知贴放在门旁边。,di- + letak + -kan；词根 letak；主动形 meletakkan；及物动词的被动形，常见宾语 notis 在被动句中作主语,动词;di- 被动\nms-0817,ms,ms-11,dimasukkan,被放入,Borang itu dimasukkan ke dalam kotak.,那张表格被放进盒子里。,di- + masuk + -kan；词根 masuk；主动形 memasukkan；及物动词的被动形，常见宾语 borang 在被动句中作主语,动词;di- 被动\nms-0818,ms,ms-11,dikunjungi,被参观；被拜访,Muzium ini dikunjungi oleh pelajar sekolah.,这座博物馆有学校的学生来参观。,di- + kunjung + -i；词根 kunjung；主动形 mengunjungi；及物动词的被动形，常见宾语 muzium 在被动句中作主语,动词;di- 被动\nms-0819,ms,ms-11,dihadiri,被出席,Mesyuarat itu dihadiri oleh penduduk kampung.,那场会议有村民出席。,di- + hadir + -i；词根 hadir；主动形 menghadiri；及物动词的被动形，常见宾语 mesyuarat 在被动句中作主语,动词;di- 被动\nms-0820,ms,ms-11,diikuti,被参加；被跟随,Program itu diikuti oleh ramai pelajar.,那个活动有许多学生参加。,di- + ikut + -i；词根 ikut；主动形 mengikuti；及物动词的被动形，常见宾语 program 在被动句中作主语,动词;di- 被动\nms-0821,ms,ms-11,dewan,礼堂；大厅,Mesyuarat itu diadakan di dewan sekolah.,那场会议在学校礼堂举行。,量词 buah,名词;新闻与公共事务\nms-0822,ms,ms-11,notis,通知,Notis itu dibaca oleh semua guru.,所有老师都读了那则通知。,一般不用量词,名词;新闻与公共事务\nms-0823,ms,ms-11,penduduk,居民,Penduduk kampung berkumpul di dewan.,村民聚集在礼堂里。,量词 orang；整词学习,名词;新闻与公共事务\nms-0824,ms,ms-11,kerajaan,政府,Kerajaan menyediakan bantuan untuk sekolah.,政府为学校提供帮助。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0825,ms,ms-11,pegawai,官员；职员,Pegawai itu sedang membaca laporan.,那名职员正在读报告。,量词 orang；整词学习,名词;新闻与公共事务\nms-0826,ms,ms-11,menteri,部长,Menteri itu mengunjungi sekolah kami.,那位部长访问我们的学校。,量词 orang,名词;新闻与公共事务\nms-0827,ms,ms-11,ketua,负责人；领队,Ketua program memberikan maklumat kepada kami.,活动负责人向我们提供信息。,量词 orang,名词;新闻与公共事务\nms-0828,ms,ms-11,ahli,成员,Ahli kelab menghadiri mesyuarat petang ini.,俱乐部成员今天下午出席会议。,量词 orang,名词;新闻与公共事务\nms-0829,ms,ms-11,jawatankuasa,委员会,Jawatankuasa sekolah akan mengadakan mesyuarat esok.,学校委员会明天将召开会议。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0830,ms,ms-11,masyarakat,社会；社群,Program ini untuk masyarakat di bandar itu.,这个活动面向那座城市的社群。,一般不用量词,名词;新闻与公共事务\nms-0831,ms,ms-11,orang ramai,公众,Perpustakaan ini dibuka kepada orang ramai.,这座图书馆向公众开放。,一般不用量词；集合称呼,名词;新闻与公共事务\nms-0832,ms,ms-11,kesihatan,健康,Program kesihatan itu diadakan di klinik.,那个健康活动在诊所举行。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0833,ms,ms-11,keselamatan,安全,Keselamatan pelajar penting bagi sekolah.,学生安全对学校很重要。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0834,ms,ms-11,kebersihan,清洁；卫生,Kebersihan dewan mesti dijaga.,礼堂卫生必须得到维护。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0835,ms,ms-11,kemudahan,设施,Kemudahan di sekolah ini untuk semua pelajar.,这所学校的设施供所有学生使用。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0836,ms,ms-11,perkhidmatan,服务,Perkhidmatan bas itu bermula pada pukul enam.,那项公交服务六点开始。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0837,ms,ms-11,pengumuman,公告,Pengumuman itu dibuat oleh ketua program.,那则公告由活动负责人发布。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0838,ms,ms-11,laporan,报告,Laporan itu ditulis oleh pegawai sekolah.,那份报告由学校职员撰写。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0839,ms,ms-11,akhbar,报纸,Bapa membaca akhbar setiap pagi.,父亲每天早晨读报。,量词 naskhah,名词;新闻与公共事务\nms-0840,ms,ms-11,wartawan,记者,Wartawan itu bertanya tentang program sekolah.,那名记者询问学校活动的情况。,量词 orang,名词;新闻与公共事务\nms-0841,ms,ms-11,pembaca,读者,Pembaca akhbar itu mahu maklumat yang jelas.,那份报纸的读者想要清楚的信息。,量词 orang；整词学习,名词;新闻与公共事务\nms-0842,ms,ms-11,tajuk,标题,Tajuk berita ini pendek dan jelas.,这则新闻的标题简短清楚。,一般不用量词,名词;新闻与公共事务\nms-0843,ms,ms-11,peristiwa,事件,Wartawan melaporkan peristiwa itu dalam akhbar.,记者在报纸上报道那个事件。,一般不用量词,名词;新闻与公共事务\nms-0844,ms,ms-11,majlis,仪式；活动,Majlis sekolah bermula pada pukul sembilan.,学校的仪式九点开始。,一般不用量词,名词;新闻与公共事务\nms-0845,ms,ms-11,sukarelawan,志愿者,Sukarelawan membantu penduduk di dewan.,志愿者在礼堂帮助居民。,量词 orang,名词;新闻与公共事务\nms-0846,ms,ms-11,mengadakan,举办,Sekolah mengadakan program membaca pada hari Sabtu.,学校星期六举办阅读活动。,meN- + ada + -kan → mengadakan，meng-，词根首字母保留；词根 ada；及物动词，常见宾语 program,动词;公共事务动词\nms-0847,ms,ms-11,melaporkan,报道,Wartawan melaporkan berita dari Johor Bahru.,记者报道来自新山的新闻。,meN- + lapor + -kan → melaporkan，me-，词根首字母保留；词根 lapor；及物动词，常见宾语 berita,动词;公共事务动词\nms-0848,ms,ms-11,mengumumkan,宣布,Ketua mengumumkan tarikh mesyuarat itu.,负责人宣布那场会议的日期。,meN- + umum + -kan → mengumumkan，meng-，词根首字母保留；词根 umum；及物动词，常见宾语 tarikh,动词;公共事务动词\nms-0849,ms,ms-11,melaksanakan,执行,Jawatankuasa melaksanakan rancangan itu bersama.,委员会一起执行那个计划。,meN- + laksana + -kan → melaksanakan，me-，词根首字母保留；词根 laksana；及物动词，常见宾语 rancangan,动词;公共事务动词\nms-0850,ms,ms-11,membincangkan,讨论,Kami membincangkan masalah kebersihan sekolah.,我们讨论学校卫生问题。,meN- + bincang + -kan → membincangkan，mem-，词根首字母保留；词根 bincang；及物动词，常见宾语 masalah,动词;公共事务动词\nms-0851,ms,ms-11,menguruskan,办理；管理,Pegawai menguruskan borang untuk program itu.,职员办理那个活动的表格。,meN- + urus + -kan → menguruskan，meng-，词根首字母保留；词根 urus；及物动词，常见宾语 borang,动词;公共事务动词\nms-0852,ms,ms-11,mengesahkan,确认,Guru mengesahkan nama pelajar pada borang.,老师确认表格上的学生姓名。,meN- + sah + -kan → mengesahkan，menge-，单音节词根 sah 保留；及物动词，常见宾语 nama,动词;公共事务动词\nms-0853,ms,ms-11,membenarkan,允许,Guru membenarkan kami menggunakan bilik ini.,老师允许我们使用这个房间。,meN- + benar + -kan → membenarkan，mem-，词根首字母保留；词根 benar；及物动词，常见宾语 kami + 动作,动词;公共事务动词\nms-0854,ms,ms-11,menjaga,照顾；维护,Kami menjaga kebersihan taman.,我们维护公园的卫生。,meN- + jaga → menjaga，men-，词根首字母保留；词根 jaga；及物动词，常见宾语 kebersihan,动词;公共事务动词\nms-0855,ms,ms-11,memeriksa,检查,Pegawai memeriksa alat di dewan.,职员检查礼堂里的工具。,meN- + periksa → memeriksa，mem-，p 脱落；词根 periksa；及物动词，常见宾语 alat,动词;公共事务动词\nms-0856,ms,ms-11,melapor,报告；报到,Sukarelawan melapor kepada ketua sebelum bekerja.,志愿者工作前向负责人报到。,meN- + lapor → melapor，me-，词根首字母保留；词根 lapor；常作不及物，用 kepada 引出报告对象,动词;公共事务动词\nms-0857,ms,ms-11,mencatat,记录,Wartawan mencatat nama ketua program.,记者记录活动负责人的姓名。,meN- + catat → mencatat，men-，词根首字母保留；词根 catat；及物动词，常见宾语 nama,动词;公共事务动词\nms-0858,ms,ms-11,menyokong,支持,Penduduk menyokong program membaca itu.,居民支持那个阅读活动。,meN- + sokong → menyokong，meny-，s 脱落；词根 sokong；及物动词，常见宾语 program,动词;公共事务动词\nms-0859,ms,ms-11,bermula,开始,Majlis itu bermula pada pukul sepuluh.,那个仪式十点开始。,ber- + mula；词根 mula；不及物动词,动词;公共事务动词\nms-0860,ms,ms-11,berakhir,结束,Mesyuarat berakhir sebelum tengah hari.,会议在中午前结束。,ber- + akhir；词根 akhir；不及物动词,动词;公共事务动词\nms-0861,ms,ms-11,serta,以及,Guru serta pelajar membersihkan dewan.,老师和学生打扫礼堂。,连接并列成分,连词;新闻连接\nms-0862,ms,ms-11,namun,然而,\"Hujan turun, namun majlis itu masih berjalan.\",下雨了，然而活动仍在进行。,连接转折,连词;新闻连接\nms-0863,ms,ms-11,maka,于是,\"Dewan sudah penuh, maka kami menunggu di luar.\",礼堂已经满了，于是我们在外面等候。,连接结果,连词;新闻连接\nms-0864,ms,ms-11,agar,以便,Notis ditulis dengan jelas agar semua orang faham.,通知写得很清楚，以便所有人理解。,引出目的,连词;新闻连接\nms-0865,ms,ms-11,iaitu,即；也就是,\"Kami bertemu ketua program, iaitu Raju.\",我们见到了活动负责人，也就是拉朱。,引出具体说明,连词;新闻连接\nms-0866,ms,ms-11,Buku itu dibaca oleh Ali.,那本书由阿里阅读。,Buku itu dibaca oleh Ali.,那本书由阿里阅读。,整句识别；第三人称施事被动,动词;句型;phrase\nms-0867,ms,ms-11,Makanan disediakan di dewan.,食物在礼堂供应。,Makanan disediakan di dewan.,食物在礼堂供应。,整句识别；前缀 di- 连写，介词 di 分写,动词;句型;phrase\nms-0868,ms,ms-11,Sila baca notis ini.,请阅读这则通知。,Sila baca notis ini.,请阅读这则通知。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0869,ms,ms-11,Majlis itu akan diadakan esok.,那个活动将在明天举行。,Majlis itu akan diadakan esok.,那个活动将在明天举行。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0870,ms,ms-11,Borang mesti dihantar sebelum Jumaat.,表格必须在星期五前送交。,Borang mesti dihantar sebelum Jumaat.,表格必须在星期五前送交。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0871,ms,ms-11,ramai,众多（人）,Ramai pelajar membaca di perpustakaan.,许多学生在图书馆阅读。,形容词，后置；表示人多时常放在名词前，如 ramai pelajar；也可作谓语，如 Pelajar di sini ramai,形容词;公共事务;补充\nms-0872,ms,ms-11,rasmi,正式,Surat rasmi itu ditulis oleh ketua.,那封正式信函由负责人撰写。,形容词，后置,形容词;公共事务;补充\nms-0873,ms,ms-11,awam,公共,Perpustakaan awam itu dekat dengan stesen.,那座公共图书馆靠近车站。,形容词，后置,形容词;公共事务;补充\nms-0874,ms,ms-11,percuma,免费的,Buku percuma itu untuk semua pelajar.,那些免费书籍供所有学生领取。,形容词，后置,形容词;公共事务;补充\nms-0875,ms,ms-11,taraf,水平,Taraf kebersihan sekolah ini baik.,这所学校的卫生水平良好。,一般不用量词,名词;公共事务;补充\nms-0876,ms,ms-11,turun,落下；下降,Hujan turun sejak pagi.,雨从早晨开始下。,不及物动词；词根 turun,动词;公共事务;补充\nms-0877,ms,ms-11,secara,以……方式,Guru menjelaskan tugas secara jelas.,老师清楚地说明任务。,后接方式词；整词学习,副词;公共事务;补充\nms-0878,ms,ms-11,naskhah,册；份（出版物）,Dua naskhah akhbar itu di atas meja.,那两份报纸在桌上。,量词 作为计量名词，量词本身不再加量词,量词;公共事务;补充\nms-0879,ms,ms-11,jumlah,总数,Jumlah pelajar dalam kelas ini dua puluh orang.,这个班的学生总数是二十人。,一般不用量词,名词;公共事务;补充\nms-0880,ms,ms-11,jadual,时间表,Jadual program itu diletakkan di depan dewan.,活动时间表贴放在礼堂前面。,一般不用量词,名词;公共事务;补充\nms-0881,ms,ms-12,terjatuh,跌倒；意外掉落,Ali terjatuh di tangga semalam.,阿里昨天在楼梯上跌倒了。,ter- + jatuh；词根 jatuh；意外；不及物,动词;ter- 形式\nms-0882,ms,ms-12,tertidur,不知不觉睡着,Adik tertidur selepas membaca buku itu.,弟弟读完那本书后不知不觉睡着了。,ter- + tidur；词根 tidur；意外；不及物,动词;ter- 形式\nms-0883,ms,ms-12,terlupa,忘记,Saya terlupa membawa pen ke kelas.,我忘了带笔去上课。,ter- + lupa；词根 lupa；意外；常接动作内容,动词;ter- 形式\nms-0884,ms,ms-12,terangkat,抬得动,Kotak berat itu tidak terangkat oleh Ali.,阿里抬不动那个重盒子。,ter- + angkat；词根 angkat；能力；常见宾语 kotak 在此作主语,动词;ter- 形式\nms-0885,ms,ms-12,terbaca,读得清；能读,Tulisan kecil itu tidak terbaca oleh ibu.,母亲读不清那些小字。,ter- + baca；词根 baca；能力；常见宾语 tulisan 在此作主语,动词;ter- 形式\nms-0886,ms,ms-12,terbuka,开着的,Pintu bilik itu masih terbuka.,那个房间的门仍开着。,ter- + buka；词根 buka；状态；不及物,动词;ter- 形式\nms-0887,ms,ms-12,tertutup,关着的,Tingkap dapur itu tertutup sejak pagi.,厨房的窗户从早晨起就关着。,ter- + tutup；词根 tutup；状态；不及物,动词;ter- 形式\nms-0888,ms,ms-12,tertinggal,被落下；遗留,Buku saya tertinggal di sekolah.,我的书落在学校了。,ter- + tinggal；词根 tinggal；意外；状态,动词;ter- 形式\nms-0889,ms,ms-12,terambil,误拿,Ali terambil buku Siti kerana warnanya sama.,阿里因书的颜色相同而误拿了西蒂的书。,ter- + ambil；词根 ambil；意外；及物，常见宾语 buku,动词;ter- 形式\nms-0890,ms,ms-12,terdengar,无意间听到,Saya terdengar suara guru dari luar kelas.,我从教室外无意间听到老师的声音。,ter- + dengar；词根 dengar；意外；及物，常见宾语 suara,动词;ter- 形式\nms-0891,ms,ms-12,tertulis,写在上面的,Nama Raju tertulis pada kotak itu.,拉朱的名字写在那个盒子上。,ter- + tulis；词根 tulis；状态；常见宾语 nama 在此作主语,动词;ter- 形式\nms-0892,ms,ms-12,tersusun,排列整齐的,Buku-buku itu tersusun di atas rak.,那些书整齐地摆在架子上。,ter- + susun；词根 susun；状态；常见宾语 buku 在此作主语,动词;ter- 形式\nms-0893,ms,ms-12,imbuhan,词缀,Imbuhan ini ada di depan kata dasar.,这个词缀在词根前面。,一般不用量词；整词学习,名词;复习与学习\nms-0894,ms,ms-12,awalan,前缀,Awalan ini mengubah maksud perkataan.,这个前缀改变词的意思。,一般不用量词；整词学习,名词;复习与学习\nms-0895,ms,ms-12,akhiran,后缀,Akhiran ini ada di hujung perkataan.,这个后缀在词的末尾。,一般不用量词；整词学习,名词;复习与学习\nms-0896,ms,ms-12,kata dasar,词根,Kata dasar itu belum saya tulis.,那个词根我还没写。,一般不用量词,名词;复习与学习\nms-0897,ms,ms-12,ayat,句子,Ayat ini sudah saya baca.,这个句子我已经读过了。,一般不用量词,名词;复习与学习\nms-0898,ms,ms-12,ejaan,拼写,Ejaan perkataan ini mesti kita periksa.,这个词的拼写我们必须检查。,一般不用量词；整词学习,名词;复习与学习\nms-0899,ms,ms-12,makna,意义,Makna ayat itu jelas bagi saya.,那个句子的意义对我来说很清楚。,一般不用量词,名词;复习与学习\nms-0900,ms,ms-12,subjek,主语,Subjek ayat ini ialah Ali.,这个句子的主语是阿里。,一般不用量词,名词;复习与学习\nms-0901,ms,ms-12,objek,宾语,Objek dalam ayat itu ialah buku.,那个句子中的宾语是书。,一般不用量词,名词;复习与学习\nms-0902,ms,ms-12,pelaku,施事；动作执行者,Pelaku dalam ayat ini ialah Siti.,这个句子中的施事是西蒂。,量词 orang；整词学习,名词;复习与学习\nms-0903,ms,ms-12,jawapan,答案,Jawapan itu sudah saya tulis.,那个答案我已经写好了。,一般不用量词；整词学习,名词;复习与学习\nms-0904,ms,ms-12,kesalahan,错误,Kesalahan ejaan itu perlu kita catat.,那个拼写错误我们需要记下来。,一般不用量词；整词学习,名词;复习与学习\nms-0905,ms,ms-12,ulang kaji,复习,Ulang kaji perlu dibuat setiap minggu.,复习需要每周进行。,学习活动名词，一般不用量词；分写 ulang kaji,名词;复习与学习\nms-0906,ms,ms-12,ujian,测验,Ujian ini untuk semua pelajar di kelas.,这项测验面向班里所有学生。,一般不用量词；整词学习,名词;复习与学习\nms-0907,ms,ms-12,tulisan,文字；书写,Tulisan pada kertas itu sangat kecil.,那张纸上的字很小。,一般不用量词；整词学习,名词;复习与学习\nms-0908,ms,ms-12,Buku itu saya baca.,那本书由我来读。,Buku itu saya baca.,那本书由我来读。,整句识别；宾语前置，第一人称施事紧接光杆动词,动词;句型;phrase\nms-0909,ms,ms-12,Surat ini awak tulis?,这封信是你写的吗？,Surat ini awak tulis?,这封信是你写的吗？,整句识别；第二人称施事被动,动词;句型;phrase\nms-0910,ms,ms-12,Buku itu belum saya baca.,那本书我还没读。,Buku itu belum saya baca.,那本书我还没读。,整句识别；belum 在施事代词前,动词;句型;phrase\nms-0911,ms,ms-12,Tugas ini akan kami selesaikan.,这项任务我们会完成。,Tugas ini akan kami selesaikan.,这项任务我们会完成。,整句识别；去掉 meN-，保留 -kan,动词;句型;phrase\nms-0912,ms,ms-12,Muzium itu sudah kita kunjungi.,那座博物馆我们已经参观过。,Muzium itu sudah kita kunjungi.,那座博物馆我们已经参观过。,整句识别；去掉 meN-，保留 -i,动词;句型;phrase\nms-0913,ms,ms-12,Pintu itu jangan awak buka.,那扇门你不要打开。,Pintu itu jangan awak buka.,那扇门你不要打开。,整句识别；jangan 在施事代词前,动词;句型;phrase\nms-0914,ms,ms-12,Kotak itu tidak terangkat oleh Raju.,拉朱抬不动那个盒子。,Kotak itu tidak terangkat oleh Raju.,拉朱抬不动那个盒子。,整句识别；ter- 表能力，第三人称施事,动词;句型;phrase\nms-0915,ms,ms-12,Saya tertidur semasa membaca.,我读书时不知不觉睡着了。,Saya tertidur semasa membaca.,我读书时不知不觉睡着了。,整句识别；ter- 表意外,动词;句型;phrase\nms-0916,ms,ms-12,suara,声音；嗓音,Suara guru itu jelas dari belakang kelas.,从教室后面也能清楚听见老师的声音。,一般不用量词,名词;复习与学习;补充\nms-0917,ms,ms-12,warna,颜色,Warna buku Ali sama dengan warna buku Siti.,阿里和西蒂的书颜色相同。,一般不用量词,名词;复习与学习;补充\nms-0918,ms,ms-12,sama,相同,Dua buku ini sama warnanya.,这两本书的颜色相同。,形容词，后置,形容词;复习与学习;补充\nms-0919,ms,ms-12,semasa,在……期间,Jangan berbual semasa guru menerangkan ayat.,老师说明句子时不要聊天。,引出同时发生的动作,连词;复习与学习;补充\nms-0920,ms,ms-12,mengubah,改变,Imbuhan boleh mengubah makna kata dasar.,词缀可以改变词根的意义。,meN- + ubah → mengubah，meng-，词根首字母保留；词根 ubah；及物动词，常见宾语 makna,动词;复习与学习;补充\n";
const M5_LESSONS=['ms-17','ms-18','ms-19','ms-20'];
const M5_READINGS=Array.from({length:8},(_,i)=>'ms-r'+(31+i));
const ms5Rows=initialRows.filter(r=>M5_LESSONS.includes(r.lesson));
const M5_TEXTS=()=>[
  ...ms5Rows.map(r=>({id:r.id,lesson:r.lesson,text:r.example})),
  ...M5_LESSONS.flatMap(id=>[...api.LESSONS[id].reading.sentences,...ms3LangSentences(api.LESSONS[id])].map(s=>({id,lesson:id,...s}))),
  ...M5_READINGS.flatMap(id=>api.READINGS[id].sentences.map(s=>({id,lesson:api.READINGS[id].afterLesson,...s})))
];
test('任务 M5：四课日期、时长、目标、写作任务和复盘提示符合参数表',()=>{
  const start=Date.UTC(2026,9,5);
  const short=d=>String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
  for(const [i,id] of M5_LESSONS.entries()){
    const l=api.LESSONS[id],week=17+i;
    assert.equal(l.lang,'ms');assert.equal(l.week,week);
    const first=new Date(start+(week-1)*7*86400000),last=new Date(start+((week-1)*7+6)*86400000);
    assert.equal(l.dates,first.getUTCFullYear()+' 年 '+short(first)+' 至 '+short(last));
    assert.equal(l.dailyTime,'每天 20 分钟 + 每周 1 次系统块 30 分钟');
    for(const key of ['name','goal','writingTask'])assert(l[key]?.trim(),id+' '+key);
    const p=msWalk(parseNodes(l.explanation())).find(n=>n.tag==='p').textContent;
    for(const text of [l.dailyTime,'配合《Complete Malay》的对应单元，单元以实际教材为准','时间分配以复盘结果为准'])assert(p.includes(text),id+' '+text);
  }
  assert.match(api.LESSONS['ms-18'].writingTask,/100 词.*5 个/);
  for(const id of ['ms-17','ms-19','ms-20'])assert.match(api.LESSONS[id].writingTask,/5 句/);
  assert.equal(initialState.settings.newPerDay.ms,10);
});
test('任务 M5：320 条固定 id 连续，每课 80 条，CSV 同源同步且 front 唯一',()=>{
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8')));
  assert.deepEqual(csv,initialRows.filter(r=>r.lang==='ms'));
  assert.equal(ms5Rows.length,320);
  const ids=Array.from({length:320},(_,i)=>'ms-'+String(1241+i).padStart(4,'0'));
  assert.deepEqual(ms5Rows.map(r=>r.id),ids);
  assert.deepEqual(initialRows.filter(r=>r.lang==='ms'&&Number(r.id.slice(3))>=1241&&Number(r.id.slice(3))<=1560),ms5Rows);
  const fronts=csv.map(r=>r.front.toLowerCase());assert.equal(new Set(fronts).size,fronts.length);
  for(const id of M5_LESSONS)assert.equal(ms5Rows.filter(r=>r.lesson===id).length,80,id);
  const first=initialRows.findIndex(r=>r.id===ids[0]);assert.deepEqual(initialRows.slice(first,first+320),ms5Rows);
  const lessonIds=Object.keys(api.LESSONS),start=lessonIds.indexOf('ms-17');
  assert.deepEqual(lessonIds.slice(start,start+4),M5_LESSONS);
  assert.equal(lessonIds[start-1],'ms-16');
});
test('任务 M5：四课主题配额、整句和补充标签完整',()=>{
  const expected={
    'ms-17':{'原因与条件':15,'生活事件':30,'处理生活事件':20,'事件评述':10,'复合句整句':5},
    'ms-18':{'目的与时间关系':15,'一天与旅行':25,'旅行过程':20,'一天的先后':10,'时间关系整句':5,'旅行状态':5},
    'ms-19':{'言语动词':15,'引述与说明':8,'消息与转述':30,'核实与交流':15,'转述整句':7,'转述与判断':5},
    'ms-20':{'语气与强调':15,'口语代词与缩略':15,'社交与网络':20,'网络交流':15,'语气整句':5,'书面与网络语体':10}
  };
  for(const [id,counts] of Object.entries(expected))for(const [tag,n] of Object.entries(counts))
    assert.equal(ms5Rows.filter(r=>r.lesson===id&&r.tags.split(';').includes(tag)).length,n,id+' '+tag);
  for(const [i,id] of M5_LESSONS.entries())assert.equal(ms5Rows.filter(r=>r.lesson===id&&r.tags.split(';').includes('补充')).length,[5,5,5,10][i]);
  assert.equal(ms5Rows.filter(r=>r.lesson==='ms-17'&&r.tags.startsWith('名词;')).length,25);
  for(const [i,id] of M5_LESSONS.entries())assert.equal(ms5Rows.filter(r=>r.lesson===id&&/[.!?]$/.test(r.front)).length,[5,5,7,5][i]);
});
test('任务 M5：例句含完整 front，量词、词类注释、短语识别方向与拼写挖空一致',()=>{
  const kinds=new Set('名词 动词 形容词 代词 数词 量词 介词 连词 副词 助动词 语气词 疑问词 问候'.split(' '));
  for(const r of ms5Rows){
    const tags=r.tags.split(';');assert(kinds.has(tags[0]),r.id);assert(!tags.includes('letter'));
    assert(r.note.trim()&&/[\u4e00-\u9fff]/.test(r.back)&&/[\u4e00-\u9fff]/.test(r.example_zh));
    assert(/[.!?]$/.test(r.example),r.id);assert(r.example.toLowerCase().includes(r.front.toLowerCase()),r.id+' 原形');
    if(/[.!?]$/.test(r.front))assert(tags.includes('phrase'),r.id);
    if(tags[0]==='名词')assert.match(r.note,/量词/,r.id);
    if(tags[0]==='形容词')assert.match(r.note,/形容词，后置/,r.id);
    if(tags[0]==='动词'&&/及物/.test(r.note)&&!/不及物/.test(r.note))assert.match(r.note,/宾语/,r.id);
    assert.deepEqual(plain(api.expandCards([r]).map(c=>c.direction)),tags.includes('phrase')?['r']:['r','p'],r.id);
    if(!tags.includes('phrase'))assert(api.clozeExample(r).includes('____'),r.id);
  }
  for(const front of ['mengenal pasti','memuat naik','memuat turun','log masuk','log keluar','berkenaan dengan','berhubung dengan','ruang menunggu'])
    assert(ms5Rows.find(r=>r.front===front).tags.split(';').includes('phrase'),front);
});
test('任务 M5：meN- 注释写出词根、变形和宾语，复合词与不规则词按整词学习',()=>{
  for(const r of ms5Rows.filter(r=>r.tags.startsWith('动词;')&&r.note.startsWith('meN- + '))){
    assert.match(r.note,/词根/,r.id);assert.match(r.note,/脱落|保留/,r.id);
    const m=r.note.match(/^meN- \+ ([a-z]+)(?: \+ -(kan|i))? → ([a-z]+)/);
    if(r.note.includes('特殊形式')||r.front==='memberitahu'||r.front==='mengeklik'||r.front.includes(' '))continue;
    assert(m,r.id);assert.equal(msMenForm(m[1])+(m[2]||''),r.front,r.id);
    assert.equal(m[3],r.front,r.id);
    const rule=msMenRule(m[1]);assert(r.note.includes(rule.prefix),r.id);
    assert(r.note.includes(rule.keep?'保留':m[1][0]+' 脱落'),r.id);
  }
  assert.match(ms5Rows.find(r=>r.front==='memahami').note,/特殊形式.*整词/);
  assert.match(ms5Rows.find(r=>r.front==='mempercayai').note,/特殊形式.*整词/);
});
test('任务 M5：马来西亚拼写与释义，印尼语拼写只允许在明确注释对照里出现',()=>{
  const banned=new Set('karena uang kantor universitas bahwa senin delapan mau saja sepeda sepatu kamar bisa kemarin'.split(' '));
  for(const s of [...M5_TEXTS(),...ms5Rows.map(r=>({id:r.id,text:r.front}))])
    for(const w of msWords(s.text).map(w=>w.toLowerCase()))assert(!banned.has(w),s.id+' '+w);
  for(const r of ms5Rows)for(const w of msWords(r.note).map(w=>w.toLowerCase()))if(banned.has(w))assert(r.note.includes('印尼语作'),r.id);
  for(const s of M5_TEXTS())assert(!/\bsenang\b(?!\s+hati)/i.test(s.text),s.id+' 高兴用 senang hati');
});
test('任务 M5：口语卡均带口语与 phrase，固定缩略仅在 ms-20 和 ms-r37 的教学内容中出现',()=>{
  const casual=ms5Rows.filter(r=>r.tags.split(';').includes('口语'));
  assert.equal(casual.length,15);
  for(const r of casual){assert.equal(r.lesson,'ms-20');assert(r.tags.split(';').includes('phrase'));assert.deepEqual(plain(api.expandCards([r]).map(c=>c.direction)),['r']);}
  const forms=['aku','kau','engkau','kamu','tak','nak','dah','je','ni','tu','mana','macam mana','ke apa','diorang','kitorang'];
  assert.deepEqual(casual.map(r=>r.front).sort(),forms.sort());
  const informal=new Set('aku kau engkau tak nak dah je ni tu diorang kitorang'.split(' '));
  const segments=[
    ...initialRows.filter(r=>r.lang==='ms').flatMap(r=>[{id:r.lesson,text:r.front},{id:r.lesson,text:r.example}]),
    ...Object.entries(api.LESSONS).filter(([,l])=>l.lang==='ms').flatMap(([id,l])=>[...(l.reading?.sentences||[]),...ms3LangSentences(l)].map(s=>({id,text:s.text}))),
    ...Object.values(api.READINGS).filter(r=>r.lang==='ms').flatMap(r=>r.sentences.map(s=>({id:r.id,text:s.text})))
  ];
  for(const s of segments)for(const w of msWords(s.text).map(w=>w.toLowerCase()))
    if(informal.has(w))assert(['ms-20','ms-r37'].includes(s.id),s.id+' '+w);
  assert.match(api.LESSONS['ms-20'].reading.title,/口语文本，写作时不用/);
  assert.match(api.READINGS['ms-r37'].title,/口语文本，写作时不用/);
});
test('任务 M5：每课六道语言题与四道共用阅读题，选择答案唯一且填空有提示',()=>{
  for(const id of M5_LESSONS){
    const l=api.LESSONS[id];assert.equal(l.exercises.length,10);assert.equal(l.reading.questions.length,4);
    assert.deepEqual(l.exercises.slice(6),l.reading.questions);
    for(let i=0;i<4;i++)assert.strictEqual(l.exercises[i+6],l.reading.questions[i]);
    assert(l.exercises.slice(0,6).every(q=>!q.prompt.startsWith('阅读')));
    assert(l.exercises.slice(6).every(q=>q.prompt.startsWith('阅读：')));
    for(const q of l.exercises){
      assert(q.prompt&&q.answer?.trim());
      if(q.options){assert.equal(q.options.filter(o=>o===q.answer).length,1);assert.equal(new Set(q.options).size,q.options.length);}
      if(q.prompt.includes('____'))assert(/[（(].+[）)]/.test(q.prompt),id+' 缺提示');
      if(!q.options)assert(!/[.!?]$/.test(q.answer),id+' 填空答案为词或短语');
    }
  }
});
test('任务 M5：四篇课内阅读均为 230–300 词、16–20 句，逐句中文完整',()=>{
  for(const id of M5_LESSONS){
    const r=api.LESSONS[id].reading,n=msWordCount(r.sentences);assert(r.title);
    assert(n>=230&&n<=300,id+' '+n);assert(r.sentences.length>=16&&r.sentences.length<=20,id);
    for(const s of r.sentences){assert(/[\u4e00-\u9fff]/.test(s.zh));assert(/[.!?]$/.test(s.text),id+' '+s.text);}
  }
  for(const [id,genre] of [['ms-17','日记'],['ms-18','短故事'],['ms-19','对话'],['ms-20','短信或便条']])assert(api.LESSONS[id].reading.title.includes(genre),id);
});
test('任务 M5：八篇阅读编号、周次、体裁、实际词数和句数符合各篇区间',()=>{
  const ids=Object.keys(api.READINGS),start=ids.indexOf('ms-r31');
  assert.deepEqual(ids.slice(start,start+8),M5_READINGS);assert.equal(ids[start-1],'ms-r30');
  const ranges=[[230,250,16,18],[230,250,16,18],[245,265,17,19],[240,260,16,18],[260,280,18,20],[255,275,17,19],[270,290,18,20],[280,300,18,20]];
  const genres=['日记','简单新闻','短故事','菜谱或日程','对话','邮件','短信或便条（口语）','说明文'];
  for(const [i,id] of M5_READINGS.entries()){
    const r=api.READINGS[id],[lo,hi,slo,shi]=ranges[i],week=17+Math.floor(i/2);
    assert.equal(r.id,id);assert.equal(r.lang,'ms');assert.equal(r.week,week);assert.equal(r.afterLesson,'ms-'+week);
    assert.equal(r.genre,genres[i]);assert(/[\u4e00-\u9fff]/.test(r.title));
    assert.equal(r.words,msWordCount(r.sentences));assert(r.words>=lo&&r.words<=hi,id+' '+r.words);
    assert(r.sentences.length>=slo&&r.sentences.length<=shi,id);
    assert(r.sentences.every(s=>s.text&&/[\u4e00-\u9fff]/.test(s.zh)&&/[.!?]$/.test(s.text)));
    if(i%2)assert.notEqual(r.genre,api.READINGS[M5_READINGS[i-1]].genre);
  }
});
test('任务 M5：阅读线三道事实题与一道推断题，五个已学关键词在文中，五行复述',()=>{
  for(const id of M5_READINGS){
    const r=api.READINGS[id],known=new Set(initialRows.filter(row=>row.lang==='ms'&&row.lesson<=r.afterLesson).map(row=>row.front.toLowerCase()));
    assert.equal(r.questions.length,4);assert.equal(r.questions.filter(q=>q.prompt.startsWith('阅读：')).length,3);assert.equal(r.questions.filter(q=>q.prompt.startsWith('推断：')).length,1);
    for(const q of r.questions){assert(q.options.length>=3);assert(q.options.includes(q.answer));assert.equal(new Set(q.options).size,q.options.length);}
    assert.equal(r.keyWords.length,5);assert.equal(new Set(r.keyWords.map(k=>k.word.toLowerCase())).size,5);
    const article=r.sentences.map(s=>s.text.toLowerCase()).join(' ');
    for(const k of r.keyWords){assert(known.has(k.word.toLowerCase()),id+' 未学关键词 '+k.word);assert(/[\u4e00-\u9fff]/.test(k.zh));assert(article.includes(k.word.toLowerCase()),id+' 文中没有 '+k.word);}
    assert.equal(r.retell.length,5);assert(r.retell.every(s=>typeof s==='string'&&/[\u4e00-\u9fff]/.test(s)));
  }
});
test('任务 M5：例句、课文、阅读线和讲解例句只使用本课及之前完整课程的词汇',()=>{
  for(const id of M5_LESSONS){
    const texts=M5_TEXTS().filter(s=>s.lesson===id);
    assert.deepEqual(msVocabularyMisses(id,texts),[],id);
  }
});
test('任务 M5：-lah、-kah 与固定 pun 连写从第 20 周开放，不放行任意 pun 或未来词',()=>{
  for(const [word,form] of [['baca','bacalah'],['boleh','bolehkah'],['dia','dialah'],['buku','bukunyalah'],['mahu','mahupun'],['atau','ataupun'],['bagaimana','bagaimanapun']]){
    assert(!msForms(word,19).has(form),form+' 规则提前开放');assert(msForms(word,20).has(form),form+' 未生成');
  }
  for(const word of ['saya','dia','buku'])assert(!msForms(word,20).has(word+'pun'),word+'pun 不应连写');
  assert(!msVocabulary('ms-19').has('menatal'));assert(msVocabulary('ms-20').has('menatal'));
  assert(msVocabularyMisses('ms-19',[{text:'Bacalah mesej ini.'}]).length>0);
  assert(msVocabularyMisses('ms-20',[{text:'Sayapun membaca.'}]).length>0);
  assert(msVocabularyMisses('ms-20',[{text:'Xylophonist membaca buku.'}]).length>0,'大写句首不绕过词汇检查');
});
test('任务 M5：讲解 HTML 可解析、各语法点、五句提纲与自查清单完整',()=>{
  const required=[
    ['kerana','sebab','oleh sebab','jadi','oleh itu','maka','tetapi','namun','walau bagaimanapun','walaupun','meskipun','sungguhpun','jika','kalau','sekiranya','andai','从句位置','逗号'],
    ['supaya','agar','untuk','sehingga','hingga','sementara','semasa','ketika','sewaktu','sebelum','selepas','setelah','sesudah','apabila','bila','sejak','begitu','100 词'],
    ['yang','主语','宾语','被动第二式','bahawa','berkata','memberitahu','bertanya sama ada','menyuruh','iaitu','人称'],
    ['-lah','-kah','Dialah yang','pun','juga','sahaja','pula','lagi','memang','sudah tentu','saya','aku','anda','awak','kamu','kau','beliau','tak','nak','dah','je','ni','tu','mana','macam mana','ke apa','网络文本','只识别']
  ];
  for(const [i,id] of M5_LESSONS.entries()){
    const l=api.LESSONS[id],markup=l.explanation(),nodes=msWalk(parseNodes(markup));
    assert(!/<script|\bon\w+=|javascript:/i.test(markup));
    assert(nodes.filter(n=>n.tag==='h4').length>=7);assert(ms3LangSentences(l).length>=3);
    assert(nodes.some(n=>n.tag==='ol'&&n.querySelectorAll('li').length===5));
    assert(nodes.some(n=>n.tag==='ul'&&n.querySelectorAll('li').length>=4));
    for(const part of [...required[i],'自查','名词短语','词缀拼写'])assert(markup.includes(part),id+' '+part);
    for(const p of nodes.filter(n=>n.tag==='p'&&n.getAttribute('lang')==='ms')){
      const parent=nodes.find(n=>n.childNodes.includes(p)),next=parent.childNodes[parent.childNodes.indexOf(p)+1];
      assert(next instanceof ElementModel&&/[\u4e00-\u9fff]/.test(next.textContent),id+' 例句后跟中文');
    }
  }
});
test('任务 M5：旧 ms 原 CSV 行与旧 es／ru 行按 id 原样原序保留，cards 与 log 不变',()=>{
  const oldMs=plain(api.parseCSV(M5_OLD_MS_CSV)),oldIds=new Set(oldMs.map(r=>r.id));
  assert.deepEqual(initialRows.filter(r=>oldIds.has(r.id)),oldMs);
  const csvLines=fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8').trimEnd().split('\n');
  const oldLines=M5_OLD_MS_CSV.trimEnd().split('\n');assert.deepEqual(csvLines.slice(0,oldLines.length),oldLines);
  const rawRows=[...blocks[0][1].matchAll(/\n  \{\n[\s\S]*?\n  \}/g)].map(m=>m[0].slice(1));
  assert.equal(rawRows.length,initialRows.length);
  const rawById=new Map(rawRows.map(raw=>[JSON.parse(raw).id,raw]));
  for(const lang of ['es','ru','ms','uz','kk']){
    const old=lang==='ms'?oldMs:plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards',lang+'.csv'),'utf8')));
    const ids=new Set(old.map(r=>r.id));assert.deepEqual(initialRows.filter(r=>ids.has(r.id)),old,lang+' 原序');
    for(const r of old)assert.equal(rawById.get(r.id),JSON.stringify([r],null,2).slice(2,-2),r.id+' 原行');
  }
  assert.deepEqual({cards:initialState.cards,log:initialState.log},M3_OLD_PROGRESS);
});
test('任务 M5：渲染四课八篇、课内作答与中文开关不改变真实进度、词卡或缓存',()=>{
  const {api:a,document,cache}=createAPI(true,html);a.initialize();
  const before=plain(a.getData().state),beforeRows=plain(a.getData().rows),dirty=a.getData().dirty,cacheBefore=[...cache.entries()];
  for(const id of M5_LESSONS){
    a.openLesson(id);const page=document.getElementById('content').textContent;
    for(const field of ['name','dates','dailyTime','goal','writingTask'])assert(page.includes(a.LESSONS[id][field]),id+' '+field);
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);
    for(const form of document.querySelectorAll('[data-exercise]')){
      form.elements.answer.value=a.LESSONS[id].exercises[Number(form.dataset.exercise)].answer;
      document.getElementById('app').listeners.submit[0]({target:form,preventDefault(){}});
    }
  }
  a.showReadings();
  assert.deepEqual(document.querySelectorAll('[data-reading]').map(n=>n.dataset.reading).filter(id=>M5_READINGS.includes(id)),M5_READINGS);
  for(const id of M5_READINGS){
    a.openReadingItem(id);assert(document.getElementById('content').textContent.includes(a.READINGS[id].title));
    assert.equal(document.querySelectorAll('[data-question]').length,4);
    const zh=()=>document.querySelectorAll('details').filter(n=>n.querySelector('summary')?.textContent==='查看本句中文');
    assert.equal(zh().length,a.READINGS[id].sentences.length);assert(zh().every(n=>n.getAttribute('open')===null));
    a.toggleReadingZh();assert(zh().every(n=>n.getAttribute('open')!==null));a.toggleReadingZh();
  }
  assert.deepEqual(plain(a.getData().state),before);assert.deepEqual(plain(a.getData().rows),beforeRows);
  assert.equal(a.getData().dirty,dirty);assert.deepEqual([...cache.entries()],cacheBefore);
});



// 任务 M6：并行分配 ms-1561–ms-1840；旧行按 id 原序保留，不假定 M4/M5 已在本树。
const M6_OLD_MS_CSV="id,lang,lesson,front,back,example,example_zh,note,tags\nms-0001,ms,ms-01,saya,我,Saya pelajar.,我是学生。,第一人称单数,代词\nms-0002,ms,ms-01,awak,你,Awak guru.,你是老师。,常用于熟悉的人；正式称呼可用 anda,代词\nms-0003,ms,ms-01,anda,您；你,Anda pelajar.,您是学生。,较正式的第二人称,代词\nms-0004,ms,ms-01,dia,他；她,Dia guru.,他是老师。,不分性别,代词\nms-0005,ms,ms-01,beliau,他；她（敬称）,Beliau guru saya.,他是我的老师。,用于值得尊敬的人,代词\nms-0006,ms,ms-01,kami,我们（不含听话人）,Kami pelajar.,我们是学生。,不含听话人,代词\nms-0007,ms,ms-01,kita,我们（含听话人）,Kita keluarga.,我们是一家人。,包含听话人,代词\nms-0008,ms,ms-01,mereka,他们；她们,Mereka kawan saya.,他们是我的朋友。,第三人称复数,代词\nms-0009,ms,ms-01,ini,这；这个,Buku ini buku saya.,这本书是我的书。,指示词；作定语时放名词后,代词\nms-0010,ms,ms-01,itu,那；那个,Rumah itu rumah saya.,那所房子是我的家。,指示词；作定语时放名词后,代词\nms-0011,ms,ms-01,Ini rumah.,这是房子。,Ini rumah.,这是房子。,无系词句；整句识别,代词;phrase\nms-0012,ms,ms-01,Itu sekolah.,那是学校。,Itu sekolah.,那是学校。,无系词句；整句识别,代词;phrase\nms-0013,ms,ms-01,selamat pagi,早上好,\"Selamat pagi, Ali!\",早上好，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0014,ms,ms-01,selamat tengah hari,中午好,\"Selamat tengah hari, Siti!\",中午好，西蒂！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0015,ms,ms-01,selamat petang,下午好,\"Selamat petang, Ali!\",下午好，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0016,ms,ms-01,selamat malam,晚上好,\"Selamat malam, Siti!\",晚上好，西蒂！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0017,ms,ms-01,Apa khabar?,你好吗？,Apa khabar?,你好吗？,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0018,ms,ms-01,khabar baik,很好（回答问候）,\"Khabar baik, terima kasih.\",很好，谢谢。,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0019,ms,ms-01,terima kasih,谢谢,\"Terima kasih, Ali!\",谢谢你，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0020,ms,ms-01,sama-sama,不客气,\"Sama-sama, Siti!\",不客气，西蒂！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0021,ms,ms-01,maaf,对不起,\"Maaf, Ali!\",对不起，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0022,ms,ms-01,selamat tinggal,再见（对留下的人说）,\"Selamat tinggal, Siti!\",再见，西蒂！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0023,ms,ms-01,selamat jalan,再见（对离开的人说）,\"Selamat jalan, Ali!\",再见，阿里！,礼貌用语；作为完整交际话语识别,问候;phrase\nms-0024,ms,ms-01,ya,是；对,\"Ya, ini buku saya.\",是的，这是我的书。,礼貌用语；作为完整交际话语识别,语气词;问候\nms-0025,ms,ms-01,tidak,不；不是,\"Tidak, itu buku Ali.\",不，那是阿里的书。,可单独作否定回答；否定谓语的区别见 ms-02,语气词;问候\nms-0026,ms,ms-01,satu,一,Ini satu buku.,这是一本书。,基数词；置于名词前，本周先认数字,数词\nms-0027,ms,ms-01,dua,二,Ini dua buku.,这是二本书。,基数词；置于名词前，本周先认数字,数词\nms-0028,ms,ms-01,tiga,三,Ini tiga buku.,这是三本书。,基数词；置于名词前，本周先认数字,数词\nms-0029,ms,ms-01,empat,四,Ini empat buku.,这是四本书。,基数词；置于名词前，本周先认数字,数词\nms-0030,ms,ms-01,lima,五,Ini lima buku.,这是五本书。,基数词；置于名词前，本周先认数字,数词\nms-0031,ms,ms-01,enam,六,Ini enam buku.,这是六本书。,基数词；置于名词前，本周先认数字,数词\nms-0032,ms,ms-01,tujuh,七,Ini tujuh buku.,这是七本书。,基数词；置于名词前，本周先认数字,数词\nms-0033,ms,ms-01,lapan,八,Ini lapan buku.,这是八本书。,基数词；置于名词前，本周先认数字,数词\nms-0034,ms,ms-01,sembilan,九,Ini sembilan buku.,这是九本书。,基数词；置于名词前，本周先认数字,数词\nms-0035,ms,ms-01,sepuluh,十,Ini sepuluh buku.,这是十本书。,基数词；置于名词前，本周先认数字,数词\nms-0036,ms,ms-01,buku,书,Ini buku saya.,这是我的书。,量词 buah,名词;教室\nms-0037,ms,ms-01,meja,桌子,Ini meja saya.,这是我的桌子。,量词 buah,名词;教室\nms-0038,ms,ms-01,kerusi,椅子,Ini kerusi saya.,这是我的椅子。,量词 buah,名词;教室\nms-0039,ms,ms-01,pen,笔,Ini pen saya.,这是我的笔。,量词 batang,名词;教室\nms-0040,ms,ms-01,pensel,铅笔,Ini pensel saya.,这是我的铅笔。,量词 batang,名词;教室\nms-0041,ms,ms-01,kertas,纸,Ini kertas saya.,这是我的纸。,量词 helai,名词;教室\nms-0042,ms,ms-01,beg,包,Ini beg saya.,这是我的包。,量词 buah,名词;教室\nms-0043,ms,ms-01,bilik,房间,Ini bilik saya.,这是我的房间。,量词 buah,名词;教室\nms-0044,ms,ms-01,pintu,门,Ini pintu saya.,这是我的门。,量词 buah,名词;教室\nms-0045,ms,ms-01,tingkap,窗户,Ini tingkap saya.,这是我的窗户。,量词 buah,名词;教室\nms-0046,ms,ms-01,rumah,房子；家,Ini rumah saya.,这是我的房子。,量词 buah,名词;教室\nms-0047,ms,ms-01,sekolah,学校,Ini sekolah saya.,这是我的学校。,量词 buah,名词;教室\nms-0048,ms,ms-01,kelas,班级,Ini kelas saya.,这是我的班级。,量词 buah,名词;教室\nms-0049,ms,ms-01,guru,老师,Ini guru saya.,这是我的老师。,量词 orang,名词;教室\nms-0050,ms,ms-01,pelajar,学生,Ini pelajar saya.,这是我的学生。,量词 orang,名词;教室\nms-0051,ms,ms-01,orang,人,Dia orang Malaysia.,他是马来西亚人。,量词 orang；ms-03 也用作人的量词,名词;家庭\nms-0052,ms,ms-01,lelaki,男子,Lelaki itu bapa saya.,那个男子是我的父亲。,量词 orang,名词;家庭\nms-0053,ms,ms-01,perempuan,女子,Perempuan itu ibu saya.,那个女子是我的母亲。,量词 orang,名词;家庭\nms-0054,ms,ms-01,kawan,朋友,Ali kawan saya.,阿里是我的朋友。,量词 orang,名词;家庭\nms-0055,ms,ms-01,keluarga,家庭；家人,Ini keluarga saya.,这是我的家人。,量词 buah；指家庭时使用，家人按 orang 计数,名词;家庭\nms-0056,ms,ms-01,ibu,母亲,Ibu saya guru.,我的母亲是老师。,量词 orang,名词;家庭\nms-0057,ms,ms-01,bapa,父亲,Bapa saya guru.,我的父亲是老师。,量词 orang,名词;家庭\nms-0058,ms,ms-01,abang,哥哥,Abang saya pelajar.,我的哥哥是学生。,量词 orang,名词;家庭\nms-0059,ms,ms-01,kakak,姐姐,Kakak saya pelajar.,我的姐姐是学生。,量词 orang,名词;家庭\nms-0060,ms,ms-01,adik,弟弟；妹妹,Adik saya pelajar.,我的弟弟是学生。,量词 orang,名词;家庭\nms-0061,ms,ms-01,komputer,电脑,Itu komputer Ali.,那是阿里的电脑。,量词 buah,名词;城市;英语借词\nms-0062,ms,ms-01,telefon,电话；手机,Itu telefon Ali.,那是阿里的电话。,量词 buah,名词;城市;英语借词\nms-0063,ms,ms-01,bas,公共汽车,Itu bas.,那是公共汽车。,量词 buah,名词;城市;英语借词\nms-0064,ms,ms-01,teksi,出租车,Itu teksi.,那是出租车。,量词 buah,名词;城市;英语借词\nms-0065,ms,ms-01,hospital,医院,Itu hospital.,那是医院。,量词 buah,名词;城市;英语借词\nms-0066,ms,ms-01,restoran,餐馆,Itu restoran.,那是餐馆。,量词 buah,名词;城市;英语借词\nms-0067,ms,ms-01,hotel,酒店,Itu hotel.,那是酒店。,量词 buah,名词;城市;英语借词\nms-0068,ms,ms-01,bank,银行,Itu bank.,那是银行。,量词 buah,名词;城市;英语借词\nms-0069,ms,ms-01,kamera,相机,Itu kamera Ali.,那是阿里的相机。,量词 buah,名词;城市;英语借词\nms-0070,ms,ms-01,tiket,票,Itu tiket Ali.,那是阿里的票。,量词 keping,名词;城市;英语借词\nms-0071,ms,ms-01,gereja,教堂,Ini gereja.,这是教堂。,量词 buah,名词;身边事物;葡语借词\nms-0072,ms,ms-01,bendera,旗帜,Ini bendera.,这是旗帜。,量词 helai,名词;身边事物;葡语借词\nms-0073,ms,ms-01,keju,奶酪,Ini keju.,这是奶酪。,量词 keping,名词;身边事物;葡语借词\nms-0074,ms,ms-01,teh,茶,Ini teh.,这是茶。,量词 cawan,名词;身边事物;闽南语借词\nms-0075,ms,ms-01,mi,面条,Ini mi.,这是面条。,量词 mangkuk,名词;身边事物;闽南语借词\nms-0076,ms,ms-01,kuih,糕点,Ini kuih.,这是糕点。,量词 biji,名词;身边事物;闽南语借词\nms-0077,ms,ms-01,Saya pelajar.,我是学生。,Saya pelajar.,我是学生。,整句识别；名字 Ali 可换成自己的名字,代词;phrase\nms-0078,ms,ms-01,Ini buku saya.,这是我的书。,Ini buku saya.,这是我的书。,整句识别；名字 Ali 可换成自己的名字,代词;phrase\nms-0079,ms,ms-01,Nama saya Ali.,我的名字是阿里。,Nama saya Ali.,我的名字是阿里。,整句识别；名字 Ali 可换成自己的名字,名词;phrase\nms-0080,ms,ms-01,Terima kasih banyak.,非常感谢。,Terima kasih banyak.,非常感谢。,整句识别；名字 Ali 可换成自己的名字,问候;phrase\nms-0081,ms,ms-02,baca,读,Saya baca buku.,我读书。,及物；常见宾语 buku,动词;学习与工作\nms-0082,ms,ms-02,makan,吃,Saya makan mi.,我吃面条。,及物；常见宾语 mi、kuih,动词;学习与工作\nms-0083,ms,ms-02,minum,喝,Saya minum teh.,我喝茶。,及物；常见宾语 teh,动词;学习与工作\nms-0084,ms,ms-02,tulis,写,Saya tulis nama saya.,我写我的名字。,及物；常见宾语 nama、e-mel,动词;学习与工作\nms-0085,ms,ms-02,pergi,去,Saya pergi ke sekolah.,我去学校。,不及物；目的地用 ke,动词;学习与工作\nms-0086,ms,ms-02,ada,有；在,Saya ada komputer.,我有电脑。,表示拥有或存在；后接 buku、komputer 等事物,动词;学习与工作\nms-0087,ms,ms-02,suka,喜欢,Saya suka bahasa Melayu.,我喜欢马来语。,及物；常见宾语 bahasa Melayu、mi,动词;学习与工作\nms-0088,ms,ms-02,tinggal,住,Saya tinggal di Melaka.,我住在马六甲。,不及物；住处用 di,动词;学习与工作\nms-0089,ms,ms-02,belajar,学习,Saya belajar bahasa Melayu.,我学习马来语。,bel- + ajar；词根 ajar；本周只作整词记，第 5 周再学前缀规则；常见学习内容（宾语）bahasa Melayu,动词;学习与工作\nms-0090,ms,ms-02,bekerja,工作,Ibu saya bekerja di bank.,我的母亲在银行工作。,be- + kerja；词根 kerja；本周只作整词记，第 5 周再学前缀规则,动词;学习与工作\nms-0091,ms,ms-02,faham,懂；理解,Saya faham bahasa Melayu.,我懂马来语。,及物；常见宾语 bahasa Melayu,动词;学习与工作\nms-0092,ms,ms-02,tahu,知道,Saya tahu nama guru itu.,我知道那位老师的名字。,及物；常见宾语 nama,动词;学习与工作\nms-0093,ms,ms-02,apa,什么,Awak baca apa?,你读什么？,句末疑问词,疑问词\nms-0094,ms,ms-02,siapa,谁,Dia siapa?,他是谁？,询问人,疑问词\nms-0095,ms,ms-02,di mana,在哪里,Awak tinggal di mana?,你住在哪里？,di 表地点；作为固定词组记,疑问词\nms-0096,ms,ms-02,ke mana,去哪里,Awak pergi ke mana?,你去哪里？,ke 表方向；作为固定词组记,疑问词\nms-0097,ms,ms-02,dari mana,从哪里来,Awak dari mana?,你来自哪里？,dari 表来源；作为固定词组记,疑问词\nms-0098,ms,ms-02,bila,什么时候,Bila awak pergi ke Melaka?,你什么时候去马六甲？,询问时间,疑问词\nms-0099,ms,ms-02,mengapa,为什么,Mengapa awak suka buku itu?,你为什么喜欢那本书？,询问原因；同义 kenapa,疑问词\nms-0100,ms,ms-02,bagaimana,怎么样,Bagaimana khabar keluarga awak?,你的家人近况怎么样？,询问情况,疑问词\nms-0101,ms,ms-02,berapa,多少,Berapa orang pelajar ada di kelas?,班里有多少学生？,询问数量,疑问词\nms-0102,ms,ms-02,besar,大的,Rumah saya besar.,我的房子很大。,形容词，后置；作谓语时可不用系词,形容词\nms-0103,ms,ms-02,kecil,小的,Bilik saya kecil.,我的房间很小。,形容词，后置；作谓语时可不用系词,形容词\nms-0104,ms,ms-02,baru,新的,Ini buku baru saya.,这是我的新书。,形容词，后置；作谓语时可不用系词；ms-04 再识别副词义「刚」,形容词\nms-0105,ms,ms-02,lama,旧的,Itu komputer lama saya.,那是我的旧电脑。,形容词，后置；作谓语时可不用系词,形容词\nms-0106,ms,ms-02,baik,好的,Guru saya baik.,我的老师很好。,形容词，后置；作谓语时可不用系词,形容词\nms-0107,ms,ms-02,cantik,漂亮的,Bendera itu cantik.,那面旗帜很漂亮。,形容词，后置；作谓语时可不用系词,形容词\nms-0108,ms,ms-02,panjang,长的,Pensel ini panjang.,这支铅笔很长。,形容词，后置；作谓语时可不用系词,形容词\nms-0109,ms,ms-02,pendek,短的,Pensel itu pendek.,那支铅笔很短。,形容词，后置；作谓语时可不用系词,形容词\nms-0110,ms,ms-02,tinggi,高的,Abang saya tinggi.,我的哥哥个子高。,形容词，后置；作谓语时可不用系词,形容词\nms-0111,ms,ms-02,rendah,矮的；低的,Meja itu rendah.,那张桌子很矮。,形容词，后置；作谓语时可不用系词,形容词\nms-0112,ms,ms-02,murah,便宜的,Tiket bas ini murah.,这张公共汽车票很便宜。,形容词，后置；作谓语时可不用系词,形容词\nms-0113,ms,ms-02,mahal,贵的,Kamera itu mahal.,那台相机很贵。,形容词，后置；作谓语时可不用系词,形容词\nms-0114,ms,ms-02,panas,热的,Teh ini panas.,这杯茶很热。,形容词，后置；作谓语时可不用系词,形容词\nms-0115,ms,ms-02,sejuk,凉的,Teh itu sejuk.,那杯茶凉了。,形容词，后置；作谓语时可不用系词,形容词\nms-0116,ms,ms-02,sedap,好吃的,Mi ini sedap.,这些面条很好吃。,形容词，后置；作谓语时可不用系词,形容词\nms-0117,ms,ms-02,Malaysia,马来西亚,Saya dari Malaysia.,我来自马来西亚。,国家专名，首字母大写；地名一般不用量词,名词;国家与语言\nms-0118,ms,ms-02,China,中国,Kawan saya dari China.,我的朋友来自中国。,国家专名，首字母大写；地名一般不用量词,名词;国家与语言\nms-0119,ms,ms-02,England,英格兰,Dia dari England.,他来自英格兰。,国家或地区专名；此处专指英格兰；地名一般不用量词,名词;国家与语言\nms-0120,ms,ms-02,bahasa Melayu,马来语,Saya suka bahasa Melayu.,我喜欢马来语。,语言名称；bahasa 小写、Melayu 大写；一般不用量词；专名或语言名称不用事物量词,名词;国家与语言\nms-0121,ms,ms-02,bahasa Cina,汉语,Dia faham bahasa Cina.,他懂汉语。,语言名称；一般不用量词；专名或语言名称不用事物量词,名词;国家与语言\nms-0122,ms,ms-02,bahasa Inggeris,英语,Beliau faham bahasa Inggeris.,他懂英语。,语言名称；一般不用量词；专名或语言名称不用事物量词,名词;国家与语言\nms-0123,ms,ms-02,orang Cina,华人；中国人,Mei Ling orang Cina.,美玲是华人。,量词 orang；本句指族群,名词;国家与语言\nms-0124,ms,ms-02,orang Malaysia,马来西亚人,Ali orang Malaysia.,阿里是马来西亚人。,量词 orang,名词;国家与语言\nms-0125,ms,ms-02,doktor,医生,Ali doktor.,阿里是医生。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0126,ms,ms-02,jururawat,护士,Ali jururawat.,阿里是护士。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0127,ms,ms-02,polis,警察,Ali polis.,阿里是警察。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0128,ms,ms-02,jurutera,工程师,Ali jurutera.,阿里是工程师。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0129,ms,ms-02,peguam,律师,Ali peguam.,阿里是律师。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0130,ms,ms-02,petani,农民,Ali petani.,阿里是农民。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0131,ms,ms-02,kerani,文员,Ali kerani.,阿里是文员。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0132,ms,ms-02,pemandu,司机,Ali pemandu.,阿里是司机。,量词 orang；本周作为职业名称整词记,名词;学习与工作\nms-0133,ms,ms-02,dan,和,Saya suka teh dan kuih.,我喜欢茶和糕点。,并列连接词,连词\nms-0134,ms,ms-02,atau,或者,Awak suka teh atau mi?,你喜欢茶还是面条？,连接可选择的成分,连词\nms-0135,ms,ms-02,tetapi,但是,Bilik ini kecil tetapi cantik.,这个房间小但是漂亮。,表示转折,连词\nms-0136,ms,ms-02,sangat,很,Buku ini sangat baik.,这本书很好。,放在形容词前,副词\nms-0137,ms,ms-02,sekali,很；极了,Mi ini sedap sekali.,这些面条非常好吃。,表示程度时放形容词后,副词\nms-0138,ms,ms-02,juga,也,Saya juga pelajar.,我也是学生。,表示相同情况,副词\nms-0139,ms,ms-02,radio,收音机,Ini radio baru.,这是新的收音机。,量词 buah,名词;英语借词\nms-0140,ms,ms-02,televisyen,电视机,Ini televisyen baru.,这是新的电视机。,量词 buah,名词;英语借词\nms-0141,ms,ms-02,internet,互联网,Ada internet di hotel ini.,这家酒店有互联网。,一般不用量词；不可数的网络名称,名词;英语借词\nms-0142,ms,ms-02,e-mel,电子邮件,Ini e-mel baru.,这是新的电子邮件。,量词 buah,名词;英语借词\nms-0143,ms,ms-02,universiti,大学,Ini universiti baru.,这是新的大学。,量词 buah,名词;英语借词\nms-0144,ms,ms-02,kolej,学院,Ini kolej baru.,这是新的学院。,量词 buah,名词;英语借词\nms-0145,ms,ms-02,klinik,诊所,Ini klinik baru.,这是新的诊所。,量词 buah,名词;英语借词\nms-0146,ms,ms-02,muzium,博物馆,Ini muzium baru.,这是新的博物馆。,量词 buah,名词;英语借词\nms-0147,ms,ms-02,Siapakah guru anda?,谁是您的老师？,Siapakah guru anda?,谁是您的老师？,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0148,ms,ms-02,Adakah awak pelajar?,你是学生吗？,Adakah awak pelajar?,你是学生吗？,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0149,ms,ms-02,Saya dari Malaysia.,我来自马来西亚。,Saya dari Malaysia.,我来自马来西亚。,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0150,ms,ms-02,Saya boleh baca bahasa Melayu.,我会读马来语。,Saya boleh baca bahasa Melayu.,我会读马来语。,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0151,ms,ms-02,Saya bukan doktor.,我不是医生。,Saya bukan doktor.,我不是医生。,整句识别；疑问前置时可加 -kah；不据此推导其他词缀,代词;phrase\nms-0152,ms,ms-02,ialah,是（名词谓语前）,Ali ialah pelajar.,阿里是学生。,正式书面语的判断词；后接名词短语,助动词;补充\nms-0153,ms,ms-02,adalah,是（形容词或介词短语前）,Buku ini adalah sangat baik.,这本书很好。,正式书面语的判断词；本句可省，不接动词,助动词;补充\nms-0154,ms,ms-02,bukan,不是,Dia bukan guru saya.,他不是我的老师。,否定名词或代词,副词;补充\nms-0155,ms,ms-02,adakah,是否；是不是,Adakah itu rumah awak?,那是你的房子吗？,ada + -kah，作为整词记；引导是非问,疑问词;补充\nms-0156,ms,ms-02,boleh,能；可以,Saya boleh tulis e-mel.,我会写电子邮件。,后接动词,助动词;补充\nms-0157,ms,ms-02,pejabat,办公室,Ibu saya ada di pejabat.,我的母亲在办公室。,量词 buah,名词;补充\nms-0158,ms,ms-02,kerana,因为,Saya suka mi ini kerana sedap.,我喜欢这些面条，因为它们好吃。,连接原因,连词;补充\nms-0159,ms,ms-02,kenapa,为什么,Kenapa awak tidak minum teh?,你为什么不喝茶？,同义词 mengapa,疑问词;补充\nms-0160,ms,ms-02,dengan,和；与,Saya pergi ke sekolah dengan Ali.,我和阿里去学校。,引出同行的人,介词;补充\nms-0161,ms,ms-03,ekor,只；头（动物量词）,Saya ada dua ekor kucing.,我有两只猫。,用于动物,量词\nms-0162,ms,ms-03,buah,个；本；辆（一般事物量词）,Saya ada tiga buah buku.,我有三本书。,用于 buku、rumah 等,量词\nms-0163,ms,ms-03,batang,支；根,Saya ada dua batang pen.,我有两支笔。,用于 pen、pensel 等细长物,量词\nms-0164,ms,ms-03,helai,张；件（薄片量词）,Ada dua helai kertas di atas meja.,桌子上有两张纸。,用于 kertas、bendera 等,量词\nms-0165,ms,ms-03,biji,粒；个,Ada tiga biji telur di dalam mangkuk.,碗里有三个鸡蛋。,用于 telur、epal 等,量词\nms-0166,ms,ms-03,keping,张；片,Saya ada dua keping tiket.,我有两张票。,用于 tiket 等薄片,量词\nms-0167,ms,ms-03,pasang,双；对,Saya ada dua pasang kasut.,我有两双鞋。,用于成对的物品,量词\nms-0168,ms,ms-03,cawan,杯（茶杯的容量）,Saya minum satu cawan teh.,我喝一杯茶。,也作名词「茶杯」，量词 buah；此处计容量,量词\nms-0169,ms,ms-03,gelas,杯（玻璃杯的容量）,Saya minum satu gelas air.,我喝一杯水。,也作名词「玻璃杯」，量词 buah；此处计容量,量词\nms-0170,ms,ms-03,mangkuk,碗（容量）,Saya makan satu mangkuk mi.,我吃一碗面条。,也作名词「碗」，量词 buah；补充替换已学 orang,量词;补充\nms-0171,ms,ms-03,sebelas,十一,Ada sebelas buah buku di sekolah.,学校里有十一本书。,基数词；数字 11,数词\nms-0172,ms,ms-03,dua belas,十二,Ada dua belas buah buku di sekolah.,学校里有十二本书。,基数词；数字 12,数词\nms-0173,ms,ms-03,tiga belas,十三,Ada tiga belas buah buku di sekolah.,学校里有十三本书。,基数词；数字 13,数词\nms-0174,ms,ms-03,empat belas,十四,Ada empat belas buah buku di sekolah.,学校里有十四本书。,基数词；数字 14,数词\nms-0175,ms,ms-03,lima belas,十五,Ada lima belas buah buku di sekolah.,学校里有十五本书。,基数词；数字 15,数词\nms-0176,ms,ms-03,dua puluh,二十,Ada dua puluh buah buku di sekolah.,学校里有二十本书。,基数词；数字 20,数词\nms-0177,ms,ms-03,tiga puluh,三十,Ada tiga puluh buah buku di sekolah.,学校里有三十本书。,基数词；数字 30,数词\nms-0178,ms,ms-03,seratus,一百,Ada seratus buah buku di sekolah.,学校里有一百本书。,基数词；数字 100,数词\nms-0179,ms,ms-03,dua ratus,二百,Ada dua ratus buah buku di sekolah.,学校里有二百本书。,基数词；数字 200,数词\nms-0180,ms,ms-03,seribu,一千,Ada seribu buah buku di sekolah.,学校里有一千本书。,基数词；数字 1000,数词\nms-0181,ms,ms-03,pertama,第一,Ini buku pertama saya.,这是我的第一本书。,序数词，放在名词后,数词\nms-0182,ms,ms-03,kedua,第二,Ini bilik kedua.,这是第二个房间。,序数词，放在名词后,数词\nms-0183,ms,ms-03,ketiga,第三,Ali pelajar ketiga.,阿里是第三个学生。,序数词，放在名词后,数词\nms-0184,ms,ms-03,seorang,一个人（连量词）,Ada seorang guru di kelas.,班里有一位老师。,se- 表一；本课只记此整词，不开放 se- 的通用推导,数词\nms-0185,ms,ms-03,sebuah,一个；一本（连量词）,Saya ada sebuah buku.,我有一本书。,se- 表一；本课只记此整词，不开放 se- 的通用推导,数词\nms-0186,ms,ms-03,tauhu,豆腐,Ada tauhu di rumah saya.,我家里有豆腐。,量词 keping,名词;家居与食物;闽南语借词\nms-0187,ms,ms-03,tauge,豆芽,Ada tauge di rumah saya.,我家里有豆芽。,一般不用量词；按份数可用 pinggan,名词;家居与食物;闽南语借词\nms-0188,ms,ms-03,bihun,米粉,Ada bihun di rumah saya.,我家里有米粉。,量词 mangkuk,名词;家居与食物;闽南语借词\nms-0189,ms,ms-03,kicap,酱油,Ada kicap di rumah saya.,我家里有酱油。,量词 sudu,名词;家居与食物;闽南语借词\nms-0190,ms,ms-03,teko,茶壶,Ada teko di rumah saya.,我家里有茶壶。,量词 buah,名词;家居与食物;闽南语借词\nms-0191,ms,ms-03,nasi,米饭,Ada nasi di rumah saya.,我家里有米饭。,量词 pinggan,名词;家居与食物\nms-0192,ms,ms-03,air,水,Ada air di rumah saya.,我家里有水。,量词 gelas,名词;家居与食物\nms-0193,ms,ms-03,roti,面包,Ada roti di rumah saya.,我家里有面包。,量词 keping,名词;家居与食物\nms-0194,ms,ms-03,telur,鸡蛋,Ada telur di rumah saya.,我家里有鸡蛋。,量词 biji,名词;家居与食物\nms-0195,ms,ms-03,susu,奶,Ada susu di rumah saya.,我家里有奶。,量词 gelas,名词;家居与食物\nms-0196,ms,ms-03,kopi,咖啡,Ada kopi di rumah saya.,我家里有咖啡。,量词 cawan,名词;家居与食物\nms-0197,ms,ms-03,gula,糖,Ada gula di rumah saya.,我家里有糖。,量词 sudu,名词;家居与食物\nms-0198,ms,ms-03,garam,盐,Ada garam di rumah saya.,我家里有盐。,量词 sudu,名词;家居与食物\nms-0199,ms,ms-03,sayur,蔬菜,Ada sayur di rumah saya.,我家里有蔬菜。,一般不用量词；按份数可用 pinggan,名词;家居与食物\nms-0200,ms,ms-03,pisang,香蕉,Ada pisang di rumah saya.,我家里有香蕉。,量词 biji,名词;家居与食物\nms-0201,ms,ms-03,epal,苹果,Ada epal di rumah saya.,我家里有苹果。,量词 biji,名词;家居与食物\nms-0202,ms,ms-03,pinggan,盘子,Ada pinggan di rumah saya.,我家里有盘子。,量词 buah,名词;家居与食物\nms-0203,ms,ms-03,sudu,勺子,Ada sudu di rumah saya.,我家里有勺子。,量词 batang,名词;家居与食物\nms-0204,ms,ms-03,garpu,叉子,Ada garpu di rumah saya.,我家里有叉子。,量词 batang,名词;家居与食物\nms-0205,ms,ms-03,katil,床,Ada katil di rumah saya.,我家里有床。,量词 buah,名词;家居与食物\nms-0206,ms,ms-03,almari,柜子,Ada almari di rumah saya.,我家里有柜子。,量词 buah,名词;家居与食物\nms-0207,ms,ms-03,lampu,灯,Ada lampu di rumah saya.,我家里有灯。,量词 buah,名词;家居与食物\nms-0208,ms,ms-03,jam,钟表,Ada jam di rumah saya.,我家里有钟表。,量词 buah,名词;家居与食物\nms-0209,ms,ms-03,kasut,鞋,Ada kasut di rumah saya.,我家里有鞋。,量词 pasang,名词;家居与食物\nms-0210,ms,ms-03,bantal,枕头,Ada bantal di rumah saya.,我家里有枕头。,量词 biji,名词;家居与食物\nms-0211,ms,ms-03,kucing,猫,Ada dua ekor kucing di belakang rumah.,房子后面有两只猫。,量词 ekor,名词;动物\nms-0212,ms,ms-03,anjing,狗,Ada dua ekor anjing di belakang rumah.,房子后面有两只狗。,量词 ekor,名词;动物\nms-0213,ms,ms-03,ayam,鸡,Ada dua ekor ayam di belakang rumah.,房子后面有两只鸡。,量词 ekor,名词;动物\nms-0214,ms,ms-03,ikan,鱼,Ada dua ekor ikan di belakang rumah.,房子后面有两条鱼。,量词 ekor,名词;动物\nms-0215,ms,ms-03,burung,鸟,Ada dua ekor burung di belakang rumah.,房子后面有两只鸟。,量词 ekor,名词;动物\nms-0216,ms,ms-03,lembu,牛,Ada dua ekor lembu di belakang rumah.,房子后面有两头牛。,量词 ekor,名词;动物\nms-0217,ms,ms-03,semua,所有,Semua buku ini baru.,这些书都是新的。,表示全部,数词\nms-0218,ms,ms-03,banyak,许多,Saya ada banyak buku.,我有许多书。,表示数量多；本周不用重叠,数词\nms-0219,ms,ms-03,beberapa,几个；一些,Ada beberapa orang pelajar di kelas.,班里有几个学生。,后可接量词，不用重叠,数词\nms-0220,ms,ms-03,sedikit,少量,Ada sedikit gula di dalam teh ini.,这杯茶里有少量糖。,表示数量少,数词\nms-0221,ms,ms-03,para,诸位；众（用于人）,Para pelajar ada di sekolah.,学生们在学校。,表示一群人，后面不用重叠,数词\nms-0222,ms,ms-03,cukup,足够,Buku ini cukup untuk semua pelajar.,这些书够所有学生用。,形容词，后置；本句作谓语,形容词;补充\nms-0223,ms,ms-03,lebih,更；较,Rumah Ali lebih besar.,阿里的房子更大。,程度副词，放形容词前,副词;补充\nms-0224,ms,ms-03,kurang,不太；较少,Teh ini kurang panas.,这杯茶不太热。,程度副词，放形容词前,副词;补充\nms-0225,ms,ms-03,atas,上面,Buku ada di atas meja.,书在桌子上。,方位名词，一般不用量词；di atas 作为地点词组记,名词;方位\nms-0226,ms,ms-03,bawah,下面,Kucing ada di bawah kerusi.,猫在椅子下面。,方位名词，一般不用量词；di bawah 作为地点词组记,名词;方位\nms-0227,ms,ms-03,dalam,里面,Pen ada di dalam beg.,笔在包里。,方位名词，一般不用量词；di dalam 作为地点词组记,名词;方位\nms-0228,ms,ms-03,depan,前面,Ali ada di depan sekolah.,阿里在学校前面。,方位名词，一般不用量词；di depan 作为地点词组记,名词;方位\nms-0229,ms,ms-03,belakang,后面,Bilik saya di belakang kelas.,我的房间在教室后面。,方位名词，一般不用量词；di belakang 作为地点词组记,名词;方位\nms-0230,ms,ms-03,sebelah,旁边,Rumah Ali di sebelah rumah saya.,阿里的房子在我家旁边。,方位名词，一般不用量词；di sebelah 作为地点词组记,名词;方位\nms-0231,ms,ms-03,Tiada buku di sini.,这里没有书。,Tiada buku di sini.,这里没有书。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0232,ms,ms-03,Saya ada dua buah buku.,我有两本书。,Saya ada dua buah buku.,我有两本书。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0233,ms,ms-03,Buku-buku ini untuk pelajar.,这些书是给学生的。,Buku-buku ini untuk pelajar.,这些书是给学生的。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0234,ms,ms-03,Ini buku yang saya suka.,这是我喜欢的书。,Ini buku yang saya suka.,这是我喜欢的书。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0235,ms,ms-03,Ada seekor kucing di rumah.,家里有一只猫。,Ada seekor kucing di rumah.,家里有一只猫。,整句识别；tiada = tidak ada；untuk 表「给、供」；seekor 作整词记,代词;phrase\nms-0236,ms,ms-03,lantai,地板,Lantai bilik saya baru.,我房间的地板是新的。,一般不用量词；按一面墙或一片地板描述,名词;家居;补充\nms-0237,ms,ms-03,dinding,墙壁,Dinding rumah saya tinggi.,我家的墙壁很高。,一般不用量词；按一面墙或一片地板描述,名词;家居;补充\nms-0238,ms,ms-03,tandas,厕所,Tandas ada di sebelah bilik ini.,厕所在这个房间旁边。,量词 buah,名词;家居;补充\nms-0239,ms,ms-03,dapur,厨房,Ada sebuah dapur di rumah saya.,我家里有一间厨房。,量词 buah,名词;家居;补充\nms-0240,ms,ms-03,bunga,花,Ada bunga di atas meja.,桌子上有花。,量词 kuntum,名词;家居;补充\nms-0241,ms,ms-04,sudah,已经,Saya sudah makan nasi.,我已经吃过米饭了。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0242,ms,ms-04,telah,已经（较正式）,Ali telah tulis e-mel.,阿里已经写了电子邮件。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0243,ms,ms-04,belum,还没有,Saya belum makan.,我还没吃饭。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0244,ms,ms-04,akan,将要,Esok saya akan pergi ke Melaka.,明天我将去马六甲。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0245,ms,ms-04,sedang,正在,Ibu sedang baca buku.,母亲正在读书。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0246,ms,ms-04,masih,仍然；还,Adik masih tidur.,弟弟还在睡觉。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0247,ms,ms-04,pernah,曾经,Saya pernah pergi ke Pulau Pinang.,我曾经去过槟城。,时间或体貌标记，放在动词前；动词不因时间而变形,助动词;时间\nms-0248,ms,ms-04,baru sahaja,刚刚,Ali baru sahaja datang.,阿里刚刚到。,时间或体貌标记，放在动词前；动词不因时间而变形；baru 的副词义，本课用固定搭配补足，不重复建 baru 卡,助动词;时间;补充\nms-0249,ms,ms-04,sekarang,现在,Sekarang saya ada di rumah.,现在我在家。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0250,ms,ms-04,hari ini,今天,Hari ini saya akan baca buku.,今天我将读书。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0251,ms,ms-04,semalam,昨天,Semalam saya pergi ke bank.,昨天我去了银行。,印尼语作 kemarin；本课马来语 semalam 指昨天；时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0252,ms,ms-04,kelmarin,前天,Kelmarin Ali datang ke rumah saya.,前天阿里来了我家。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0253,ms,ms-04,esok,明天,Esok saya akan beli roti.,明天我将买面包。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0254,ms,ms-04,lusa,后天,Lusa kami akan pergi ke Melaka.,后天我们将去马六甲。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0255,ms,ms-04,pagi,早晨,Saya bangun pada pukul enam pagi.,我早晨六点起床。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0256,ms,ms-04,tengah hari,中午,Saya makan pada pukul dua belas tengah hari.,我中午十二点吃饭。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0257,ms,ms-04,petang,下午；傍晚,Saya balik pada pukul lima petang.,我下午五点回家。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0258,ms,ms-04,malam,晚上,Saya tidur pada pukul sepuluh malam.,我晚上十点睡觉。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0259,ms,ms-04,minggu ini,这周,Minggu ini saya masih di Kuala Lumpur.,这周我仍在吉隆坡。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0260,ms,ms-04,minggu depan,下周,Minggu depan saya akan pergi ke Johor Bahru.,下周我将去新山。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0261,ms,ms-04,minggu lepas,上周,Minggu lepas saya beli buku ini.,上周我买了这本书。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0262,ms,ms-04,bulan,月,Bulan ini saya akan pergi ke China.,这个月我将去中国。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0263,ms,ms-04,tahun,年,Tahun ini adik saya belajar di sekolah.,今年我的弟弟在学校学习。,时间名词，一般不用量词，计时可直接接数字,名词;时间\nms-0264,ms,ms-04,Isnin,星期一,\"Pada hari Isnin, saya baca buku.\",星期一，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0265,ms,ms-04,Selasa,星期二,\"Pada hari Selasa, saya baca buku.\",星期二，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0266,ms,ms-04,Rabu,星期三,\"Pada hari Rabu, saya baca buku.\",星期三，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0267,ms,ms-04,Khamis,星期四,\"Pada hari Khamis, saya baca buku.\",星期四，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0268,ms,ms-04,Jumaat,星期五,\"Pada hari Jumaat, saya baca buku.\",星期五，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0269,ms,ms-04,Sabtu,星期六,\"Pada hari Sabtu, saya baca buku.\",星期六，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0270,ms,ms-04,Ahad,星期日,\"Pada hari Ahad, saya baca buku.\",星期日，我读书。,星期名称首字母大写；一般不用量词，计次数可用 hari,名词;时间\nms-0271,ms,ms-04,Januari,一月,\"Pada bulan Januari, saya ada di Malaysia.\",一月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0272,ms,ms-04,Februari,二月,\"Pada bulan Februari, saya ada di Malaysia.\",二月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0273,ms,ms-04,Mac,三月,\"Pada bulan Mac, saya ada di Malaysia.\",三月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0274,ms,ms-04,April,四月,\"Pada bulan April, saya ada di Malaysia.\",四月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0275,ms,ms-04,Mei,五月,\"Pada bulan Mei, saya ada di Malaysia.\",五月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0276,ms,ms-04,Jun,六月,\"Pada bulan Jun, saya ada di Malaysia.\",六月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0277,ms,ms-04,Julai,七月,\"Pada bulan Julai, saya ada di Malaysia.\",七月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0278,ms,ms-04,Ogos,八月,\"Pada bulan Ogos, saya ada di Malaysia.\",八月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0279,ms,ms-04,September,九月,\"Pada bulan September, saya ada di Malaysia.\",九月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0280,ms,ms-04,Oktober,十月,\"Pada bulan Oktober, saya ada di Malaysia.\",十月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0281,ms,ms-04,November,十一月,\"Pada bulan November, saya ada di Malaysia.\",十一月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0282,ms,ms-04,Disember,十二月,\"Pada bulan Disember, saya ada di Malaysia.\",十二月，我在马来西亚。,月份名称首字母大写；一般不用量词，前可加 bulan,名词;时间\nms-0283,ms,ms-04,bangun,起床,Saya bangun pada pukul enam.,我六点起床。,不及物,动词;日常生活\nms-0284,ms,ms-04,tidur,睡觉,Adik sedang tidur.,弟弟正在睡觉。,不及物,动词;日常生活\nms-0285,ms,ms-04,mandi,洗澡,Saya mandi pada waktu pagi.,我早晨洗澡。,不及物,动词;日常生活\nms-0286,ms,ms-04,balik,回去；回家,Saya akan balik ke rumah.,我将回家。,不及物；目的地用 ke,动词;日常生活\nms-0287,ms,ms-04,datang,来,Ali akan datang esok.,阿里明天会来。,不及物；到达地点用 ke,动词;日常生活\nms-0288,ms,ms-04,tunggu,等,Saya tunggu bas.,我等公共汽车。,及物；常见宾语 bas、kawan,动词;日常生活\nms-0289,ms,ms-04,beli,买,Saya beli roti.,我买面包。,及物；常见宾语 roti、buku,动词;日常生活\nms-0290,ms,ms-04,jual,卖,Mereka jual kuih.,他们卖糕点。,及物；常见宾语 kuih、buku,动词;日常生活\nms-0291,ms,ms-04,buat,做,Saya buat nota.,我做笔记。,及物；常见宾语 nota,动词;日常生活\nms-0292,ms,ms-04,cari,找,Saya cari buku saya.,我找我的书。,及物；常见宾语 buku、pen,动词;日常生活\nms-0293,ms,ms-04,tengok,看,Saya tengok filem di rumah.,我在家看电影。,及物；常见宾语 filem；本周作整词记,动词;日常生活\nms-0294,ms,ms-04,lari,跑,Saya lari pada waktu pagi.,我早晨跑步。,不及物,动词;日常生活;补充\nms-0295,ms,ms-04,rehat,休息,Saya rehat di rumah.,我在家休息。,不及物,动词;日常生活;补充\nms-0296,ms,ms-04,masak,煮；做饭,Ibu masak nasi.,母亲煮米饭。,及物；常见宾语 nasi、mi,动词;日常生活;补充\nms-0297,ms,ms-04,cuci,洗,Saya cuci pinggan.,我洗盘子。,及物；常见宾语 pinggan、cawan,动词;日常生活;补充\nms-0298,ms,ms-04,aktiviti,活动,Aktiviti ini pada hari Sabtu.,这个活动在星期六。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0299,ms,ms-04,program,项目；活动安排,Program sekolah ini pada bulan Oktober.,学校的这个活动安排在十月。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0300,ms,ms-04,projek,项目,Projek ini belum siap.,这个项目尚未完成。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0301,ms,ms-04,idea,想法,Idea Ali sangat baik.,阿里的想法很好。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0302,ms,ms-04,nota,笔记,Saya tulis nota di kelas.,我在课堂上记笔记。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0303,ms,ms-04,fail,文件夹,Fail itu di atas meja.,那个文件夹在桌子上。,量词 buah,名词;英语借词\nms-0304,ms,ms-04,video,视频,Video ini sangat pendek.,这个视频很短。,量词 buah,名词;英语借词\nms-0305,ms,ms-04,muzik,音乐,Saya suka muzik ini.,我喜欢这段音乐。,一般不用量词；数量可直接放名词前,名词;英语借词\nms-0306,ms,ms-04,foto,照片,Foto keluarga saya di dalam bilik.,我的全家福在房间里。,量词 keping,名词;英语借词\nms-0307,ms,ms-04,filem,电影,Filem ini panjang sekali.,这部电影很长。,量词 buah,名词;英语借词\nms-0308,ms,ms-04,Saya belum siap.,我还没准备好。,Saya belum siap.,我还没准备好。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0309,ms,ms-04,Sekarang waktu rehat.,现在是休息时间。,Sekarang waktu rehat.,现在是休息时间。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0310,ms,ms-04,Esok saya akan pergi ke sekolah.,明天我将去学校。,Esok saya akan pergi ke sekolah.,明天我将去学校。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0311,ms,ms-04,Semalam saya sudah baca buku itu.,昨天我已经读了那本书。,Semalam saya sudah baca buku itu.,昨天我已经读了那本书。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0312,ms,ms-04,Hari ini saya sedang tulis nota.,今天我正在写笔记。,Hari ini saya sedang tulis nota.,今天我正在写笔记。,整句识别；时间词与体貌标记配合使用,代词;phrase\nms-0313,ms,ms-04,pukul,点钟（报时用）,Saya datang pada pukul lapan.,我八点来。,报时标记，放在数字前；一般不用量词，不表示计时长度,名词;时间;补充\nms-0314,ms,ms-04,setengah,半,Saya balik pada pukul lima setengah.,我五点半回家。,数词，表示一半,数词;时间;补充\nms-0315,ms,ms-04,suku,四分之一；一刻钟,Saya datang pada pukul tiga suku.,我三点一刻来。,数词；报时为过十五分钟,数词;时间;补充\nms-0316,ms,ms-04,minit,分钟,Saya rehat lima belas minit.,我休息十五分钟。,计时单位，一般不用量词,名词;时间;补充\nms-0317,ms,ms-04,pada,在（某个时间）,Saya pergi pada hari Isnin.,我星期一去。,介词，引时间；地点用 di,介词;时间;补充\nms-0318,ms,ms-04,tarikh,日期,Tarikh program ini 5 Oktober 2026.,这个活动的日期是 2026 年 10 月 5 日。,一般不用量词；写作 tarikh + 日期,名词;时间;补充\nms-0319,ms,ms-04,hari,天；日,Saya ada di sini tiga hari.,我在这里待三天。,计时单位，一般不用量词,名词;时间;补充\nms-0320,ms,ms-04,minggu,周；星期,Saya ada di Melaka dua minggu.,我在马六甲待两周。,计时单位，一般不用量词,名词;时间;补充\nms-0321,ms,ms-05,berjalan,走路,Saya berjalan ke sekolah setiap hari.,我每天走路去学校。,ber- + jalan → berjalan；词根 jalan；ber- 常规形式；不及物,动词;日常活动\nms-0322,ms,ms-05,berlari,跑步,Ali berlari di padang pada waktu pagi.,阿里早晨在运动场跑步。,ber- + lari → berlari；词根 lari；ber- 常规形式；不及物,动词;日常活动\nms-0323,ms,ms-05,bermain,玩；参加运动,Adik bermain bola dengan kawan.,弟弟和朋友玩球。,ber- + main → bermain；词根 main；ber- 常规形式；不及物,动词;日常活动\nms-0324,ms,ms-05,bercakap,说话,Kami bercakap dalam bahasa Melayu.,我们用马来语说话。,ber- + cakap → bercakap；词根 cakap；ber- 常规形式；不及物,动词;日常活动\nms-0325,ms,ms-05,berbual,聊天,Ibu berbual dengan kakak di rumah.,母亲和姐姐在家聊天。,ber- + bual → berbual；词根 bual；ber- 常规形式；不及物,动词;日常活动\nms-0326,ms,ms-05,berkata,说,\"Ali berkata, \"\"Saya sudah siap.\"\"\",阿里说：“我已经准备好了。”,ber- + kata → berkata；词根 kata；ber- 常规形式；不及物,动词;日常活动\nms-0327,ms,ms-05,berdiri,站立,Guru berdiri di depan kelas.,老师站在班级前面。,ber- + diri → berdiri；词根 diri；ber- 常规形式；不及物,动词;日常活动\nms-0328,ms,ms-05,berhenti,停下,Bas itu berhenti di depan sekolah.,那辆巴士在学校前停下。,ber- + henti → berhenti；词根 henti；ber- 常规形式；不及物,动词;日常活动\nms-0329,ms,ms-05,bertemu,见面,Saya bertemu dengan Siti pada hari Ahad.,我星期日和西蒂见面。,ber- + temu → bertemu；词根 temu；ber- 常规形式；不及物,动词;日常活动\nms-0330,ms,ms-05,berenang,游泳,Kami berenang di kolam pada petang Sabtu.,我们星期六下午在泳池游泳。,ber- + renang → berenang；词根 renang；be- 变体；不及物,动词;日常活动\nms-0331,ms,ms-05,berbaju,穿着上衣,Ali berbaju biru hari ini.,阿里今天穿着蓝色上衣。,ber- + baju → berbaju；词根 baju；ber- 常规形式；不及物,动词;日常活动\nms-0332,ms,ms-05,berkereta,有汽车；乘汽车,Kami berkereta ke Melaka pada hari Ahad.,我们星期日乘汽车去马六甲。,ber- + kereta → berkereta；词根 kereta；ber- 常规形式；不及物,动词;日常活动\nms-0333,ms,ms-05,berehat,休息,Bapa berehat di rumah pada waktu malam.,父亲晚上在家休息。,ber- + rehat → berehat；词根 rehat；be- 变体；不及物,动词;日常活动\nms-0334,ms,ms-05,berbasikal,骑自行车,Saya berbasikal dengan abang setiap petang.,我每天下午和哥哥骑自行车。,ber- + basikal → berbasikal；词根 basikal；ber- 常规形式；不及物,动词;日常活动\nms-0335,ms,ms-05,bersukan,从事体育运动,Kami bersukan di sekolah pada hari Jumaat.,我们星期五在学校运动。,ber- + sukan → bersukan；词根 sukan；ber- 常规形式；不及物,动词;日常活动\nms-0336,ms,ms-05,bersenam,做体操；锻炼,Ibu bersenam selama dua puluh minit.,母亲锻炼二十分钟。,ber- + senam → bersenam；词根 senam；ber- 常规形式；不及物,动词;日常活动\nms-0337,ms,ms-05,berlatih,练习,Mereka berlatih badminton pada waktu petang.,他们下午练习羽毛球。,ber- + latih → berlatih；词根 latih；ber- 常规形式；不及物,动词;日常活动\nms-0338,ms,ms-05,berkebun,做园艺；种菜,Bapa berkebun di belakang rumah.,父亲在屋后种菜。,ber- + kebun → berkebun；词根 kebun；ber- 常规形式；不及物,动词;日常活动\nms-0339,ms,ms-05,berdoa,祈祷,Keluarga itu berdoa di rumah.,那家人在家祈祷。,ber- + doa → berdoa；词根 doa；ber- 常规形式；不及物,动词;日常活动\nms-0340,ms,ms-05,berjumpa,见到；碰面,Saya berjumpa dengan guru selepas kelas.,我课后与老师见面。,ber- + jumpa → berjumpa；词根 jumpa；ber- 常规形式；不及物,动词;日常活动\nms-0341,ms,ms-05,bertanya,询问,Pelajar bertanya kepada guru tentang buku itu.,学生向老师询问那本书。,ber- + tanya → bertanya；词根 tanya；ber- 常规形式；不及物,动词;日常活动\nms-0342,ms,ms-05,bercuti,休假,Kami bercuti di Pulau Pinang minggu ini.,我们这周在槟城度假。,ber- + cuti → bercuti；词根 cuti；ber- 常规形式；不及物,动词;日常活动\nms-0343,ms,ms-05,berkumpul,集合；聚集,Para pelajar berkumpul di padang sekolah.,学生们在学校运动场集合。,ber- + kumpul → berkumpul；词根 kumpul；ber- 常规形式；不及物,动词;日常活动\nms-0344,ms,ms-05,berpayung,撑伞,Siti berpayung kerana hujan.,西蒂因为下雨而撑伞。,ber- + payung → berpayung；词根 payung；ber- 常规形式；不及物,动词;日常活动\nms-0345,ms,ms-05,berkasut,穿着鞋,Abang berkasut hitam ke sekolah.,哥哥穿着黑鞋去学校。,ber- + kasut → berkasut；词根 kasut；ber- 常规形式；不及物,动词;日常活动\nms-0346,ms,ms-05,selalu,经常,Saya selalu berjalan ke sekolah.,我经常走路去学校。,频率副词，放在动作前,副词;时间\nms-0347,ms,ms-05,sentiasa,始终；总是,Ibu sentiasa bangun pada pukul enam.,母亲总是六点起床。,表示持续或一贯,副词;时间\nms-0348,ms,ms-05,biasanya,通常,Kami biasanya bersukan pada hari Sabtu.,我们通常星期六运动。,表示一般习惯,副词;时间\nms-0349,ms,ms-05,kadang-kadang,有时,Saya kadang-kadang berkereta ke pejabat.,我有时乘汽车去办公室。,频率副词，连字符不可省,副词;时间\nms-0350,ms,ms-05,jarang,很少,Bapa jarang bercuti pada bulan Disember.,父亲很少在十二月休假。,频率低，不等于从不,副词;时间\nms-0351,ms,ms-05,tidak pernah,从未,Saya tidak pernah berenang di kolam itu.,我从未在那个泳池游泳。,否定词与体貌标记组合,副词;时间\nms-0352,ms,ms-05,setiap hari,每天,Ali belajar bahasa Melayu setiap hari.,阿里每天学马来语。,固定时间短语，setiap 后用单数名词,副词;时间\nms-0353,ms,ms-05,sering,时常,Kami sering berbual pada waktu rehat.,我们时常在休息时间聊天。,频率副词,副词;时间\nms-0354,ms,ms-05,sukan,体育运动,Saya suka sukan di sekolah.,我喜欢学校的体育运动。,量词 种类用 jenis,名词;活动与运动\nms-0355,ms,ms-05,bola,球,Adik ada dua biji bola.,弟弟有两个球。,量词 biji,名词;活动与运动\nms-0356,ms,ms-05,bola sepak,足球运动,Abang bermain bola sepak pada hari Ahad.,哥哥星期日踢足球。,量词 比赛场次用 perlawanan,名词;活动与运动\nms-0357,ms,ms-05,badminton,羽毛球运动,Kami bermain badminton setiap petang.,我们每天下午打羽毛球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0358,ms,ms-05,tenis,网球运动,Siti bermain tenis dengan Ali.,西蒂和阿里打网球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0359,ms,ms-05,pingpong,乒乓球运动,Kami bermain pingpong di sekolah.,我们在学校打乒乓球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0360,ms,ms-05,hoki,曲棍球运动,Kakak bermain hoki pada hari Sabtu.,姐姐星期六打曲棍球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0361,ms,ms-05,golf,高尔夫球运动,Bapa jarang bermain golf.,父亲很少打高尔夫球。,量词 比赛场次用 perlawanan,名词;活动与运动;英语借词\nms-0362,ms,ms-05,yoga,瑜伽,Ibu belajar yoga di rumah.,母亲在家学瑜伽。,量词 通常不用量词,名词;活动与运动;梵语借词\nms-0363,ms,ms-05,senaman,锻炼；体操,Senaman ini baik untuk saya.,这种锻炼对我有益。,量词 套用 set,名词;活动与运动\nms-0364,ms,ms-05,latihan,练习；训练,Latihan badminton kami pada pukul lima.,我们的羽毛球训练在五点。,通常不用专用量词，可写 satu latihan（一项练习）,名词;活动与运动\nms-0365,ms,ms-05,padang,运动场；草地,Padang sekolah itu besar.,那所学校的运动场很大。,量词 buah,名词;活动与运动\nms-0366,ms,ms-05,kolam,池；泳池,Kami berenang di kolam besar itu.,我们在那个大泳池游泳。,量词 buah,名词;活动与运动\nms-0367,ms,ms-05,kelab,俱乐部,Kelab sukan itu ada dua puluh orang pelajar.,那个体育俱乐部有二十名学生。,量词 buah,名词;活动与运动;英语借词\nms-0368,ms,ms-05,hobi,爱好,Hobi saya ialah berkebun.,我的爱好是园艺。,量词 通常不用量词,名词;活动与运动;英语借词\nms-0369,ms,ms-05,tangan,手,Tangan saya kecil.,我的手很小。,量词 只用 belah，双手用 pasang,名词;身体与衣物\nms-0370,ms,ms-05,kaki,脚；腿,Kaki Ali panjang.,阿里的腿很长。,量词 只用 belah，双脚用 pasang,名词;身体与衣物\nms-0371,ms,ms-05,kepala,头,Kepala kucing itu kecil.,那只猫的头很小。,一般不另用量词，按所属的人或动物计数,名词;身体与衣物\nms-0372,ms,ms-05,mata,眼睛,Mata adik besar.,弟弟的眼睛很大。,量词 只用 belah，双眼用 pasang,名词;身体与衣物\nms-0373,ms,ms-05,baju,上衣,Saya ada tiga helai baju biru.,我有三件蓝色上衣。,量词 helai,名词;身体与衣物\nms-0374,ms,ms-05,seluar,裤子,Seluar abang panjang.,哥哥的裤子很长。,量词 helai,名词;身体与衣物\nms-0375,ms,ms-05,kemeja,衬衫,Kemeja bapa baru.,父亲的衬衫是新的。,量词 helai,名词;身体与衣物;葡语借词\nms-0376,ms,ms-05,stoking,袜子,Saya ada dua pasang stoking.,我有两双袜子。,量词 pasang,名词;身体与衣物;英语借词\nms-0377,ms,ms-05,topi,帽子,Topi Siti biru.,西蒂的帽子是蓝色的。,量词 顶用 buah,名词;身体与衣物\nms-0378,ms,ms-05,tudung,头巾,Tudung Aminah cantik.,阿米娜的头巾很漂亮。,量词 helai,名词;身体与衣物\nms-0379,ms,ms-05,Saya berjalan setiap pagi.,我每天早晨走路。,Saya berjalan setiap pagi.,我每天早晨走路。,ber- + jalan；不及物；时间短语在句尾,动词;日常活动;phrase\nms-0380,ms,ms-05,Kami biasanya bersenam bersama.,我们通常一起锻炼。,Kami biasanya bersenam bersama.,我们通常一起锻炼。,ber- + senam；不及物；频率词在动作前,动词;日常活动;phrase\nms-0381,ms,ms-05,Saya tidak pernah bermain golf.,我从未打过高尔夫球。,Saya tidak pernah bermain golf.,我从未打过高尔夫球。,ber- + main；不及物；golf 是活动补语,动词;日常活动;phrase\nms-0382,ms,ms-05,Ali sedang berehat di rumah.,阿里正在家休息。,Ali sedang berehat di rumah.,阿里正在家休息。,ber- + rehat；be- 变体；不及物,动词;日常活动;phrase\nms-0383,ms,ms-05,Kita bertemu selepas kelas.,我们课后见面。,Kita bertemu selepas kelas.,我们课后见面。,ber- + temu；不及物,动词;日常活动;phrase\nms-0384,ms,ms-05,kereta,汽车,Kereta bapa besar.,父亲的汽车很大。,量词 buah,名词;日常活动;补充\nms-0385,ms,ms-05,basikal,自行车,Basikal saya baru.,我的自行车是新的。,量词 buah,名词;日常活动;补充\nms-0386,ms,ms-05,payung,伞,Payung ini untuk Siti.,这把伞给西蒂。,量词 把用 kaki,名词;日常活动;补充\nms-0387,ms,ms-05,hujan,雨,Hari ini hujan.,今天下雨。,通常不用量词；hujan 也可直接表示下雨,名词;日常活动;补充\nms-0388,ms,ms-05,gim,健身房,Gim itu di sebelah sekolah.,那间健身房在学校旁边。,量词 buah,名词;日常活动;英语借词;补充\nms-0389,ms,ms-05,selepas,在……之后,Saya berehat selepas senaman.,我锻炼后休息。,后接时间或活动，表示先后,介词;日常活动;补充\nms-0390,ms,ms-05,sebelum,在……之前,Kami mandi sebelum makan.,我们吃饭前洗澡。,后接时间或活动,介词;日常活动;补充\nms-0391,ms,ms-05,selama,持续……时间,Ali berenang selama setengah jam.,阿里游泳半小时。,后接时长,介词;日常活动;补充\nms-0392,ms,ms-05,kepada,向；对某人,Siti bertanya kepada guru.,西蒂向老师提问。,引出动作所指向的人,介词;日常活动;补充\nms-0393,ms,ms-05,tentang,关于,Kami berbual tentang sukan.,我们谈论体育。,引出话题,介词;日常活动;补充\nms-0394,ms,ms-05,bersama,一起,Kami berjalan bersama ke sekolah.,我们一起走路去学校。,ber- + sama；词根 sama；本课作副词,副词;日常活动;补充\nms-0395,ms,ms-05,letih,疲倦的,Saya letih selepas bersukan.,我运动后很累。,形容词，后置,形容词;日常活动;补充\nms-0396,ms,ms-05,sihat,健康的,Keluarga kami sihat.,我们一家人都健康。,形容词，后置,形容词;日常活动;阿拉伯语借词;补充\nms-0397,ms,ms-05,biru,蓝色的,Baju biru itu baju saya.,那件蓝色上衣是我的上衣。,形容词，后置,形容词;日常活动;补充\nms-0398,ms,ms-05,hitam,黑色的,Kasut hitam itu baru.,那双黑鞋是新的。,形容词，后置,形容词;日常活动;补充\nms-0399,ms,ms-05,merah,红色的,Bola merah itu untuk adik.,那个红球给弟弟。,形容词，后置,形容词;日常活动;补充\nms-0400,ms,ms-05,putih,白色的,Kemeja putih itu baru.,那件白衬衫是新的。,形容词，后置,形容词;日常活动;补充\nms-0401,ms,ms-06,melihat,看见,Saya melihat Siti di sekolah.,我在学校看见西蒂。,meN- + lihat → melihat，me-；l 保留；词根 lihat；及物；常见宾语 buku、kawan,动词;学习与工作\nms-0402,ms,ms-06,memasak,烹煮,Ibu memasak nasi di dapur.,母亲在厨房煮饭。,meN- + masak → memasak，me-；m 保留；词根 masak；及物；常见宾语 nasi、sayur,动词;学习与工作\nms-0403,ms,ms-06,menanti,等候,Kami menanti bas di depan sekolah.,我们在学校前等巴士。,meN- + nanti → menanti，me-；n 保留；词根 nanti；及物；常见宾语 bas、kawan,动词;学习与工作\nms-0404,ms,ms-06,merasa,品尝,Bapa merasa kopi itu.,父亲尝了尝那杯咖啡。,meN- + rasa → merasa，me-；r 保留；词根 rasa；及物；常见宾语 sup、kopi,动词;学习与工作\nms-0405,ms,ms-06,menyanyi,唱歌,Adik menyanyi di dalam bilik.,弟弟在房间里唱歌。,meN- + nyanyi → menyanyi，me-；ny 保留，不是 s 脱落；词根 nyanyi；不及物，不直接带宾语,动词;学习与工作\nms-0406,ms,ms-06,membaca,阅读,Siti membaca surat Ali.,西蒂读阿里的信。,meN- + baca → membaca，mem-；b 保留；词根 baca；及物；常见宾语 buku、surat,动词;学习与工作\nms-0407,ms,ms-06,membeli,购买,Kami membeli beras di kedai.,我们在商店买米。,meN- + beli → membeli，mem-；b 保留；词根 beli；及物；常见宾语 beras、baju,动词;学习与工作\nms-0408,ms,ms-06,memakai,穿戴；使用,Ali memakai baju putih ke sekolah.,阿里穿白色上衣去学校。,meN- + pakai → memakai，mem-；p 脱落；词根 pakai；及物；常见宾语 baju、kasut,动词;学习与工作\nms-0409,ms,ms-06,memukul,敲打；击打,Siti memukul bola itu.,西蒂击打那个球。,meN- + pukul → memukul，mem-；p 脱落；词根 pukul；及物；常见宾语 bola、gendang,动词;学习与工作\nms-0410,ms,ms-06,memproses,处理,Kerani memproses borang itu.,办事员处理那张表格。,meN- + proses → memproses，mem-；pr 辅音簇保留；词根 proses；及物；常见宾语 borang、data,动词;学习与工作\nms-0411,ms,ms-06,membawa,携带,Saya membawa beg ke sekolah.,我带着书包去学校。,meN- + bawa → membawa，mem-；b 保留；词根 bawa；及物；常见宾语 beg、buku,动词;学习与工作\nms-0412,ms,ms-06,mencari,寻找,Ali mencari pen di dalam beg.,阿里在包里找笔。,meN- + cari → mencari，men-；c 保留；词根 cari；及物；常见宾语 buku、pen,动词;学习与工作\nms-0413,ms,ms-06,mendengar,听；听见,Kami mendengar berita di radio.,我们听广播里的新闻。,meN- + dengar → mendengar，men-；d 保留；词根 dengar；及物；常见宾语 muzik、berita,动词;学习与工作\nms-0414,ms,ms-06,menjual,售卖,Kedai itu menjual sayur dan roti.,那家店卖蔬菜和面包。,meN- + jual → menjual，men-；j 保留；词根 jual；及物；常见宾语 sayur、roti,动词;学习与工作\nms-0415,ms,ms-06,menulis,书写,Saya menulis surat kepada Siti.,我给西蒂写信。,meN- + tulis → menulis，men-；t 脱落；词根 tulis；及物；常见宾语 surat、nota,动词;学习与工作\nms-0416,ms,ms-06,menunggu,等候,Mei Ling menunggu Raju di sekolah.,美玲在学校等拉朱。,meN- + tunggu → menunggu，men-；t 脱落；词根 tunggu；及物；常见宾语 bas、kawan,动词;学习与工作\nms-0417,ms,ms-06,mentadbir,管理,Beliau mentadbir sekolah itu.,他管理那所学校。,meN- + tadbir → mentadbir，men-；借词 t 保留，不是词首辅音簇；词根 tadbir；及物；常见宾语 sekolah、pejabat,动词;学习与工作\nms-0418,ms,ms-06,mencuci,洗,Adik mencuci tangan dengan sabun.,弟弟用肥皂洗手。,meN- + cuci → mencuci，men-；c 保留；词根 cuci；及物；常见宾语 tangan、baju,动词;学习与工作\nms-0419,ms,ms-06,menjawab,回答,Guru menjawab soalan saya.,老师回答我的问题。,meN- + jawab → menjawab，men-；j 保留；词根 jawab；及物；常见宾语 soalan、surat,动词;学习与工作\nms-0420,ms,ms-06,mengambil,拿取,Saya mengambil buku di atas meja.,我拿桌上的书。,meN- + ambil → mengambil，meng-；元音 a 保留；词根 ambil；及物；常见宾语 buku、air,动词;学习与工作\nms-0421,ms,ms-06,mengajar,教,Siti mengajar bahasa Melayu di sekolah.,西蒂在学校教马来语。,meN- + ajar → mengajar，meng-；元音 a 保留；词根 ajar；及物；常见宾语 bahasa、pelajar,动词;学习与工作\nms-0422,ms,ms-06,menghantar,送；寄送,Ali menghantar surat kepada Mei Ling.,阿里给美玲寄信。,meN- + hantar → menghantar，meng-；h 保留；词根 hantar；及物；常见宾语 surat、anak,动词;学习与工作\nms-0423,ms,ms-06,mengira,计算；数,Kerani mengira wang di pejabat.,办事员在办公室数钱。,meN- + kira → mengira，meng-；k 脱落；词根 kira；及物；常见宾语 wang、buku,动词;学习与工作\nms-0424,ms,ms-06,mengirim,寄送,Saya mengirim e-mel kepada guru.,我给老师发电子邮件。,meN- + kirim → mengirim，meng-；k 脱落；词根 kirim；及物；常见宾语 surat、e-mel,动词;学习与工作\nms-0425,ms,ms-06,mengkaji,研究,Mereka mengkaji bahasa Melayu di universiti.,他们在大学研究马来语。,meN- + kaji → mengkaji，meng-；k 保留，词汇例外；词根 kaji；及物；常见宾语 bahasa、resipi,动词;学习与工作\nms-0426,ms,ms-06,menggali,挖掘,Bapa menggali lubang di belakang rumah.,父亲在屋后挖洞。,meN- + gali → menggali，meng-；g 保留；词根 gali；及物；常见宾语 lubang、tanah,动词;学习与工作\nms-0427,ms,ms-06,mengukur,测量,Kakak mengukur kain itu.,姐姐测量那块布。,meN- + ukur → mengukur，meng-；元音 u 保留；词根 ukur；及物；常见宾语 meja、kain,动词;学习与工作\nms-0428,ms,ms-06,menyapu,扫,Ali menyapu lantai rumah.,阿里扫家里的地板。,meN- + sapu → menyapu，meny-；s 脱落；词根 sapu；及物；常见宾语 lantai、bilik,动词;学习与工作\nms-0429,ms,ms-06,menyewa,租用,Kami menyewa basikal di Melaka.,我们在马六甲租自行车。,meN- + sewa → menyewa，meny-；s 脱落；词根 sewa；及物；常见宾语 rumah、basikal,动词;学习与工作\nms-0430,ms,ms-06,menyimpan,保存；收好,Ibu menyimpan wang di bank.,母亲把钱存进银行。,meN- + simpan → menyimpan，meny-；s 脱落；词根 simpan；及物；常见宾语 wang、buku,动词;学习与工作\nms-0431,ms,ms-06,menyusun,排列；整理,Saya menyusun buku di atas meja.,我整理桌上的书。,meN- + susun → menyusun，meny-；s 脱落；词根 susun；及物；常见宾语 buku、kerusi,动词;学习与工作\nms-0432,ms,ms-06,mengecat,涂漆,Bapa mengecat pintu dengan berus.,父亲用刷子给门涂漆。,meN- + cat → mengecat，menge-；单音节词根完整保留；词根 cat；及物；常见宾语 dinding、pintu,动词;学习与工作\nms-0433,ms,ms-06,mengepam,打气；抽水,Ali mengepam tayar basikal.,阿里给自行车轮胎打气。,meN- + pam → mengepam，menge-；单音节词根完整保留；词根 pam；及物；常见宾语 tayar、air,动词;学习与工作\nms-0434,ms,ms-06,mengelap,擦拭,Siti mengelap meja dengan kain.,西蒂用布擦桌子。,meN- + lap → mengelap，menge-；单音节词根完整保留；词根 lap；及物；常见宾语 meja、tingkap,动词;学习与工作\nms-0435,ms,ms-06,mengepos,邮寄,Kakak mengepos surat pada hari Isnin.,姐姐星期一寄信。,meN- + pos → mengepos，menge-；单音节词根完整保留；词根 pos；及物；常见宾语 surat、borang,动词;学习与工作\nms-0436,ms,ms-06,surat,信,Surat ini daripada Ali.,这封信来自阿里。,量词 封用 pucuk,名词;学习与工作\nms-0437,ms,ms-06,sampul,信封,Saya menyimpan surat di dalam sampul.,我把信收在信封里。,量词 个用 keping,名词;学习与工作\nms-0438,ms,ms-06,borang,表格,Siti membaca borang itu.,西蒂读那张表格。,量词 张用 helai,名词;学习与工作\nms-0439,ms,ms-06,berus,刷子,Bapa membawa berus ke rumah.,父亲把刷子带回家。,量词 把用 batang,名词;学习与工作\nms-0440,ms,ms-06,cat,油漆,Cat ini merah.,这种油漆是红色的。,量词 罐用 tin,名词;学习与工作;闽南语借词\nms-0441,ms,ms-06,pam,泵；打气筒,Pam basikal itu kecil.,那个自行车打气筒很小。,量词 buah,名词;学习与工作;英语借词\nms-0442,ms,ms-06,tayar,轮胎,Tayar kereta itu baru.,那辆汽车的轮胎是新的。,量词 个用 biji,名词;学习与工作;英语借词\nms-0443,ms,ms-06,baldi,桶,Saya membawa baldi ke dapur.,我把桶拿到厨房。,量词 buah,名词;学习与工作;葡语借词\nms-0444,ms,ms-06,kain,布,Ibu membeli kain biru.,母亲买蓝布。,量词 片用 helai,名词;学习与工作\nms-0445,ms,ms-06,sabun,肥皂,Sabun ini untuk mencuci tangan.,这块肥皂用来洗手。,量词 块用 buku,名词;学习与工作\nms-0446,ms,ms-06,ubat,药,Ibu membeli ubat di klinik.,母亲在诊所买药。,量词 片用 biji，液体用 botol,名词;学习与工作\nms-0447,ms,ms-06,wang,钱,Wang saya ada di dalam beg.,我的钱在包里。,量词 金额用 ringgit,名词;学习与工作\nms-0448,ms,ms-06,cerita,故事,Cerita Ali sangat panjang.,阿里的故事很长。,量词 篇用 buah,名词;学习与工作\nms-0449,ms,ms-06,berita,新闻；消息,Berita itu tentang sekolah kami.,那条新闻是关于我们学校的。,量词 条用 buah,名词;学习与工作\nms-0450,ms,ms-06,lagu,歌曲,Lagu ini dalam bahasa Melayu.,这首歌是马来语歌。,量词 首用 buah,名词;学习与工作\nms-0451,ms,ms-06,resipi,食谱,Saya membaca resipi ibu.,我读母亲的食谱。,通常不用专用量词，可写 satu resipi（一份食谱）,名词;学习与工作;英语借词\nms-0452,ms,ms-06,beras,生米,Beras ini untuk keluarga kami.,这些米给我们一家人。,量词 袋用 kampit,名词;学习与工作\nms-0453,ms,ms-06,bawang,洋葱；葱蒜类,Ibu membeli bawang di kedai.,母亲在商店买洋葱。,量词 个用 biji,名词;学习与工作\nms-0454,ms,ms-06,minyak,油,Minyak ini untuk memasak.,这种油用来烹饪。,量词 瓶用 botol,名词;学习与工作\nms-0455,ms,ms-06,periuk,锅,Periuk itu ada di dapur.,那口锅在厨房。,量词 口用 buah,名词;学习与工作\nms-0456,ms,ms-06,sambil,一边……一边……,Siti memasak sambil mendengar radio.,西蒂一边做饭一边听广播。,连接同时发生的动作,连词;时间\nms-0457,ms,ms-06,lalu,然后；于是,Ali mengambil pen lalu menulis surat.,阿里拿起笔，然后写信。,连接先后动作,连词;时间\nms-0458,ms,ms-06,kemudian,然后,\"Saya mencuci tangan, kemudian makan nasi.\",我洗手，然后吃饭。,连接叙述的先后,副词;时间\nms-0459,ms,ms-06,akhirnya,最后；终于,Akhirnya kami bertemu di sekolah.,最后我们在学校见面了。,表示过程的末尾,副词;时间\nms-0460,ms,ms-06,segera,立刻,Saya segera menjawab e-mel guru.,我立即回复老师的电子邮件。,副词，表示不拖延,副词;时间\nms-0461,ms,ms-06,Saya sedang membaca surat.,我正在读信。,Saya sedang membaca surat.,我正在读信。,meN- + baca → membaca，b 保留；宾语 surat,动词;学习与工作;phrase\nms-0462,ms,ms-06,Ibu memasak sambil menyanyi.,母亲一边做饭一边唱歌。,Ibu memasak sambil menyanyi.,母亲一边做饭一边唱歌。,me- + masak；me- + nyanyi；此处不带宾语,动词;学习与工作;phrase\nms-0463,ms,ms-06,Ali menulis dengan pen.,阿里用笔写字。,Ali menulis dengan pen.,阿里用笔写字。,meN- + tulis → menulis，t 脱落；宾语可为 surat，本句省略,动词;学习与工作;phrase\nms-0464,ms,ms-06,Kami menyusun buku bersama.,我们一起整理书。,Kami menyusun buku bersama.,我们一起整理书。,meN- + susun → menyusun，s 脱落；宾语 buku,动词;学习与工作;phrase\nms-0465,ms,ms-06,Siti mengelap meja itu.,西蒂擦那张桌子。,Siti mengelap meja itu.,西蒂擦那张桌子。,meN- + lap → mengelap，单音节；宾语 meja,动词;学习与工作;phrase\nms-0466,ms,ms-06,kedai,商店,Kedai itu menjual beras dan sayur.,那家店卖米和蔬菜。,量词 家用 buah,名词;日常用品;补充\nms-0467,ms,ms-06,soalan,问题,Soalan guru itu tentang resipi.,老师的那个问题是关于食谱的。,通常不用专用量词，可写 satu soalan（一题）,名词;日常用品;补充\nms-0468,ms,ms-06,lubang,洞,Lubang itu kecil.,那个洞很小。,量词 个用 buah,名词;日常用品;补充\nms-0469,ms,ms-06,cili,辣椒,Ibu mencuci cili di dapur.,母亲在厨房洗辣椒。,量词 个用 biji,名词;日常用品;补充\nms-0470,ms,ms-06,daging,肉,Saya memasak daging dengan bawang.,我用洋葱煮肉。,量词 块用 ketul,名词;日常用品;补充\nms-0471,ms,ms-06,timun,黄瓜,Kakak membeli timun di kedai.,姐姐在商店买黄瓜。,量词 条用 batang,名词;日常用品;补充\nms-0472,ms,ms-06,lobak,萝卜,Saya mencuci lobak sebelum memasak.,我做饭前洗萝卜。,量词 根用 batang,名词;日常用品;补充\nms-0473,ms,ms-06,limau,柑橘；青柠,Air limau itu sejuk.,那杯青柠汁是凉的。,量词 个用 biji,名词;日常用品;补充\nms-0474,ms,ms-06,madu,蜂蜜,Madu itu di dalam gelas.,蜂蜜在玻璃杯里。,量词 瓶用 botol,名词;日常用品;补充\nms-0475,ms,ms-06,botol,瓶子,Botol itu untuk susu.,那个瓶子用来装牛奶。,量词 buah,名词;日常用品;补充\nms-0476,ms,ms-06,daripada,来自某人；由某种材料；比,Surat ini daripada guru saya.,这封信来自我的老师。,人、来源、材料和比较；地点来源用 dari,介词;学习与工作;补充\nms-0477,ms,ms-06,bersih,干净的,Meja itu sudah bersih.,那张桌子已经干净了。,形容词，后置,形容词;日常用品;补充\nms-0478,ms,ms-06,kotor,脏的,Kain kotor itu di dalam baldi.,那块脏布在桶里。,形容词，后置,形容词;日常用品;补充\nms-0479,ms,ms-06,kering,干的,Baju itu sudah kering.,那件上衣已经干了。,形容词，后置,形容词;日常用品;补充\nms-0480,ms,ms-06,basah,湿的,Kain itu masih basah.,那块布还湿着。,形容词，后置,形容词;日常用品;补充\nms-0481,ms,ms-07,di,在,Saya bekerja di Kuala Lumpur.,我在吉隆坡工作。,后接地点，分写；本课不教被动前缀 di-,介词;城市\nms-0482,ms,ms-07,ke,到；向,Kami pergi ke stesen dengan bas.,我们坐巴士去车站。,后接方向或地点，分写,介词;城市\nms-0483,ms,ms-07,dari,从,Ali datang dari Johor Bahru.,阿里从新山来。,地点、方向或时间的起点,介词;城市\nms-0484,ms,ms-07,untuk,为了；给,Buku ini untuk adik saya.,这本书给我的弟弟。,表示用途或受益者,介词;城市\nms-0485,ms,ms-07,bagi,为；对于,Latihan ini baik bagi pelajar.,这个练习对学生有益。,表示对象或受益者,介词;城市\nms-0486,ms,ms-07,mengenai,关于,Kami berbual mengenai bandar Melaka.,我们谈论马六甲城。,用法近于 tentang；本课作为介词整词学习,介词;城市\nms-0487,ms,ms-07,oleh,由,Saya membaca cerita oleh Siti.,我读西蒂写的故事。,可在名词后标作者；被动句施事用法留待 ms-11,介词;城市\nms-0488,ms,ms-07,sejak,自从,Saya tinggal di sini sejak tahun 2020.,我自2020年起住在这里。,引出持续情况的起点,介词;城市\nms-0489,ms,ms-07,hingga,直到,Ali bekerja dari pagi hingga petang.,阿里从早到下午工作。,引出时间或空间终点,介词;城市\nms-0490,ms,ms-07,sehingga,直到,Kami menunggu sehingga pukul lima.,我们一直等到五点。,引出终点或限度,介词;城市\nms-0491,ms,ms-07,sampai,直到；到,Saya berjalan dari rumah sampai sekolah.,我从家一直走到学校。,本课作介词，引出终点,介词;城市\nms-0492,ms,ms-07,antara,在……之间,Kami berehat antara pukul dua dengan pukul tiga.,我们在两点到三点之间休息。,常用 antara A dengan B,介词;城市\nms-0493,ms,ms-07,tanpa,没有；不带,Dia pergi ke sekolah tanpa beg.,他没带书包就去学校。,后接缺少的事物或动作,介词;城市\nms-0494,ms,ms-07,seperti,像,Rumah ini seperti rumah saya.,这座房子像我的家。,引出相似的事物,介词;城市\nms-0495,ms,ms-07,terhadap,对；对于,Sikapnya terhadap pelajar sangat baik.,他对学生的态度很好。,常配态度、看法等名词,介词;城市;补充\nms-0496,ms,ms-07,menerusi,经由；通过,Kami membaca berita menerusi e-mel.,我们通过电子邮件读消息。,本课作介词整词学习，不开放 -i 派生,介词;城市;补充\nms-0497,ms,ms-07,di atas,在……上面,Buku saya di atas meja.,我的书在桌上。,di 分写，atas 表上方,介词;方位\nms-0498,ms,ms-07,di bawah,在……下面,Kucing itu di bawah kerusi.,那只猫在椅子下面。,di 分写，bawah 表下方,介词;方位\nms-0499,ms,ms-07,di dalam,在……里面,Wang saya di dalam beg.,我的钱在包里。,具体空间内部,介词;方位\nms-0500,ms,ms-07,di luar,在……外面,Ali menunggu di luar sekolah.,阿里在学校外等候。,luar 表外部,介词;方位\nms-0501,ms,ms-07,di depan,在……前面,Bas berhenti di depan stesen.,巴士在车站前停下。,depan 表前方,介词;方位\nms-0502,ms,ms-07,di belakang,在……后面,Taman itu di belakang rumah.,公园在屋后。,belakang 表后方,介词;方位\nms-0503,ms,ms-07,di sebelah,在……旁边,Klinik di sebelah bank.,诊所在银行旁边。,sebelah 表旁边,介词;方位\nms-0504,ms,ms-07,di tepi,在……边上,Mereka berdiri di tepi jalan.,他们站在路边。,tepi 表边缘,介词;方位\nms-0505,ms,ms-07,di tengah,在……中间,Meja itu di tengah bilik.,那张桌子在房间中间。,tengah 表中央,介词;方位\nms-0506,ms,ms-07,di antara,在……之间,Masjid itu di antara dua buah bangunan.,清真寺在两栋建筑之间。,具体空间位置；后接两个对象或复数,介词;方位\nms-0507,ms,ms-07,hadapan,前方,Ali berdiri di hadapan sekolah.,阿里站在学校前面。,量词 通常不用量词,名词;方位\nms-0508,ms,ms-07,hujung,尽头；末端,Pejabat pos itu di hujung jalan.,邮局在路的尽头。,量词 通常不用量词,名词;方位\nms-0509,ms,ms-07,stesen,车站,Stesen itu berhampiran rumah saya.,车站在我家附近。,量词 buah,名词;城市;英语借词\nms-0510,ms,ms-07,pejabat pos,邮局,Kami mengepos surat di pejabat pos.,我们在邮局寄信。,量词 buah,名词;城市\nms-0511,ms,ms-07,pasar,市场,Ibu membeli sayur di pasar.,母亲在市场买菜。,量词 buah,名词;城市\nms-0512,ms,ms-07,masjid,清真寺,Masjid itu di tengah bandar.,那座清真寺在市中心。,量词 buah,名词;城市;阿拉伯语借词\nms-0513,ms,ms-07,taman,公园,Kami bersenam di taman setiap pagi.,我们每天早晨在公园锻炼。,量词 座用 buah,名词;城市\nms-0514,ms,ms-07,jalan,道路,Jalan ini ke stesen.,这条路通往车站。,量词 条用 batang,名词;城市\nms-0515,ms,ms-07,jambatan,桥,Jambatan itu panjang.,那座桥很长。,量词 座用 buah,名词;城市\nms-0516,ms,ms-07,lapangan terbang,机场,Bas ini ke lapangan terbang.,这辆巴士开往机场。,量词 座用 buah,名词;城市\nms-0517,ms,ms-07,perpustakaan,图书馆,Siti membaca di perpustakaan.,西蒂在图书馆读书。,量词 座用 buah,名词;城市\nms-0518,ms,ms-07,balai polis,警察局,Balai polis itu di sebelah bank.,警察局在银行旁边。,量词 座用 buah,名词;城市\nms-0519,ms,ms-07,bandar,城市,Bandar Melaka ada banyak kedai.,马六甲城有许多商店。,量词 座用 buah,名词;城市\nms-0520,ms,ms-07,kampung,村庄,Kampung saya berhampiran Johor Bahru.,我的村庄在新山附近。,量词 座用 buah,名词;城市\nms-0521,ms,ms-07,bangunan,建筑物,Bangunan itu tinggi dan putih.,那栋建筑很高，是白色的。,量词 栋用 buah,名词;城市\nms-0522,ms,ms-07,kedai buku,书店,Saya membeli buku di kedai buku itu.,我在那家书店买书。,量词 家用 buah,名词;城市\nms-0523,ms,ms-07,kedai makan,小餐馆,Kami makan di kedai makan berhampiran stesen.,我们在车站附近的小餐馆吃饭。,量词 家用 buah,名词;城市\nms-0524,ms,ms-07,pasar raya,超市,Pasar raya itu menjual susu dan roti.,那家超市卖牛奶和面包。,量词 家用 buah,名词;城市\nms-0525,ms,ms-07,pusat bandar,市中心,Pejabat saya di pusat bandar.,我的办公室在市中心。,量词 个用 buah,名词;城市\nms-0526,ms,ms-07,hentian bas,巴士停靠站,Ali menunggu di hentian bas.,阿里在巴士站等候。,量词 个用 buah,名词;城市\nms-0527,ms,ms-07,pelabuhan,港口,Pelabuhan itu di Pulau Pinang.,那个港口在槟城。,量词 座用 buah,名词;城市\nms-0528,ms,ms-07,stadium,体育场,Kami bermain bola sepak di stadium.,我们在体育场踢足球。,量词 座用 buah,名词;城市;英语借词\nms-0529,ms,ms-07,kereta api,火车,Saya ke Kuala Lumpur dengan kereta api.,我乘火车去吉隆坡。,量词 列用 buah,名词;交通\nms-0530,ms,ms-07,motosikal,摩托车,Motosikal itu di depan rumah.,那辆摩托车在屋前。,量词 辆用 buah,名词;交通;英语借词\nms-0531,ms,ms-07,kapal terbang,飞机,Kapal terbang itu besar.,那架飞机很大。,量词 架用 buah,名词;交通\nms-0532,ms,ms-07,feri,渡轮,Kami ke Pulau Pinang dengan feri.,我们坐渡轮去槟城。,量词 艘用 buah,名词;交通;英语借词\nms-0533,ms,ms-07,lori,货车,Lori itu membawa beras ke kedai.,那辆货车把米运到商店。,量词 辆用 buah,名词;交通;英语借词\nms-0534,ms,ms-07,van,厢式车,Van sekolah itu sudah sampai.,学校的厢式车已经到了。,量词 辆用 buah,名词;交通;英语借词\nms-0535,ms,ms-07,beca,三轮车,Saya melihat beca di Melaka.,我在马六甲看见三轮车。,量词 辆用 buah,名词;交通;闽南语借词\nms-0536,ms,ms-07,bot,小船,Bot itu di sebelah jambatan.,那条小船在桥旁边。,量词 艘用 buah,名词;交通;英语借词\nms-0537,ms,ms-07,Jalan terus.,一直走。,Jalan terus.,一直走。,祈使表达；jalan 作不及物动词，terus 表继续,动词;问路;phrase\nms-0538,ms,ms-07,Belok kiri.,向左转。,Belok kiri.,向左转。,不及物指路动词 belok；左为 kiri,动词;问路;phrase\nms-0539,ms,ms-07,Belok kanan.,向右转。,Belok kanan.,向右转。,不及物指路动词 belok；右为 kanan,动词;问路;phrase\nms-0540,ms,ms-07,Bagaimana hendak ke stesen?,怎样去车站？,Bagaimana hendak ke stesen?,怎样去车站？,完整问路句，hendak 表意图,动词;问路;phrase\nms-0541,ms,ms-07,Di mana perpustakaan?,图书馆在哪里？,Di mana perpustakaan?,图书馆在哪里？,地点疑问句，di mana 分写,动词;问路;phrase\nms-0542,ms,ms-07,Ikut jalan ini.,沿这条路走。,Ikut jalan ini.,沿这条路走。,及物祈使动词 ikut；常见宾语 jalan,动词;问路;phrase\nms-0543,ms,ms-07,Berhenti di sini.,在这里停下。,Berhenti di sini.,在这里停下。,ber- + henti；不及物；祈使也保留 ber-,动词;问路;phrase\nms-0544,ms,ms-07,Berjalan ke sana.,走到那里去。,Berjalan ke sana.,走到那里去。,ber- + jalan；不及物,动词;问路;phrase\nms-0545,ms,ms-07,kiri,左边,Bank itu di sebelah kiri.,银行在左边。,量词 通常不用量词,名词;城市;补充\nms-0546,ms,ms-07,kanan,右边,Stesen itu di sebelah kanan.,车站在右边。,量词 通常不用量词,名词;城市;补充\nms-0547,ms,ms-07,utara,北方,Sekolah itu di utara bandar.,学校在城市北部。,量词 通常不用量词,名词;城市;补充\nms-0548,ms,ms-07,selatan,南方,Kampung itu di selatan Melaka.,那个村庄在马六甲南边。,量词 通常不用量词,名词;城市;补充\nms-0549,ms,ms-07,timur,东方,Masjid itu di timur kampung.,清真寺在村庄东边。,量词 通常不用量词,名词;城市;补充\nms-0550,ms,ms-07,barat,西方,Pelabuhan itu di barat bandar.,港口在城市西边。,量词 通常不用量词,名词;城市;补充\nms-0551,ms,ms-07,simpang,路口；岔路,Ali menunggu di simpang itu.,阿里在那个路口等候。,量词 个用 buah,名词;城市;补充\nms-0552,ms,ms-07,lampu isyarat,交通信号灯,Bas berhenti di lampu isyarat.,巴士在信号灯前停下。,量词 组用 set,名词;城市;补充\nms-0553,ms,ms-07,peta,地图,Saya melihat peta bandar Melaka.,我查看马六甲城的地图。,量词 张用 helai,名词;城市;补充\nms-0554,ms,ms-07,laluan,路线；通道,Laluan ini untuk basikal.,这条通道供自行车使用。,通常不用专用量词，可写 satu laluan（一条通道）,名词;城市;补充\nms-0555,ms,ms-07,sikap,态度,Sikap Ali terhadap kawan sangat baik.,阿里对朋友的态度很好。,量词 通常不用量词,名词;城市;补充\nms-0556,ms,ms-07,dekat,近的,Rumah saya dekat dengan sekolah.,我家离学校近。,形容词，后置；dekat dengan,形容词;城市;补充\nms-0557,ms,ms-07,jauh,远的,Stesen itu jauh dari kampung.,车站离村庄远。,形容词，后置；jauh dari,形容词;城市;补充\nms-0558,ms,ms-07,berhampiran,靠近,Rumah saya berhampiran stesen.,我家靠近车站。,ber- + hampir + -an；词根 hampir；本课按整词学，不开放 -an；不及物,动词;城市;补充\nms-0559,ms,ms-07,masuk,进入,Ali masuk ke dalam kedai.,阿里走进商店。,不及物；地点由 ke 引出,动词;城市;补充\nms-0560,ms,ms-07,keluar,出去；出来,Siti keluar dari perpustakaan.,西蒂从图书馆出来。,不及物；地点由 dari 引出,动词;城市;补充\nms-0561,ms,ms-08,dapat,能够；得以,Esok saya akan dapat bertemu dengan guru.,明天我将能见到老师。,表示有条件实现，放在动词前,助动词;情态\nms-0562,ms,ms-08,mesti,必须；一定要,Kita mesti mencuci tangan sebelum makan.,我们吃饭前必须洗手。,义务或要求，后接动词,助动词;情态\nms-0563,ms,ms-08,harus,应该；应当,Kita harus membantu keluarga.,我们应该帮助家人。,本课表示应当，后接动词,助动词;情态\nms-0564,ms,ms-08,perlu,需要,Saya perlu membeli roti.,我需要买面包。,必要性，后接动词或名词,助动词;情态\nms-0565,ms,ms-08,mahu,想要,Saya mahu minum air limau.,我想喝青柠汁。,意愿；标准书面形式,助动词;情态\nms-0566,ms,ms-08,hendak,想要；打算,Kami hendak makan di restoran.,我们打算在餐馆吃饭。,意愿或打算；标准书面形式,助动词;情态\nms-0567,ms,ms-08,ingin,希望；想要,Saya ingin belajar memasak rendang.,我想学做仁当。,较正式的意愿表达,助动词;情态\nms-0568,ms,ms-08,pandai,擅长；会,Siti pandai memasak nasi lemak.,西蒂擅长做椰浆饭。,本课作情态性谓语，后接动词；也可作形容词,助动词;情态\nms-0569,ms,ms-08,sanggup,愿意；肯,Ali sanggup membantu saya.,阿里愿意帮助我。,表示愿意承担某事,助动词;情态\nms-0570,ms,ms-08,mampu,有能力,Kami mampu membayar bil ini.,我们有能力支付这张账单。,能力或财力，后接动词,助动词;情态\nms-0571,ms,ms-08,patut,应该,Kita patut menunggu di luar.,我们应该在外面等候。,表示合适的做法,助动词;情态;补充\nms-0572,ms,ms-08,enggan,不愿意,Adik enggan minum susu itu.,弟弟不愿喝那杯牛奶。,否定意愿，不另加 tidak,助动词;情态;补充\nms-0573,ms,ms-08,tolong,请帮忙,Tolong buka pintu itu.,请帮忙打开那扇门。,请求时后接动词原形；作及物动词「帮助」时常见宾语 saya,动词;请求与礼貌\nms-0574,ms,ms-08,minta,要；请求,Saya minta segelas air.,我要一杯水。,及物；常见宾语 air、bantuan；本课作礼貌请求,动词;请求与礼貌\nms-0575,ms,ms-08,tolong bantu saya,请帮帮我,\"Ali, tolong bantu saya.\",阿里，请帮帮我。,请求表达；及物动词 bantu 的宾语 saya,动词;请求与礼貌;phrase\nms-0576,ms,ms-08,minta air,要水,Saya minta air panas.,我要热水。,及物动词 minta；常见宾语 air,动词;请求与礼貌;phrase\nms-0577,ms,ms-08,maafkan saya,请原谅我,\"Siti, maafkan saya.\",西蒂，请原谅我。,固定礼貌表达；maaf + -kan；宾语 saya；本课按整词学，-kan 在 ms-09 系统学,动词;请求与礼貌;phrase\nms-0578,ms,ms-08,sila,请,Sila duduk di sini.,请坐这里。,邀请或礼貌指示，后接动词,语气词;请求与礼貌\nms-0579,ms,ms-08,jangan,不要；禁止,Jangan masuk ke dapur.,不要进入厨房。,禁止词，放在动词前,语气词;请求与礼貌\nms-0580,ms,ms-08,silalah,请吧,Silalah duduk di sini.,请坐这里吧。,sila + -lah，连写；本课按整词记,语气词;请求与礼貌\nms-0581,ms,ms-08,sila tunggu sebentar,请稍等,\"Ali, sila tunggu sebentar.\",阿里，请稍等。,sila + 动词 tunggu；完整请求表达,语气词;请求与礼貌;phrase\nms-0582,ms,ms-08,jangan masuk,请勿进入,\"Adik, jangan masuk.\",弟弟，不要进去。,jangan + 动词 masuk；禁止表达,语气词;请求与礼貌;phrase\nms-0583,ms,ms-08,makanan,食物,Makanan di restoran ini sedap.,这家餐馆的食物很好吃。,通常不用专用量词；按份可用 pinggan 或 bungkus,名词;食物与需求\nms-0584,ms,ms-08,minuman,饮料,Minuman ini untuk Ali.,这杯饮料给阿里。,量词 杯用 gelas,名词;食物与需求\nms-0585,ms,ms-08,sarapan,早餐,Sarapan saya roti dan telur.,我的早餐是面包和鸡蛋。,量词 set（套餐）,名词;食物与需求\nms-0586,ms,ms-08,santan,椰浆,Ibu memasak nasi dengan santan.,母亲用椰浆煮饭。,量词 杯用 cawan,名词;食物与需求\nms-0587,ms,ms-08,tepung,面粉,Tepung itu untuk membuat roti canai.,那些面粉用来做印度煎饼。,量词 袋用 kampit,名词;食物与需求\nms-0588,ms,ms-08,mentega,黄油,Saya mahu roti dengan mentega.,我想要涂黄油的面包。,量词 块用 buku,名词;食物与需求;葡语借词\nms-0589,ms,ms-08,roti canai,印度煎饼,Saya memesan dua keping roti canai.,我点两张印度煎饼。,量词 张用 keping,名词;食物与需求\nms-0590,ms,ms-08,nasi lemak,椰浆饭,Siti membeli nasi lemak untuk sarapan.,西蒂买椰浆饭当早餐。,量词 份用 bungkus 或 pinggan,名词;食物与需求\nms-0591,ms,ms-08,satay,沙爹串,Kami makan satay di Melaka.,我们在马六甲吃沙爹。,量词 串用 cucuk,名词;食物与需求\nms-0592,ms,ms-08,rendang,仁当炖肉,Rendang ini sangat sedap.,这份仁当很好吃。,量词 份用 pinggan,名词;食物与需求\nms-0593,ms,ms-08,kari,咖喱,Ibu memasak kari ayam.,母亲煮咖喱鸡。,量词 碗用 mangkuk,名词;食物与需求\nms-0594,ms,ms-08,sup,汤,Saya minta semangkuk sup panas.,我要一碗热汤。,量词 碗用 mangkuk,名词;食物与需求;英语借词\nms-0595,ms,ms-08,jus,果汁,Jus epal ini untuk adik.,这杯苹果汁给弟弟。,量词 杯用 gelas,名词;食物与需求;英语借词\nms-0596,ms,ms-08,ais,冰,Saya mahu teh tanpa ais.,我要不加冰的茶。,量词 块用 ketul,名词;食物与需求;英语借词\nms-0597,ms,ms-08,menu,菜单,Menu itu di atas meja.,菜单在桌上。,量词 naskhah（纸本）；也可直接写 satu menu,名词;食物与需求;英语借词\nms-0598,ms,ms-08,harga,价格,Harga roti ini tiga ringgit.,这种面包的价格是三令吉。,量词 通常不用量词，金额用 ringgit,名词;食物与需求\nms-0599,ms,ms-08,bil,账单,Saya membayar bil di restoran.,我在餐馆付账。,量词 张用 helai,名词;食物与需求;英语借词\nms-0600,ms,ms-08,pesanan,订单；点单,Pesanan kami dua pinggan nasi lemak.,我们点的是两盘椰浆饭。,通常不用专用量词，可写 satu pesanan（一份订单）,名词;食物与需求\nms-0601,ms,ms-08,bantuan,帮助,Kami perlu bantuan guru.,我们需要老师的帮助。,量词 通常不用量词,名词;食物与需求\nms-0602,ms,ms-08,kebenaran,许可,Saya meminta kebenaran untuk keluar.,我请求外出的许可。,量词 通常不用量词,名词;食物与需求\nms-0603,ms,ms-08,meminta,请求,Ali meminta bantuan guru.,阿里请求老师帮助。,meN- + minta → meminta，me-；m 保留；词根 minta；及物；常见宾语 bantuan、kebenaran,动词;学习与工作\nms-0604,ms,ms-08,membantu,帮助,Saya membantu ibu di dapur.,我在厨房帮母亲。,meN- + bantu → membantu，mem-；b 保留；词根 bantu；及物；常见宾语 ibu、kawan,动词;学习与工作\nms-0605,ms,ms-08,membayar,支付,Bapa membayar bil dengan wang itu.,父亲用那些钱付账。,meN- + bayar → membayar，mem-；b 保留；词根 bayar；及物；常见宾语 bil、harga,动词;学习与工作\nms-0606,ms,ms-08,memesan,点餐；订购,Kami memesan makanan di restoran.,我们在餐馆点餐。,meN- + pesan → memesan，mem-；p 脱落；词根 pesan；及物；常见宾语 nasi、minuman,动词;学习与工作\nms-0607,ms,ms-08,menerima,收到；接受,Siti menerima surat daripada Ali.,西蒂收到阿里的信。,meN- + terima → menerima，men-；t 脱落；词根 terima；及物；常见宾语 surat、bantuan,动词;学习与工作\nms-0608,ms,ms-08,membuka,打开,Ali membuka tingkap bilik.,阿里打开房间的窗户。,meN- + buka → membuka，mem-；b 保留；词根 buka；及物；常见宾语 pintu、tingkap,动词;学习与工作\nms-0609,ms,ms-08,menutup,关上,Ibu menutup pintu dapur.,母亲关上厨房的门。,meN- + tutup → menutup，men-；t 脱落；词根 tutup；及物；常见宾语 pintu、kedai,动词;学习与工作\nms-0610,ms,ms-08,meminjam,借入,Saya meminjam buku daripada Siti.,我向西蒂借书。,meN- + pinjam → meminjam，mem-；p 脱落；词根 pinjam；及物；常见宾语 buku、pen,动词;学习与工作\nms-0611,ms,ms-08,menggoreng,油炸；炒,Bapa menggoreng ikan di dapur.,父亲在厨房煎鱼。,meN- + goreng → menggoreng，meng-；g 保留；词根 goreng；及物；常见宾语 ikan、telur,动词;学习与工作\nms-0612,ms,ms-08,merebus,用水煮,Saya merebus telur untuk sarapan.,我煮鸡蛋当早餐。,meN- + rebus → merebus，me-；r 保留；词根 rebus；及物；常见宾语 telur、mi,动词;学习与工作\nms-0613,ms,ms-08,memotong,切；剪,Ibu memotong sayur dengan pisau.,母亲用刀切菜。,meN- + potong → memotong，mem-；p 脱落；词根 potong；及物；常见宾语 sayur、kain,动词;学习与工作\nms-0614,ms,ms-08,mencampur,混合,Siti mencampur tepung dengan air.,西蒂把面粉和水混合。,meN- + campur → mencampur，men-；c 保留；词根 campur；及物；常见宾语 tepung、air,动词;学习与工作\nms-0615,ms,ms-08,menambah,添加,Saya menambah garam ke dalam sup.,我往汤里加盐。,meN- + tambah → menambah，men-；t 脱落；词根 tambah；及物；常见宾语 air、garam,动词;学习与工作\nms-0616,ms,ms-08,memilih,挑选,Raju memilih makanan pada menu.,拉朱从菜单上挑选食物。,meN- + pilih → memilih，mem-；p 脱落；词根 pilih；及物；常见宾语 makanan、buku,动词;学习与工作\nms-0617,ms,ms-08,mencuba,尝试,Kami mencuba resipi baru itu.,我们尝试那个新食谱。,meN- + cuba → mencuba，men-；c 保留；词根 cuba；及物；常见宾语 resipi、makanan,动词;学习与工作\nms-0618,ms,ms-08,memegang,拿着；握着,Adik memegang gelas dengan dua tangan.,弟弟用两只手握着玻璃杯。,meN- + pegang → memegang，mem-；p 脱落；词根 pegang；及物；常见宾语 gelas、beg,动词;学习与工作\nms-0619,ms,ms-08,menjemput,邀请,Siti menjemput kami ke rumahnya.,西蒂邀请我们去她家。,meN- + jemput → menjemput，men-；j 保留；词根 jemput；及物；常见宾语 kawan、guru,动词;学习与工作\nms-0620,ms,ms-08,menghidang,端上；摆出食物,Ibu menghidang nasi dan kari.,母亲端上米饭和咖喱。,meN- + hidang → menghidang，meng-；h 保留；词根 hidang；及物；常见宾语 nasi、makanan,动词;学习与工作\nms-0621,ms,ms-08,menolak,拒绝,Ali tidak menolak bantuan kami.,阿里没有拒绝我们的帮助。,meN- + tolak → menolak，men-；t 脱落；词根 tolak；及物；常见宾语 bantuan、pesanan,动词;学习与工作\nms-0622,ms,ms-08,mengangkat,举起；搬起,Kami mengangkat meja bersama.,我们一起搬桌子。,meN- + angkat → mengangkat，meng-；元音 a 保留；词根 angkat；及物；常见宾语 meja、beg,动词;学习与工作\nms-0623,ms,ms-08,Tolong tutup pintu.,请帮忙关门。,Tolong tutup pintu.,请帮忙关门。,及物请求动词 tutup；宾语 pintu；祈使中用词根,动词;请求与计划;phrase\nms-0624,ms,ms-08,Silalah duduk.,请坐吧。,Silalah duduk.,请坐吧。,sila + -lah；duduk 不及物,动词;请求与计划;phrase\nms-0625,ms,ms-08,Saya belum boleh keluar.,我还不能出去。,Saya belum boleh keluar.,我还不能出去。,belum 在 boleh 前；keluar 不及物,动词;请求与计划;phrase\nms-0626,ms,ms-08,Kita mesti datang awal.,我们必须早到。,Kita mesti datang awal.,我们必须早到。,mesti 在动作前；datang 不及物,动词;请求与计划;phrase\nms-0627,ms,ms-08,Saya ingin memesan minuman.,我想点饮料。,Saya ingin memesan minuman.,我想点饮料。,meN- + pesan → memesan，p 脱落；宾语 minuman,动词;请求与计划;phrase\nms-0628,ms,ms-08,ringgit,令吉,Bil ini dua puluh ringgit.,这张账单是二十令吉。,量词 货币单位，本身作量词,名词;日常需求;补充\nms-0629,ms,ms-08,sen,仙；分币,Harga kuih ini lima puluh sen.,这块糕点的价格是五十仙。,量词 货币单位，本身作量词,名词;日常需求;英语借词;补充\nms-0630,ms,ms-08,pisau,刀,Pisau itu di atas meja dapur.,刀在厨房桌上。,量词 把用 bilah,名词;日常需求;补充\nms-0631,ms,ms-08,tisu,纸巾,Saya perlu tisu untuk tangan.,我需要纸巾擦手。,量词 张用 helai,名词;日常需求;英语借词;补充\nms-0632,ms,ms-08,duduk,坐,Sila duduk di sebelah saya.,请坐在我旁边。,不及物；地点由 di 引出,动词;日常需求;补充\nms-0633,ms,ms-08,buka,打开,Tolong buka tingkap itu.,请帮忙打开那扇窗。,及物；常见宾语 pintu、tingkap；祈使可用词根,动词;日常需求;补充\nms-0634,ms,ms-08,tutup,关上,Sila tutup pintu itu.,请关上那扇门。,及物；常见宾语 pintu、kedai；祈使用词根,动词;日常需求;补充\nms-0635,ms,ms-08,sebentar,一会儿,Sila tunggu sebentar di sini.,请在这里稍等。,表示短时间,副词;时间;补充\nms-0636,ms,ms-08,awal,早,Saya datang awal hari ini.,我今天来得早。,本课作时间副词,副词;时间;补充\nms-0637,ms,ms-08,segelas,一杯,Saya minta segelas air panas.,我要一杯热水。,se- + gelas，本课按完整数量表达记，不开放 se- 推导,量词;食物;补充\nms-0638,ms,ms-08,semangkuk,一碗,Ibu menghidang semangkuk sup.,母亲端上一碗汤。,se- + mangkuk，本课按完整数量表达记，不开放 se- 推导,量词;食物;补充\nms-0639,ms,ms-08,lapar,饿的,Saya lapar dan mahu makan.,我饿了，想吃饭。,形容词，后置,形容词;食物;补充\nms-0640,ms,ms-08,dahaga,渴的,Ali dahaga dan perlu air.,阿里渴了，需要水。,形容词，后置,形容词;食物;补充\nms-0641,ms,ms-09,membesarkan,扩大,Mereka membesarkan dapur rumah itu.,他们扩建那所房子的厨房。,meN- + besar + -kan → membesarkan，mem-，词根首字母保留；词根 besar；及物动词，常见宾语 dapur,动词;-kan 动词\nms-0642,ms,ms-09,menjalankan,开展,Guru menjalankan program membaca di sekolah.,老师在学校开展阅读活动。,meN- + jalan + -kan → menjalankan，men-，词根首字母保留；词根 jalan；及物动词，常见宾语 program,动词;-kan 动词\nms-0643,ms,ms-09,memasukkan,放入,Siti memasukkan buku ke dalam beg.,西蒂把书放进包里。,meN- + masuk + -kan → memasukkan，me-，词根首字母保留；词根 masuk；及物动词，常见宾语 buku；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0644,ms,ms-09,membelikan,替某人买,Ali membelikan ibunya satu helai baju.,阿里替母亲买了一件衣服。,meN- + beli + -kan → membelikan，mem-，词根首字母保留；词根 beli；及物动词，常见宾语 ibu、baju,动词;-kan 动词\nms-0645,ms,ms-09,membuatkan,替某人做,Ibu membuatkan adik sarapan.,母亲替弟弟做早餐。,meN- + buat + -kan → membuatkan，mem-，词根首字母保留；词根 buat；及物动词，常见宾语 adik、sarapan,动词;-kan 动词\nms-0646,ms,ms-09,memberikan,给予,Guru memberikan buku kepada saya.,老师把书给我。,meN- + beri + -kan → memberikan，mem-，词根首字母保留；词根 beri；及物动词，常见宾语 buku,动词;-kan 动词\nms-0647,ms,ms-09,mengatakan,说；表示,Ali mengatakan bahawa dia letih.,阿里说他累了。,meN- + kata + -kan → mengatakan，meng-，k 脱落；词根 kata；及物动词，常见宾语 bahawa 引出的内容,动词;-kan 动词\nms-0648,ms,ms-09,menggunakan,使用,Kami menggunakan komputer di perpustakaan.,我们在图书馆使用电脑。,meN- + guna + -kan → menggunakan，meng-，词根首字母保留；词根 guna；及物动词，常见宾语 komputer,动词;-kan 动词\nms-0649,ms,ms-09,menyediakan,准备；提供,Siti menyediakan makanan untuk kami.,西蒂为我们准备食物。,meN- + sedia + -kan → menyediakan，meny-，s 脱落；词根 sedia；及物动词，常见宾语 makanan,动词;-kan 动词\nms-0650,ms,ms-09,menjelaskan,解释,Guru menjelaskan soalan itu kepada pelajar.,老师向学生解释那道题。,meN- + jelas + -kan → menjelaskan，men-，词根首字母保留；词根 jelas；及物动词，常见宾语 soalan,动词;-kan 动词\nms-0651,ms,ms-09,menyebabkan,造成,Hujan menyebabkan jalan itu basah.,雨使那条路变湿了。,meN- + sebab + -kan → menyebabkan，meny-，s 脱落；词根 sebab；及物动词，常见宾语 jalan basah 等结果,动词;-kan 动词\nms-0652,ms,ms-09,mendapatkan,获得,Saya mendapatkan maklumat daripada guru.,我从老师那里获得信息。,meN- + dapat + -kan → mendapatkan，men-，词根首字母保留；词根 dapat；及物动词，常见宾语 maklumat,动词;-kan 动词\nms-0653,ms,ms-09,meletakkan,放置,Ali meletakkan cawan di atas meja.,阿里把杯子放在桌上。,meN- + letak + -kan → meletakkan，me-，词根首字母保留；词根 letak；及物动词，常见宾语 cawan；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0654,ms,ms-09,menghantarkan,送去,Saya menghantarkan makanan ke rumah Siti.,我把食物送到西蒂家。,meN- + hantar + -kan → menghantarkan，meng-，词根首字母保留；词根 hantar；及物动词，常见宾语 makanan,动词;-kan 动词\nms-0655,ms,ms-09,mengeluarkan,取出,Dia mengeluarkan wang dari beg.,他从包里取出钱。,meN- + keluar + -kan → mengeluarkan，meng-，k 脱落；词根 keluar；及物动词，常见宾语 wang,动词;-kan 动词\nms-0656,ms,ms-09,membersihkan,清洁,Kami membersihkan bilik sebelum kelas.,我们在上课前打扫房间。,meN- + bersih + -kan → membersihkan，mem-，词根首字母保留；词根 bersih；及物动词，常见宾语 bilik,动词;-kan 动词\nms-0657,ms,ms-09,mengeringkan,弄干,Ibu mengeringkan kain di luar rumah.,母亲在屋外晾干布。,meN- + kering + -kan → mengeringkan，meng-，k 脱落；词根 kering；及物动词，常见宾语 kain,动词;-kan 动词\nms-0658,ms,ms-09,memanaskan,加热,Siti memanaskan sup di dapur.,西蒂在厨房里热汤。,meN- + panas + -kan → memanaskan，mem-，p 脱落；词根 panas；及物动词，常见宾语 sup,动词;-kan 动词\nms-0659,ms,ms-09,menyejukkan,冷却,Saya menyejukkan air sebelum minum.,我把水放凉后再喝。,meN- + sejuk + -kan → menyejukkan，meny-，s 脱落；词根 sejuk；及物动词，常见宾语 air；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0660,ms,ms-09,memendekkan,缩短,Guru memendekkan waktu rehat hari ini.,老师今天缩短了休息时间。,meN- + pendek + -kan → memendekkan，mem-，p 脱落；词根 pendek；及物动词，常见宾语 waktu；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0661,ms,ms-09,memanjangkan,延长,Kami memanjangkan waktu membaca.,我们延长阅读时间。,meN- + panjang + -kan → memanjangkan，mem-，p 脱落；词根 panjang；及物动词，常见宾语 waktu,动词;-kan 动词\nms-0662,ms,ms-09,menghabiskan,用完；吃完,Adik menghabiskan nasi di dalam mangkuk.,弟弟吃完碗里的饭。,meN- + habis + -kan → menghabiskan，meng-，词根首字母保留；词根 habis；及物动词，常见宾语 nasi,动词;-kan 动词\nms-0663,ms,ms-09,menyampaikan,传达,Guru menyampaikan pesanan kepada ibu.,老师向母亲传达消息。,meN- + sampai + -kan → menyampaikan，meny-，s 脱落；词根 sampai；及物动词，常见宾语 pesanan,动词;-kan 动词\nms-0664,ms,ms-09,menunjukkan,指给看,Ali menunjukkan alamat itu kepada saya.,阿里把那个地址指给我看。,meN- + tunjuk + -kan → menunjukkan，men-，t 脱落；词根 tunjuk；及物动词，常见宾语 alamat；词根末尾 k 与 -kan 连写为 kk,动词;-kan 动词\nms-0665,ms,ms-09,mengingatkan,提醒,Ibu mengingatkan saya tentang janji itu.,母亲提醒我那次约定。,meN- + ingat + -kan → mengingatkan，meng-，词根首字母保留；词根 ingat；及物动词，常见宾语 saya、janji,动词;-kan 动词\nms-0666,ms,ms-09,menyimpankan,留存,Saya menyimpankan wang untuk adik.,我替弟弟存钱。,meN- + simpan + -kan → menyimpankan，meny-，s 脱落；词根 simpan；及物动词，常见宾语 wang,动词;-kan 动词\nms-0667,ms,ms-09,menerangkan,说明,Guru menerangkan maksud perkataan itu.,老师说明那个词的意思。,meN- + terang + -kan → menerangkan，men-，t 脱落；词根 terang；及物动词，常见宾语 maksud,动词;-kan 动词\nms-0668,ms,ms-09,menyelesaikan,完成；解决,Kami menyelesaikan tugas sebelum petang.,我们在下午前完成任务。,meN- + selesai + -kan → menyelesaikan，meny-，s 脱落；词根 selesai；及物动词，常见宾语 tugas,动词;-kan 动词\nms-0669,ms,ms-09,menukarkan,更换,Dia menukarkan wang di bank.,他在银行兑换钱。,meN- + tukar + -kan → menukarkan，men-，t 脱落；词根 tukar；及物动词，常见宾语 wang,动词;-kan 动词\nms-0670,ms,ms-09,memulangkan,归还,Saya memulangkan buku kepada Ali.,我把书还给阿里。,meN- + pulang + -kan → memulangkan，mem-，p 脱落；词根 pulang；及物动词，常见宾语 buku,动词;-kan 动词\nms-0671,ms,ms-09,maklumat,信息,Maklumat ini ada di dalam buku.,这条信息在书里。,一般不用量词,名词;日常事务\nms-0672,ms,ms-09,alamat,地址,Saya menulis alamat sekolah pada sampul.,我把学校地址写在信封上。,一般不用量词,名词;日常事务\nms-0673,ms,ms-09,janji,约定,Saya ada janji dengan Siti esok.,我明天和西蒂有约。,一般不用量词,名词;日常事务\nms-0674,ms,ms-09,tugas,任务,Tugas saya ialah membersihkan kelas.,我的任务是打扫教室。,一般不用量词,名词;日常事务\nms-0675,ms,ms-09,hadiah,礼物,Ali memberikan hadiah kepada ibunya.,阿里给母亲礼物。,量词 buah,名词;日常事务\nms-0676,ms,ms-09,kotak,盒子,Kotak kecil itu untuk hadiah ibu.,那个小盒子用来装母亲的礼物。,量词 buah,名词;日常事务\nms-0677,ms,ms-09,bakul,篮子,Siti memasukkan sayur ke dalam bakul.,西蒂把蔬菜放进篮子里。,量词 buah,名词;日常事务\nms-0678,ms,ms-09,dulang,托盘,Ibu meletakkan cawan di atas dulang.,母亲把杯子放到托盘上。,量词 buah,名词;日常事务\nms-0679,ms,ms-09,bekas,容器,Bekas makanan itu bersih dan kering.,那个食品容器干净又干燥。,量词 buah,名词;日常事务\nms-0680,ms,ms-09,kunci,钥匙,Kunci rumah ada di dalam beg saya.,家门钥匙在我的包里。,量词 batang,名词;日常事务\nms-0681,ms,ms-09,rak,架子,Ali menyusun buku di atas rak.,阿里把书摆在架子上。,量词 buah,名词;日常事务\nms-0682,ms,ms-09,laci,抽屉,Pen saya ada di dalam laci meja.,我的笔在书桌抽屉里。,量词 buah,名词;日常事务\nms-0683,ms,ms-09,tuala,毛巾,Saya membeli satu helai tuala biru.,我买了一条蓝毛巾。,量词 helai,名词;日常事务\nms-0684,ms,ms-09,selimut,毯子,Adik tidur dengan selimut merah.,弟弟盖着红毯子睡觉。,量词 helai,名词;日常事务\nms-0685,ms,ms-09,cadar,床单,Ibu mencuci cadar pada pagi ini.,母亲今天早晨洗床单。,量词 helai,名词;日常事务\nms-0686,ms,ms-09,cermin,镜子,Cermin itu di sebelah tingkap.,那面镜子在窗户旁边。,量词 keping,名词;日常事务\nms-0687,ms,ms-09,tali,绳子,Tali ini panjang dan basah.,这根绳子又长又湿。,量词 utas,名词;日常事务\nms-0688,ms,ms-09,plastik,塑料,Bekas ini daripada plastik.,这个容器是塑料做的。,一般不用量词；数量按物品计,名词;日常事务\nms-0689,ms,ms-09,kaca,玻璃,Cawan ini daripada kaca.,这个杯子是玻璃做的。,一般不用量词；片状可用 keping,名词;日常事务\nms-0690,ms,ms-09,kayu,木材,Meja itu daripada kayu.,那张桌子是木制的。,量词 batang（长条）,名词;日常事务\nms-0691,ms,ms-09,alat,工具,Bapa menyimpan alat di dalam kotak.,父亲把工具放在盒子里。,量词 buah,名词;日常事务\nms-0692,ms,ms-09,bahan,材料,Kami menyediakan bahan untuk projek sekolah.,我们准备学校项目所需的材料。,一般不用量词,名词;日常事务\nms-0693,ms,ms-09,tujuan,目的,Tujuan program ini ialah belajar bersama.,这个活动的目的是一起学习。,一般不用量词,名词;日常事务\nms-0694,ms,ms-09,hasil,成果,Hasil projek itu sangat baik.,那个项目的成果很好。,一般不用量词,名词;日常事务\nms-0695,ms,ms-09,masalah,问题；困难,Kami menjelaskan masalah itu kepada guru.,我们向老师说明那个问题。,一般不用量词,名词;日常事务\nms-0696,ms,ms-09,bahawa,（引出陈述内容）,Siti mengatakan bahawa dia akan datang.,西蒂说她会来。,引出内容从句,连词;连接与程度\nms-0697,ms,ms-09,supaya,以便,Saya membuka tingkap supaya bilik sejuk.,我打开窗户，让房间凉快。,引出目的,连词;连接与程度\nms-0698,ms,ms-09,jika,如果,\"Jika hujan, kita belajar di rumah.\",如果下雨，我们就在家学习。,引出条件,连词;连接与程度\nms-0699,ms,ms-09,hampir,几乎,Saya hampir menghabiskan nasi itu.,我快吃完那些饭了。,放在动词前,副词;连接与程度\nms-0700,ms,ms-09,semula,重新,Ali membaca surat itu semula.,阿里重新读那封信。,常放在动词或宾语后,副词;连接与程度\nms-0701,ms,ms-09,Sila masukkan buku ke dalam beg.,请把书放进包里。,Sila masukkan buku ke dalam beg.,请把书放进包里。,整句识别；请求句保留 -kan,动词;句型;phrase\nms-0702,ms,ms-09,Tolong jelaskan soalan ini.,请解释这道题。,Tolong jelaskan soalan ini.,请解释这道题。,整句识别；请求句保留 -kan,动词;句型;phrase\nms-0703,ms,ms-09,Saya akan memulangkan buku esok.,我明天会还书。,Saya akan memulangkan buku esok.,我明天会还书。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0704,ms,ms-09,Ibu membelikan saya kasut baru.,母亲替我买了新鞋。,Ibu membelikan saya kasut baru.,母亲替我买了新鞋。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0705,ms,ms-09,Kami menyediakan makanan bersama.,我们一起准备食物。,Kami menyediakan makanan bersama.,我们一起准备食物。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0706,ms,ms-09,maksud,意思,Maksud perkataan ini jelas.,这个词的意思很清楚。,一般不用量词,名词;日常事务;补充\nms-0707,ms,ms-09,perkataan,词,Saya menulis perkataan baru di dalam buku.,我把新词写在本子里。,一般不用量词,名词;日常事务;补充\nms-0708,ms,ms-09,langkah,步骤,Guru menerangkan langkah pertama kepada kami.,老师向我们说明第一步。,一般不用量词,名词;日常事务;补充\nms-0709,ms,ms-09,contoh,例子,Guru memberikan contoh yang baik.,老师给出一个好例子。,一般不用量词,名词;日常事务;补充\nms-0710,ms,ms-09,sebab,原因,Sebab Ali belum datang ialah hujan.,阿里还没来的原因是下雨。,一般不用量词,名词;日常事务;补充\nms-0711,ms,ms-09,jelas,清楚,Alamat pada surat ini jelas.,这封信上的地址很清楚。,形容词，后置,形容词;日常事务;补充\nms-0712,ms,ms-09,penting,重要,Maklumat ini sangat penting untuk kita.,这个信息对我们很重要。,形容词，后置,形容词;日常事务;补充\nms-0713,ms,ms-09,mudah,容易,Tugas ini mudah bagi saya.,这项任务对我来说很容易。,形容词，后置,形容词;日常事务;补充\nms-0714,ms,ms-09,sukar,困难,Soalan itu sukar bagi adik.,那道题对弟弟来说很难。,形容词，后置,形容词;日常事务;补充\nms-0715,ms,ms-09,penuh,满,Bakul itu penuh dengan sayur.,那个篮子里装满了蔬菜。,形容词，后置,形容词;日常事务;补充\nms-0716,ms,ms-09,kosong,空,Kotak kosong itu di bawah meja.,那个空盒子在桌子下面。,形容词，后置,形容词;日常事务;补充\nms-0717,ms,ms-09,ringan,轻,Beg kecil ini sangat ringan.,这个小包很轻。,形容词，后置,形容词;日常事务;补充\nms-0718,ms,ms-09,berat,重,Kotak buku itu berat sekali.,那个装书的盒子很重。,形容词，后置,形容词;日常事务;补充\nms-0719,ms,ms-09,selamat,安全,Jalan ini selamat untuk kita.,这条路对我们来说是安全的。,形容词，后置,形容词;日常事务;补充\nms-0720,ms,ms-09,senang hati,高兴；开心,Ibu senang hati menerima hadiah itu.,母亲高兴地收下那份礼物。,形容词，后置；马来西亚 senang 单用多指「容易」，表示高兴要说 senang hati；印尼语 senang 单用即表示高兴,形容词;日常事务;补充\nms-0721,ms,ms-10,mengunjungi,拜访；参观,Kami mengunjungi muzium di Melaka.,我们参观马六甲的博物馆。,meN- + kunjung + -i → mengunjungi，meng-，k 脱落；词根 kunjung；及物动词，常见宾语 muzium,动词;-i 动词\nms-0722,ms,ms-10,memasuki,进入,Pelajar memasuki kelas pada pukul lapan.,学生们八点进入教室。,meN- + masuk + -i → memasuki，me-，词根首字母保留；词根 masuk；及物动词，常见宾语 kelas,动词;-i 动词\nms-0723,ms,ms-10,menaiki,登上；乘坐,Saya menaiki bas ke bandar.,我乘公共汽车去城里。,meN- + naik + -i → menaiki，me-，词根首字母保留；词根 naik；及物动词，常见宾语 bas,动词;-i 动词\nms-0724,ms,ms-10,menyukai,喜欢,Adik menyukai buku cerita ini.,弟弟喜欢这本故事书。,meN- + suka + -i → menyukai，meny-，s 脱落；词根 suka；及物动词，常见宾语 buku,动词;-i 动词\nms-0725,ms,ms-10,mencintai,爱,Kami mencintai negara Malaysia.,我们爱马来西亚这个国家。,meN- + cinta + -i → mencintai，men-，词根首字母保留；词根 cinta；及物动词，常见宾语 negara,动词;-i 动词\nms-0726,ms,ms-10,menghadiri,出席,Ibu menghadiri mesyuarat di sekolah.,母亲出席学校的会议。,meN- + hadir + -i → menghadiri，meng-，词根首字母保留；词根 hadir；及物动词，常见宾语 mesyuarat,动词;-i 动词\nms-0727,ms,ms-10,mengikuti,跟随；参加,Saya mengikuti kelas bahasa Melayu.,我参加马来语课。,meN- + ikut + -i → mengikuti，meng-，词根首字母保留；词根 ikut；及物动词，常见宾语 kelas,动词;-i 动词\nms-0728,ms,ms-10,menyertai,参加,Ali menyertai lawatan ke Pulau Pinang.,阿里参加去槟城的参观活动。,meN- + serta + -i → menyertai，meny-，s 脱落；词根 serta；及物动词，常见宾语 lawatan,动词;-i 动词\nms-0729,ms,ms-10,memiliki,拥有,Siti memiliki sebuah basikal merah.,西蒂拥有一辆红自行车。,meN- + milik + -i → memiliki，me-，词根首字母保留；词根 milik；及物动词，常见宾语 basikal,动词;-i 动词\nms-0730,ms,ms-10,mengetahui,知道,Guru mengetahui alamat rumah saya.,老师知道我家的地址。,meN- + tahu + -i → mengetahui；词根 tahu；特殊形式，整词记忆；常见宾语 alamat,动词;-i 动词\nms-0731,ms,ms-10,menghormati,尊重,Kita mesti menghormati guru dan ibu bapa.,我们必须尊重老师和父母。,meN- + hormat + -i → menghormati，meng-，词根首字母保留；词根 hormat；及物动词，常见宾语 guru,动词;-i 动词\nms-0732,ms,ms-10,menikmati,享受,Mereka menikmati makanan di restoran itu.,他们在那家餐馆享用美食。,meN- + nikmat + -i → menikmati，me-，词根首字母保留；词根 nikmat；及物动词，常见宾语 makanan,动词;-i 动词\nms-0733,ms,ms-10,melayani,对待；接待,Ali melayani tetamu dengan baik.,阿里好好地招待客人。,meN- + layan + -i → melayani，me-，词根首字母保留；词根 layan；及物动词，常见宾语 tetamu,动词;-i 动词\nms-0734,ms,ms-10,mengakhiri,结束,Guru mengakhiri kelas pada pukul lima.,老师五点结束课程。,meN- + akhir + -i → mengakhiri，meng-，词根首字母保留；词根 akhir；及物动词，常见宾语 kelas,动词;-i 动词\nms-0735,ms,ms-10,mengulangi,重复,Saya mengulangi perkataan itu dengan jelas.,我清楚地重复那个词。,meN- + ulang + -i → mengulangi，meng-，词根首字母保留；词根 ulang；及物动词，常见宾语 perkataan,动词;-i 动词\nms-0736,ms,ms-10,mengatasi,克服；解决,Kami mengatasi masalah itu bersama.,我们一起解决那个问题。,meN- + atas + -i → mengatasi，meng-，词根首字母保留；词根 atas；及物动词，常见宾语 masalah,动词;-i 动词\nms-0737,ms,ms-10,mendekati,靠近,Jangan mendekati sungai yang dalam.,不要靠近水深的河流。,meN- + dekat + -i → mendekati，men-，词根首字母保留；词根 dekat；及物动词，常见宾语 sungai,动词;-i 动词\nms-0738,ms,ms-10,menghubungi,联系,Saya menghubungi kakak dengan telefon.,我用电话联系姐姐。,meN- + hubung + -i → menghubungi，meng-，词根首字母保留；词根 hubung；及物动词，常见宾语 kakak,动词;-i 动词\nms-0739,ms,ms-10,menemani,陪伴,Siti menemani ibunya ke pasar.,西蒂陪母亲去市场。,meN- + teman + -i → menemani，men-，t 脱落；词根 teman；及物动词，常见宾语 ibu,动词;-i 动词\nms-0740,ms,ms-10,merawati,照料,Jururawat merawati adik di hospital.,护士在医院照料弟弟。,meN- + rawat + -i → merawati，me-，词根首字母保留；词根 rawat；及物动词，常见宾语 adik,动词;-i 动词\nms-0741,ms,ms-10,mengubati,医治,Doktor mengubati orang yang sakit.,医生医治病人。,meN- + ubat + -i → mengubati，meng-，词根首字母保留；词根 ubat；及物动词，常见宾语 orang sakit,动词;-i 动词\nms-0742,ms,ms-10,melindungi,保护,Payung ini melindungi kita daripada hujan.,这把伞保护我们不受雨淋。,meN- + lindung + -i → melindungi，me-，词根首字母保留；词根 lindung；及物动词，常见宾语 kita,动词;-i 动词\nms-0743,ms,ms-10,melengkapi,补全,Pelajar melengkapi nota dengan contoh.,学生用例子补全笔记。,meN- + lengkap + -i → melengkapi，me-，词根首字母保留；词根 lengkap；及物动词，常见宾语 nota,动词;-i 动词\nms-0744,ms,ms-10,menyelidiki,调查研究,Pelajar menyelidiki sejarah bandar itu.,学生研究那座城市的历史。,meN- + selidik + -i → menyelidiki，meny-，s 脱落；词根 selidik；及物动词，常见宾语 sejarah,动词;-i 动词\nms-0745,ms,ms-10,menguasai,掌握,Saya mahu menguasai bahasa Melayu.,我想掌握马来语。,meN- + kuasa + -i → menguasai，meng-，k 脱落；词根 kuasa；及物动词，常见宾语 bahasa,动词;-i 动词\nms-0746,ms,ms-10,mendatangkan,带来,Program itu mendatangkan hasil yang baik.,那个活动带来良好的成果。,meN- + datang + -kan → mendatangkan，men-，词根首字母保留；词根 datang；及物动词，常见宾语 hasil,动词;-kan／-i 对比\nms-0747,ms,ms-10,menjauhkan,使远离,Ibu menjauhkan adik daripada sungai.,母亲让弟弟远离河流。,meN- + jauh + -kan → menjauhkan，men-，词根首字母保留；词根 jauh；及物动词，常见宾语 adik,动词;-kan／-i 对比\nms-0748,ms,ms-10,menempatkan,安置,Guru menempatkan pelajar di bilik baru.,老师把学生安置在新房间。,meN- + tempat + -kan → menempatkan，men-，t 脱落；词根 tempat；及物动词，常见宾语 pelajar,动词;-kan／-i 对比\nms-0749,ms,ms-10,menghadiahkan,赠送（物品）,Ali menghadiahkan buku kepada Siti.,阿里把书赠给西蒂。,meN- + hadiah + -kan → menghadiahkan，meng-，词根首字母保留；词根 hadiah；及物动词，常见宾语 buku,动词;-kan／-i 对比\nms-0750,ms,ms-10,menyiramkan,浇洒（液体）,Ibu menyiramkan air pada pokok bunga.,母亲把水浇在花木上。,meN- + siram + -kan → menyiramkan，meny-，s 脱落；词根 siram；及物动词，常见宾语 air,动词;-kan／-i 对比\nms-0751,ms,ms-10,mendatangi,来到；登门拜访,Mereka mendatangi rumah Ali untuk bertemu dengannya.,他们到阿里家去见他。,meN- + datang + -i → mendatangi，men-，词根首字母保留；词根 datang；及物动词，常见宾语 rumah,动词;-kan／-i 对比\nms-0752,ms,ms-10,menjauhi,避开；远离,Kita mesti menjauhi sungai itu.,我们必须远离那条河。,meN- + jauh + -i → menjauhi，men-，词根首字母保留；词根 jauh；及物动词，常见宾语 sungai,动词;-kan／-i 对比\nms-0753,ms,ms-10,menempati,占用；居住于,Kami menempati bilik di tingkat dua.,我们住在二楼的房间。,meN- + tempat + -i → menempati，men-，t 脱落；词根 tempat；及物动词，常见宾语 bilik,动词;-kan／-i 对比\nms-0754,ms,ms-10,menghadiahi,赠给（某人）,Ali menghadiahi Siti sebuah buku.,阿里赠给西蒂一本书。,meN- + hadiah + -i → menghadiahi，meng-，词根首字母保留；词根 hadiah；及物动词，常见宾语 Siti,动词;-kan／-i 对比\nms-0755,ms,ms-10,menyirami,浇灌（植物）,Ibu menyirami pokok bunga di kebun.,母亲浇灌园圃里的花木。,meN- + siram + -i → menyirami，meny-，s 脱落；词根 siram；及物动词，常见宾语 pokok,动词;-kan／-i 对比\nms-0756,ms,ms-10,negara,国家,Malaysia ialah negara saya.,马来西亚是我的国家。,量词 buah,名词;参观与联系\nms-0757,ms,ms-10,mesyuarat,会议,Mesyuarat itu pada hari Jumaat.,那场会议在星期五。,一般不用量词,名词;参观与联系\nms-0758,ms,ms-10,lawatan,参观；访问,Lawatan ke Melaka itu pada minggu depan.,去马六甲的参观活动在下周。,一般不用量词,名词;参观与联系\nms-0759,ms,ms-10,tetamu,客人,Kami menyediakan makanan untuk tetamu.,我们为客人准备食物。,量词 orang,名词;参观与联系\nms-0760,ms,ms-10,sungai,河流,Sungai itu dekat dengan kampung kami.,那条河靠近我们的村子。,量词 batang,名词;参观与联系\nms-0761,ms,ms-10,sejarah,历史,Saya membaca buku tentang sejarah Malaysia.,我读关于马来西亚历史的书。,一般不用量词,名词;参观与联系\nms-0762,ms,ms-10,tingkat,楼层,Bilik kami di tingkat tiga.,我们的房间在三楼。,一般不用量词,名词;参观与联系\nms-0763,ms,ms-10,tangga,楼梯,Tangga itu di sebelah pintu.,楼梯在门旁边。,量词 buah,名词;参观与联系\nms-0764,ms,ms-10,pantai,海滩,Mereka berjalan di pantai pada petang itu.,他们那天下午在海滩散步。,一般不用量词,名词;参观与联系\nms-0765,ms,ms-10,pulau,岛屿,Pulau itu kecil dan cantik.,那个岛又小又漂亮。,量词 buah,名词;参观与联系\nms-0766,ms,ms-10,bukit,小山,Kami melihat bukit dari tingkap hotel.,我们从酒店窗户看小山。,量词 buah,名词;参观与联系\nms-0767,ms,ms-10,gunung,山；高山,Gunung itu jauh dari bandar.,那座山远离城市。,量词 buah,名词;参观与联系\nms-0768,ms,ms-10,hutan,森林,Hutan itu dekat dengan sungai.,那片森林靠近河流。,一般不用量词,名词;参观与联系\nms-0769,ms,ms-10,ladang,农场,Petani bekerja di ladang pada pagi ini.,农民今天早晨在农场工作。,量词 buah,名词;参观与联系\nms-0770,ms,ms-10,kebun,园圃,Ibu menanam bunga di kebun.,母亲在园圃里种花。,量词 buah,名词;参观与联系\nms-0771,ms,ms-10,pokok,树,Ada pokok besar di depan rumah.,房子前面有棵大树。,量词 batang,名词;参观与联系\nms-0772,ms,ms-10,daun,叶子,Daun itu jatuh di atas meja.,那片叶子落在桌上。,量词 helai,名词;参观与联系\nms-0773,ms,ms-10,akar,根,Akar pokok itu panjang.,那棵树的根很长。,一般不用量词,名词;参观与联系\nms-0774,ms,ms-10,tanah,土壤,Tanah di kebun itu basah.,园圃里的土壤是湿的。,一般不用量词,名词;参观与联系\nms-0775,ms,ms-10,pasir,沙,Pasir di pantai itu panas.,海滩上的沙很热。,一般不用量词,名词;参观与联系\nms-0776,ms,ms-10,angin,风,Angin di pantai itu sejuk.,海滩上的风很凉爽。,一般不用量词,名词;参观与联系\nms-0777,ms,ms-10,cuaca,天气,Cuaca hari ini baik untuk lawatan.,今天的天气适合参观。,一般不用量词,名词;参观与联系\nms-0778,ms,ms-10,pengalaman,经历,Saya menulis tentang pengalaman di Melaka.,我写在马六甲的经历。,一般不用量词；整词学习,名词;参观与联系\nms-0779,ms,ms-10,peluang,机会,Kami ada peluang untuk bertemu dengan guru.,我们有机会和老师见面。,一般不用量词,名词;参观与联系\nms-0780,ms,ms-10,rancangan,计划,Rancangan kami ialah mengunjungi muzium esok.,我们的计划是明天参观博物馆。,一般不用量词；整词学习,名词;参观与联系\nms-0781,ms,ms-10,Saya ingin menyertai lawatan ini.,我想参加这次参观活动。,Saya ingin menyertai lawatan ini.,我想参加这次参观活动。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0782,ms,ms-10,Sila hubungi saya esok.,请明天联系我。,Sila hubungi saya esok.,请明天联系我。,整句识别；请求句保留 -i,动词;句型;phrase\nms-0783,ms,ms-10,Kami akan menghadiri mesyuarat itu.,我们会出席那场会议。,Kami akan menghadiri mesyuarat itu.,我们会出席那场会议。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0784,ms,ms-10,Ali menghadiahi ibunya satu helai baju.,阿里送给母亲一件衣服。,Ali menghadiahi ibunya satu helai baju.,阿里送给母亲一件衣服。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0785,ms,ms-10,Jangan menjauhi kawan tanpa sebab.,不要无缘无故疏远朋友。,Jangan menjauhi kawan tanpa sebab.,不要无缘无故疏远朋友。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0786,ms,ms-10,cara,方法,Cara ini mudah untuk pelajar baru.,这个方法对新学生来说很容易。,一般不用量词,名词;参观与联系;补充\nms-0787,ms,ms-10,tempat,地方,Tempat itu dekat dengan muzium.,那个地方靠近博物馆。,一般不用量词,名词;参观与联系;补充\nms-0788,ms,ms-10,masa,时间,Kami perlu masa untuk membaca buku ini.,我们需要时间读这本书。,一般不用量词,名词;参观与联系;补充\nms-0789,ms,ms-10,catatan,记录,Saya menulis catatan tentang lawatan itu.,我写下那次参观的记录。,一般不用量词；整词学习,名词;参观与联系;补充\nms-0790,ms,ms-10,sakit,生病的；痛的,Adik sakit dan perlu berehat di rumah.,弟弟病了，需要在家休息。,形容词，后置,形容词;参观与联系;补充\nms-0791,ms,ms-10,gembira,快乐,Kami gembira dapat bertemu dengan Siti.,我们很高兴能见到西蒂。,形容词，后置,形容词;参观与联系;补充\nms-0792,ms,ms-10,tenang,平静,Tempat ini tenang pada waktu pagi.,这个地方早晨很安静。,形容词，后置,形容词;参观与联系;补充\nms-0793,ms,ms-10,indah,美丽,Pantai di pulau itu sangat indah.,那个岛上的海滩很美。,形容词，后置,形容词;参观与联系;补充\nms-0794,ms,ms-10,sibuk,忙碌,Guru sibuk menyediakan bahan untuk kelas.,老师忙着准备上课材料。,形容词，后置,形容词;参观与联系;补充\nms-0795,ms,ms-10,perlahan,慢慢地,Ali berjalan dengan perlahan di tangga.,阿里在楼梯上慢慢走。,常用 dengan perlahan,副词;参观与联系;补充\nms-0796,ms,ms-10,menanam,种植,Ibu menanam pokok di kebun.,母亲在园圃里种树。,meN- + tanam → menanam，men-，t 脱落；词根 tanam；及物动词，常见宾语 pokok,动词;参观与联系;补充\nms-0797,ms,ms-10,jatuh,落下；跌倒,Daun itu jatuh ke dalam sungai.,那片叶子落进河里。,不及物动词；词根 jatuh,动词;参观与联系;补充\nms-0798,ms,ms-10,walaupun,虽然,\"Walaupun hujan, kami masih pergi ke muzium.\",虽然下雨，我们仍去博物馆。,引出让步,连词;参观与联系;补充\nms-0799,ms,ms-10,manakala,而（对照）,Ali membaca manakala Siti menulis nota.,阿里阅读，而西蒂记笔记。,连接对照内容,连词;参观与联系;补充\nms-0800,ms,ms-10,sama ada,是否；是……还是,Saya belum tahu sama ada Ali akan datang.,我还不知道阿里是否会来。,引出尚未确定的情况,连词;参观与联系;补充\nms-0801,ms,ms-11,dibaca,被阅读,Buku itu dibaca oleh Ali.,那本书由阿里阅读。,di- + baca；词根 baca；主动形 membaca；及物动词的被动形，常见宾语 buku 在被动句中作主语,动词;di- 被动\nms-0802,ms,ms-11,ditulis,被书写,Surat itu ditulis oleh Siti.,那封信由西蒂书写。,di- + tulis；词根 tulis；主动形 menulis；及物动词的被动形，常见宾语 surat 在被动句中作主语,动词;di- 被动\nms-0803,ms,ms-11,dibuka,被打开,Pintu perpustakaan dibuka pada pukul lapan.,图书馆的门八点打开。,di- + buka；词根 buka；主动形 membuka；及物动词的被动形，常见宾语 pintu 在被动句中作主语,动词;di- 被动\nms-0804,ms,ms-11,ditutup,被关闭,Tingkap itu ditutup oleh guru.,那扇窗由老师关上。,di- + tutup；词根 tutup；主动形 menutup；及物动词的被动形，常见宾语 tingkap 在被动句中作主语,动词;di- 被动\nms-0805,ms,ms-11,dibeli,被购买,Beras itu dibeli oleh ibu.,那些米由母亲购买。,di- + beli；词根 beli；主动形 membeli；及物动词的被动形，常见宾语 beras 在被动句中作主语,动词;di- 被动\nms-0806,ms,ms-11,dijual,被出售,Makanan ini dijual di pasar.,这些食物在市场上出售。,di- + jual；词根 jual；主动形 menjual；及物动词的被动形，常见宾语 makanan 在被动句中作主语,动词;di- 被动\nms-0807,ms,ms-11,dihantar,被送去,Surat itu dihantar ke pejabat semalam.,那封信昨天被送到办公室。,di- + hantar；词根 hantar；主动形 menghantar；及物动词的被动形，常见宾语 surat 在被动句中作主语,动词;di- 被动\nms-0808,ms,ms-11,dipilih,被选中,Buku ini dipilih oleh para pelajar.,这本书由学生们选中。,di- + pilih；词根 pilih；主动形 memilih；及物动词的被动形，常见宾语 buku 在被动句中作主语,动词;di- 被动\nms-0809,ms,ms-11,dibawa,被携带,Kotak itu dibawa ke dalam kelas.,那个盒子被搬进教室。,di- + bawa；词根 bawa；主动形 membawa；及物动词的被动形，常见宾语 kotak 在被动句中作主语,动词;di- 被动\nms-0810,ms,ms-11,disimpan,被存放,Alat itu disimpan di dalam almari.,那个工具存放在柜子里。,di- + simpan；词根 simpan；主动形 menyimpan；及物动词的被动形，常见宾语 alat 在被动句中作主语,动词;di- 被动\nms-0811,ms,ms-11,diberikan,被给予,Hadiah itu diberikan kepada Raju.,那份礼物给了拉朱。,di- + beri + -kan；词根 beri；主动形 memberikan；及物动词的被动形，常见宾语 hadiah 在被动句中作主语,动词;di- 被动\nms-0812,ms,ms-11,digunakan,被使用,Bilik itu digunakan untuk mesyuarat.,那个房间用于开会。,di- + guna + -kan；词根 guna；主动形 menggunakan；及物动词的被动形，常见宾语 bilik 在被动句中作主语,动词;di- 被动\nms-0813,ms,ms-11,disediakan,被准备；被提供,Makanan disediakan oleh Siti pada pagi ini.,食物今天早晨由西蒂准备。,di- + sedia + -kan；词根 sedia；主动形 menyediakan；及物动词的被动形，常见宾语 makanan 在被动句中作主语,动词;di- 被动\nms-0814,ms,ms-11,dijelaskan,被解释,Tujuan program dijelaskan oleh guru.,活动目的由老师解释。,di- + jelas + -kan；词根 jelas；主动形 menjelaskan；及物动词的被动形，常见宾语 tujuan 在被动句中作主语,动词;di- 被动\nms-0815,ms,ms-11,dibersihkan,被清洁,Dewan itu dibersihkan sebelum mesyuarat.,礼堂在会议前被打扫。,di- + bersih + -kan；词根 bersih；主动形 membersihkan；及物动词的被动形，常见宾语 dewan 在被动句中作主语,动词;di- 被动\nms-0816,ms,ms-11,diletakkan,被放置,Notis diletakkan di sebelah pintu.,通知贴放在门旁边。,di- + letak + -kan；词根 letak；主动形 meletakkan；及物动词的被动形，常见宾语 notis 在被动句中作主语,动词;di- 被动\nms-0817,ms,ms-11,dimasukkan,被放入,Borang itu dimasukkan ke dalam kotak.,那张表格被放进盒子里。,di- + masuk + -kan；词根 masuk；主动形 memasukkan；及物动词的被动形，常见宾语 borang 在被动句中作主语,动词;di- 被动\nms-0818,ms,ms-11,dikunjungi,被参观；被拜访,Muzium ini dikunjungi oleh pelajar sekolah.,这座博物馆有学校的学生来参观。,di- + kunjung + -i；词根 kunjung；主动形 mengunjungi；及物动词的被动形，常见宾语 muzium 在被动句中作主语,动词;di- 被动\nms-0819,ms,ms-11,dihadiri,被出席,Mesyuarat itu dihadiri oleh penduduk kampung.,那场会议有村民出席。,di- + hadir + -i；词根 hadir；主动形 menghadiri；及物动词的被动形，常见宾语 mesyuarat 在被动句中作主语,动词;di- 被动\nms-0820,ms,ms-11,diikuti,被参加；被跟随,Program itu diikuti oleh ramai pelajar.,那个活动有许多学生参加。,di- + ikut + -i；词根 ikut；主动形 mengikuti；及物动词的被动形，常见宾语 program 在被动句中作主语,动词;di- 被动\nms-0821,ms,ms-11,dewan,礼堂；大厅,Mesyuarat itu diadakan di dewan sekolah.,那场会议在学校礼堂举行。,量词 buah,名词;新闻与公共事务\nms-0822,ms,ms-11,notis,通知,Notis itu dibaca oleh semua guru.,所有老师都读了那则通知。,一般不用量词,名词;新闻与公共事务\nms-0823,ms,ms-11,penduduk,居民,Penduduk kampung berkumpul di dewan.,村民聚集在礼堂里。,量词 orang；整词学习,名词;新闻与公共事务\nms-0824,ms,ms-11,kerajaan,政府,Kerajaan menyediakan bantuan untuk sekolah.,政府为学校提供帮助。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0825,ms,ms-11,pegawai,官员；职员,Pegawai itu sedang membaca laporan.,那名职员正在读报告。,量词 orang；整词学习,名词;新闻与公共事务\nms-0826,ms,ms-11,menteri,部长,Menteri itu mengunjungi sekolah kami.,那位部长访问我们的学校。,量词 orang,名词;新闻与公共事务\nms-0827,ms,ms-11,ketua,负责人；领队,Ketua program memberikan maklumat kepada kami.,活动负责人向我们提供信息。,量词 orang,名词;新闻与公共事务\nms-0828,ms,ms-11,ahli,成员,Ahli kelab menghadiri mesyuarat petang ini.,俱乐部成员今天下午出席会议。,量词 orang,名词;新闻与公共事务\nms-0829,ms,ms-11,jawatankuasa,委员会,Jawatankuasa sekolah akan mengadakan mesyuarat esok.,学校委员会明天将召开会议。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0830,ms,ms-11,masyarakat,社会；社群,Program ini untuk masyarakat di bandar itu.,这个活动面向那座城市的社群。,一般不用量词,名词;新闻与公共事务\nms-0831,ms,ms-11,orang ramai,公众,Perpustakaan ini dibuka kepada orang ramai.,这座图书馆向公众开放。,一般不用量词；集合称呼,名词;新闻与公共事务\nms-0832,ms,ms-11,kesihatan,健康,Program kesihatan itu diadakan di klinik.,那个健康活动在诊所举行。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0833,ms,ms-11,keselamatan,安全,Keselamatan pelajar penting bagi sekolah.,学生安全对学校很重要。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0834,ms,ms-11,kebersihan,清洁；卫生,Kebersihan dewan mesti dijaga.,礼堂卫生必须得到维护。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0835,ms,ms-11,kemudahan,设施,Kemudahan di sekolah ini untuk semua pelajar.,这所学校的设施供所有学生使用。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0836,ms,ms-11,perkhidmatan,服务,Perkhidmatan bas itu bermula pada pukul enam.,那项公交服务六点开始。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0837,ms,ms-11,pengumuman,公告,Pengumuman itu dibuat oleh ketua program.,那则公告由活动负责人发布。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0838,ms,ms-11,laporan,报告,Laporan itu ditulis oleh pegawai sekolah.,那份报告由学校职员撰写。,一般不用量词；整词学习,名词;新闻与公共事务\nms-0839,ms,ms-11,akhbar,报纸,Bapa membaca akhbar setiap pagi.,父亲每天早晨读报。,量词 naskhah,名词;新闻与公共事务\nms-0840,ms,ms-11,wartawan,记者,Wartawan itu bertanya tentang program sekolah.,那名记者询问学校活动的情况。,量词 orang,名词;新闻与公共事务\nms-0841,ms,ms-11,pembaca,读者,Pembaca akhbar itu mahu maklumat yang jelas.,那份报纸的读者想要清楚的信息。,量词 orang；整词学习,名词;新闻与公共事务\nms-0842,ms,ms-11,tajuk,标题,Tajuk berita ini pendek dan jelas.,这则新闻的标题简短清楚。,一般不用量词,名词;新闻与公共事务\nms-0843,ms,ms-11,peristiwa,事件,Wartawan melaporkan peristiwa itu dalam akhbar.,记者在报纸上报道那个事件。,一般不用量词,名词;新闻与公共事务\nms-0844,ms,ms-11,majlis,仪式；活动,Majlis sekolah bermula pada pukul sembilan.,学校的仪式九点开始。,一般不用量词,名词;新闻与公共事务\nms-0845,ms,ms-11,sukarelawan,志愿者,Sukarelawan membantu penduduk di dewan.,志愿者在礼堂帮助居民。,量词 orang,名词;新闻与公共事务\nms-0846,ms,ms-11,mengadakan,举办,Sekolah mengadakan program membaca pada hari Sabtu.,学校星期六举办阅读活动。,meN- + ada + -kan → mengadakan，meng-，词根首字母保留；词根 ada；及物动词，常见宾语 program,动词;公共事务动词\nms-0847,ms,ms-11,melaporkan,报道,Wartawan melaporkan berita dari Johor Bahru.,记者报道来自新山的新闻。,meN- + lapor + -kan → melaporkan，me-，词根首字母保留；词根 lapor；及物动词，常见宾语 berita,动词;公共事务动词\nms-0848,ms,ms-11,mengumumkan,宣布,Ketua mengumumkan tarikh mesyuarat itu.,负责人宣布那场会议的日期。,meN- + umum + -kan → mengumumkan，meng-，词根首字母保留；词根 umum；及物动词，常见宾语 tarikh,动词;公共事务动词\nms-0849,ms,ms-11,melaksanakan,执行,Jawatankuasa melaksanakan rancangan itu bersama.,委员会一起执行那个计划。,meN- + laksana + -kan → melaksanakan，me-，词根首字母保留；词根 laksana；及物动词，常见宾语 rancangan,动词;公共事务动词\nms-0850,ms,ms-11,membincangkan,讨论,Kami membincangkan masalah kebersihan sekolah.,我们讨论学校卫生问题。,meN- + bincang + -kan → membincangkan，mem-，词根首字母保留；词根 bincang；及物动词，常见宾语 masalah,动词;公共事务动词\nms-0851,ms,ms-11,menguruskan,办理；管理,Pegawai menguruskan borang untuk program itu.,职员办理那个活动的表格。,meN- + urus + -kan → menguruskan，meng-，词根首字母保留；词根 urus；及物动词，常见宾语 borang,动词;公共事务动词\nms-0852,ms,ms-11,mengesahkan,确认,Guru mengesahkan nama pelajar pada borang.,老师确认表格上的学生姓名。,meN- + sah + -kan → mengesahkan，menge-，单音节词根 sah 保留；及物动词，常见宾语 nama,动词;公共事务动词\nms-0853,ms,ms-11,membenarkan,允许,Guru membenarkan kami menggunakan bilik ini.,老师允许我们使用这个房间。,meN- + benar + -kan → membenarkan，mem-，词根首字母保留；词根 benar；及物动词，常见宾语 kami + 动作,动词;公共事务动词\nms-0854,ms,ms-11,menjaga,照顾；维护,Kami menjaga kebersihan taman.,我们维护公园的卫生。,meN- + jaga → menjaga，men-，词根首字母保留；词根 jaga；及物动词，常见宾语 kebersihan,动词;公共事务动词\nms-0855,ms,ms-11,memeriksa,检查,Pegawai memeriksa alat di dewan.,职员检查礼堂里的工具。,meN- + periksa → memeriksa，mem-，p 脱落；词根 periksa；及物动词，常见宾语 alat,动词;公共事务动词\nms-0856,ms,ms-11,melapor,报告；报到,Sukarelawan melapor kepada ketua sebelum bekerja.,志愿者工作前向负责人报到。,meN- + lapor → melapor，me-，词根首字母保留；词根 lapor；常作不及物，用 kepada 引出报告对象,动词;公共事务动词\nms-0857,ms,ms-11,mencatat,记录,Wartawan mencatat nama ketua program.,记者记录活动负责人的姓名。,meN- + catat → mencatat，men-，词根首字母保留；词根 catat；及物动词，常见宾语 nama,动词;公共事务动词\nms-0858,ms,ms-11,menyokong,支持,Penduduk menyokong program membaca itu.,居民支持那个阅读活动。,meN- + sokong → menyokong，meny-，s 脱落；词根 sokong；及物动词，常见宾语 program,动词;公共事务动词\nms-0859,ms,ms-11,bermula,开始,Majlis itu bermula pada pukul sepuluh.,那个仪式十点开始。,ber- + mula；词根 mula；不及物动词,动词;公共事务动词\nms-0860,ms,ms-11,berakhir,结束,Mesyuarat berakhir sebelum tengah hari.,会议在中午前结束。,ber- + akhir；词根 akhir；不及物动词,动词;公共事务动词\nms-0861,ms,ms-11,serta,以及,Guru serta pelajar membersihkan dewan.,老师和学生打扫礼堂。,连接并列成分,连词;新闻连接\nms-0862,ms,ms-11,namun,然而,\"Hujan turun, namun majlis itu masih berjalan.\",下雨了，然而活动仍在进行。,连接转折,连词;新闻连接\nms-0863,ms,ms-11,maka,于是,\"Dewan sudah penuh, maka kami menunggu di luar.\",礼堂已经满了，于是我们在外面等候。,连接结果,连词;新闻连接\nms-0864,ms,ms-11,agar,以便,Notis ditulis dengan jelas agar semua orang faham.,通知写得很清楚，以便所有人理解。,引出目的,连词;新闻连接\nms-0865,ms,ms-11,iaitu,即；也就是,\"Kami bertemu ketua program, iaitu Raju.\",我们见到了活动负责人，也就是拉朱。,引出具体说明,连词;新闻连接\nms-0866,ms,ms-11,Buku itu dibaca oleh Ali.,那本书由阿里阅读。,Buku itu dibaca oleh Ali.,那本书由阿里阅读。,整句识别；第三人称施事被动,动词;句型;phrase\nms-0867,ms,ms-11,Makanan disediakan di dewan.,食物在礼堂供应。,Makanan disediakan di dewan.,食物在礼堂供应。,整句识别；前缀 di- 连写，介词 di 分写,动词;句型;phrase\nms-0868,ms,ms-11,Sila baca notis ini.,请阅读这则通知。,Sila baca notis ini.,请阅读这则通知。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0869,ms,ms-11,Majlis itu akan diadakan esok.,那个活动将在明天举行。,Majlis itu akan diadakan esok.,那个活动将在明天举行。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0870,ms,ms-11,Borang mesti dihantar sebelum Jumaat.,表格必须在星期五前送交。,Borang mesti dihantar sebelum Jumaat.,表格必须在星期五前送交。,整句识别；注意宾语与词缀,动词;句型;phrase\nms-0871,ms,ms-11,ramai,众多（人）,Ramai pelajar membaca di perpustakaan.,许多学生在图书馆阅读。,形容词，后置；表示人多时常放在名词前，如 ramai pelajar；也可作谓语，如 Pelajar di sini ramai,形容词;公共事务;补充\nms-0872,ms,ms-11,rasmi,正式,Surat rasmi itu ditulis oleh ketua.,那封正式信函由负责人撰写。,形容词，后置,形容词;公共事务;补充\nms-0873,ms,ms-11,awam,公共,Perpustakaan awam itu dekat dengan stesen.,那座公共图书馆靠近车站。,形容词，后置,形容词;公共事务;补充\nms-0874,ms,ms-11,percuma,免费的,Buku percuma itu untuk semua pelajar.,那些免费书籍供所有学生领取。,形容词，后置,形容词;公共事务;补充\nms-0875,ms,ms-11,taraf,水平,Taraf kebersihan sekolah ini baik.,这所学校的卫生水平良好。,一般不用量词,名词;公共事务;补充\nms-0876,ms,ms-11,turun,落下；下降,Hujan turun sejak pagi.,雨从早晨开始下。,不及物动词；词根 turun,动词;公共事务;补充\nms-0877,ms,ms-11,secara,以……方式,Guru menjelaskan tugas secara jelas.,老师清楚地说明任务。,后接方式词；整词学习,副词;公共事务;补充\nms-0878,ms,ms-11,naskhah,册；份（出版物）,Dua naskhah akhbar itu di atas meja.,那两份报纸在桌上。,量词 作为计量名词，量词本身不再加量词,量词;公共事务;补充\nms-0879,ms,ms-11,jumlah,总数,Jumlah pelajar dalam kelas ini dua puluh orang.,这个班的学生总数是二十人。,一般不用量词,名词;公共事务;补充\nms-0880,ms,ms-11,jadual,时间表,Jadual program itu diletakkan di depan dewan.,活动时间表贴放在礼堂前面。,一般不用量词,名词;公共事务;补充\nms-0881,ms,ms-12,terjatuh,跌倒；意外掉落,Ali terjatuh di tangga semalam.,阿里昨天在楼梯上跌倒了。,ter- + jatuh；词根 jatuh；意外；不及物,动词;ter- 形式\nms-0882,ms,ms-12,tertidur,不知不觉睡着,Adik tertidur selepas membaca buku itu.,弟弟读完那本书后不知不觉睡着了。,ter- + tidur；词根 tidur；意外；不及物,动词;ter- 形式\nms-0883,ms,ms-12,terlupa,忘记,Saya terlupa membawa pen ke kelas.,我忘了带笔去上课。,ter- + lupa；词根 lupa；意外；常接动作内容,动词;ter- 形式\nms-0884,ms,ms-12,terangkat,抬得动,Kotak berat itu tidak terangkat oleh Ali.,阿里抬不动那个重盒子。,ter- + angkat；词根 angkat；能力；常见宾语 kotak 在此作主语,动词;ter- 形式\nms-0885,ms,ms-12,terbaca,读得清；能读,Tulisan kecil itu tidak terbaca oleh ibu.,母亲读不清那些小字。,ter- + baca；词根 baca；能力；常见宾语 tulisan 在此作主语,动词;ter- 形式\nms-0886,ms,ms-12,terbuka,开着的,Pintu bilik itu masih terbuka.,那个房间的门仍开着。,ter- + buka；词根 buka；状态；不及物,动词;ter- 形式\nms-0887,ms,ms-12,tertutup,关着的,Tingkap dapur itu tertutup sejak pagi.,厨房的窗户从早晨起就关着。,ter- + tutup；词根 tutup；状态；不及物,动词;ter- 形式\nms-0888,ms,ms-12,tertinggal,被落下；遗留,Buku saya tertinggal di sekolah.,我的书落在学校了。,ter- + tinggal；词根 tinggal；意外；状态,动词;ter- 形式\nms-0889,ms,ms-12,terambil,误拿,Ali terambil buku Siti kerana warnanya sama.,阿里因书的颜色相同而误拿了西蒂的书。,ter- + ambil；词根 ambil；意外；及物，常见宾语 buku,动词;ter- 形式\nms-0890,ms,ms-12,terdengar,无意间听到,Saya terdengar suara guru dari luar kelas.,我从教室外无意间听到老师的声音。,ter- + dengar；词根 dengar；意外；及物，常见宾语 suara,动词;ter- 形式\nms-0891,ms,ms-12,tertulis,写在上面的,Nama Raju tertulis pada kotak itu.,拉朱的名字写在那个盒子上。,ter- + tulis；词根 tulis；状态；常见宾语 nama 在此作主语,动词;ter- 形式\nms-0892,ms,ms-12,tersusun,排列整齐的,Buku-buku itu tersusun di atas rak.,那些书整齐地摆在架子上。,ter- + susun；词根 susun；状态；常见宾语 buku 在此作主语,动词;ter- 形式\nms-0893,ms,ms-12,imbuhan,词缀,Imbuhan ini ada di depan kata dasar.,这个词缀在词根前面。,一般不用量词；整词学习,名词;复习与学习\nms-0894,ms,ms-12,awalan,前缀,Awalan ini mengubah maksud perkataan.,这个前缀改变词的意思。,一般不用量词；整词学习,名词;复习与学习\nms-0895,ms,ms-12,akhiran,后缀,Akhiran ini ada di hujung perkataan.,这个后缀在词的末尾。,一般不用量词；整词学习,名词;复习与学习\nms-0896,ms,ms-12,kata dasar,词根,Kata dasar itu belum saya tulis.,那个词根我还没写。,一般不用量词,名词;复习与学习\nms-0897,ms,ms-12,ayat,句子,Ayat ini sudah saya baca.,这个句子我已经读过了。,一般不用量词,名词;复习与学习\nms-0898,ms,ms-12,ejaan,拼写,Ejaan perkataan ini mesti kita periksa.,这个词的拼写我们必须检查。,一般不用量词；整词学习,名词;复习与学习\nms-0899,ms,ms-12,makna,意义,Makna ayat itu jelas bagi saya.,那个句子的意义对我来说很清楚。,一般不用量词,名词;复习与学习\nms-0900,ms,ms-12,subjek,主语,Subjek ayat ini ialah Ali.,这个句子的主语是阿里。,一般不用量词,名词;复习与学习\nms-0901,ms,ms-12,objek,宾语,Objek dalam ayat itu ialah buku.,那个句子中的宾语是书。,一般不用量词,名词;复习与学习\nms-0902,ms,ms-12,pelaku,施事；动作执行者,Pelaku dalam ayat ini ialah Siti.,这个句子中的施事是西蒂。,量词 orang；整词学习,名词;复习与学习\nms-0903,ms,ms-12,jawapan,答案,Jawapan itu sudah saya tulis.,那个答案我已经写好了。,一般不用量词；整词学习,名词;复习与学习\nms-0904,ms,ms-12,kesalahan,错误,Kesalahan ejaan itu perlu kita catat.,那个拼写错误我们需要记下来。,一般不用量词；整词学习,名词;复习与学习\nms-0905,ms,ms-12,ulang kaji,复习,Ulang kaji perlu dibuat setiap minggu.,复习需要每周进行。,学习活动名词，一般不用量词；分写 ulang kaji,名词;复习与学习\nms-0906,ms,ms-12,ujian,测验,Ujian ini untuk semua pelajar di kelas.,这项测验面向班里所有学生。,一般不用量词；整词学习,名词;复习与学习\nms-0907,ms,ms-12,tulisan,文字；书写,Tulisan pada kertas itu sangat kecil.,那张纸上的字很小。,一般不用量词；整词学习,名词;复习与学习\nms-0908,ms,ms-12,Buku itu saya baca.,那本书由我来读。,Buku itu saya baca.,那本书由我来读。,整句识别；宾语前置，第一人称施事紧接光杆动词,动词;句型;phrase\nms-0909,ms,ms-12,Surat ini awak tulis?,这封信是你写的吗？,Surat ini awak tulis?,这封信是你写的吗？,整句识别；第二人称施事被动,动词;句型;phrase\nms-0910,ms,ms-12,Buku itu belum saya baca.,那本书我还没读。,Buku itu belum saya baca.,那本书我还没读。,整句识别；belum 在施事代词前,动词;句型;phrase\nms-0911,ms,ms-12,Tugas ini akan kami selesaikan.,这项任务我们会完成。,Tugas ini akan kami selesaikan.,这项任务我们会完成。,整句识别；去掉 meN-，保留 -kan,动词;句型;phrase\nms-0912,ms,ms-12,Muzium itu sudah kita kunjungi.,那座博物馆我们已经参观过。,Muzium itu sudah kita kunjungi.,那座博物馆我们已经参观过。,整句识别；去掉 meN-，保留 -i,动词;句型;phrase\nms-0913,ms,ms-12,Pintu itu jangan awak buka.,那扇门你不要打开。,Pintu itu jangan awak buka.,那扇门你不要打开。,整句识别；jangan 在施事代词前,动词;句型;phrase\nms-0914,ms,ms-12,Kotak itu tidak terangkat oleh Raju.,拉朱抬不动那个盒子。,Kotak itu tidak terangkat oleh Raju.,拉朱抬不动那个盒子。,整句识别；ter- 表能力，第三人称施事,动词;句型;phrase\nms-0915,ms,ms-12,Saya tertidur semasa membaca.,我读书时不知不觉睡着了。,Saya tertidur semasa membaca.,我读书时不知不觉睡着了。,整句识别；ter- 表意外,动词;句型;phrase\nms-0916,ms,ms-12,suara,声音；嗓音,Suara guru itu jelas dari belakang kelas.,从教室后面也能清楚听见老师的声音。,一般不用量词,名词;复习与学习;补充\nms-0917,ms,ms-12,warna,颜色,Warna buku Ali sama dengan warna buku Siti.,阿里和西蒂的书颜色相同。,一般不用量词,名词;复习与学习;补充\nms-0918,ms,ms-12,sama,相同,Dua buku ini sama warnanya.,这两本书的颜色相同。,形容词，后置,形容词;复习与学习;补充\nms-0919,ms,ms-12,semasa,在……期间,Jangan berbual semasa guru menerangkan ayat.,老师说明句子时不要聊天。,引出同时发生的动作,连词;复习与学习;补充\nms-0920,ms,ms-12,mengubah,改变,Imbuhan boleh mengubah makna kata dasar.,词缀可以改变词根的意义。,meN- + ubah → mengubah，meng-，词根首字母保留；词根 ubah；及物动词，常见宾语 makna,动词;复习与学习;补充\n";
const M6_OLD_IDS=["es-0001", "es-0002", "es-0003", "es-0004", "es-0005", "es-0006", "es-0007", "es-0008", "es-0009", "es-0010", "es-0011", "es-0012", "es-0013", "es-0014", "es-0015", "es-0016", "es-0017", "es-0018", "es-0019", "es-0020", "es-0021", "es-0022", "es-0023", "es-0024", "es-0025", "es-0026", "es-0027", "es-0028", "es-0029", "es-0030", "es-0031", "es-0032", "es-0033", "es-0034", "es-0035", "es-0036", "es-0037", "es-0038", "es-0039", "es-0040", "es-0041", "es-0042", "es-0043", "es-0044", "es-0045", "es-0046", "es-0047", "es-0048", "es-0049", "es-0050", "es-0051", "es-0052", "es-0053", "es-0054", "es-0055", "es-0056", "es-0057", "es-0058", "es-0059", "es-0060", "es-0061", "es-0062", "es-0063", "es-0064", "es-0065", "es-0066", "es-0067", "es-0068", "es-0069", "es-0070", "es-0071", "es-0072", "es-0073", "es-0074", "es-0075", "es-0076", "es-0077", "es-0078", "es-0079", "es-0080", "es-0081", "es-0082", "es-0083", "es-0084", "es-0085", "es-0086", "es-0087", "es-0088", "es-0089", "es-0090", "es-0091", "es-0092", "es-0093", "es-0094", "es-0095", "es-0096", "es-0097", "es-0098", "es-0099", "es-0100", "es-0101", "es-0102", "es-0103", "es-0104", "es-0105", "es-0106", "es-0107", "es-0108", "es-0109", "es-0110", "es-0111", "es-0112", "es-0113", "ru-0001", "ru-0002", "ru-0003", "ru-0004", "ru-0005", "ru-0006", "ru-0007", "ru-0008", "ru-0009", "ru-0010", "ru-0011", "ru-0012", "ru-0013", "ru-0014", "ru-0015", "ru-0016", "ru-0017", "ru-0018", "ru-0019", "ru-0020", "ru-0021", "ru-0022", "ru-0023", "ru-0024", "ru-0025", "ru-0026", "ru-0027", "ru-0028", "ru-0029", "ru-0030", "ru-0031", "ru-0032", "ru-0033", "ru-0034", "ru-0035", "ru-0036", "ru-0037", "ru-0038", "ru-0039", "ru-0040", "ru-0041", "ru-0042", "ru-0043", "ru-0044", "ru-0045", "ru-0046", "ru-0047", "ru-0048", "ru-0049", "ru-0050", "ru-0051", "ru-0052", "ru-0053", "ru-0054", "ru-0055", "ru-0056", "ru-0057", "ru-0058", "ru-0059", "ru-0060", "ru-0061", "ru-0062", "ru-0063", "ru-0064", "ru-0065", "ru-0066", "ru-0067", "ru-0068", "ru-0069", "ru-0070", "ru-0071", "ru-0072", "ru-0073", "ru-0074", "ru-0075", "ru-0076", "ru-0077", "ru-0078", "ru-0079", "ru-0080", "ru-0081", "ru-0082", "ru-0083", "ru-0084", "ru-0085", "ru-0086", "ru-0087", "ru-0088", "ru-0089", "ru-0090", "ru-0091", "ru-0092", "ru-0093", "ru-0094", "ru-0095", "ru-0096", "ru-0097", "ru-0098", "ru-0099", "ru-0100", "ru-0101", "ru-0102", "ru-0103", "ru-0104", "ru-0105", "ru-0106", "ru-0107", "ru-0108", "ru-0109", "ru-0110", "ru-0111", "ru-0112", "ru-0113", "ru-0114", "ru-0115", "ru-0116", "ru-0117", "ru-0118", "ru-0119", "ru-0120", "ru-0121", "ru-0122", "ru-0123", "ru-0124", "ru-0125", "ru-0126", "ru-0127", "ru-0128", "ru-0129", "ru-0130", "ru-0131", "ru-0132", "ru-0133", "ru-0134", "ru-0135", "ru-0136", "ru-0137", "ru-0138", "ru-0139", "ru-0140", "ru-0141", "es-0114", "es-0115", "es-0116", "es-0117", "es-0118", "es-0119", "es-0120", "es-0121", "es-0122", "es-0123", "es-0124", "es-0125", "es-0126", "es-0127", "es-0128", "es-0129", "es-0130", "es-0131", "es-0132", "es-0133", "es-0134", "es-0135", "es-0136", "es-0137", "es-0138", "es-0139", "es-0140", "es-0141", "es-0142", "es-0143", "es-0144", "es-0145", "es-0146", "es-0147", "es-0148", "es-0149", "es-0150", "es-0151", "es-0152", "es-0153", "es-0154", "es-0155", "es-0156", "es-0157", "es-0158", "es-0159", "es-0160", "es-0161", "es-0162", "es-0163", "es-0164", "es-0165", "es-0166", "es-0167", "es-0168", "es-0169", "es-0170", "es-0171", "es-0172", "es-0173", "es-0174", "es-0175", "es-0176", "es-0177", "es-0178", "es-0179", "es-0180", "es-0181", "es-0182", "es-0183", "es-0184", "es-0185", "es-0186", "es-0187", "es-0188", "es-0189", "es-0190", "es-0191", "es-0192", "es-0193", "es-0194", "es-0195", "es-0196", "es-0197", "es-0198", "es-0199", "es-0200", "es-0201", "es-0202", "es-0203", "es-0204", "es-0205", "es-0206", "es-0207", "es-0208", "es-0209", "es-0210", "es-0211", "es-0212", "es-0213", "es-0214", "es-0215", "es-0216", "es-0217", "es-0218", "es-0219", "es-0220", "es-0221", "es-0222", "es-0223", "es-0224", "es-0225", "es-0226", "es-0227", "es-0228", "es-0229", "es-0230", "es-0231", "es-0232", "es-0233", "es-0234", "es-0235", "es-0236", "es-0237", "es-0238", "es-0239", "es-0240", "es-0241", "es-0242", "es-0243", "es-0244", "es-0245", "es-0246", "es-0247", "es-0248", "es-0249", "es-0250", "es-0251", "es-0252", "es-0253", "es-0254", "es-0255", "es-0256", "es-0257", "es-0258", "es-0259", "es-0260", "es-0261", "es-0262", "es-0263", "es-0264", "es-0265", "es-0266", "es-0267", "es-0268", "es-0269", "es-0270", "es-0271", "es-0272", "es-0273", "es-0274", "es-0275", "es-0276", "es-0277", "es-0278", "es-0279", "es-0280", "es-0281", "es-0282", "es-0283", "es-0284", "es-0285", "es-0286", "es-0287", "es-0288", "es-0289", "es-0290", "es-0291", "es-0292", "es-0293", "es-0294", "es-0295", "es-0296", "es-0297", "es-0298", "es-0299", "es-0300", "es-0301", "es-0302", "es-0303", "es-0304", "es-0305", "es-0306", "es-0307", "es-0308", "es-0309", "es-0310", "es-0311", "es-0312", "es-0313", "es-0314", "es-0315", "es-0316", "es-0317", "es-0318", "es-0319", "es-0320", "es-0321", "es-0322", "es-0323", "es-0324", "es-0325", "es-0326", "es-0327", "es-0328", "es-0329", "es-0330", "es-0331", "es-0332", "es-0333", "es-0334", "es-0335", "es-0336", "es-0337", "es-0338", "es-0339", "es-0340", "es-0341", "es-0342", "es-0343", "es-0344", "es-0345", "es-0346", "es-0347", "es-0348", "es-0349", "es-0350", "es-0351", "es-0352", "es-0353", "ru-0142", "ru-0143", "ru-0144", "ru-0145", "ru-0146", "ru-0147", "ru-0148", "ru-0149", "ru-0150", "ru-0151", "ru-0152", "ru-0153", "ru-0154", "ru-0155", "ru-0156", "ru-0157", "ru-0158", "ru-0159", "ru-0160", "ru-0161", "ru-0162", "ru-0163", "ru-0164", "ru-0165", "ru-0166", "ru-0167", "ru-0168", "ru-0169", "ru-0170", "ru-0171", "ru-0172", "ru-0173", "ru-0174", "ru-0175", "ru-0176", "ru-0177", "ru-0178", "ru-0179", "ru-0180", "ru-0181", "ru-0182", "ru-0183", "ru-0184", "ru-0185", "ru-0186", "ru-0187", "ru-0188", "ru-0189", "ru-0190", "ru-0191", "ru-0192", "ru-0193", "ru-0194", "ru-0195", "ru-0196", "ru-0197", "ru-0198", "ru-0199", "ru-0200", "ru-0201", "ru-0202", "ru-0203", "ru-0204", "ru-0205", "ru-0206", "ru-0207", "ru-0208", "ru-0209", "ru-0210", "ru-0211", "ru-0212", "ru-0213", "ru-0214", "ru-0215", "ru-0216", "ru-0217", "ru-0218", "ru-0219", "ru-0220", "ru-0221", "ru-0222", "ru-0223", "ru-0224", "ru-0225", "ru-0226", "ru-0227", "ru-0228", "ru-0229", "ru-0230", "ru-0231", "ru-0232", "ru-0233", "ru-0234", "ru-0235", "ru-0236", "ru-0237", "ru-0238", "ru-0239", "ru-0240", "ru-0241", "ru-0242", "ru-0243", "ru-0244", "ru-0245", "ru-0246", "ru-0247", "ru-0248", "ru-0249", "ru-0250", "ru-0251", "ru-0252", "ru-0253", "ru-0254", "ru-0255", "ru-0256", "ru-0257", "ru-0258", "ru-0259", "ru-0260", "ru-0261", "ru-0262", "ru-0263", "ru-0264", "ru-0265", "ru-0266", "ru-0267", "ru-0268", "ru-0269", "ru-0270", "ru-0271", "ru-0272", "ru-0273", "ru-0274", "ru-0275", "ru-0276", "ru-0277", "ru-0278", "ru-0279", "ru-0280", "ru-0281", "ru-0282", "ru-0283", "ru-0284", "ru-0285", "ru-0286", "ru-0287", "ru-0288", "ru-0289", "ru-0290", "ru-0291", "ru-0292", "ru-0293", "ru-0294", "ru-0295", "ru-0296", "ru-0297", "ru-0298", "ru-0299", "ru-0300", "ru-0301", "ru-0302", "ru-0303", "ru-0304", "ru-0305", "ru-0306", "ru-0307", "ru-0308", "ru-0309", "ru-0310", "ru-0311", "ru-0312", "ru-0313", "ru-0314", "ru-0315", "ru-0316", "ru-0317", "ru-0318", "ru-0319", "ru-0320", "ru-0321", "ru-0322", "ru-0323", "ru-0324", "ru-0325", "ru-0326", "ru-0327", "ru-0328", "ru-0329", "ru-0330", "ru-0331", "ru-0332", "ru-0333", "ru-0334", "ru-0335", "ru-0336", "ru-0337", "ru-0338", "ru-0339", "ru-0340", "ru-0341", "ru-0342", "es-0354", "es-0355", "es-0356", "es-0357", "es-0358", "es-0359", "es-0360", "es-0361", "es-0362", "es-0363", "es-0364", "es-0365", "es-0366", "es-0367", "es-0368", "es-0369", "es-0370", "es-0371", "es-0372", "es-0373", "es-0374", "es-0375", "es-0376", "es-0377", "es-0378", "es-0379", "es-0380", "es-0381", "es-0382", "es-0383", "es-0384", "es-0385", "es-0386", "es-0387", "es-0388", "es-0389", "es-0390", "es-0391", "es-0392", "es-0393", "es-0394", "es-0395", "es-0396", "es-0397", "es-0398", "es-0399", "es-0400", "es-0401", "es-0402", "es-0403", "es-0404", "es-0405", "es-0406", "es-0407", "es-0408", "es-0409", "es-0410", "es-0411", "es-0412", "es-0413", "es-0414", "es-0415", "es-0416", "es-0417", "es-0418", "es-0419", "es-0420", "es-0421", "es-0422", "es-0423", "es-0424", "es-0425", "es-0426", "es-0427", "es-0428", "es-0429", "es-0430", "es-0431", "es-0432", "es-0433", "es-0434", "es-0435", "es-0436", "es-0437", "es-0438", "es-0439", "es-0440", "es-0441", "es-0442", "es-0443", "es-0444", "es-0445", "es-0446", "es-0447", "es-0448", "es-0449", "es-0450", "es-0451", "es-0452", "es-0453", "es-0454", "es-0455", "es-0456", "es-0457", "es-0458", "es-0459", "es-0460", "es-0461", "es-0462", "es-0463", "es-0464", "es-0465", "es-0466", "es-0467", "es-0468", "es-0469", "es-0470", "es-0471", "es-0472", "es-0473", "es-0474", "es-0475", "es-0476", "es-0477", "es-0478", "es-0479", "es-0480", "es-0481", "es-0482", "es-0483", "es-0484", "es-0485", "es-0486", "es-0487", "es-0488", "es-0489", "es-0490", "es-0491", "es-0492", "es-0493", "es-0494", "es-0495", "es-0496", "es-0497", "es-0498", "es-0499", "es-0500", "es-0501", "es-0502", "es-0503", "es-0504", "es-0505", "es-0506", "es-0507", "es-0508", "es-0509", "es-0510", "es-0511", "es-0512", "es-0513", "es-0514", "es-0515", "es-0516", "es-0517", "es-0518", "es-0519", "es-0520", "es-0521", "es-0522", "es-0523", "es-0524", "es-0525", "es-0526", "es-0527", "es-0528", "es-0529", "es-0530", "es-0531", "es-0532", "es-0533", "es-0534", "es-0535", "es-0536", "es-0537", "es-0538", "es-0539", "es-0540", "es-0541", "es-0542", "es-0543", "es-0544", "es-0545", "es-0546", "es-0547", "es-0548", "es-0549", "es-0550", "es-0551", "es-0552", "es-0553", "es-0554", "es-0555", "es-0556", "es-0557", "es-0558", "es-0559", "es-0560", "es-0561", "es-0562", "es-0563", "es-0564", "es-0565", "es-0566", "es-0567", "es-0568", "es-0569", "es-0570", "es-0571", "es-0572", "es-0573", "es-0574", "es-0575", "es-0576", "es-0577", "es-0578", "es-0579", "es-0580", "es-0581", "es-0582", "es-0583", "es-0584", "es-0585", "es-0586", "es-0587", "es-0588", "es-0589", "es-0590", "es-0591", "es-0592", "es-0593", "es-0594", "es-0595", "es-0596", "es-0597", "es-0598", "es-0599", "es-0600", "es-0601", "es-0602", "es-0603", "es-0604", "es-0605", "es-0606", "es-0607", "es-0608", "es-0609", "es-0610", "es-0611", "es-0612", "es-0613", "es-0614", "es-0615", "es-0616", "es-0617", "es-0618", "es-0619", "es-0620", "es-0621", "es-0622", "es-0623", "es-0624", "es-0625", "es-0626", "es-0627", "es-0628", "es-0629", "es-0630", "es-0631", "es-0632", "es-0633", "es-0634", "es-0635", "es-0636", "es-0637", "es-0638", "es-0639", "es-0640", "es-0641", "es-0642", "es-0643", "es-0644", "es-0645", "es-0646", "es-0647", "es-0648", "es-0649", "es-0650", "es-0651", "es-0652", "es-0653", "es-0654", "es-0655", "es-0656", "es-0657", "es-0658", "es-0659", "es-0660", "es-0661", "es-0662", "es-0663", "es-0664", "es-0665", "es-0666", "es-0667", "es-0668", "es-0669", "es-0670", "es-0671", "es-0672", "es-0673", "es-0674", "es-0675", "es-0676", "es-0677", "es-0678", "es-0679", "es-0680", "es-0681", "es-0682", "es-0683", "es-0684", "es-0685", "es-0686", "es-0687", "es-0688", "es-0689", "es-0690", "es-0691", "es-0692", "es-0693", "es-0694", "es-0695", "es-0696", "es-0697", "es-0698", "es-0699", "es-0700", "es-0701", "es-0702", "es-0703", "es-0704", "es-0705", "es-0706", "es-0707", "es-0708", "es-0709", "es-0710", "es-0711", "es-0712", "es-0713", "es-0714", "es-0715", "es-0716", "es-0717", "es-0718", "es-0719", "es-0720", "es-0721", "es-0722", "es-0723", "es-0724", "es-0725", "es-0726", "es-0727", "es-0728", "es-0729", "es-0730", "es-0731", "es-0732", "es-0733", "es-0734", "es-0735", "es-0736", "es-0737", "es-0738", "es-0739", "es-0740", "es-0741", "es-0742", "es-0743", "es-0744", "es-0745", "es-0746", "es-0747", "es-0748", "es-0749", "es-0750", "es-0751", "es-0752", "es-0753", "es-0754", "es-0755", "es-0756", "es-0757", "es-0758", "es-0759", "es-0760", "es-0761", "es-0762", "es-0763", "es-0764", "es-0765", "es-0766", "es-0767", "es-0768", "es-0769", "es-0770", "es-0771", "es-0772", "es-0773", "es-0774", "es-0775", "es-0776", "es-0777", "es-0778", "es-0779", "es-0780", "es-0781", "es-0782", "es-0783", "es-0784", "es-0785", "es-0786", "es-0787", "es-0788", "es-0789", "es-0790", "es-0791", "es-0792", "es-0793", "es-0794", "es-0795", "es-0796", "es-0797", "es-0798", "es-0799", "es-0800", "es-0801", "es-0802", "es-0803", "es-0804", "es-0805", "es-0806", "es-0807", "es-0808", "es-0809", "es-0810", "es-0811", "es-0812", "es-0813", "es-0814", "es-0815", "es-0816", "es-0817", "es-0818", "es-0819", "es-0820", "es-0821", "es-0822", "es-0823", "es-0824", "es-0825", "es-0826", "es-0827", "es-0828", "es-0829", "es-0830", "es-0831", "es-0832", "es-0833", "es-0834", "es-0835", "es-0836", "es-0837", "es-0838", "es-0839", "es-0840", "es-0841", "es-0842", "es-0843", "es-0844", "es-0845", "es-0846", "es-0847", "es-0848", "es-0849", "es-0850", "es-0851", "es-0852", "es-0853", "es-0854", "es-0855", "es-0856", "es-0857", "es-0858", "es-0859", "es-0860", "es-0861", "es-0862", "es-0863", "es-0864", "es-0865", "es-0866", "es-0867", "es-0868", "es-0869", "es-0870", "es-0871", "es-0872", "es-0873", "es-0874", "es-0875", "es-0876", "es-0877", "es-0878", "es-0879", "es-0880", "es-0881", "es-0882", "es-0883", "es-0884", "es-0885", "es-0886", "es-0887", "es-0888", "es-0889", "es-0890", "es-0891", "es-0892", "es-0893", "es-0894", "es-0895", "es-0896", "es-0897", "es-0898", "es-0899", "es-0900", "es-0901", "es-0902", "es-0903", "es-0904", "es-0905", "es-0906", "es-0907", "es-0908", "es-0909", "es-0910", "es-0911", "es-0912", "es-0913", "es-0914", "es-0915", "es-0916", "es-0917", "es-0918", "es-0919", "es-0920", "es-0921", "es-0922", "es-0923", "es-0924", "es-0925", "es-0926", "es-0927", "es-0928", "es-0929", "es-0930", "es-0931", "es-0932", "es-0933", "es-0934", "es-0935", "es-0936", "es-0937", "es-0938", "es-0939", "es-0940", "es-0941", "es-0942", "es-0943", "es-0944", "es-0945", "es-0946", "es-0947", "es-0948", "es-0949", "es-0950", "es-0951", "es-0952", "es-0953", "es-0954", "es-0955", "es-0956", "es-0957", "es-0958", "es-0959", "es-0960", "es-0961", "es-0962", "es-0963", "es-0964", "es-0965", "es-0966", "es-0967", "es-0968", "es-0969", "es-0970", "es-0971", "es-0972", "es-0973", "es-0974", "es-0975", "es-0976", "es-0977", "es-0978", "es-0979", "es-0980", "es-0981", "es-0982", "es-0983", "es-0984", "es-0985", "es-0986", "es-0987", "es-0988", "es-0989", "es-0990", "es-0991", "es-0992", "es-0993", "ru-0343", "ru-0344", "ru-0345", "ru-0346", "ru-0347", "ru-0348", "ru-0349", "ru-0350", "ru-0351", "ru-0352", "ru-0353", "ru-0354", "ru-0355", "ru-0356", "ru-0357", "ru-0358", "ru-0359", "ru-0360", "ru-0361", "ru-0362", "ru-0363", "ru-0364", "ru-0365", "ru-0366", "ru-0367", "ru-0368", "ru-0369", "ru-0370", "ru-0371", "ru-0372", "ru-0373", "ru-0374", "ru-0375", "ru-0376", "ru-0377", "ru-0378", "ru-0379", "ru-0380", "ru-0381", "ru-0382", "ru-0383", "ru-0384", "ru-0385", "ru-0386", "ru-0387", "ru-0388", "ru-0389", "ru-0390", "ru-0391", "ru-0392", "ru-0393", "ru-0394", "ru-0395", "ru-0396", "ru-0397", "ru-0398", "ru-0399", "ru-0400", "ru-0401", "ru-0402", "ru-0403", "ru-0404", "ru-0405", "ru-0406", "ru-0407", "ru-0408", "ru-0409", "ru-0410", "ru-0411", "ru-0412", "ru-0413", "ru-0414", "ru-0415", "ru-0416", "ru-0417", "ru-0418", "ru-0419", "ru-0420", "ru-0421", "ru-0422", "ru-0423", "ru-0424", "ru-0425", "ru-0426", "ru-0427", "ru-0428", "ru-0429", "ru-0430", "ru-0431", "ru-0432", "ru-0433", "ru-0434", "ru-0435", "ru-0436", "ru-0437", "ru-0438", "ru-0439", "ru-0440", "ru-0441", "ru-0442", "ru-0443", "ru-0444", "ru-0445", "ru-0446", "ru-0447", "ru-0448", "ru-0449", "ru-0450", "ru-0451", "ru-0452", "ru-0453", "ru-0454", "ru-0455", "ru-0456", "ru-0457", "ru-0458", "ru-0459", "ru-0460", "ru-0461", "ru-0462", "ru-0463", "ru-0464", "ru-0465", "ru-0466", "ru-0467", "ru-0468", "ru-0469", "ru-0470", "ru-0471", "ru-0472", "ru-0473", "ru-0474", "ru-0475", "ru-0476", "ru-0477", "ru-0478", "ru-0479", "ru-0480", "ru-0481", "ru-0482", "ru-0483", "ru-0484", "ru-0485", "ru-0486", "ru-0487", "ru-0488", "ru-0489", "ru-0490", "ru-0491", "ru-0492", "ru-0493", "ru-0494", "ru-0495", "ru-0496", "ru-0497", "ru-0498", "ru-0499", "ru-0500", "ru-0501", "ru-0502", "ru-0503", "ru-0504", "ru-0505", "ru-0506", "ru-0507", "ru-0508", "ru-0509", "ru-0510", "ru-0511", "ru-0512", "ru-0513", "ru-0514", "ru-0515", "ru-0516", "ru-0517", "ru-0518", "ru-0519", "ru-0520", "ru-0521", "ru-0522", "es-0994", "es-0995", "es-0996", "es-0997", "es-0998", "es-0999", "es-1000", "es-1001", "es-1002", "es-1003", "es-1004", "es-1005", "es-1006", "es-1007", "es-1008", "es-1009", "es-1010", "es-1011", "es-1012", "es-1013", "es-1014", "es-1015", "es-1016", "es-1017", "es-1018", "es-1019", "es-1020", "es-1021", "es-1022", "es-1023", "es-1024", "es-1025", "es-1026", "es-1027", "es-1028", "es-1029", "es-1030", "es-1031", "es-1032", "es-1033", "es-1034", "es-1035", "es-1036", "es-1037", "es-1038", "es-1039", "es-1040", "es-1041", "es-1042", "es-1043", "es-1044", "es-1045", "es-1046", "es-1047", "es-1048", "es-1049", "es-1050", "es-1051", "es-1052", "es-1053", "es-1054", "es-1055", "es-1056", "es-1057", "es-1058", "es-1059", "es-1060", "es-1061", "es-1062", "es-1063", "es-1064", "es-1065", "es-1066", "es-1067", "es-1068", "es-1069", "es-1070", "es-1071", "es-1072", "es-1073", "es-1074", "es-1075", "es-1076", "es-1077", "es-1078", "es-1079", "es-1080", "es-1081", "es-1082", "es-1083", "es-1084", "es-1085", "es-1086", "es-1087", "es-1088", "es-1089", "es-1090", "es-1091", "es-1092", "es-1093", "es-1094", "es-1095", "es-1096", "es-1097", "es-1098", "es-1099", "es-1100", "es-1101", "es-1102", "es-1103", "es-1104", "es-1105", "es-1106", "es-1107", "es-1108", "es-1109", "es-1110", "es-1111", "es-1112", "es-1113", "es-1114", "es-1115", "es-1116", "es-1117", "es-1118", "es-1119", "es-1120", "es-1121", "es-1122", "es-1123", "es-1124", "es-1125", "es-1126", "es-1127", "es-1128", "es-1129", "es-1130", "es-1131", "es-1132", "es-1133", "es-1134", "es-1135", "es-1136", "es-1137", "es-1138", "es-1139", "es-1140", "es-1141", "es-1142", "es-1143", "es-1144", "es-1145", "es-1146", "es-1147", "es-1148", "es-1149", "es-1150", "es-1151", "es-1152", "es-1153", "es-1154", "es-1155", "es-1156", "es-1157", "es-1158", "es-1159", "es-1160", "es-1161", "es-1162", "es-1163", "es-1164", "es-1165", "es-1166", "es-1167", "es-1168", "es-1169", "es-1170", "es-1171", "es-1172", "es-1173", "es-1174", "es-1175", "es-1176", "es-1177", "es-1178", "es-1179", "es-1180", "es-1181", "es-1182", "es-1183", "es-1184", "es-1185", "es-1186", "es-1187", "es-1188", "es-1189", "es-1190", "es-1191", "es-1192", "es-1193", "es-1194", "es-1195", "es-1196", "es-1197", "es-1198", "es-1199", "es-1200", "es-1201", "es-1202", "es-1203", "es-1204", "es-1205", "es-1206", "es-1207", "es-1208", "es-1209", "es-1210", "es-1211", "es-1212", "es-1213", "es-1214", "es-1215", "es-1216", "es-1217", "es-1218", "es-1219", "es-1220", "es-1221", "es-1222", "es-1223", "es-1224", "es-1225", "es-1226", "es-1227", "es-1228", "es-1229", "es-1230", "es-1231", "es-1232", "es-1233", "es-1234", "es-1235", "es-1236", "es-1237", "es-1238", "es-1239", "es-1240", "es-1241", "es-1242", "es-1243", "es-1244", "es-1245", "es-1246", "es-1247", "es-1248", "es-1249", "es-1250", "es-1251", "es-1252", "es-1253", "es-1254", "es-1255", "es-1256", "es-1257", "es-1258", "es-1259", "es-1260", "es-1261", "es-1262", "es-1263", "es-1264", "es-1265", "es-1266", "es-1267", "es-1268", "es-1269", "es-1270", "es-1271", "es-1272", "es-1273", "es-1274", "es-1275", "es-1276", "es-1277", "es-1278", "es-1279", "es-1280", "es-1281", "es-1282", "es-1283", "es-1284", "es-1285", "es-1286", "es-1287", "es-1288", "es-1289", "es-1290", "es-1291", "es-1292", "es-1293", "es-1294", "es-1295", "es-1296", "es-1297", "es-1298", "es-1299", "es-1300", "es-1301", "es-1302", "es-1303", "es-1304", "es-1305", "es-1306", "es-1307", "es-1308", "es-1309", "es-1310", "es-1311", "es-1312", "es-1313", "ru-0523", "ru-0524", "ru-0525", "ru-0526", "ru-0527", "ru-0528", "ru-0529", "ru-0530", "ru-0531", "ru-0532", "ru-0533", "ru-0534", "ru-0535", "ru-0536", "ru-0537", "ru-0538", "ru-0539", "ru-0540", "ru-0541", "ru-0542", "ru-0543", "ru-0544", "ru-0545", "ru-0546", "ru-0547", "ru-0548", "ru-0549", "ru-0550", "ru-0551", "ru-0552", "ru-0553", "ru-0554", "ru-0555", "ru-0556", "ru-0557", "ru-0558", "ru-0559", "ru-0560", "ru-0561", "ru-0562", "ru-0563", "ru-0564", "ru-0565", "ru-0566", "ru-0567", "ru-0568", "ru-0569", "ru-0570", "ru-0571", "ru-0572", "ru-0573", "ru-0574", "ru-0575", "ru-0576", "ru-0577", "ru-0578", "ru-0579", "ru-0580", "ru-0581", "ru-0582", "ru-0583", "ru-0584", "ru-0585", "ru-0586", "ru-0587", "ru-0588", "ru-0589", "ru-0590", "ru-0591", "ru-0592", "ru-0593", "ru-0594", "ru-0595", "ru-0596", "ru-0597", "ru-0598", "ru-0599", "ru-0600", "ru-0601", "ru-0602", "ru-0603", "ru-0604", "ru-0605", "ru-0606", "ru-0607", "ru-0608", "ru-0609", "ru-0610", "ru-0611", "ru-0612", "ru-0613", "ru-0614", "ru-0615", "ru-0616", "ru-0617", "ru-0618", "ru-0619", "ru-0620", "ru-0621", "ru-0622", "ru-0623", "ru-0624", "ru-0625", "ru-0626", "ru-0627", "ru-0628", "ru-0629", "ru-0630", "ru-0631", "ru-0632", "ru-0633", "ru-0634", "ru-0635", "ru-0636", "ru-0637", "ru-0638", "ru-0639", "ru-0640", "ru-0641", "ru-0642", "ru-0643", "ru-0644", "ru-0645", "ru-0646", "ru-0647", "ru-0648", "ru-0649", "ru-0650", "ru-0651", "ru-0652", "ru-0653", "ru-0654", "ru-0655", "ru-0656", "ru-0657", "ru-0658", "ru-0659", "ru-0660", "ru-0661", "ru-0662", "ru-0663", "ru-0664", "ru-0665", "ru-0666", "ru-0667", "ru-0668", "ru-0669", "ru-0670", "ru-0671", "ru-0672", "ru-0673", "ru-0674", "ru-0675", "ru-0676", "ru-0677", "ru-0678", "ru-0679", "ru-0680", "ru-0681", "ru-0682", "ru-0683", "ru-0684", "ru-0685", "ru-0686", "ru-0687", "ru-0688", "ru-0689", "ru-0690", "ru-0691", "ru-0692", "ru-0693", "ru-0694", "ru-0695", "ru-0696", "ru-0697", "ru-0698", "ru-0699", "ru-0700", "ru-0701", "ru-0702", "ru-0703", "ru-0704", "ru-0705", "ru-0706", "ru-0707", "ru-0708", "ru-0709", "ru-0710", "ru-0711", "ru-0712", "ru-0713", "ru-0714", "ru-0715", "ru-0716", "ru-0717", "ru-0718", "ru-0719", "ru-0720", "ru-0721", "ru-0722", "ru-0723", "ru-0724", "ru-0725", "ru-0726", "ru-0727", "ru-0728", "ru-0729", "ru-0730", "ru-0731", "ru-0732", "ru-0733", "ru-0734", "ru-0735", "es-1314", "es-1315", "es-1316", "es-1317", "es-1318", "es-1319", "es-1320", "es-1321", "es-1322", "es-1323", "es-1324", "es-1325", "es-1326", "es-1327", "es-1328", "es-1329", "es-1330", "es-1331", "es-1332", "es-1333", "es-1334", "es-1335", "es-1336", "es-1337", "es-1338", "es-1339", "es-1340", "es-1341", "es-1342", "es-1343", "es-1344", "es-1345", "es-1346", "es-1347", "es-1348", "es-1349", "es-1350", "es-1351", "es-1352", "es-1353", "es-1354", "es-1355", "es-1356", "es-1357", "es-1358", "es-1359", "es-1360", "es-1361", "es-1362", "es-1363", "es-1364", "es-1365", "es-1366", "es-1367", "es-1368", "es-1369", "es-1370", "es-1371", "es-1372", "es-1373", "es-1374", "es-1375", "es-1376", "es-1377", "es-1378", "es-1379", "es-1380", "es-1381", "es-1382", "es-1383", "es-1384", "es-1385", "es-1386", "es-1387", "es-1388", "es-1389", "es-1390", "es-1391", "es-1392", "es-1393", "es-1394", "es-1395", "es-1396", "es-1397", "es-1398", "es-1399", "es-1400", "es-1401", "es-1402", "es-1403", "es-1404", "es-1405", "es-1406", "es-1407", "es-1408", "es-1409", "es-1410", "es-1411", "es-1412", "es-1413", "es-1414", "es-1415", "es-1416", "es-1417", "es-1418", "es-1419", "es-1420", "es-1421", "es-1422", "es-1423", "es-1424", "es-1425", "es-1426", "es-1427", "es-1428", "es-1429", "es-1430", "es-1431", "es-1432", "es-1433", "es-1434", "es-1435", "es-1436", "es-1437", "es-1438", "es-1439", "es-1440", "es-1441", "es-1442", "es-1443", "es-1444", "es-1445", "es-1446", "es-1447", "es-1448", "es-1449", "es-1450", "es-1451", "es-1452", "es-1453", "es-1454", "es-1455", "es-1456", "es-1457", "es-1458", "es-1459", "es-1460", "es-1461", "es-1462", "es-1463", "es-1464", "es-1465", "es-1466", "es-1467", "es-1468", "es-1469", "es-1470", "es-1471", "es-1472", "es-1473", "es-1474", "es-1475", "es-1476", "es-1477", "es-1478", "es-1479", "es-1480", "es-1481", "es-1482", "es-1483", "es-1484", "es-1485", "es-1486", "es-1487", "es-1488", "es-1489", "es-1490", "es-1491", "es-1492", "es-1493", "es-1494", "es-1495", "es-1496", "es-1497", "es-1498", "es-1499", "es-1500", "es-1501", "es-1502", "es-1503", "es-1504", "es-1505", "es-1506", "es-1507", "es-1508", "es-1509", "es-1510", "es-1511", "es-1512", "es-1513", "es-1514", "es-1515", "es-1516", "es-1517", "es-1518", "es-1519", "es-1520", "es-1521", "es-1522", "es-1523", "es-1524", "es-1525", "es-1526", "es-1527", "es-1528", "es-1529", "es-1530", "es-1531", "es-1532", "es-1533", "es-1534", "es-1535", "es-1536", "es-1537", "es-1538", "es-1539", "es-1540", "es-1541", "es-1542", "es-1543", "es-1544", "es-1545", "es-1546", "es-1547", "es-1548", "es-1549", "es-1550", "es-1551", "es-1552", "es-1553", "es-1554", "es-1555", "es-1556", "es-1557", "es-1558", "es-1559", "es-1560", "es-1561", "es-1562", "es-1563", "es-1564", "es-1565", "es-1566", "es-1567", "es-1568", "es-1569", "es-1570", "es-1571", "es-1572", "es-1573", "es-1574", "es-1575", "es-1576", "es-1577", "es-1578", "es-1579", "es-1580", "es-1581", "es-1582", "es-1583", "es-1584", "es-1585", "es-1586", "es-1587", "es-1588", "es-1589", "es-1590", "es-1591", "es-1592", "es-1593", "es-1594", "es-1595", "es-1596", "es-1597", "es-1598", "es-1599", "es-1600", "es-1601", "es-1602", "es-1603", "es-1604", "es-1605", "es-1606", "es-1607", "es-1608", "es-1609", "es-1610", "es-1611", "es-1612", "es-1613", "es-1614", "es-1615", "es-1616", "es-1617", "es-1618", "es-1619", "es-1620", "es-1621", "es-1622", "es-1623", "es-1624", "es-1625", "es-1626", "es-1627", "es-1628", "es-1629", "es-1630", "es-1631", "es-1632", "es-1633", "ru-0736", "ru-0737", "ru-0738", "ru-0739", "ru-0740", "ru-0741", "ru-0742", "ru-0743", "ru-0744", "ru-0745", "ru-0746", "ru-0747", "ru-0748", "ru-0749", "ru-0750", "ru-0751", "ru-0752", "ru-0753", "ru-0754", "ru-0755", "ru-0756", "ru-0757", "ru-0758", "ru-0759", "ru-0760", "ru-0761", "ru-0762", "ru-0763", "ru-0764", "ru-0765", "ru-0766", "ru-0767", "ru-0768", "ru-0769", "ru-0770", "ru-0771", "ru-0772", "ru-0773", "ru-0774", "ru-0775", "ru-0776", "ru-0777", "ru-0778", "ru-0779", "ru-0780", "ru-0781", "ru-0782", "ru-0783", "ru-0784", "ru-0785", "ru-0786", "ru-0787", "ru-0788", "ru-0789", "ru-0790", "ru-0791", "ru-0792", "ru-0793", "ru-0794", "ru-0795", "ru-0796", "ru-0797", "ru-0798", "ru-0799", "ru-0800", "ru-0801", "ru-0802", "ru-0803", "ru-0804", "ru-0805", "ru-0806", "ru-0807", "ru-0808", "ru-0809", "ru-0810", "ru-0811", "ru-0812", "ru-0813", "ru-0814", "ru-0815", "ru-0816", "ru-0817", "ru-0818", "ru-0819", "ru-0820", "ru-0821", "ru-0822", "ru-0823", "ru-0824", "ru-0825", "ru-0826", "ru-0827", "ru-0828", "ru-0829", "ru-0830", "ru-0831", "ru-0832", "ru-0833", "ru-0834", "ru-0835", "ru-0836", "ru-0837", "ru-0838", "ru-0839", "ru-0840", "ru-0841", "ru-0842", "ru-0843", "ru-0844", "ru-0845", "ru-0846", "ru-0847", "ru-0848", "ru-0849", "ru-0850", "ru-0851", "ru-0852", "ru-0853", "ru-0854", "ru-0855", "ru-0856", "ru-0857", "ru-0858", "ru-0859", "ru-0860", "ru-0861", "ru-0862", "ru-0863", "ru-0864", "ru-0865", "ru-0866", "ru-0867", "ru-0868", "ru-0869", "ru-0870", "ru-0871", "ru-0872", "ru-0873", "ru-0874", "ru-0875", "ru-0876", "ru-0877", "ru-0878", "ru-0879", "ru-0880", "ru-0881", "ru-0882", "ru-0883", "ru-0884", "ru-0885", "ru-0886", "ru-0887", "ru-0888", "ru-0889", "ru-0890", "ru-0891", "ru-0892", "ru-0893", "ru-0894", "ru-0895", "ru-0896", "ru-0897", "ru-0898", "ru-0899", "ru-0900", "ru-0901", "ru-0902", "ru-0903", "ru-0904", "ru-0905", "ru-0906", "ru-0907", "ru-0908", "ru-0909", "ru-0910", "ru-0911", "ru-0912", "ru-0913", "ru-0914", "ru-0915", "ru-0916", "ru-0917", "ru-0918", "ru-0919", "ru-0920", "ru-0921", "ru-0922", "ru-0923", "ru-0924", "ru-0925", "ru-0926", "ru-0927", "ru-0928", "ru-0929", "ru-0930", "ru-0931", "ru-0932", "ru-0933", "ru-0934", "ru-0935", "es-1634", "es-1635", "es-1636", "es-1637", "es-1638", "es-1639", "es-1640", "es-1641", "es-1642", "es-1643", "es-1644", "es-1645", "es-1646", "es-1647", "es-1648", "es-1649", "es-1650", "es-1651", "es-1652", "es-1653", "es-1654", "es-1655", "es-1656", "es-1657", "es-1658", "es-1659", "es-1660", "es-1661", "es-1662", "es-1663", "es-1664", "es-1665", "es-1666", "es-1667", "es-1668", "es-1669", "es-1670", "es-1671", "es-1672", "es-1673", "es-1674", "es-1675", "es-1676", "es-1677", "es-1678", "es-1679", "es-1680", "es-1681", "es-1682", "es-1683", "es-1684", "es-1685", "es-1686", "es-1687", "es-1688", "es-1689", "es-1690", "es-1691", "es-1692", "es-1693", "es-1694", "es-1695", "es-1696", "es-1697", "es-1698", "es-1699", "es-1700", "es-1701", "es-1702", "es-1703", "es-1704", "es-1705", "es-1706", "es-1707", "es-1708", "es-1709", "es-1710", "es-1711", "es-1712", "es-1713", "es-1714", "es-1715", "es-1716", "es-1717", "es-1718", "es-1719", "es-1720", "es-1721", "es-1722", "es-1723", "es-1724", "es-1725", "es-1726", "es-1727", "es-1728", "es-1729", "es-1730", "es-1731", "es-1732", "es-1733", "es-1734", "es-1735", "es-1736", "es-1737", "es-1738", "es-1739", "es-1740", "es-1741", "es-1742", "es-1743", "es-1744", "es-1745", "es-1746", "es-1747", "es-1748", "es-1749", "es-1750", "es-1751", "es-1752", "es-1753", "es-1754", "es-1755", "es-1756", "es-1757", "es-1758", "es-1759", "es-1760", "es-1761", "es-1762", "es-1763", "es-1764", "es-1765", "es-1766", "es-1767", "es-1768", "es-1769", "es-1770", "es-1771", "es-1772", "es-1773", "es-1774", "es-1775", "es-1776", "es-1777", "es-1778", "es-1779", "es-1780", "es-1781", "es-1782", "es-1783", "es-1784", "es-1785", "es-1786", "es-1787", "es-1788", "es-1789", "es-1790", "es-1791", "es-1792", "es-1793", "es-1794", "es-1795", "es-1796", "es-1797", "es-1798", "es-1799", "es-1800", "es-1801", "es-1802", "es-1803", "es-1804", "es-1805", "es-1806", "es-1807", "es-1808", "es-1809", "es-1810", "es-1811", "es-1812", "es-1813", "es-1814", "es-1815", "es-1816", "es-1817", "es-1818", "es-1819", "es-1820", "es-1821", "es-1822", "es-1823", "es-1824", "es-1825", "es-1826", "es-1827", "es-1828", "es-1829", "es-1830", "es-1831", "es-1832", "es-1833", "es-1834", "es-1835", "es-1836", "es-1837", "es-1838", "es-1839", "es-1840", "es-1841", "es-1842", "es-1843", "es-1844", "es-1845", "es-1846", "es-1847", "es-1848", "es-1849", "es-1850", "es-1851", "es-1852", "es-1853", "es-1854", "es-1855", "es-1856", "es-1857", "es-1858", "es-1859", "es-1860", "es-1861", "es-1862", "es-1863", "es-1864", "es-1865", "es-1866", "es-1867", "es-1868", "es-1869", "es-1870", "es-1871", "es-1872", "es-1873", "ru-0936", "ru-0937", "ru-0938", "ru-0939", "ru-0940", "ru-0941", "ru-0942", "ru-0943", "ru-0944", "ru-0945", "ru-0946", "ru-0947", "ru-0948", "ru-0949", "ru-0950", "ru-0951", "ru-0952", "ru-0953", "ru-0954", "ru-0955", "ru-0956", "ru-0957", "ru-0958", "ru-0959", "ru-0960", "ru-0961", "ru-0962", "ru-0963", "ru-0964", "ru-0965", "ru-0966", "ru-0967", "ru-0968", "ru-0969", "ru-0970", "ru-0971", "ru-0972", "ru-0973", "ru-0974", "ru-0975", "ru-0976", "ru-0977", "ru-0978", "ru-0979", "ru-0980", "ru-0981", "ru-0982", "ru-0983", "ru-0984", "ru-0985", "ru-0986", "ru-0987", "ru-0988", "ru-0989", "ru-0990", "ru-0991", "ru-0992", "ru-0993", "ru-0994", "ru-0995", "ru-0996", "ru-0997", "ru-0998", "ru-0999", "ru-1000", "ru-1001", "ru-1002", "ru-1003", "ru-1004", "ru-1005", "ru-1006", "ru-1007", "ru-1008", "ru-1009", "ru-1010", "ru-1011", "ru-1012", "ru-1013", "ru-1014", "ru-1015", "ru-1016", "ru-1017", "ru-1018", "ru-1019", "ru-1020", "ru-1021", "ru-1022", "ru-1023", "ru-1024", "ru-1025", "ru-1026", "ru-1027", "ru-1028", "ru-1029", "ru-1030", "ru-1031", "ru-1032", "ru-1033", "ru-1034", "ru-1035", "ru-1036", "ru-1037", "ru-1038", "ru-1039", "ru-1040", "ru-1041", "ru-1042", "ru-1043", "ru-1044", "ru-1045", "ru-1046", "ru-1047", "ru-1048", "ru-1049", "ru-1050", "ru-1051", "ru-1052", "ru-1053", "ru-1054", "ru-1055", "ru-1056", "ru-1057", "ru-1058", "ru-1059", "ru-1060", "ru-1061", "ru-1062", "ru-1063", "ru-1064", "ru-1065", "ru-1066", "ru-1067", "ru-1068", "ru-1069", "ru-1070", "ru-1071", "ru-1072", "ru-1073", "ru-1074", "ru-1075", "ru-1076", "ru-1077", "ru-1078", "ru-1079", "ru-1080", "ru-1081", "ru-1082", "ru-1083", "ru-1084", "ru-1085", "ru-1086", "ru-1087", "ru-1088", "ru-1089", "ru-1090", "ru-1091", "ru-1092", "ru-1093", "ru-1094", "ru-1095", "ru-1096", "ru-1097", "ru-1098", "ru-1099", "ru-1100", "ru-1101", "ru-1102", "ru-1103", "ru-1104", "ru-1105", "ru-1106", "ru-1107", "ru-1108", "ru-1109", "ru-1110", "ru-1111", "ru-1112", "ru-1113", "ru-1114", "ru-1115", "ru-1116", "ru-1117", "ru-1118", "ru-1119", "ru-1120", "ru-1121", "ru-1122", "ru-1123", "ru-1124", "ru-1125", "ru-1126", "ru-1127", "ru-1128", "ru-1129", "ru-1130", "ru-1131", "ru-1132", "ru-1133", "ru-1134", "ru-1135", "ru-1136", "es-1874", "es-1875", "es-1876", "es-1877", "es-1878", "es-1879", "es-1880", "es-1881", "es-1882", "es-1883", "es-1884", "es-1885", "es-1886", "es-1887", "es-1888", "es-1889", "es-1890", "es-1891", "es-1892", "es-1893", "es-1894", "es-1895", "es-1896", "es-1897", "es-1898", "es-1899", "es-1900", "es-1901", "es-1902", "es-1903", "es-1904", "es-1905", "es-1906", "es-1907", "es-1908", "es-1909", "es-1910", "es-1911", "es-1912", "es-1913", "es-1914", "es-1915", "es-1916", "es-1917", "es-1918", "es-1919", "es-1920", "es-1921", "es-1922", "es-1923", "es-1924", "es-1925", "es-1926", "es-1927", "es-1928", "es-1929", "es-1930", "es-1931", "es-1932", "es-1933", "es-1934", "es-1935", "es-1936", "es-1937", "es-1938", "es-1939", "es-1940", "es-1941", "es-1942", "es-1943", "es-1944", "es-1945", "es-1946", "es-1947", "es-1948", "es-1949", "es-1950", "es-1951", "es-1952", "es-1953", "es-1954", "es-1955", "es-1956", "es-1957", "es-1958", "es-1959", "es-1960", "es-1961", "es-1962", "es-1963", "es-1964", "es-1965", "es-1966", "es-1967", "es-1968", "es-1969", "es-1970", "es-1971", "es-1972", "es-1973", "es-1974", "es-1975", "es-1976", "es-1977", "es-1978", "es-1979", "es-1980", "es-1981", "es-1982", "es-1983", "es-1984", "es-1985", "es-1986", "es-1987", "es-1988", "es-1989", "es-1990", "es-1991", "es-1992", "es-1993", "ru-1137", "ru-1138", "ru-1139", "ru-1140", "ru-1141", "ru-1142", "ru-1143", "ru-1144", "ru-1145", "ru-1146", "ru-1147", "ru-1148", "ru-1149", "ru-1150", "ru-1151", "ru-1152", "ru-1153", "ru-1154", "ru-1155", "ru-1156", "ru-1157", "ru-1158", "ru-1159", "ru-1160", "ru-1161", "ru-1162", "ru-1163", "ru-1164", "ru-1165", "ru-1166", "ru-1167", "ru-1168", "ru-1169", "ru-1170", "ru-1171", "ru-1172", "ru-1173", "ru-1174", "ru-1175", "ru-1176", "ru-1177", "ru-1178", "ru-1179", "ru-1180", "ru-1181", "ru-1182", "ru-1183", "ru-1184", "ru-1185", "ru-1186", "ru-1187", "ru-1188", "ru-1189", "ru-1190", "ru-1191", "ru-1192", "ru-1193", "ru-1194", "ru-1195", "ru-1196", "ru-1197", "ru-1198", "ru-1199", "ru-1200", "ru-1201", "ru-1202", "ru-1203", "ru-1204", "ru-1205", "ru-1206", "ru-1207", "ru-1208", "ru-1209", "ru-1210", "ru-1211", "ru-1212", "ru-1213", "ru-1214", "ru-1215", "ru-1216", "ru-1217", "ru-1218", "ru-1219", "ru-1220", "ru-1221", "ru-1222", "ru-1223", "ru-1224", "ru-1225", "ru-1226", "ru-1227", "ru-1228", "ru-1229", "ru-1230", "ru-1231", "ru-1232", "ru-1233", "ru-1234", "ru-1235", "ru-1236", "ru-1237", "ru-1238", "ru-1239", "ru-1240", "ru-1241", "ru-1242", "ru-1243", "ru-1244", "ru-1245", "ru-1246", "ru-1247", "ru-1248", "ru-1249", "ru-1250", "ru-1251", "ru-1252", "ru-1253", "ru-1254", "ru-1255", "ru-1256", "ru-1257", "ru-1258", "ru-1259", "ru-1260", "ru-1261", "ru-1262", "ru-1263", "ru-1264", "ru-1265", "ru-1266", "ru-1267", "ru-1268", "ru-1269", "ru-1270", "ru-1271", "ru-1272", "ru-1273", "ru-1274", "ru-1275", "ru-1276", "ru-1277", "ru-1278", "ru-1279", "ru-1280", "ru-1281", "ru-1282", "ru-1283", "ru-1284", "ru-1285", "ru-1286", "ru-1287", "ru-1288", "ru-1289", "ru-1290", "ru-1291", "ru-1292", "ru-1293", "ru-1294", "ru-1295", "ru-1296", "ru-1297", "ru-1298", "ru-1299", "ru-1300", "ru-1301", "ru-1302", "ru-1303", "ru-1304", "ru-1305", "ru-1306", "ru-1307", "ru-1308", "ru-1309", "ru-1310", "ru-1311", "ru-1312", "ru-1313", "ru-1314", "ru-1315", "ru-1316", "ru-1317", "ru-1318", "ru-1319", "ru-1320", "ru-1321", "ru-1322", "ru-1323", "ru-1324", "ru-1325", "ru-1326", "ru-1327", "ru-1328", "ru-1329", "ru-1330", "ru-1331", "ru-1332", "ru-1333", "ru-1334", "ru-1335", "ru-1336", "ru-1337", "ru-1338", "ru-1339", "ru-1340", "ru-1341", "ru-1342", "ru-1343", "ru-1344", "ru-1345", "ru-1346", "ru-1347", "ru-1348", "ru-1349", "ru-1350", "ru-1351", "ru-1352", "ru-1353", "ru-1354", "ru-1355", "ru-1356", "ru-1357", "ru-1358", "ru-1359", "ru-1360", "ru-1361", "ru-1362", "ru-1363", "ru-1364", "ru-1365", "ru-1366", "ru-1367", "ru-1368", "ru-1369", "ru-1370", "ru-1371", "ru-1372", "ru-1373", "ru-1374", "ru-1375", "ru-1376", "ru-1377", "ru-1378", "ru-1379", "ru-1380", "ru-1381", "ru-1382", "ru-1383", "ru-1384", "ru-1385", "ru-1386", "ru-1387", "ru-1388", "ru-1389", "ru-1390", "ru-1391", "ru-1392", "ru-1393", "ru-1394", "ru-1395", "ru-1396", "ru-1397", "ru-1398", "ru-1399", "ru-1400", "ru-1401", "ru-1402", "ru-1403", "ru-1404", "ru-1405", "ru-1406", "ru-1407", "ru-1408", "ru-1409", "ru-1410", "ru-1411", "ru-1412", "ru-1413", "ru-1414", "ru-1415", "ru-1416", "ru-1417", "ru-1418", "ru-1419", "ru-1420", "ru-1421", "ru-1422", "ru-1423", "ru-1424", "ru-1425", "ru-1426", "ru-1427", "ru-1428", "ru-1429", "ru-1430", "ru-1431", "ru-1432", "ru-1433", "ru-1434", "ru-1435", "ru-1436", "ru-1437", "ru-1438", "ru-1439", "ru-1440", "ru-1441", "ru-1442", "ru-1443", "ru-1444", "ru-1445", "ru-1446", "ru-1447", "ru-1448", "ru-1449", "ru-1450", "ru-1451", "ru-1452", "ru-1453", "ru-1454", "ru-1455", "ru-1456", "ru-1457", "ru-1458", "ru-1459", "ru-1460", "ru-1461", "ru-1462", "ru-1463", "ru-1464", "ru-1465", "ru-1466", "ru-1467", "ru-1468", "ru-1469", "ru-1470", "ru-1471", "ru-1472", "ru-1473", "ru-1474", "ru-1475", "ru-1476", "ru-1477", "ru-1478", "ru-1479", "ru-1480", "ru-1481", "ru-1482", "ru-1483", "ru-1484", "ru-1485", "ru-1486", "ru-1487", "ru-1488", "ru-1489", "ru-1490", "ru-1491", "ru-1492", "ru-1493", "ru-1494", "ru-1495", "ru-1496", "ru-1497", "ru-1498", "ru-1499", "ru-1500", "ru-1501", "ru-1502", "ru-1503", "ru-1504", "ru-1505", "ru-1506", "ru-1507", "ru-1508", "ru-1509", "ru-1510", "ru-1511", "ru-1512", "ru-1513", "ru-1514", "ru-1515", "ru-1516", "ru-1517", "ru-1518", "ru-1519", "ru-1520", "ru-1521", "ru-1522", "ru-1523", "ru-1524", "ru-1525", "ru-1526", "ru-1527", "ru-1528", "ru-1529", "ru-1530", "ru-1531", "ru-1532", "ru-1533", "ru-1534", "ru-1535", "ru-1536", "ru-1537", "ru-1538", "ru-1539", "ru-1540", "ru-1541", "ru-1542", "ru-1543", "ru-1544", "ru-1545", "ru-1546", "ru-1547", "ru-1548", "ru-1549", "ru-1550", "ru-1551", "ru-1552", "ru-1553", "ru-1554", "ru-1555", "ru-1556", "ru-1557", "ru-1558", "ru-1559", "ru-1560", "ru-1561", "ru-1562", "ru-1563", "ru-1564", "ru-1565", "ru-1566", "ru-1567", "ru-1568", "ru-1569", "ru-1570", "ru-1571", "ru-1572", "ru-1573", "ru-1574", "ru-1575", "ru-1576", "ru-1577", "ru-1578", "ru-1579", "ru-1580", "ru-1581", "ru-1582", "ru-1583", "ru-1584", "ru-1585", "ru-1586", "ru-1587", "ru-1588", "ru-1589", "ru-1590", "ru-1591", "ru-1592", "ru-1593", "ru-1594", "ru-1595", "ru-1596", "ru-1597", "ru-1598", "ru-1599", "ru-1600", "ru-1601", "ru-1602", "ru-1603", "ru-1604", "ru-1605", "ru-1606", "ru-1607", "ru-1608", "ru-1609", "ru-1610", "ru-1611", "ru-1612", "ru-1613", "ru-1614", "ru-1615", "ru-1616", "ru-1617", "ru-1618", "ru-1619", "ru-1620", "ru-1621", "ru-1622", "ru-1623", "ms-0001", "ms-0002", "ms-0003", "ms-0004", "ms-0005", "ms-0006", "ms-0007", "ms-0008", "ms-0009", "ms-0010", "ms-0011", "ms-0012", "ms-0013", "ms-0014", "ms-0015", "ms-0016", "ms-0017", "ms-0018", "ms-0019", "ms-0020", "ms-0021", "ms-0022", "ms-0023", "ms-0024", "ms-0025", "ms-0026", "ms-0027", "ms-0028", "ms-0029", "ms-0030", "ms-0031", "ms-0032", "ms-0033", "ms-0034", "ms-0035", "ms-0036", "ms-0037", "ms-0038", "ms-0039", "ms-0040", "ms-0041", "ms-0042", "ms-0043", "ms-0044", "ms-0045", "ms-0046", "ms-0047", "ms-0048", "ms-0049", "ms-0050", "ms-0051", "ms-0052", "ms-0053", "ms-0054", "ms-0055", "ms-0056", "ms-0057", "ms-0058", "ms-0059", "ms-0060", "ms-0061", "ms-0062", "ms-0063", "ms-0064", "ms-0065", "ms-0066", "ms-0067", "ms-0068", "ms-0069", "ms-0070", "ms-0071", "ms-0072", "ms-0073", "ms-0074", "ms-0075", "ms-0076", "ms-0077", "ms-0078", "ms-0079", "ms-0080", "ms-0081", "ms-0082", "ms-0083", "ms-0084", "ms-0085", "ms-0086", "ms-0087", "ms-0088", "ms-0089", "ms-0090", "ms-0091", "ms-0092", "ms-0093", "ms-0094", "ms-0095", "ms-0096", "ms-0097", "ms-0098", "ms-0099", "ms-0100", "ms-0101", "ms-0102", "ms-0103", "ms-0104", "ms-0105", "ms-0106", "ms-0107", "ms-0108", "ms-0109", "ms-0110", "ms-0111", "ms-0112", "ms-0113", "ms-0114", "ms-0115", "ms-0116", "ms-0117", "ms-0118", "ms-0119", "ms-0120", "ms-0121", "ms-0122", "ms-0123", "ms-0124", "ms-0125", "ms-0126", "ms-0127", "ms-0128", "ms-0129", "ms-0130", "ms-0131", "ms-0132", "ms-0133", "ms-0134", "ms-0135", "ms-0136", "ms-0137", "ms-0138", "ms-0139", "ms-0140", "ms-0141", "ms-0142", "ms-0143", "ms-0144", "ms-0145", "ms-0146", "ms-0147", "ms-0148", "ms-0149", "ms-0150", "ms-0151", "ms-0152", "ms-0153", "ms-0154", "ms-0155", "ms-0156", "ms-0157", "ms-0158", "ms-0159", "ms-0160", "ms-0161", "ms-0162", "ms-0163", "ms-0164", "ms-0165", "ms-0166", "ms-0167", "ms-0168", "ms-0169", "ms-0170", "ms-0171", "ms-0172", "ms-0173", "ms-0174", "ms-0175", "ms-0176", "ms-0177", "ms-0178", "ms-0179", "ms-0180", "ms-0181", "ms-0182", "ms-0183", "ms-0184", "ms-0185", "ms-0186", "ms-0187", "ms-0188", "ms-0189", "ms-0190", "ms-0191", "ms-0192", "ms-0193", "ms-0194", "ms-0195", "ms-0196", "ms-0197", "ms-0198", "ms-0199", "ms-0200", "ms-0201", "ms-0202", "ms-0203", "ms-0204", "ms-0205", "ms-0206", "ms-0207", "ms-0208", "ms-0209", "ms-0210", "ms-0211", "ms-0212", "ms-0213", "ms-0214", "ms-0215", "ms-0216", "ms-0217", "ms-0218", "ms-0219", "ms-0220", "ms-0221", "ms-0222", "ms-0223", "ms-0224", "ms-0225", "ms-0226", "ms-0227", "ms-0228", "ms-0229", "ms-0230", "ms-0231", "ms-0232", "ms-0233", "ms-0234", "ms-0235", "ms-0236", "ms-0237", "ms-0238", "ms-0239", "ms-0240", "ms-0241", "ms-0242", "ms-0243", "ms-0244", "ms-0245", "ms-0246", "ms-0247", "ms-0248", "ms-0249", "ms-0250", "ms-0251", "ms-0252", "ms-0253", "ms-0254", "ms-0255", "ms-0256", "ms-0257", "ms-0258", "ms-0259", "ms-0260", "ms-0261", "ms-0262", "ms-0263", "ms-0264", "ms-0265", "ms-0266", "ms-0267", "ms-0268", "ms-0269", "ms-0270", "ms-0271", "ms-0272", "ms-0273", "ms-0274", "ms-0275", "ms-0276", "ms-0277", "ms-0278", "ms-0279", "ms-0280", "ms-0281", "ms-0282", "ms-0283", "ms-0284", "ms-0285", "ms-0286", "ms-0287", "ms-0288", "ms-0289", "ms-0290", "ms-0291", "ms-0292", "ms-0293", "ms-0294", "ms-0295", "ms-0296", "ms-0297", "ms-0298", "ms-0299", "ms-0300", "ms-0301", "ms-0302", "ms-0303", "ms-0304", "ms-0305", "ms-0306", "ms-0307", "ms-0308", "ms-0309", "ms-0310", "ms-0311", "ms-0312", "ms-0313", "ms-0314", "ms-0315", "ms-0316", "ms-0317", "ms-0318", "ms-0319", "ms-0320", "ms-0321", "ms-0322", "ms-0323", "ms-0324", "ms-0325", "ms-0326", "ms-0327", "ms-0328", "ms-0329", "ms-0330", "ms-0331", "ms-0332", "ms-0333", "ms-0334", "ms-0335", "ms-0336", "ms-0337", "ms-0338", "ms-0339", "ms-0340", "ms-0341", "ms-0342", "ms-0343", "ms-0344", "ms-0345", "ms-0346", "ms-0347", "ms-0348", "ms-0349", "ms-0350", "ms-0351", "ms-0352", "ms-0353", "ms-0354", "ms-0355", "ms-0356", "ms-0357", "ms-0358", "ms-0359", "ms-0360", "ms-0361", "ms-0362", "ms-0363", "ms-0364", "ms-0365", "ms-0366", "ms-0367", "ms-0368", "ms-0369", "ms-0370", "ms-0371", "ms-0372", "ms-0373", "ms-0374", "ms-0375", "ms-0376", "ms-0377", "ms-0378", "ms-0379", "ms-0380", "ms-0381", "ms-0382", "ms-0383", "ms-0384", "ms-0385", "ms-0386", "ms-0387", "ms-0388", "ms-0389", "ms-0390", "ms-0391", "ms-0392", "ms-0393", "ms-0394", "ms-0395", "ms-0396", "ms-0397", "ms-0398", "ms-0399", "ms-0400", "ms-0401", "ms-0402", "ms-0403", "ms-0404", "ms-0405", "ms-0406", "ms-0407", "ms-0408", "ms-0409", "ms-0410", "ms-0411", "ms-0412", "ms-0413", "ms-0414", "ms-0415", "ms-0416", "ms-0417", "ms-0418", "ms-0419", "ms-0420", "ms-0421", "ms-0422", "ms-0423", "ms-0424", "ms-0425", "ms-0426", "ms-0427", "ms-0428", "ms-0429", "ms-0430", "ms-0431", "ms-0432", "ms-0433", "ms-0434", "ms-0435", "ms-0436", "ms-0437", "ms-0438", "ms-0439", "ms-0440", "ms-0441", "ms-0442", "ms-0443", "ms-0444", "ms-0445", "ms-0446", "ms-0447", "ms-0448", "ms-0449", "ms-0450", "ms-0451", "ms-0452", "ms-0453", "ms-0454", "ms-0455", "ms-0456", "ms-0457", "ms-0458", "ms-0459", "ms-0460", "ms-0461", "ms-0462", "ms-0463", "ms-0464", "ms-0465", "ms-0466", "ms-0467", "ms-0468", "ms-0469", "ms-0470", "ms-0471", "ms-0472", "ms-0473", "ms-0474", "ms-0475", "ms-0476", "ms-0477", "ms-0478", "ms-0479", "ms-0480", "ms-0481", "ms-0482", "ms-0483", "ms-0484", "ms-0485", "ms-0486", "ms-0487", "ms-0488", "ms-0489", "ms-0490", "ms-0491", "ms-0492", "ms-0493", "ms-0494", "ms-0495", "ms-0496", "ms-0497", "ms-0498", "ms-0499", "ms-0500", "ms-0501", "ms-0502", "ms-0503", "ms-0504", "ms-0505", "ms-0506", "ms-0507", "ms-0508", "ms-0509", "ms-0510", "ms-0511", "ms-0512", "ms-0513", "ms-0514", "ms-0515", "ms-0516", "ms-0517", "ms-0518", "ms-0519", "ms-0520", "ms-0521", "ms-0522", "ms-0523", "ms-0524", "ms-0525", "ms-0526", "ms-0527", "ms-0528", "ms-0529", "ms-0530", "ms-0531", "ms-0532", "ms-0533", "ms-0534", "ms-0535", "ms-0536", "ms-0537", "ms-0538", "ms-0539", "ms-0540", "ms-0541", "ms-0542", "ms-0543", "ms-0544", "ms-0545", "ms-0546", "ms-0547", "ms-0548", "ms-0549", "ms-0550", "ms-0551", "ms-0552", "ms-0553", "ms-0554", "ms-0555", "ms-0556", "ms-0557", "ms-0558", "ms-0559", "ms-0560", "ms-0561", "ms-0562", "ms-0563", "ms-0564", "ms-0565", "ms-0566", "ms-0567", "ms-0568", "ms-0569", "ms-0570", "ms-0571", "ms-0572", "ms-0573", "ms-0574", "ms-0575", "ms-0576", "ms-0577", "ms-0578", "ms-0579", "ms-0580", "ms-0581", "ms-0582", "ms-0583", "ms-0584", "ms-0585", "ms-0586", "ms-0587", "ms-0588", "ms-0589", "ms-0590", "ms-0591", "ms-0592", "ms-0593", "ms-0594", "ms-0595", "ms-0596", "ms-0597", "ms-0598", "ms-0599", "ms-0600", "ms-0601", "ms-0602", "ms-0603", "ms-0604", "ms-0605", "ms-0606", "ms-0607", "ms-0608", "ms-0609", "ms-0610", "ms-0611", "ms-0612", "ms-0613", "ms-0614", "ms-0615", "ms-0616", "ms-0617", "ms-0618", "ms-0619", "ms-0620", "ms-0621", "ms-0622", "ms-0623", "ms-0624", "ms-0625", "ms-0626", "ms-0627", "ms-0628", "ms-0629", "ms-0630", "ms-0631", "ms-0632", "ms-0633", "ms-0634", "ms-0635", "ms-0636", "ms-0637", "ms-0638", "ms-0639", "ms-0640", "uz-0001", "uz-0002", "uz-0003", "uz-0004", "uz-0005", "uz-0006", "uz-0007", "uz-0008", "uz-0009", "uz-0010", "uz-0011", "uz-0012", "uz-0013", "uz-0014", "uz-0015", "uz-0016", "uz-0017", "uz-0018", "uz-0019", "uz-0020", "uz-0021", "uz-0022", "uz-0023", "uz-0024", "uz-0025", "uz-0026", "uz-0027", "uz-0028", "uz-0029", "uz-0030", "uz-0031", "uz-0032", "uz-0033", "uz-0034", "uz-0035", "uz-0036", "uz-0037", "uz-0038", "uz-0039", "uz-0040", "uz-0041", "uz-0042", "uz-0043", "uz-0044", "uz-0045", "uz-0046", "uz-0047", "uz-0048", "uz-0049", "uz-0050", "uz-0051", "uz-0052", "uz-0053", "uz-0054", "uz-0055", "uz-0056", "uz-0057", "uz-0058", "uz-0059", "uz-0060", "uz-0061", "uz-0062", "uz-0063", "uz-0064", "uz-0065", "uz-0066", "uz-0067", "uz-0068", "uz-0069", "uz-0070", "uz-0071", "uz-0072", "uz-0073", "uz-0074", "uz-0075", "uz-0076", "uz-0077", "uz-0078", "uz-0079", "uz-0080", "uz-0081", "uz-0082", "uz-0083", "uz-0084", "uz-0085", "uz-0086", "uz-0087", "uz-0088", "uz-0089", "uz-0090", "uz-0091", "uz-0092", "uz-0093", "uz-0094", "uz-0095", "uz-0096", "uz-0097", "uz-0098", "uz-0099", "uz-0100", "uz-0101", "uz-0102", "uz-0103", "uz-0104", "uz-0105", "uz-0106", "uz-0107", "uz-0108", "uz-0109", "uz-0110", "uz-0111", "uz-0112", "uz-0113", "uz-0114", "uz-0115", "uz-0116", "uz-0117", "uz-0118", "uz-0119", "uz-0120", "uz-0121", "uz-0122", "uz-0123", "uz-0124", "uz-0125", "uz-0126", "uz-0127", "uz-0128", "uz-0129", "uz-0130", "uz-0131", "uz-0132", "uz-0133", "uz-0134", "uz-0135", "uz-0136", "uz-0137", "uz-0138", "uz-0139", "uz-0140", "uz-0141", "uz-0142", "uz-0143", "uz-0144", "uz-0145", "uz-0146", "uz-0147", "uz-0148", "uz-0149", "uz-0150", "uz-0151", "uz-0152", "uz-0153", "uz-0154", "uz-0155", "uz-0156", "uz-0157", "uz-0158", "uz-0159", "uz-0160", "uz-0161", "uz-0162", "uz-0163", "uz-0164", "uz-0165", "uz-0166", "uz-0167", "uz-0168", "uz-0169", "uz-0170", "uz-0171", "uz-0172", "uz-0173", "uz-0174", "uz-0175", "uz-0176", "uz-0177", "uz-0178", "uz-0179", "uz-0180", "uz-0181", "uz-0182", "uz-0183", "uz-0184", "uz-0185", "uz-0186", "uz-0187", "uz-0188", "uz-0189", "uz-0190", "uz-0191", "uz-0192", "uz-0193", "uz-0194", "uz-0195", "uz-0196", "uz-0197", "uz-0198", "uz-0199", "uz-0200", "uz-0201", "uz-0202", "uz-0203", "uz-0204", "uz-0205", "uz-0206", "uz-0207", "uz-0208", "uz-0209", "uz-0210", "uz-0211", "uz-0212", "uz-0213", "uz-0214", "uz-0215", "uz-0216", "uz-0217", "uz-0218", "uz-0219", "uz-0220", "uz-0221", "uz-0222", "uz-0223", "uz-0224", "uz-0225", "uz-0226", "uz-0227", "uz-0228", "uz-0229", "uz-0230", "uz-0231", "uz-0232", "uz-0233", "uz-0234", "uz-0235", "uz-0236", "uz-0237", "uz-0238", "uz-0239", "uz-0240", "uz-0241", "uz-0242", "uz-0243", "uz-0244", "uz-0245", "uz-0246", "uz-0247", "uz-0248", "uz-0249", "uz-0250", "uz-0251", "uz-0252", "uz-0253", "uz-0254", "uz-0255", "uz-0256", "uz-0257", "uz-0258", "uz-0259", "uz-0260", "uz-0261", "uz-0262", "uz-0263", "uz-0264", "uz-0265", "uz-0266", "uz-0267", "uz-0268", "uz-0269", "uz-0270", "uz-0271", "uz-0272", "uz-0273", "uz-0274", "uz-0275", "uz-0276", "uz-0277", "uz-0278", "uz-0279", "uz-0280", "uz-0281", "uz-0282", "uz-0283", "uz-0284", "uz-0285", "uz-0286", "uz-0287", "uz-0288", "uz-0289", "uz-0290", "uz-0291", "uz-0292", "uz-0293", "uz-0294", "uz-0295", "uz-0296", "uz-0297", "uz-0298", "uz-0299", "uz-0300", "uz-0301", "uz-0302", "uz-0303", "uz-0304", "uz-0305", "uz-0306", "uz-0307", "uz-0308", "uz-0309", "uz-0310", "uz-0311", "uz-0312", "uz-0313", "uz-0314", "uz-0315", "uz-0316", "uz-0317", "uz-0318", "uz-0319", "uz-0320", "uz-0321", "uz-0322", "uz-0323", "uz-0324", "uz-0325", "uz-0326", "uz-0327", "uz-0328", "uz-0329", "uz-0330", "uz-0331", "uz-0332", "uz-0333", "uz-0334", "uz-0335", "uz-0336", "uz-0337", "uz-0338", "uz-0339", "uz-0340", "uz-0341", "uz-0342", "uz-0343", "uz-0344", "uz-0345", "uz-0346", "uz-0347", "uz-0348", "uz-0349", "uz-0350", "uz-0351", "uz-0352", "uz-0353", "uz-0354", "uz-0355", "uz-0356", "uz-0357", "uz-0358", "uz-0359", "uz-0360", "uz-0361", "uz-0362", "uz-0363", "uz-0364", "uz-0365", "uz-0366", "uz-0367", "uz-0368", "uz-0369", "uz-0370", "uz-0371", "uz-0372", "uz-0373", "uz-0374", "uz-0375", "uz-0376", "uz-0377", "uz-0378", "uz-0379", "uz-0380", "uz-0381", "uz-0382", "uz-0383", "uz-0384", "uz-0385", "uz-0386", "uz-0387", "uz-0388", "uz-0389", "uz-0390", "uz-0391", "uz-0392", "uz-0393", "uz-0394", "uz-0395", "uz-0396", "uz-0397", "uz-0398", "uz-0399", "uz-0400", "uz-0401", "uz-0402", "uz-0403", "uz-0404", "kk-0001", "kk-0002", "kk-0003", "kk-0004", "kk-0005", "kk-0006", "kk-0007", "kk-0008", "kk-0009", "kk-0010", "kk-0011", "kk-0012", "kk-0013", "kk-0014", "kk-0015", "kk-0016", "kk-0017", "kk-0018", "kk-0019", "kk-0020", "kk-0021", "kk-0022", "kk-0023", "kk-0024", "kk-0025", "kk-0026", "kk-0027", "kk-0028", "kk-0029", "kk-0030", "kk-0031", "kk-0032", "kk-0033", "kk-0034", "kk-0035", "kk-0036", "kk-0037", "kk-0038", "kk-0039", "kk-0040", "kk-0041", "kk-0042", "kk-0043", "kk-0044", "kk-0045", "kk-0046", "kk-0047", "kk-0048", "kk-0049", "kk-0050", "kk-0051", "kk-0052", "kk-0053", "kk-0054", "kk-0055", "kk-0056", "kk-0057", "kk-0058", "kk-0059", "kk-0060", "kk-0061", "kk-0062", "kk-0063", "kk-0064", "kk-0065", "kk-0066", "kk-0067", "kk-0068", "kk-0069", "kk-0070", "kk-0071", "kk-0072", "kk-0073", "kk-0074", "kk-0075", "kk-0076", "kk-0077", "kk-0078", "kk-0079", "kk-0080", "kk-0081", "kk-0082", "kk-0083", "kk-0084", "kk-0085", "kk-0086", "kk-0087", "kk-0088", "kk-0089", "kk-0090", "kk-0091", "kk-0092", "kk-0093", "kk-0094", "kk-0095", "kk-0096", "kk-0097", "kk-0098", "kk-0099", "kk-0100", "kk-0101", "kk-0102", "kk-0103", "kk-0104", "kk-0105", "kk-0106", "kk-0107", "kk-0108", "kk-0109", "kk-0110", "kk-0111", "kk-0112", "kk-0113", "kk-0114", "kk-0115", "kk-0116", "kk-0117", "kk-0118", "kk-0119", "kk-0120", "kk-0121", "kk-0122", "kk-0123", "kk-0124", "kk-0125", "kk-0126", "kk-0127", "kk-0128", "kk-0129", "kk-0130", "kk-0131", "kk-0132", "kk-0133", "kk-0134", "kk-0135", "kk-0136", "kk-0137", "kk-0138", "kk-0139", "kk-0140", "kk-0141", "kk-0142", "kk-0143", "kk-0144", "kk-0145", "kk-0146", "kk-0147", "kk-0148", "kk-0149", "kk-0150", "kk-0151", "kk-0152", "kk-0153", "kk-0154", "kk-0155", "kk-0156", "kk-0157", "kk-0158", "kk-0159", "kk-0160", "kk-0161", "kk-0162", "kk-0163", "kk-0164", "kk-0165", "kk-0166", "kk-0167", "kk-0168", "kk-0169", "kk-0170", "kk-0171", "kk-0172", "kk-0173", "kk-0174", "kk-0175", "kk-0176", "kk-0177", "kk-0178", "kk-0179", "kk-0180", "kk-0181", "kk-0182", "kk-0183", "kk-0184", "kk-0185", "kk-0186", "kk-0187", "kk-0188", "kk-0189", "kk-0190", "kk-0191", "kk-0192", "kk-0193", "kk-0194", "kk-0195", "kk-0196", "kk-0197", "kk-0198", "kk-0199", "kk-0200", "kk-0201", "kk-0202", "kk-0203", "kk-0204", "kk-0205", "kk-0206", "kk-0207", "kk-0208", "kk-0209", "kk-0210", "kk-0211", "kk-0212", "kk-0213", "kk-0214", "kk-0215", "kk-0216", "kk-0217", "kk-0218", "kk-0219", "kk-0220", "kk-0221", "kk-0222", "kk-0223", "kk-0224", "kk-0225", "kk-0226", "kk-0227", "kk-0228", "kk-0229", "kk-0230", "kk-0231", "kk-0232", "kk-0233", "kk-0234", "kk-0235", "kk-0236", "kk-0237", "kk-0238", "kk-0239", "kk-0240", "kk-0241", "kk-0242", "kk-0243", "kk-0244", "kk-0245", "kk-0246", "kk-0247", "kk-0248", "kk-0249", "kk-0250", "kk-0251", "kk-0252", "kk-0253", "kk-0254", "kk-0255", "kk-0256", "kk-0257", "kk-0258", "kk-0259", "kk-0260", "kk-0261", "kk-0262", "kk-0263", "kk-0264", "kk-0265", "kk-0266", "kk-0267", "kk-0268", "kk-0269", "kk-0270", "kk-0271", "kk-0272", "kk-0273", "kk-0274", "kk-0275", "kk-0276", "kk-0277", "kk-0278", "kk-0279", "kk-0280", "kk-0281", "kk-0282", "kk-0283", "kk-0284", "kk-0285", "kk-0286", "kk-0287", "kk-0288", "kk-0289", "kk-0290", "kk-0291", "kk-0292", "kk-0293", "kk-0294", "kk-0295", "kk-0296", "kk-0297", "kk-0298", "kk-0299", "kk-0300", "kk-0301", "kk-0302", "kk-0303", "kk-0304", "kk-0305", "kk-0306", "kk-0307", "kk-0308", "kk-0309", "kk-0310", "kk-0311", "kk-0312", "kk-0313", "kk-0314", "kk-0315", "kk-0316", "kk-0317", "kk-0318", "kk-0319", "kk-0320", "kk-0321", "kk-0322", "kk-0323", "kk-0324", "kk-0325", "kk-0326", "kk-0327", "kk-0328", "kk-0329", "kk-0330", "kk-0331", "kk-0332", "kk-0333", "kk-0334", "kk-0335", "kk-0336", "kk-0337", "kk-0338", "kk-0339", "kk-0340", "kk-0341", "kk-0342", "kk-0343", "kk-0344", "kk-0345", "kk-0346", "kk-0347", "kk-0348", "kk-0349", "kk-0350", "kk-0351", "kk-0352", "kk-0353", "kk-0354", "kk-0355", "kk-0356", "kk-0357", "kk-0358", "kk-0359", "kk-0360", "kk-0361", "kk-0362", "kk-0363", "kk-0364", "kk-0365", "kk-0366", "kk-0367", "kk-0368", "kk-0369", "kk-0370", "kk-0371", "kk-0372", "kk-0373", "kk-0374", "kk-0375", "kk-0376", "kk-0377", "kk-0378", "kk-0379", "kk-0380", "kk-0381", "kk-0382", "kk-0383", "kk-0384", "kk-0385", "kk-0386", "kk-0387", "kk-0388", "kk-0389", "kk-0390", "kk-0391", "kk-0392", "kk-0393", "kk-0394", "kk-0395", "kk-0396", "kk-0397", "kk-0398", "kk-0399", "kk-0400", "kk-0401", "kk-0402", "kk-0403", "kk-0404", "kk-0405", "kk-0406", "kk-0407", "kk-0408", "kk-0409", "kk-0410", "kk-0411", "kk-0412", "kk-0413", "kk-0414", "kk-0415", "kk-0416", "kk-0417", "ms-0641", "ms-0642", "ms-0643", "ms-0644", "ms-0645", "ms-0646", "ms-0647", "ms-0648", "ms-0649", "ms-0650", "ms-0651", "ms-0652", "ms-0653", "ms-0654", "ms-0655", "ms-0656", "ms-0657", "ms-0658", "ms-0659", "ms-0660", "ms-0661", "ms-0662", "ms-0663", "ms-0664", "ms-0665", "ms-0666", "ms-0667", "ms-0668", "ms-0669", "ms-0670", "ms-0671", "ms-0672", "ms-0673", "ms-0674", "ms-0675", "ms-0676", "ms-0677", "ms-0678", "ms-0679", "ms-0680", "ms-0681", "ms-0682", "ms-0683", "ms-0684", "ms-0685", "ms-0686", "ms-0687", "ms-0688", "ms-0689", "ms-0690", "ms-0691", "ms-0692", "ms-0693", "ms-0694", "ms-0695", "ms-0696", "ms-0697", "ms-0698", "ms-0699", "ms-0700", "ms-0701", "ms-0702", "ms-0703", "ms-0704", "ms-0705", "ms-0706", "ms-0707", "ms-0708", "ms-0709", "ms-0710", "ms-0711", "ms-0712", "ms-0713", "ms-0714", "ms-0715", "ms-0716", "ms-0717", "ms-0718", "ms-0719", "ms-0720", "ms-0721", "ms-0722", "ms-0723", "ms-0724", "ms-0725", "ms-0726", "ms-0727", "ms-0728", "ms-0729", "ms-0730", "ms-0731", "ms-0732", "ms-0733", "ms-0734", "ms-0735", "ms-0736", "ms-0737", "ms-0738", "ms-0739", "ms-0740", "ms-0741", "ms-0742", "ms-0743", "ms-0744", "ms-0745", "ms-0746", "ms-0747", "ms-0748", "ms-0749", "ms-0750", "ms-0751", "ms-0752", "ms-0753", "ms-0754", "ms-0755", "ms-0756", "ms-0757", "ms-0758", "ms-0759", "ms-0760", "ms-0761", "ms-0762", "ms-0763", "ms-0764", "ms-0765", "ms-0766", "ms-0767", "ms-0768", "ms-0769", "ms-0770", "ms-0771", "ms-0772", "ms-0773", "ms-0774", "ms-0775", "ms-0776", "ms-0777", "ms-0778", "ms-0779", "ms-0780", "ms-0781", "ms-0782", "ms-0783", "ms-0784", "ms-0785", "ms-0786", "ms-0787", "ms-0788", "ms-0789", "ms-0790", "ms-0791", "ms-0792", "ms-0793", "ms-0794", "ms-0795", "ms-0796", "ms-0797", "ms-0798", "ms-0799", "ms-0800", "ms-0801", "ms-0802", "ms-0803", "ms-0804", "ms-0805", "ms-0806", "ms-0807", "ms-0808", "ms-0809", "ms-0810", "ms-0811", "ms-0812", "ms-0813", "ms-0814", "ms-0815", "ms-0816", "ms-0817", "ms-0818", "ms-0819", "ms-0820", "ms-0821", "ms-0822", "ms-0823", "ms-0824", "ms-0825", "ms-0826", "ms-0827", "ms-0828", "ms-0829", "ms-0830", "ms-0831", "ms-0832", "ms-0833", "ms-0834", "ms-0835", "ms-0836", "ms-0837", "ms-0838", "ms-0839", "ms-0840", "ms-0841", "ms-0842", "ms-0843", "ms-0844", "ms-0845", "ms-0846", "ms-0847", "ms-0848", "ms-0849", "ms-0850", "ms-0851", "ms-0852", "ms-0853", "ms-0854", "ms-0855", "ms-0856", "ms-0857", "ms-0858", "ms-0859", "ms-0860", "ms-0861", "ms-0862", "ms-0863", "ms-0864", "ms-0865", "ms-0866", "ms-0867", "ms-0868", "ms-0869", "ms-0870", "ms-0871", "ms-0872", "ms-0873", "ms-0874", "ms-0875", "ms-0876", "ms-0877", "ms-0878", "ms-0879", "ms-0880", "ms-0881", "ms-0882", "ms-0883", "ms-0884", "ms-0885", "ms-0886", "ms-0887", "ms-0888", "ms-0889", "ms-0890", "ms-0891", "ms-0892", "ms-0893", "ms-0894", "ms-0895", "ms-0896", "ms-0897", "ms-0898", "ms-0899", "ms-0900", "ms-0901", "ms-0902", "ms-0903", "ms-0904", "ms-0905", "ms-0906", "ms-0907", "ms-0908", "ms-0909", "ms-0910", "ms-0911", "ms-0912", "ms-0913", "ms-0914", "ms-0915", "ms-0916", "ms-0917", "ms-0918", "ms-0919", "ms-0920"];
const M6_OLD_PROGRESS={"cards": {"es-0001:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0002:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0003:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0004:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0005:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0006:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0007:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0008:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0009:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0010:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0011:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0012:r": {"due": "2026-09-11", "ivl": 4, "ease": 2.6, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0013:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0014:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "es-0015:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0001:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0002:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0003:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0004:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0005:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0006:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0007:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0008:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0009:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}, "ru-0010:r": {"due": "2026-09-08", "ivl": 1, "ease": 2.5, "reps": 1, "lapses": 0, "last": "2026-09-07", "first": "2026-09-07"}}, "log": [{"t": "2026-09-07T04:00:07.567Z", "card": "es-0001:r", "grade": 5}, {"t": "2026-09-07T04:00:17.145Z", "card": "es-0002:r", "grade": 5}, {"t": "2026-09-07T04:00:24.249Z", "card": "es-0003:r", "grade": 5}, {"t": "2026-09-07T04:00:29.752Z", "card": "es-0004:r", "grade": 5}, {"t": "2026-09-07T04:00:35.774Z", "card": "es-0005:r", "grade": 5}, {"t": "2026-09-07T04:00:40.665Z", "card": "es-0006:r", "grade": 5}, {"t": "2026-09-07T04:00:48.333Z", "card": "es-0007:r", "grade": 5}, {"t": "2026-09-07T04:00:52.006Z", "card": "es-0008:r", "grade": 5}, {"t": "2026-09-07T04:03:36.337Z", "card": "es-0009:r", "grade": 5}, {"t": "2026-09-07T04:03:39.485Z", "card": "es-0010:r", "grade": 5}, {"t": "2026-09-07T04:03:45.718Z", "card": "es-0011:r", "grade": 5}, {"t": "2026-09-07T04:03:47.833Z", "card": "es-0012:r", "grade": 5}, {"t": "2026-09-07T04:03:59.508Z", "card": "es-0013:r", "grade": 4}, {"t": "2026-09-07T04:04:07.565Z", "card": "es-0014:r", "grade": 4}, {"t": "2026-09-07T04:04:11.973Z", "card": "es-0015:r", "grade": 4}, {"t": "2026-09-07T04:04:23.285Z", "card": "ru-0001:r", "grade": 4}, {"t": "2026-09-07T04:06:12.511Z", "card": "ru-0002:r", "grade": 4}, {"t": "2026-09-07T04:06:22.331Z", "card": "ru-0003:r", "grade": 4}, {"t": "2026-09-07T04:06:27.348Z", "card": "ru-0004:r", "grade": 4}, {"t": "2026-09-07T04:06:38.334Z", "card": "ru-0005:r", "grade": 4}, {"t": "2026-09-07T04:06:44.753Z", "card": "ru-0006:r", "grade": 4}, {"t": "2026-09-07T04:06:52.439Z", "card": "ru-0007:r", "grade": 4}, {"t": "2026-09-07T04:07:01.487Z", "card": "ru-0008:r", "grade": 4}, {"t": "2026-09-07T04:07:26.139Z", "card": "ru-0009:r", "grade": 4}, {"t": "2026-09-07T04:07:38.718Z", "card": "ru-0010:r", "grade": 4}]};

// M6 保留本轮区间断言；全课程连续性在下方完整检查。
const M6_LESSONS=['ms-21','ms-22','ms-23','ms-24'];
const M6_READINGS=Array.from({length:8},(_,i)=>'ms-r'+String(i+39).padStart(2,'0'));
const ms6Rows=initialRows.filter(r=>M6_LESSONS.includes(r.lesson));
const ms6Readings=M6_READINGS.map(id=>api.READINGS[id]);
const ms6Texts=()=>[
  ...ms6Rows.map(r=>({id:r.id,lesson:r.lesson,text:r.example})),
  ...M6_LESSONS.flatMap(id=>[...api.LESSONS[id].reading.sentences,...ms3LangSentences(api.LESSONS[id])].map(s=>({id,lesson:id,...s}))),
  ...ms6Readings.flatMap(r=>r.sentences.map(s=>({id:r.id,lesson:r.afterLesson,...s})))
];
test('任务 M6：四课周次、跨年日期、时长、目标与写作要求',()=>{
  const start=Date.UTC(2026,9,5),short=d=>String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
  for(const [i,id] of M6_LESSONS.entries()){
    const l=api.LESSONS[id],week=21+i;
    assert(l,id);assert.equal(l.lang,'ms');assert.equal(l.week,week);
    assert.equal(l.dates,'2027 年 '+short(new Date(start+(week-1)*7*86400000))+' 至 '+short(new Date(start+((week-1)*7+6)*86400000)));
    assert.equal(l.dailyTime,'每天 20 分钟 + 每周 1 次系统块 30 分钟');
    assert(l.goal.length>=15&&l.writingTask.length>=15);
    assert(l.explanation().includes(l.dailyTime));
    assert(l.explanation().includes('配合《Complete Malay》的对应单元，单元以实际教材为准'));
    assert(l.explanation().includes('时间分配以复盘结果为准'));
  }
  assert.match(api.LESSONS['ms-21'].writingTask,/5 句/);
  for(const id of ['ms-22','ms-23'])assert.match(api.LESSONS[id].writingTask,/100 词/);
  assert.match(api.LESSONS['ms-24'].writingTask,/150 词/);
});
test('任务 M6：预分配 280 条 id、每课数量、CSV 同步与 front 全语言内去重',()=>{
  const csv=plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8')));
  assert.deepEqual(csv,initialRows.filter(r=>r.lang==='ms'));
  assert.equal(ms6Rows.length,280);
  assert.deepEqual(ms6Rows.map(r=>r.id),Array.from({length:280},(_,i)=>'ms-'+String(i+1561).padStart(4,'0')));
  assert.equal(new Set(csv.map(r=>r.front.toLowerCase())).size,csv.length);
  for(const [i,id] of M6_LESSONS.entries())assert.equal(ms6Rows.filter(r=>r.lesson===id).length,[80,80,80,40][i]);
  const ids=Object.keys(api.LESSONS),start=ids.indexOf('ms-21');
  assert.deepEqual(ids.slice(start,start+4),M6_LESSONS);
  const rowStart=initialRows.findIndex(r=>r.id==='ms-1561');
  assert.deepEqual(initialRows.slice(rowStart,rowStart+280),ms6Rows);
  assert.equal(initialRows[rowStart-1].id,'ms-1560');
});
test('任务 M6：主题配额、补充标记与各课生成卡数',()=>{
  const quotas={
    'ms-21':{'重叠与相互':25,'果蔬与集合':20,'市场动作':20,'食物与市场':10,'市场整句':5},
    'ms-22':{'书信套语':20,'办公与通信':25,'通信动作':20,'书信衔接':5,'书信整句':5,'正式通信':5},
    'ms-23':{'叙事连接':12,'新闻与事件':30,'叙事与报道动作':25,'叙事描写':8,'叙事整句':5},
    'ms-24':{'复盘与学习':15,'词缀对照':15,'复盘整句':10}
  };
  for(const [id,topics]of Object.entries(quotas))for(const[tag,n]of Object.entries(topics))
    assert.equal(ms6Rows.filter(r=>r.lesson===id&&r.tags.split(';').includes(tag)).length,n,id+' '+tag);
  assert.equal(ms6Rows.filter(r=>r.tags.split(';').includes('补充')).length,5);
  assert(ms6Rows.filter(r=>r.tags.includes('书信套语')).every(r=>r.tags.split(';').includes('phrase')));
  assert.deepEqual(M6_LESSONS.map(id=>api.expandCards(ms6Rows.filter(r=>r.lesson===id)).length),[155,135,154,70]);
});
test('任务 M6：词类、完整例句、原形挖空、量词与及物宾语注释',()=>{
  const kinds=new Set('名词 动词 形容词 代词 数词 量词 介词 连词 副词 助动词 语气词 疑问词 问候'.split(' '));
  for(const r of ms6Rows){
    const tags=r.tags.split(';'),phrase=tags.includes('phrase');
    assert(kinds.has(tags[0])&&!tags.includes('letter'),r.id);
    assert(r.back&&r.note&&/[\u4e00-\u9fff]/.test(r.example_zh));
    assert(/[.!?]$/.test(r.example),r.id);assert(r.example.toLowerCase().includes(r.front.toLowerCase()),r.id);
    if(/[.!?]$/.test(r.front))assert(phrase,r.id);
    if(tags[0]==='动词'&&r.front.includes(' '))assert(phrase,r.id);
    if(tags[0]==='名词'&&!phrase)assert.match(r.note,/量词/,r.id);
    if(tags[0]==='形容词')assert.match(r.note,/形容词，后置/,r.id);
    if(/及物/.test(r.note)&&!/不及物/.test(r.note))assert.match(r.note,/宾语/,r.id);
    assert.equal(api.expandCards([r]).length,phrase?1:2,r.id);
    if(!phrase)assert(api.clozeExample(r).includes('____'),r.id);
  }
});
test('任务 M6：马来西亚拼写、同形词义与标准书面语范围',()=>{
  const banned=new Set('karena uang kantor universitas bahwa senin delapan mau saja sepeda sepatu kamar kemarin'.split(' '));
  const informal=new Set('aku kau engkau tak nak dah je ni tu'.split(' '));
  for(const s of [...ms6Texts(),...ms6Rows.map(r=>({id:r.id,text:r.front}))])
    for(const w of msWords(s.text).map(w=>w.toLowerCase())){
      assert(!banned.has(w)&&!informal.has(w),s.id+' '+w);
      // M6 has no poison lesson; bisa in any new instructional text is unexpected.
      assert.notEqual(w,'bisa',s.id+' 不用 bisa 表示能');
    }
  for(const r of ms6Rows){
    for(const w of msWords(r.note).map(w=>w.toLowerCase()))if(banned.has(w))assert(r.note.includes('印尼语作'),r.id);
    if(msWords(r.example).some(w=>w.toLowerCase()==='senang'))assert.doesNotMatch(r.example_zh,/高兴/);
  }
});
test('任务 M6：meN- 词根、音变说明和复合动词拼写一致',()=>{
  for(const r of ms6Rows.filter(r=>r.note.startsWith('meN- + ')&&(!r.tags.split(';').includes('phrase')||r.front==='menemu bual'))){
    const m=r.note.match(/^meN- \+ ([a-z]+)(?: \+ -(kan|i))? → ([a-z]+)/);assert(m,r.id);
    const [,root,suffix='',form]=m;
    assert.equal(msMenForm(root)+suffix,form,r.id);
    assert(r.front===form||r.front.startsWith(form+' '),r.id);
    const rule=msMenRule(root);assert(rule,r.id);
    if(!rule.keep)assert(r.note.includes(root[0]+' 脱落'),r.id);
    else assert(r.note.includes('保留')||r.front==='menemu bual',r.id);
  }
  assert(ms6Rows.some(r=>r.front==='menemu bual'&&r.tags.includes('phrase')));
});
test('任务 M6：每课六道语法题与四道共享阅读题，填空有提示且选项可判',()=>{
  for(const id of M6_LESSONS){
    const l=api.LESSONS[id];assert.equal(l.exercises.length,10);
    assert.equal(l.reading.questions.length,4);
    assert.deepEqual(l.exercises.slice(6),l.reading.questions);
    for(let i=0;i<4;i++)assert.strictEqual(l.exercises[i+6],l.reading.questions[i]);
    assert(l.exercises.slice(0,6).every(q=>!q.prompt.startsWith('阅读')));
    assert(l.exercises.slice(6).every(q=>q.prompt.startsWith('阅读')));
    for(const q of l.exercises){
      assert(q.prompt&&typeof q.answer==='string'&&q.answer.trim());
      if(q.options){assert(q.options.includes(q.answer));assert.equal(new Set(q.options).size,q.options.length);}
      if(q.prompt.includes('____'))assert(/[（(].+[）)]/.test(q.prompt),id+' 填空提示');
    }
  }
});
test('任务 M6：课内阅读 300–380 词、18–22 句与逐句中译',()=>{
  for(const id of M6_LESSONS){
    const r=api.LESSONS[id].reading,n=msWordCount(r.sentences);
    assert(n>=300&&n<=380,id+' '+n);assert(r.sentences.length>=18&&r.sentences.length<=22,id);
    for(const s of r.sentences)assert(/[.!?]$/.test(s.text)&&/[\u4e00-\u9fff]/.test(s.zh),id);
  }
  assert.match(api.LESSONS['ms-24'].reading.title,/自测材料/);
});
test('任务 M6：八篇阅读线连续区段、周次、体裁、词数与句数',()=>{
  const ids=Object.keys(api.READINGS),start=ids.indexOf('ms-r39');
  assert.deepEqual(ids.slice(start,start+8),M6_READINGS);
  const ranges=[[300,320,18,20],[300,320,18,20],[320,340,19,21],[320,340,18,20],[340,360,20,22],[340,360,20,22],[360,380,20,22],[360,380,20,22]];
  const genres=['日常生活','短故事','邮件','通知或广告','简单新闻','短故事','人物介绍','说明文'];
  for(const[i,r]of ms6Readings.entries()){
    const[lo,hi,slo,shi]=ranges[i],week=21+Math.floor(i/2);
    assert.equal(r.id,M6_READINGS[i]);assert.equal(r.lang,'ms');assert.equal(r.week,week);assert.equal(r.afterLesson,'ms-'+week);
    assert.equal(r.genre,genres[i]);assert(/[\u4e00-\u9fff]/.test(r.title));
    assert.equal(r.words,msWordCount(r.sentences));assert(r.words>=lo&&r.words<=hi,r.id+' '+r.words);
    assert(r.sentences.length>=slo&&r.sentences.length<=shi,r.id);
    for(const s of r.sentences)assert(/[.!?]$/.test(s.text)&&/[\u4e00-\u9fff]/.test(s.zh),r.id);
    if(i%2)assert.notEqual(r.genre,ms6Readings[i-1].genre);
  }
});
test('任务 M6：阅读线三道理解加一道推断、五个已学关键词和五行复述',()=>{
  for(const r of ms6Readings){
    assert.equal(r.questions.length,4);
    assert.equal(r.questions.filter(q=>q.prompt.startsWith('阅读')).length,3);
    assert.equal(r.questions.filter(q=>q.prompt.startsWith('推断')).length,1);
    for(const q of r.questions){
      assert(q.options.length>=3);assert(q.options.includes(q.answer));assert.equal(new Set(q.options).size,q.options.length);
    }
    assert.equal(r.keyWords.length,5);assert.equal(new Set(r.keyWords.map(k=>k.word.toLowerCase())).size,5);
    const learned=initialRows.filter(x=>x.lang==='ms'&&Number(x.lesson.slice(3))<=r.week);
    for(const k of r.keyWords){assert(learned.some(x=>x.front.toLowerCase()===k.word.toLowerCase()),r.id+' '+k.word);assert(/[\u4e00-\u9fff]/.test(k.zh));}
    assert.equal(r.retell.length,5);assert(r.retell.every(s=>typeof s==='string'&&/[\u4e00-\u9fff]/.test(s)));
  }
});
test('任务 M6：全部新例句、课文、阅读线及讲解例句的动态词汇范围',()=>{
  const all=ms6Texts();
  for(const id of M6_LESSONS)assert.deepEqual(msVocabularyMisses(id,all.filter(s=>s.lesson===id)),[],id);
});
test('任务 M6：全部 24 课阅读按 id 原序保留并验词，共 46 篇与 1840 条',()=>{
  const lessons=Object.keys(api.LESSONS).filter(id=>/^ms-\d{2}$/.test(id)&&Number(id.slice(3))<=24).sort();
  const readings=Object.values(api.READINGS).filter(r=>r.lang==='ms'&&r.week<=24);
  const expected=lessons.filter(id=>Number(id.slice(3))>=2).flatMap(id=>{
    const n=Number(id.slice(3));return [2*n-3,2*n-2].map(i=>'ms-r'+String(i).padStart(2,'0'));
  });
  assert.deepEqual(readings.map(r=>r.id),expected);
  for(const id of lessons)assert.deepEqual(msVocabularyMisses(id,readings.filter(r=>r.afterLesson===id).flatMap(r=>r.sentences.map(s=>({id:r.id,...s})))),[],id);
  const currentRows=initialRows.filter(r=>r.lang==='ms'&&lessons.includes(r.lesson));
  assert.equal(currentRows.length,lessons.reduce((n,id)=>n+(['ms-12','ms-24'].includes(id)?40:80),0));
  assert.equal(lessons.length,24);
  {
    assert.equal(currentRows.length,1840);assert.equal(readings.length,46);
    assert.deepEqual(readings.map(r=>r.id),Array.from({length:46},(_,i)=>'ms-r'+String(i+1).padStart(2,'0')));
  }
});
test('任务 M6：相互推导第 21 周开放，拼写、后附顺序和例外受约束',()=>{
  for(const[root,form]of [['kenal','berkenalan'],['salam','bersalaman'],['pandang','berpandangan'],['tolong','tolong-menolong'],['sapa','sapa-menyapa'],['hormat','hormat-menghormati']]){
    assert(!msForms(root,20).has(form),form+' 提前开放');assert(msForms(root,21).has(form),form+' 未推导');
  }
  assert(msForms('menghormati',21).has('hormat-menghormati'));
  assert(msForms('salam',21).has('bersalam-salaman'));
  assert(msForms('tolong',21).has('tolong-menolongnya'));
  for(const bad of ['tolong-mentolong','tolongnya-menolongnya','ber-kenal-an','hormat-menyormati'])
    assert(!msForms(bad.startsWith('hormat')?'hormat':bad.startsWith('ber')?'kenal':'tolong',21).has(bad),bad);
  assert(!msForms('kaji',21).has('kaji-mengkaji'),'不以普通规则开放词汇例外');
  assert(msVocabularyMisses('ms-21',[{text:'Permohonan itu diterima.'}]).length,'后课词和句首大写不能提前放行');
});
test('任务 M6：讲解 HTML 可解析、例句中译相随、五句提纲与自查',()=>{
  for(const id of M6_LESSONS){
    const markup=api.LESSONS[id].explanation(),nodes=msWalk(parseNodes(markup));
    assert(!/<script|\bon\w+=|javascript:/i.test(markup),id);
    assert(nodes.filter(n=>n.tag==='h4').length>=6,id);
    assert(ms3LangSentences(api.LESSONS[id]).length>=3,id);
    assert(nodes.some(n=>n.tag==='ol'&&n.querySelectorAll('li').length===5),id);
    assert(nodes.some(n=>n.tag==='ul'&&n.querySelectorAll('li').length>=4),id);
    assert(markup.includes('名词短语')&&markup.includes('词缀拼写')&&markup.includes('自查'),id);
    for(const p of nodes.filter(n=>n.tag==='p'&&n.getAttribute('lang')==='ms')){
      const parent=nodes.find(n=>n.childNodes.includes(p)),next=parent.childNodes[parent.childNodes.indexOf(p)+1];
      assert(next instanceof ElementModel&&/[\u4e00-\u9fff]/.test(next.textContent),id+' 例句中译');
    }
  }
});
test('任务 M6：语法主题、十三行词缀表、复合句表和阶段自测覆盖',()=>{
  const expected={
    'ms-21':['buku-buku','sayur-sayuran','buah-buahan','berjalan-jalan','duduk-duduk','kanak-kanak','kekanak-kanakan','berkenalan','bersalaman','berpandangan','tolong-menolong','hormat-menghormati','besar-besar','cantik-cantik','连字符'],
    'ms-22':['Kepada','Tuan','Puan','Salam sejahtera','Assalamualaikum','Yang benar','Yang ikhlas','主题行','6 Mac 2027','正式信','非正式信'],
    'ms-23':['pada mulanya','kemudian','selepas itu','lalu','akhirnya','pada masa itu','siapa','apa','bila','di mana','mengapa','体貌','被动','总述','细节','感受'],
    'ms-24':['tidak','bukan','量词','meN-','dari','daripada','被动第二式','150 词','20 分钟','ms-r46','framework/templates/monthly-review.md','读懂比例','本月正确率','下月调整']
  };
  for(const[id,items]of Object.entries(expected))for(const item of items)assert(api.LESSONS[id].explanation().includes(item),id+' '+item);
  const tables=msWalk(parseNodes(api.LESSONS['ms-24'].explanation())).filter(n=>n.tag==='table');
  assert.equal(tables.length,2);assert.equal(tables[0].querySelectorAll('tr').length,14);
  assert.deepEqual(tables[0].querySelectorAll('tr').slice(1).map(n=>n.querySelector('td').textContent),['ber-','meN-','-kan','-i','di-','ter-','peN-','-an','peN-an','per-an','ke-an','se-','重叠']);
  assert.equal(tables[1].querySelectorAll('tr').length,9);
});
test('任务 M6：旧 ms、es、ru 等词卡原行原序保留，cards 与 log 不变',()=>{
  const oldMs=plain(api.parseCSV(M6_OLD_MS_CSV)),oldSet=new Set(M6_OLD_IDS);
  assert.deepEqual(initialRows.filter(r=>oldSet.has(r.id)).map(r=>r.id),M6_OLD_IDS);
  const csvText=fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8');
  const lines=new Map(csvText.trimEnd().split('\n').slice(1).map(line=>[line.split(',')[0],line]));
  for(const line of M6_OLD_MS_CSV.trimEnd().split('\n').slice(1))assert.equal(lines.get(line.split(',')[0]),line);
  assert.deepEqual(initialRows.filter(r=>r.lang==='ms'&&oldSet.has(r.id)),oldMs);
  const rawRows=[...blocks[0][1].matchAll(/\n  \{\n[\s\S]*?\n  \}/g)].map(m=>m[0].slice(1));
  assert.equal(rawRows.length,initialRows.length);
  const byId=new Map(rawRows.map(raw=>[JSON.parse(raw).id,raw]));
  for(const lang of ['es','ru','ms','uz','kk']){
    const csv=lang==='ms'?oldMs:plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards',lang+'.csv'),'utf8')));
    const old=csv.filter(r=>oldSet.has(r.id));
    assert.deepEqual(initialRows.filter(r=>r.lang===lang&&oldSet.has(r.id)),old,lang);
    for(const r of old)assert.equal(byId.get(r.id),JSON.stringify([r],null,2).slice(2,-2),r.id+' 原始行');
  }
  assert.deepEqual({cards:initialState.cards,log:initialState.log},M6_OLD_PROGRESS);
});
test('任务 M6：渲染四课八篇、课内作答和中文开关不改变进度或缓存',()=>{
  const {api:a,document,cache}=createAPI(true,html);a.initialize();
  const before=plain(a.getData().state),rowsBefore=plain(a.getData().rows),dirty=a.getData().dirty,cacheBefore=[...cache.entries()];
  for(const id of M6_LESSONS){
    a.openLesson(id);const page=document.getElementById('content').textContent;
    for(const field of ['name','dates','dailyTime','goal','writingTask'])assert(page.includes(a.LESSONS[id][field]),id+' '+field);
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);
    for(const form of document.querySelectorAll('[data-exercise]')){
      form.elements.answer.value=a.LESSONS[id].exercises[Number(form.dataset.exercise)].answer;
      document.getElementById('app').listeners.submit[0]({target:form,preventDefault(){}});
    }
  }
  a.showReadings();
  assert.deepEqual(document.querySelectorAll('[data-reading]').map(n=>n.dataset.reading).filter(id=>M6_READINGS.includes(id)),M6_READINGS);
  for(const id of M6_READINGS){
    a.openReadingItem(id);assert(document.getElementById('content').textContent.includes(a.READINGS[id].title));
    assert.equal(document.querySelectorAll('[data-question]').length,4);
    const zh=()=>document.querySelectorAll('details').filter(n=>n.querySelector('summary')?.textContent==='查看本句中文');
    assert.equal(zh().length,a.READINGS[id].sentences.length);
    assert(zh().every(n=>n.getAttribute('open')===null));a.toggleReadingZh();assert(zh().every(n=>n.getAttribute('open')!==null));a.toggleReadingZh();
  }
  assert.deepEqual(plain(a.getData().state),before);assert.deepEqual(plain(a.getData().rows),rowsBefore);
  assert.equal(a.getData().dirty,dirty);assert.deepEqual([...cache.entries()],cacheBefore);
});

// 本次整合替换的 id 与新旧词形；不是词汇范围白名单。
const MS_INTEGRATION_REPLACEMENTS={
  "ms-1256": {
    "old": "banjir",
    "new": "tanah runtuh"
  },
  "ms-1260": {
    "old": "bencana",
    "new": "kemarau"
  },
  "ms-1266": {
    "old": "kecemasan",
    "new": "wabak"
  },
  "ms-1280": {
    "old": "sumbangan",
    "new": "tabung"
  },
  "ms-1283": {
    "old": "meneruskan",
    "new": "melanjutkan"
  },
  "ms-1284": {
    "old": "membaiki",
    "new": "menyelenggara"
  },
  "ms-1286": {
    "old": "memindahkan",
    "new": "mengosongkan"
  },
  "ms-1287": {
    "old": "menyelamatkan",
    "new": "menaungi"
  },
  "ms-1290": {
    "old": "memerlukan",
    "new": "menangani"
  },
  "ms-1291": {
    "old": "mengutamakan",
    "new": "mendahulukan"
  },
  "ms-1296": {
    "old": "menyumbang",
    "new": "menderma"
  },
  "ms-1370": {
    "old": "mendaftar",
    "new": "berlepas"
  },
  "ms-1400": {
    "old": "terlalu",
    "new": "kerap"
  },
  "ms-1401": {
    "old": "memberitahu",
    "new": "menyebut"
  },
  "ms-1409": {
    "old": "mencadangkan",
    "new": "mengusulkan"
  },
  "ms-1423": {
    "old": "yakni",
    "new": "tambahan pula"
  },
  "ms-1430": {
    "old": "kenyataan",
    "new": "pernyataan"
  },
  "ms-1434": {
    "old": "sumber",
    "new": "khabar"
  },
  "ms-1444": {
    "old": "perbualan",
    "new": "perbahasan"
  },
  "ms-1457": {
    "old": "menilai",
    "new": "menyelidik"
  },
  "ms-1458": {
    "old": "membandingkan",
    "new": "membuktikan"
  },
  "ms-1467": {
    "old": "berunding",
    "new": "berbincang"
  },
  "ms-1491": {
    "old": "bahkan",
    "new": "sememangnya"
  },
  "ms-1543": {
    "old": "menyunting",
    "new": "menyisipkan"
  },
  "ms-1551": {
    "old": "sopan",
    "new": "santun"
  },
  "ms-1555": {
    "old": "gaya",
    "new": "laras"
  },
  "ms-1607": {
    "old": "membungkus",
    "new": "membalut"
  },
  "ms-1610": {
    "old": "memetik",
    "new": "mencincang"
  },
  "ms-1617": {
    "old": "mengagihkan",
    "new": "menjajakan"
  },
  "ms-1625": {
    "old": "berkongsi",
    "new": "memborong"
  },
  "ms-1629": {
    "old": "manis",
    "new": "tawar"
  },
  "ms-1635": {
    "old": "licin",
    "new": "lembik"
  },
  "ms-1663": {
    "old": "salinan",
    "new": "memo"
  },
  "ms-1668": {
    "old": "pengirim",
    "new": "kurier"
  },
  "ms-1677": {
    "old": "skrin",
    "new": "pengimbas"
  },
  "ms-1678": {
    "old": "dokumen",
    "new": "direktori"
  },
  "ms-1681": {
    "old": "setiausaha",
    "new": "penyelaras"
  },
  "ms-1687": {
    "old": "membalas",
    "new": "mengutarakan"
  },
  "ms-1692": {
    "old": "mencetak",
    "new": "mengimbas"
  },
  "ms-1694": {
    "old": "menyemak",
    "new": "menyelaraskan"
  },
  "ms-1699": {
    "old": "menangguhkan",
    "new": "menjadualkan"
  },
  "ms-1700": {
    "old": "membatalkan",
    "new": "memuktamadkan"
  },
  "ms-1702": {
    "old": "merujuk",
    "new": "menyertakan"
  },
  "ms-1709": {
    "old": "meskipun",
    "new": "sekalipun"
  },
  "ms-1710": {
    "old": "justeru",
    "new": "lantaran itu"
  },
  "ms-1719": {
    "old": "kelewatan",
    "new": "kesulitan"
  },
  "ms-1721": {
    "old": "pada mulanya",
    "new": "pada awalnya"
  },
  "ms-1722": {
    "old": "selepas itu",
    "new": "selanjutnya"
  },
  "ms-1724": {
    "old": "tidak lama kemudian",
    "new": "sejurus kemudian"
  },
  "ms-1731": {
    "old": "sebaik sahaja",
    "new": "tatkala"
  },
  "ms-1733": {
    "old": "banjir",
    "new": "gempa bumi"
  },
  "ms-1735": {
    "old": "kebakaran",
    "new": "letupan"
  },
  "ms-1736": {
    "old": "kemalangan",
    "new": "perlanggaran"
  },
  "ms-1737": {
    "old": "mangsa",
    "new": "penghuni"
  },
  "ms-1738": {
    "old": "saksi",
    "new": "petugas"
  },
  "ms-1743": {
    "old": "kerosakan",
    "new": "kemusnahan"
  },
  "ms-1746": {
    "old": "kenyataan",
    "new": "pengisytiharan"
  },
  "ms-1747": {
    "old": "sumber",
    "new": "agensi"
  },
  "ms-1749": {
    "old": "wawancara",
    "new": "sidang media"
  },
  "ms-1751": {
    "old": "kawasan",
    "new": "daerah"
  },
  "ms-1753": {
    "old": "jurugambar",
    "new": "jurukamera"
  },
  "ms-1755": {
    "old": "bekalan",
    "new": "stok"
  },
  "ms-1766": {
    "old": "merakam",
    "new": "mendokumentasikan"
  },
  "ms-1767": {
    "old": "menerbitkan",
    "new": "mencatatkan"
  },
  "ms-1768": {
    "old": "menyiarkan",
    "new": "menghebahkan"
  },
  "ms-1771": {
    "old": "menafikan",
    "new": "menyangkal"
  },
  "ms-1772": {
    "old": "mengesan",
    "new": "menyiasat"
  },
  "ms-1773": {
    "old": "menyelamatkan",
    "new": "merawat"
  },
  "ms-1774": {
    "old": "memindahkan",
    "new": "mengangkut"
  },
  "ms-1776": {
    "old": "membaiki",
    "new": "membangunkan"
  },
  "ms-1783": {
    "old": "meneruskan",
    "new": "menyambung"
  },
  "ms-1784": {
    "old": "berlaku",
    "new": "terjadi"
  },
  "ms-1785": {
    "old": "beredar",
    "new": "berundur"
  },
  "ms-1788": {
    "old": "cemas",
    "new": "panik"
  },
  "ms-1793": {
    "old": "rosak",
    "new": "musnah"
  },
  "ms-1802": {
    "old": "kemajuan",
    "new": "penguasaan"
  },
  "ms-1806": {
    "old": "kaedah",
    "new": "pendekatan"
  },
  "ms-1813": {
    "old": "rumusan",
    "new": "kesimpulan"
  },
  "ms-1816": {
    "old": "pelajaran",
    "new": "latihan kendiri"
  },
  "ms-1817": {
    "old": "pembelajaran",
    "new": "pengayaan"
  },
  "ms-1818": {
    "old": "pengajaran",
    "new": "bimbingan"
  },
  "ms-1819": {
    "old": "ajaran",
    "new": "panduan"
  },
  "ms-1822": {
    "old": "bacaan",
    "new": "hafalan"
  },
  "ms-1823": {
    "old": "pembacaan",
    "new": "penghafalan"
  },
  "ms-1824": {
    "old": "penulisan",
    "new": "penterjemahan"
  },
  "ms-1825": {
    "old": "penulis",
    "new": "penterjemah"
  }
};


test('任务 M-整合：ms 全部 1840 条 front 不重复，24 课、46 篇阅读线编号连续，M5、M6 词条在 M4 之后按 id 顺序追加',()=>{
  const rows=initialRows.filter(r=>r.lang==='ms');
  assert.equal(rows.length,1840);
  assert.equal(new Set(rows.map(r=>r.front.toLowerCase())).size,1840);
  assert.deepEqual(rows.map(r=>r.id),Array.from({length:1840},(_,i)=>'ms-'+String(i+1).padStart(4,'0')));
  assert.deepEqual(Object.keys(api.LESSONS).filter(id=>id.startsWith('ms-')),Array.from({length:24},(_,i)=>'ms-'+String(i+1).padStart(2,'0')));
  assert.deepEqual(Object.keys(api.READINGS).filter(id=>id.startsWith('ms-r')),Array.from({length:46},(_,i)=>'ms-r'+String(i+1).padStart(2,'0')));
  const start=initialRows.findIndex(r=>r.id==='ms-1240');
  assert.deepEqual(initialRows.slice(start).map(r=>r.id),Array.from({length:601},(_,i)=>'ms-'+String(i+1240).padStart(4,'0')));
  assert.deepEqual(Object.keys(api.LESSONS).slice(-8),[...M5_LESSONS,...M6_LESSONS]);
  assert.deepEqual(Object.keys(api.READINGS).slice(-16),[...M5_READINGS,...M6_READINGS]);
  assert.deepEqual(plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8'))),rows);
  for(const [root,week,form] of [['tulis',14,'penulisannya'],['tulis',20,'penulisannyalah'],['salam',21,'bersalam-salamannyalah'],['tolong',21,'tolong-menolongnyalah']]){
    assert(!msForms(root,week-1).has(form),form+' 提前开放');
    assert(msForms(root,week).has(form),form+' 组合规则未生成');
  }
});
test('任务 M-整合：86 张替换卡的 front 在全部 ms 卡中唯一，例句含 front 且只用该课及之前的词',()=>{
  assert.equal(Object.keys(MS_INTEGRATION_REPLACEMENTS).length,86);
  const rows=initialRows.filter(r=>r.lang==='ms');
  for(const [id,change] of Object.entries(MS_INTEGRATION_REPLACEMENTS)){
    const row=rows.find(r=>r.id===id);assert(row,id);
    assert.equal(row.front,change.new,id);assert.notEqual(change.old,change.new,id);
    assert.equal(rows.filter(r=>r.front.toLowerCase()===row.front.toLowerCase()).length,1,id);
    assert(rows.some(r=>r.id<id&&r.front.toLowerCase()===change.old.toLowerCase()),id+' 旧词仍在前课');
    assert(row.example.toLowerCase().includes(row.front.toLowerCase()),id+' 原形');
    assert(/[.!?]$/.test(row.example)&&/[\u4e00-\u9fff]/.test(row.example_zh),id);
    assert.deepEqual(msVocabularyMisses(row.lesson,[{id,text:row.example}]),[],id);
  }
});
test('任务 M-整合：旧行对照 HEAD，未替换新行对照来源分支，state-data 与旧课程阅读原样保留',()=>{
  const show=(ref,file)=>require('node:child_process').execFileSync('git',['show',ref+':'+file],{cwd:__dirname,encoding:'utf8',maxBuffer:16*1024*1024});
  const script=(text,id)=>text.match(new RegExp('<script[^>]*id="'+id+'"[^>]*>[\\s\\S]*?</script>'))[0];
  const cardText=text=>script(text,'cards-data').replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'');
  const rawById=text=>new Map([...cardText(text).matchAll(/  \{\n[\s\S]*?\n  \}/g)].map(m=>[JSON.parse(m[0]).id,m[0]]));
  const currentRaw=rawById(html),currentById=new Map(initialRows.map(r=>[r.id,r]));
  const csvLines=text=>new Map(text.trimEnd().split('\n').slice(1).map(line=>[line.split(',')[0],line]));
  const currentCsv=csvLines(fs.readFileSync(path.join(__dirname,'cards/ms.csv'),'utf8'));
  const head=show('HEAD','srs/index.html');
  const oldRows=JSON.parse(cardText(head)).filter(r=>r.lang!=='ms'||Number(r.id.slice(3))<=1240);
  const oldIds=new Set(oldRows.map(r=>r.id));
  assert.deepEqual(initialRows.filter(r=>oldIds.has(r.id)),oldRows);
  for(const [id,raw] of rawById(head))if(oldIds.has(id))assert.equal(currentRaw.get(id),raw,id+' HEAD 原始行');
  for(const [id,line] of csvLines(show('HEAD','srs/cards/ms.csv')))if(Number(id.slice(3))<=1240)assert.equal(currentCsv.get(id),line,id+' HEAD CSV 原行');
  assert.equal(script(html,'state-data'),script(head,'state-data'),'state-data 完整字节');
  const runtimeOf=text=>[...text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].at(-1)[1];
  // 去掉追加区段后按原文核对全部旧课程、阅读、辅助函数及页面行为。
  const oldRuntime=text=>runtimeOf(text)
    .replace(/,\n  "ms-17":[\s\S]*?(?=\n};\nfunction spanishExplanation\(\))/,'')
    .replace(/,\n  "ms-r31":[\s\S]*?(?=\n};\nconst readingList)/,'');
  assert.equal(oldRuntime(html),oldRuntime(head),'旧课程、阅读与页面行为源码');
  const sourceSection=(text,first,next,end)=>{
    const start=text.indexOf('  "'+first+'":');assert(start>=0,first);
    const stop=next?text.indexOf(',\n  "'+next+'":',start):text.indexOf(end,start);
    assert(stop>start,first+' 区段末尾');return text.slice(start,stop);
  };
  for(const [ref,lo,hi] of [['ms-m5',1241,1560],['ms-m6',1561,1840]]){
    const branch=show(ref,'srs/index.html'),sourceRaw=rawById(branch);
    const sourceRows=JSON.parse(cardText(branch)).filter(r=>r.lang==='ms'&&Number(r.id.slice(3))>=lo&&Number(r.id.slice(3))<=hi);
    const sourceCsv=csvLines(show(ref,'srs/cards/ms.csv'));
    for(const old of sourceRows){
      const row=currentById.get(old.id);
      if(MS_INTEGRATION_REPLACEMENTS[old.id]){
        assert.equal(old.front,MS_INTEGRATION_REPLACEMENTS[old.id].old);
        for(const key of ['id','lang','lesson','tags'])assert.equal(row[key],old[key],old.id+' '+key);
      }else{
        assert.deepEqual(row,old,old.id+' 来源字段');assert.equal(currentRaw.get(old.id),sourceRaw.get(old.id),old.id+' 来源原始行');
        assert.equal(currentCsv.get(old.id),sourceCsv.get(old.id),old.id+' 来源 CSV 原行');
      }
    }
    const m5=ref==='ms-m5';
    const lessonEnd='\n};\nfunction spanishExplanation()',readingEnd='\n};\nconst readingList';
    assert.equal(sourceSection(html,m5?'ms-17':'ms-21',m5?'ms-21':null,lessonEnd),sourceSection(branch,m5?'ms-17':'ms-21',null,lessonEnd),ref+' 课程原文');
    assert.equal(sourceSection(html,m5?'ms-r31':'ms-r39',m5?'ms-r39':null,readingEnd),sourceSection(branch,m5?'ms-r31':'ms-r39',null,readingEnd),ref+' 阅读原文');
  }
});
