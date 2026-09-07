'use strict';
// 离线定向验证：node srs/verify.cjs。只使用 Node 内置模块。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
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
renderLessons,bindEvents,
openLesson(id){lesson=id;tab='lessons';render();},
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
function record(day='2026-09-14',grade=4) { return api.schedule(null,grade,day); }

test('来源 CSV 与两个内嵌 JSON 完整一致；只有一个可执行脚本且无外部资源',() => {
  const rows = ['es','ru'].flatMap(lang => plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards',lang+'.csv'),'utf8'))));
  // 内嵌数据按追加顺序保留旧行；来源 CSV 各自按语言排列。
  for (const lang of ['es','ru']) assert.deepEqual(rows.filter(row=>row.lang===lang),initialRows.filter(row=>row.lang===lang));
  assert.equal(rows.length,1515);
  assert.equal(api.expandCards(rows).length,2895);
  assert.equal(rows.filter(r=>r.lang==='es').length,993);
  assert.equal(rows.filter(r=>r.tags.split(';').includes('letter')).length,33);
  assert.equal(rows.filter(r=>r.lang==='ru'&&!r.tags.split(';').includes('letter')).length,489);
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
test('全部拼写卡例句可挖空；边界不会误遮单词内部，俄语重音不泄露答案',() => {
  for(const row of initialRows.filter(r=>!api.recognitionOnly(r))) assert(!api.clozeExample(row).includes('此例句没有'),row.id+' '+row.front);
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
  assert.deepEqual([stats.total,stats.new,stats.learning,stats.mastered,stats.reviews,stats.accuracy],[1941,1940,1,0,2,'50%']);
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
  assert.deepEqual(Object.keys(api.LESSONS),['es-01','es-02','es-03','es-04','es-05','es-06','es-07','es-08','es-09','es-10','es-11','es-12','ru-01','ru-02','ru-03','ru-04','ru-05','ru-06','ru-07','ru-08','ru-09','ru-10','ru-11','ru-12']);
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
      assert.equal(lesson.reading.questions.length,['es-04','es-05','es-07','es-08','es-09','es-10','es-11','es-12','ru-05','ru-08','ru-09','ru-10','ru-11','ru-12'].includes(id)?4:3);
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
    'es-06':{dates:'10-19 至 10-25',cards:90,sentences:18,min:170,max:220,questions:3,text:6,book:6},
    'es-07':{dates:'10-26 至 11-01',cards:90,sentences:20,min:170,max:220,questions:4,text:5,book:7},
    'es-08':{dates:'11-02 至 11-08',cards:90,sentences:24,min:220,max:280,questions:4,text:5,book:8}
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
const esVocabulary=lesson => {
  const set=new Set(ES_EXTRA);
  for (const row of initialRows.filter(row=>row.lang==='es' && row.lesson<=lesson)) {
    for (const word of [...esWords(row.front),...esWords(row.example)]) set.add(word);
    // note 里用 " / " 列出的变位形式就是本课教到的词形。
    for (const part of row.note.split(/[；;：:]/)) if (part.includes(' / ')) for (const word of esWords(part)) set.add(word);
    const verb=row.front.toLowerCase().match(/^([\p{L}\p{M}]+?)(ar|er|ir)(se)?$/u);
    if (!verb) continue;
    const [,stem,kind]=verb;
    for (const ending of ES_ENDINGS[kind]) set.add(stem+ending);
    if (kind === 'ar') {
      if (stem.endsWith('c')) set.add(stem.slice(0,-1)+'qué');
      if (stem.endsWith('g')) set.add(stem+'ué');
      if (stem.endsWith('z')) set.add(stem.slice(0,-1)+'cé');
    }
  }
  return set;
};
const esVariants=word=>[word,word.replace(/es$/,''),word.replace(/s$/,''),word.replace(/as$/,'os'),word.replace(/a$/,'o'),word.replace(/os$/,'o')];
const esKnown=(lesson,word)=>esVariants(word).some(form=>esVocabulary(lesson).has(form));
const checkReadingVocabulary=ids => {
  for (const id of ids) {
    const set=esVocabulary(id);
    for (const sentence of api.LESSONS[id].reading.sentences) {
      for (const word of esWords(sentence.text)) {
        assert(esVariants(word).some(form=>set.has(form)),id+' 阅读超出词表：'+word+'（'+sentence.text+'）');
      }
    }
  }
};
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
    'es-09':{dates:'11-09 至 11-15',cards:80,sentences:26,min:220,max:260,questions:4,text:6,book:9},
    'es-10':{dates:'11-16 至 11-22',cards:80,sentences:28,min:250,max:300,questions:4,text:1,book:10},
    'es-11':{dates:'11-23 至 11-29',cards:80,sentences:28,min:260,max:300,questions:4,text:5,book:11},
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
  for (const text of ['月度检查点 3','framework/metrics-and-review.md','决定矩阵','本课短文','维持模式','建设期']) assert(review.includes(text),'es-12 讲解缺少：'+text);
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
// 俄语阅读的词汇范围：本课及以前词卡的 front、例句和 note 里列出的形式，
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
const ruVocabulary=lesson => {
  const set=new Set();
  for (const row of initialRows.filter(row=>row.lang==='ru' && row.lesson<=lesson && !row.tags.split(';').includes('letter'))) {
    for (const word of [...ruWords(row.front),...ruWords(row.example),...ruWords(row.note)]) set.add(word);
    const tags=row.tags.split(';');
    for (const word of ruWords(row.front)) for (const form of ruForms(word,tags)) set.add(form);
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
  assert.deepEqual(initialRows.slice(1335).map(row=>row.id),Array.from({length:180},(_,i)=>'ru-'+String(343+i).padStart(4,'0')));
});
test('任务 C 只追加 cards-data 与 ru.csv；已有记录顺序不变',() => {
  assert.deepEqual(initialRows.slice(254,494).map(row=>row.id),Array.from({length:240},(_,i)=>'es-'+String(114+i).padStart(4,'0')));
  assert.deepEqual(initialRows.slice(494,695).map(row=>row.id),Array.from({length:201},(_,i)=>'ru-'+String(142+i).padStart(4,'0')));
  // 任务 D 的西语第 5–8 周整段接在 ru 行之后，同样只追加。
  assert.deepEqual(initialRows.slice(695,1055).map(row=>row.id),Array.from({length:360},(_,i)=>'es-'+String(354+i).padStart(4,'0')));
  // 任务 E1 的西语第 9–12 周同样只追加在最后。
  assert.deepEqual(initialRows.slice(1055,1335).map(row=>row.id),Array.from({length:280},(_,i)=>'es-'+String(714+i).padStart(4,'0')));
});
test('各课程分语言展示；阅读中文默认折叠；240 道练习按题型反馈且不写入进度',() => {
  const {api:a,document}=createAPI(true);a.initialize();
  const before=plain(a.getData().state);
  for (const [id,lesson] of Object.entries(a.LESSONS)) {
    a.openLesson(id);
    assert.equal(document.querySelectorAll('[data-lesson]').length,24);
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
  assert.equal(initialRows.filter(row=>row.tags.split(';').includes('phrase')).length,102);
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
