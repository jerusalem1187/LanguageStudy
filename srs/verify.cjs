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
  assert.deepEqual(rows,initialRows);
  assert.equal(api.expandCards(rows).length,467);
  assert.equal(rows.filter(r=>r.lang==='es').length,113);
  assert.equal(rows.filter(r=>r.tags.split(';').includes('letter')).length,33);
  assert.equal(rows.filter(r=>r.lang==='ru'&&!r.tags.split(';').includes('letter')).length,108);
  assert.match(html,/<div id="app"><\/div>/);
  assert.doesNotMatch(html,/<(?:script|link|img)[^>]+(?:src|href)=/i);
  assert.doesNotMatch(runtime,/\b(?:fetch|XMLHttpRequest|WebSocket|importScripts)\s*\(/);
  assert.equal(api.LESSONS['es-01'].exercises.length,10);
  assert.equal(api.LESSONS['ru-01'].exercises.length,10);
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
  assert.deepEqual([stats.total,stats.new,stats.learning,stats.mastered,stats.reviews,stats.accuracy],[226,225,1,0,2,'50%']);
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
  assert.deepEqual(Object.keys(api.LESSONS),['es-01','ru-01','ru-02','ru-03','ru-04']);
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
      assert([5,6].includes(lesson.reading.sentences.length));assert.equal(lesson.reading.questions.length,3);
      for (const sentence of lesson.reading.sentences) assert(sentence.text && sentence.zh);
      assert.deepEqual(lesson.exercises.slice(-3),lesson.reading.questions);
    } else assert.equal(lesson.reading,null);
  }
  assert.deepEqual(['ru-02','ru-03','ru-04'].map(id=>initialRows.filter(row=>row.lesson===id).length),[14,36,40]);
  const vocabulary=new Set(initialRows.filter(row=>['ru-01','ru-02','ru-03'].includes(row.lesson)).map(row=>row.front.toLowerCase().replace(/\u0301/g,'')));
  for (const sentence of api.LESSONS['ru-03'].reading.sentences) {
    for (const word of sentence.text.toLowerCase().replace(/\u0301/g,'').match(/[а-яё]+/g)) assert(vocabulary.has(word),word);
  }
});
test('各课程分语言展示；阅读中文默认折叠；50 道练习可判对错且不写入进度',() => {
  const {api:a,document}=createAPI(true);a.initialize();
  const before=plain(a.getData().state);
  for (const [id,lesson] of Object.entries(a.LESSONS)) {
    a.openLesson(id);
    assert.equal(document.querySelectorAll('[data-lesson]').length,5);
    const page=document.getElementById('content').innerHTML;
    assert(page.indexOf('西语课程')<page.indexOf('俄语课程'));
    assert(page.includes(lesson.goal));assert(page.includes(lesson.writingTask));
    assert.equal(document.querySelectorAll('[data-exercise]').length,10);
    if (lesson.reading) {
      const translations=document.querySelectorAll('details').filter(node=>node.querySelector('summary')?.textContent==='查看本句中文');
      assert.equal(translations.length,lesson.reading.sentences.length);
      for (const node of translations) assert.equal(node.getAttribute('open'),null);
    }
    for (const form of document.querySelectorAll('[data-exercise]')) {
      const exercise=lesson.exercises[Number(form.dataset.exercise)];
      const submit=()=>document.getElementById('app').listeners.submit[0]({target:form,preventDefault(){}});
      form.elements.answer.value='不正确的答案';submit();
      assert.match(form.querySelector('.exercise-result').innerHTML,/拼写不一致/);
      form.elements.answer.value=exercise.answer;submit();
      assert.match(form.querySelector('.exercise-result').innerHTML,/完全一致/);
    }
  }
  assert.deepEqual(plain(a.getData().state),before);assert.equal(a.getData().dirty,false);
});
test('letter / phrase 标签只生成识别卡；其他词条仍有两个方向',() => {
  for (const row of initialRows) {
    const expected=row.tags.split(';').some(tag=>['letter','phrase'].includes(tag))?['r']:['r','p'];
    assert.deepEqual(plain(api.expandCards([row]).map(card=>card.direction)),expected,row.id);
  }
  assert.equal(initialRows.filter(row=>row.tags.split(';').includes('phrase')).length,8);
  // 标签规则也适用于以后导入的西语词，不靠课次或语言写死。
  for (const tag of ['phrase','letter']) assert.deepEqual(plain(api.expandCards([{...initialRows[0],tags:'extra;'+tag}]).map(card=>card.direction)),['r']);
});
test('新俄语 id 连续；多音节词标 U+0301；名词标性，动词标变位，假朋友有说明',() => {
  const added=initialRows.filter(row=>['ru-02','ru-03','ru-04'].includes(row.lesson));
  assert.deepEqual(added.map(row=>row.id),Array.from({length:90},(_,i)=>'ru-'+String(52+i).padStart(4,'0')));
  for (const row of added) {
    assert.doesNotMatch(row.front,/[A-Za-z\u0341\u00b4]/,row.id);
    const words=row.front.match(/[А-Яа-яЁё\u0301]+/g) || [];
    for (const word of words) {
      if ((word.match(/[аеёиоуыэюя]/gi)||[]).length>1) assert(/[\u0301ёЁ]/.test(word),row.id+' '+word);
      for (let i=0;i<word.length;i++) if (word[i]==='\u0301') assert(/[аеёиоуыэюя]/i.test(word[i-1]),row.id);
    }
    if (row.tags.split(';').includes('名词')) assert.match(row.note,/名词（[阳阴中]）/,row.id);
    if (row.tags.split(';').includes('不定式')) assert.match(row.note,/[一二]变位/,row.id);
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
  test('state-data 内容与 /tmp 开工留底逐字节一致',() => {
    const bytes=fs.readFileSync(path.join(__dirname,'index.html'));
    const opening=Buffer.from('<script type="application/json" id="state-data">');
    const start=bytes.indexOf(opening)+opening.length;
    assert(start>=opening.length);
    const end=bytes.indexOf(Buffer.from('</script>'),start);assert(end>start);
    assert.deepEqual(bytes.subarray(start,end),fs.readFileSync(process.argv[backupFlag+1]));
  });
}
