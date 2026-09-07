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
safeJSON,serializeDocument,saveFile,initialize,LESSONS,reveal,gradeCard,
setData(r,s){rows=r;state=s;dirty=true;revision=1;session=null;},
setHandle(h){fileHandle=h;handleReady=true;},
getData(){return {rows,state,dirty,source,lastSaved,notice,session};},
change(){state.settings.newPerDay.es++;touch();},
setHandleStore(fn){handleStore=fn;},
openReview(lang='all'){language=lang;ensureSession();},
revealForTest(){revealed=true;},
setSession(s){session=s;language=s.lang;revealed=true;},
};
})();`;

// 最小文档模型：测试序列化的数据边界，不替代浏览器 DOM 验证。
class DocumentModel {
  constructor(text=html) { this.text = text; this.hidden=false; }
  cloneNode() { return new DocumentModel(this.text); }
  get documentElement() { return {outerHTML:this.text.replace(/^<!DOCTYPE html>\s*/i,'')}; }
  getElementById(id) {
    const doc = this;
    if (!['cards-data','state-data','app'].includes(id)) return {innerHTML:'',textContent:'',focus(){}};
    const pattern = id==='app' ? /(<div id="app">)[\s\S]*?(<\/div>)/ : new RegExp('(<script type="application/json" id="'+id+'">)[\\s\\S]*?(</script>)');
    return {
      get textContent(){ return doc.text.match(pattern)?.[0].replace(/^<[^>]+>|<\/script>$/g,'') || ''; },
      set textContent(value){ doc.text=doc.text.replace(pattern,(_,a,b)=>a+value+b); },
      replaceChildren(){ doc.text=doc.text.replace(pattern,(_,a,b)=>a+b); },
      append(){}, addEventListener(){},
    };
  }
  querySelector(selector) {
    const doc=this, name = selector.match(/name="([^"]+)"/)[1];
    const pattern = new RegExp('(<meta name="'+name+'" content=")[^"]*(">)');
    return {get content(){return doc.text.match(pattern)?.[0].match(/content="([^"]*)"/)[1] || '';},set content(value){doc.text=doc.text.replace(pattern,(_,a,b)=>a+value+b);}};
  }
  addEventListener() {}
}
function createAPI(bootstrap=false) {
  const cache = new Map();
  const document = new DocumentModel();
  const context = vm.createContext({document,location:{pathname:'/srs/index.html'},window:{addEventListener(){}},localStorage:{setItem:(k,v)=>cache.set(k,v),getItem:k=>cache.get(k)||null},navigator:{},URL,Blob,FileReader:undefined,setTimeout:() => 0,clearTimeout,console});
  vm.runInContext(source,context);
  if (!bootstrap) context.api.setData(context.api.validateRows(plain(initialRows)),context.api.validateState(plain(initialState)));
  return {api:context.api,context,cache,document};
}
const {api} = createAPI();
function emptyState() { return api.validateState(plain(initialState),new Date('2026-09-14T12:00:00Z')); }
function record(day='2026-09-14',grade=4) { return api.schedule(null,grade,day); }

test('来源 CSV 与两个内嵌 JSON 完整一致；只有一个可执行脚本且无外部资源',() => {
  const rows = ['es','ru'].flatMap(lang => plain(api.parseCSV(fs.readFileSync(path.join(__dirname,'cards',lang+'.csv'),'utf8'))));
  assert.deepEqual(rows,initialRows);
  assert.equal(api.expandCards(rows).length,295);
  assert.equal(rows.filter(r=>r.lang==='es').length,113);
  assert.equal(rows.filter(r=>r.tags.split(';').includes('letter')).length,33);
  assert.equal(rows.filter(r=>r.lang==='ru'&&!r.tags.split(';').includes('letter')).length,18);
  assert.match(html,/<div id="app"><\/div>/);
  assert.doesNotMatch(html,/<(?:script|link|img)[^>]+(?:src|href)=/i);
  assert.doesNotMatch(runtime,/\b(?:fetch|XMLHttpRequest|WebSocket|importScripts)\s*\(/);
  assert.equal(api.LESSONS['es-01'].exercises.length,10);
  assert.equal(api.LESSONS['ru-01'].exercises.length,10);
});
test('字母集合、国际词重音位置与西语全部人称',() => {
  assert.equal(initialRows.filter(r=>r.tags.includes('letter')).map(r=>r.front.split(' ')[0]).join(''),'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ');
  const stressed = ['телефо́н','университе́т','студе́нт','пробле́ма','интерне́т','компью́тер','му́зыка','теа́тр','спо́рт','ко́фе','па́рк','ба́нк','рестора́н','такси́','метро́','ра́дио','музе́й','оте́ль'];
  assert.deepEqual(initialRows.filter(r=>r.tags.includes('国际词')).map(r=>r.front),stressed);
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
test('全部词条例句可挖空；边界不会误遮单词内部，俄语重音不泄露答案',() => {
  for(const row of initialRows.filter(r=>!r.tags.includes('letter'))) assert(!api.clozeExample(row).includes('此例句没有'),row.id+' '+row.front);
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
  const handle={queryPermission:async()=>{calls.push('query');return 'prompt';},requestPermission:async()=>{calls.push('permission');return 'granted';},createWritable:async()=>({write:async text=>{calls.push('write');output=text;},close:async()=>calls.push('close')})};
  context.window.showSaveFilePicker=async options=>{calls.push('picker');assert.equal(options.suggestedName,'index.html');return handle;};
  a.setHandleStore(async(mode,value)=>{calls.push(mode);assert.equal(value,handle);});
  await a.saveFile();assert.deepEqual(calls,['picker','write','close','put']);
  assert.equal(a.getData().dirty,false);assert(cache.size);assert.match(output,/<div id="app"><\/div>/);
  calls.length=0;await a.saveFile();assert.deepEqual(calls,['query','permission','write','close']);
  assert.deepEqual(JSON.parse(cache.values().next().value).state,plain(a.getData().state));
});
test('写入失败不清除 dirty；并发评分在保存快照之后仍标记未保存',async () => {
  const {api:a,context}=createAPI();context.window.showSaveFilePicker=async()=>{};
  let aborted=false;
  a.setHandle({queryPermission:async()=> 'granted',createWritable:async()=>({write:async()=>{throw new Error('disk full');},abort:async()=>{aborted=true;}})});
  await a.saveFile();assert.equal(a.getData().dirty,true);assert(aborted);assert.match(a.getData().notice,/disk full/);
  a.setHandle({queryPermission:async()=> 'granted',createWritable:async()=>({write:async()=>a.change(),close:async()=>{}})});
  await a.saveFile();assert.equal(a.getData().dirty,true);assert.match(a.getData().notice,/新进度/);
});
test('取消 picker 与拒绝权限均保留进度，不降级为静默下载',async () => {
  const {api:a,context}=createAPI();
  context.window.showSaveFilePicker=async()=>{const e=new Error('cancel');e.name='AbortError';throw e;};
  await a.saveFile();assert.equal(a.getData().dirty,true);assert.match(a.getData().notice,/取消/);
  a.setHandle({queryPermission:async()=> 'prompt',requestPermission:async()=> 'denied',createWritable:async()=>assert.fail('must not write')});
  await a.saveFile();assert.equal(a.getData().dirty,true);assert.match(a.getData().notice,/写入权限/);
});
test('加载选较新的缓存，包括未保存词条；较旧及损坏缓存回退文件',() => {
  for (const kind of ['newer','older','broken']) {
    const {api:a,cache}=createAPI(true),cached=plain(initialState),rows=plain(initialRows);
    cached.updatedAt=kind==='newer'?'2026-09-15T00:00:00Z':'2026-09-01T00:00:00Z';
    cached.cards['es-0001:r']=record();rows[0].note='缓存中的词条修订';
    cache.set('language-srs:v1:/srs/index.html',kind==='broken'?'bad json':JSON.stringify({state:cached,cards:rows}));
    a.initialize();const result=a.getData();
    assert.equal(result.source,kind==='newer'?'本地缓存':'文件');
    assert.equal(result.dirty,kind==='newer');
    assert.equal(result.rows[0].note,kind==='newer'?'缓存中的词条修订':initialRows[0].note);
    assert.equal(Object.keys(result.state.cards).length,kind==='newer'?1:0);
  }
});
