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
const initialState = JSON.parse(blocks[1][1]);
const plain = value => JSON.parse(JSON.stringify(value));
const source = runtime.slice(0,runtime.indexOf('// 启动。')) + runtime.slice(runtime.indexOf('function initialize()'),runtime.indexOf('try { initialize(); }')) + `
globalThis.api = {localDay,addDays,validateRows,validateState,parseCSV,mergeRows,pruneLog,
schedule,expandCards,buildQueue,spellingResult,clozeExample,mergeProgress,statistics,
safeJSON,serializeDocument,snapshotDocument,saveFile,initialize,LESSONS,reveal,gradeCard,recognitionOnly,
renderLessons,bindEvents,READINGS,renderReadings,validateReadings,
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
  return {version:1,updatedAt:'2026-09-14T00:00:00.000Z',settings:{newPerDay:{es:15,ru:10}},cards:{},log:[]};
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
const R1_LESSONS=['ru-13','ru-14','ru-15','ru-16'];
const r1Rows=initialRows.filter(row=>R1_LESSONS.includes(row.lesson));
const r1Expanded=r1Rows.reduce((total,row)=>total+(row.tags.split(';').includes('phrase')?1:2),0);
// 原有 2895 张卡保持固定基数；新卡按标签计算预期方向，另有逐卡检查。
const s1Expanded=s1Rows.reduce((total,row)=>total+(row.tags.split(';').includes('phrase')?1:2),0);
function record(day='2026-09-14',grade=4) { return api.schedule(null,grade,day); }

test('来源 CSV 与两个内嵌 JSON 完整一致；只有一个可执行脚本且无外部资源',() => {
  const rows = ['es','ru'].flatMap(lang => plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards',lang+'.csv'),'utf8'))));
  // 内嵌数据按追加顺序保留旧行；来源 CSV 各自按语言排列。
  for (const lang of ['es','ru']) assert.deepEqual(rows.filter(row=>row.lang===lang),initialRows.filter(row=>row.lang===lang));
  assert.equal(rows.length,2048);
  assert.equal(api.expandCards(rows).length,2895+s1Expanded+r1Expanded);
  assert.equal(rows.filter(r=>r.lang==='es').length,1313);
  assert.equal(rows.filter(r=>r.tags.split(';').includes('letter')).length,33);
  assert.equal(rows.filter(r=>r.lang==='ru'&&!r.tags.split(';').includes('letter')).length,702);
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
  assert.equal(initialRows.filter(r=>r.tags.includes('letter')).map(r=>r.front.split(' ')[0]).join(''),'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ');
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
  assert.deepEqual([queue.due.length,queue.newCards.length],[0,25]);
  assert(queue.newCards.every(c=>c.direction==='r'));
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
  for(const row of initialRows.filter(r=>!S1_LESSONS.includes(r.lesson) && !R1_LESSONS.includes(r.lesson) && !api.recognitionOnly(r))) assert(!api.clozeExample(row).includes('此例句没有'),row.id+' '+row.front);
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
  assert.deepEqual([stats.total,stats.new,stats.learning,stats.mastered,stats.reviews,stats.accuracy],[1941+s1Expanded,1940+s1Expanded,1,0,2,'50%']);
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
  assert.deepEqual(Object.keys(api.LESSONS),['es-01','es-02','es-03','es-04','es-05','es-06','es-07','es-08','es-09','es-10','es-11','es-12','es-13','es-14','es-15','es-16','ru-01','ru-02','ru-03','ru-04','ru-05','ru-06','ru-07','ru-08','ru-09','ru-10','ru-11','ru-12','ru-13','ru-14','ru-15','ru-16']);
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
      assert.equal(lesson.reading.questions.length,['es-04','es-05','es-07','es-08','es-09','es-10','es-11','es-12','es-13','es-14','es-15','es-16','ru-05','ru-08','ru-09','ru-10','ru-11','ru-12','ru-13','ru-14','ru-15','ru-16'].includes(id)?4:3);
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
const esVocabulary=lesson => {
  const week=Number(lesson.slice(3)),set=new Set(ES_EXTRA);
  for (const row of initialRows.filter(row=>row.lang==='es' && row.lesson<=lesson)) {
    for (const word of esWords(row.front)) set.add(word);
    // 旧课保留既有词汇范围；新课例句独立核验，不能用例句自身扩大词表。
    if (row.lesson<'es-13') for (const word of esWords(row.example)) set.add(word);
    // 只读取明确用斜线列出的词形；不把 note 的散文说明当作允许词表。
    if (row.lesson<'es-13') {
      for (const part of row.note.split(/[；;：:]/)) if (part.includes(' / ')) for (const word of esWords(part)) set.add(word);
    } else for (const forms of esListedForms(row)) for (const form of forms) for (const word of esWords(form)) set.add(word);
    if (row.tags.split(';').includes('名词')) {
      for (const word of esWords(row.front).slice(1)) set.add(esAttach(word.replace(/z$/,'c'),/[aeiouáéíóú]$/.test(word)?'s':'es'));
      const feminine=row.note.match(/女性(?:为|是) (?:la|una) ([\p{L}\p{M}]+)/u)?.[1];
      if (feminine) set.add(feminine);
    }
    if (row.lesson>='es-13' && row.tags.split(';').includes('分词')) {
      const infinitive=row.note.match(/(?:对应不定式|不定式)[：: ]+([\p{L}\p{M}]+)/u)?.[1];
      if (infinitive) set.add(infinitive.toLowerCase());
    }
    if (!row.tags.split(';').some(tag=>['动词','不定式'].includes(tag))) continue;
    const taughtInfinitive=row.lesson>='es-13'?row.note.match(/^([\p{L}\p{M}]+) 的(?:现在完成时|简单将来时|条件式|肯定命令式)/u)?.[1]:null;
    const infinitive=(taughtInfinitive || row.front).toLowerCase().replace(/se$/,''),verb=infinitive.match(/^([\p{L}\p{M}]*?)(ar|er|[ií]r)$/u);
    if (!verb) continue;
    const [,stem,endingKind]=verb,kind=endingKind.replace('í','i');
    set.add(infinitive);
    for (const ending of ES_ENDINGS[kind]) set.add(stem+ending);
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
const esVariants=word=>[word,word.replace(/es$/,''),word.replace(/s$/,''),word.replace(/as$/,'os'),word.replace(/a$/,'o'),word.replace(/os$/,'o')];
const esKnown=(lesson,word)=>esVariants(word).some(form=>esVocabulary(lesson).has(form));
const checkSentenceVocabulary=(lesson,sentences,label) => {
  const set=esVocabulary(lesson);
  for (const sentence of sentences) {
    for (const word of esWords(sentence.text)) {
      assert(esVariants(word).some(form=>set.has(form)),label+' 阅读超出词表：'+word+'（'+sentence.text+'）');
    }
  }
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
  assert.deepEqual(csv.map(row=>row.id),Array.from({length:1313},(_,i)=>'es-'+String(i+1).padStart(4,'0')));
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
// 俄语阅读的词汇范围：本课及以前词卡的 front 和 note 里列出的形式；旧课保留例句依据。
// R1 新例句不作为自身的放行来源，避免未学词通过例句进入词汇范围。
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
    if (/(ый|ий|ой)$/.test(word)) for (const end of ['ая','ое','ые','яя','ее','ие','ую','о']) out.push(word.slice(0,-2)+end);
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
const ruVocabulary=lesson => {
  const set=new Set();
  for (const row of initialRows.filter(row=>row.lang==='ru' && row.lesson<=lesson && !row.tags.split(';').includes('letter'))) {
    for (const word of [...ruWords(row.front),...ruWords(row.note),...(row.lesson<'ru-13'?ruWords(row.example):[])]) set.add(word);
    const tags=row.tags.split(';');
    for (const word of ruWords(row.front))
      for (const form of [...ruForms(word,tags),...ruConstructionForms(word,row,lesson)]) set.add(form);
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
    for (const word of row.front.match(/[А-Яа-яЁё́]+/g) || []) {
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
test('各课程分语言展示；阅读中文默认折叠；320 道练习按题型反馈且不写入进度',() => {
  const {api:a,document}=createAPI(true);a.initialize();
  const before=plain(a.getData().state);
  for (const [id,lesson] of Object.entries(a.LESSONS)) {
    a.openLesson(id);
    assert.equal(document.querySelectorAll('[data-lesson]').length,32);
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
  assert.equal(initialRows.filter(row=>row.tags.split(';').includes('phrase')).length,130+r1Rows.filter(row=>row.tags.split(';').includes('phrase')).length);
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

// 任务 F1：阅读理解线。词汇范围沿用上面的推导式检查，对全部 30 篇执行。
const READING_BANDS={2:[80,100],3:[100,130],4:[130,160],5:[150,180],6:[170,200],7:[200,230],8:[220,260],9:[240,280],10:[260,300],11:[280,320],12:[300,350],13:[300,350],14:[300,350],15:[300,350],16:[300,350]};
const READING_GENRES=['对话','日记','邮件','短故事','描写','通知或广告','菜谱或日程','人物介绍','简单新闻'];
test('任务 F1：READINGS 结构完整、篇幅在区间内、答案在选项里、重点词是已学词',() => {
  const esReadings=Object.entries(api.READINGS).filter(([,item])=>item.lang==='es');
  assert.deepEqual(esReadings.map(([id])=>id),Array.from({length:30},(_,i)=>'es-r'+String(i+1).padStart(2,'0')));
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
  // 每周两篇，从第 2 周到第 16 周。
  for (let week=2;week<=16;week++) assert.equal(Object.values(api.READINGS).filter(item=>item.lang==='es' && item.week===week).length,2,'第 '+week+' 周篇数');
});
test('任务 F1 / S1：30 篇阅读只用 afterLesson 及之前的词卡与其规则变化形式',() => {
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
  assert.equal(list.length,54);
  assert.deepEqual(list.map(node=>node.dataset.reading),Object.keys(a.READINGS));
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
  assert.equal(document.querySelectorAll('[data-reading]').length,54,'返回按钮回到阅读列表');
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
  assert.deepEqual(rows,[['es · 西语','1 / 30','4.0 / 4'],['ru · 俄语','0 / 24','—']]);
  const expected={es:['每天 30 分钟 + 每周 3 次系统块 40 分钟','每天 25 分钟 + 每周 30 分钟语法与写作'],ru:['每天 10 分钟','每天 30 分钟 + 周末系统块 60 分钟']};
  for (const [id,lesson] of Object.entries(a.LESSONS)) {
    const want=expected[lesson.lang][lesson.week>=5?1:0];
    assert.equal(lesson.dailyTime,want,id+' dailyTime');
    a.openLesson(id);
    assert(document.querySelector('.kicker').textContent.includes(want),id+' 标题行时长');
  }
});

// 任务 F2：俄语阅读篇目。词汇范围沿用上面俄语课文用的同一套推导式检查，对全部 24 篇执行。
const RU_READING_SENTENCES={5:[6,8],6:[8,10],7:[8,10],8:[10,12],9:[10,12],10:[12,14],11:[12,14],12:[14,16]};
const RU_READING_GENRES=['对话','日记','短信或便条','人物介绍','房间或城市描写','一天的安排','通知'];
test('任务 F2：俄语篇目接在西语之后按 id 顺序追加，西语篇目不动',() => {
  assert.deepEqual(Object.keys(api.READINGS),[
    ...Array.from({length:30},(_,i)=>'es-r'+String(i+1).padStart(2,'0')),
    ...Array.from({length:24},(_,i)=>'ru-r'+String(i+1).padStart(2,'0'))
  ]);
  assert.equal(Object.values(api.READINGS).filter(item=>item.lang==='ru').length,24);
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
      for (const word of sentence.text.match(/[А-Яа-яЁё́]+/g) || []) {
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
test('任务 F2 / R1：24 篇俄语阅读只用 afterLesson 及之前的词卡与其规则变化形式',() => {
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
  assert.equal(list.filter(id=>id.startsWith('es-r')).length,30);
  assert.deepEqual(list.slice(30),Object.values(a.READINGS).filter(item=>item.lang==='ru').map(item=>item.id));
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
    for (const word of forms.match(/[А-Яа-яЁё́]+/g) || []) {
      if ((word.match(/[аеёиоуыэюя]/gi)||[]).length>1) assert(/[́ёЁ]/.test(word),row.id+' note 多音节形式要标重音：'+word);
      for (let i=0;i<word.length;i++) if (word[i]==='́') assert(/[аеёиоуыэюя]/i.test(word[i-1]),row.id+' note 重音记号要跟在元音后：'+word);
    }
  }
});

// 任务 R1：建设期四课和八篇俄语阅读。沿用同一词形推导器检查卡片例句与两条阅读线。
const R1_STANDARD_STRESS={
  друзей:'друзе́й',братьев:'бра́тьев',детей:'дете́й',много:'мно́го',мало:'ма́ло',
  сколько:'ско́лько',несколько:'не́сколько',после:'по́сле',около:'о́коло',кроме:'кро́ме',
  первое:'пе́рвое',второе:'второ́е',третье:'тре́тье',четвёртое:'четвё́ртое',пятое:'пя́тое',
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
    // -ия 等是抽象词尾，不能指定统一重音；по-кита́йски 等完整词仍要检查。
    const ending=text[match.index-1]==='-' && !/[А-Яа-яЁё\u0301]/.test(text[match.index-2] || '');
    const vowelCount=(word.match(/[аеёиоуыэюя]/gi)||[]).length;
    // ё 本身就是重读元音，按一个重音计；ё 上不再加 U+0301。
    const accents=(word.match(/\u0301/g)||[]).length + (/[ёЁ]/.test(word) ? 1 : 0);
    if (vowelCount>1 && !ending) assert.equal(accents,1,label+' 多音节词须有一个 U+0301：'+word);
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
  assert.deepEqual(csv.map(row=>row.id),Array.from({length:735},(_,i)=>'ru-'+String(i+1).padStart(4,'0')));
  const previous=initialRows.findIndex(row=>row.id==='es-1313');assert(previous>=0);
  assert.deepEqual(initialRows.slice(previous+1).map(row=>row.id),ids,'新词仅接在已有 cards-data 末尾');
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
      assert(pair && (ruWords(pair).length>=2 || /(?:没有|无)(?:常用)?(?:对应)?完成体/.test(row.note)),row.id+' 体的配对或无常用完成体的说明');
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
