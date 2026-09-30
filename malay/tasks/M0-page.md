# 任务 M0：SRS 页面接入第三种语言 ms（马来语）

先读 `malay/tasks/00-common.md` 的「工作范围」和「验证」两节。本轮不写任何课程、阅读或卡片内容，只把页面从「两种语言硬编码」改成「按 LANGS 列表生成」，并注册 ms。改动必须对现有西语、俄语数据和已保存的进度完全兼容。

## 背景

`srs/index.html` 是单文件页面：第一个 `<script type="application/json" id="cards-data">` 是卡片数组，第二个 `id="state-data"` 是进度，第三个 `id="srs-app"` 是运行时脚本。运行时脚本开头有 `const LANGS = ['es','ru'];`。以下位置把语言写死了（行号以 `id="srs-app"` 脚本内部为准，用 grep 找）：

1. `validateState`：`settings:{newPerDay:{es:settings.es,ru:settings.ru}}`，以及前面对 `LANGS.some(...)` 的整数校验。
2. `renderLessons`：`lang==='es'?'西语':'俄语'` 和 `'es · 西语':'ru · 俄语'`。
3. `renderReadings`：同上两处。
4. `renderStats`：阅读统计表的 `r.lang==='es'?'es · 西语':'ru · 俄语'`。
5. `renderReview`：`<select id="language">` 的选项写死了 es、ru 两项（长名「西班牙语」「俄语」）。
6. `renderSettings`：每日新卡数表单写死了 `limit-es`、`limit-ru` 两个输入框。
7. `bindEvents` 里 `form.id === 'limits'` 的提交处理：`const es = ..., ru = ...; state.settings.newPerDay = {es,ru};`。
8. `verify.cjs` 的 `api.change()`（`newPerDay.es++`）可以不动；`emptyState()` 的 `newPerDay:{es:15,ru:10}`、CSV 一致性测试的 `['es','ru']` 需要扩展。

## 要做的改动

### 1. 语言注册表

在 `const LANGS = ['es','ru'];` 处改为：

```js
const LANGS = ['es','ru','ms'];
const LANG_INFO = {
  es:{short:'西语',long:'西班牙语',newPerDay:15},
  ru:{short:'俄语',long:'俄语',newPerDay:10},
  ms:{short:'马来语',long:'马来语',newPerDay:10}
};
```

以后加语言只改这两处。

### 2. 进度兼容

`validateState`：对 LANGS 里每种语言，`settings.newPerDay[lang]` 缺失时取 `LANG_INFO[lang].newPerDay` 作默认；存在但不是 0–999 的整数时仍报错。返回的 `settings.newPerDay` 用 `Object.fromEntries(LANGS.map(...))` 生成。这样用户手机上、旧缓存里只有 es、ru 两项的进度照常加载，保存后自动补上 ms。

`state-data` JSON 块：在 `settings.newPerDay` 里加 `"ms": 10`，放在 `"ru": 10` 之后。这是本轮对 state-data 的唯一改动；cards 和 log 一个字节都不动。

`mergeProgress`：检查合并后 settings 不会丢掉 ms（现有逻辑保留当前 settings，应已满足；加测试确认）。

### 3. 渲染

2–7 各处改为遍历 LANGS、从 LANG_INFO 取名字。课程页和阅读页按 LANGS 顺序分三段（西语、俄语、马来语）；马来语暂时没有课程和阅读，课程段显示空的 course-picker，阅读段沿用现有「暂无」的处理方式（看 renderReadings 里 `items.length?…:…` 的分支，保持原样即可）。

设置页的输入框 id 为 `limit-<lang>`、name 为 `<lang>`；提交处理遍历 LANGS 读取并校验。

复习页的语言下拉框选项：`全部`，然后每种语言 `<lang> · <long>`。

统计页：现有 `statistics` 已按 LANGS 遍历，确认马来语一行出现（总卡 0）。

### 4. 卡片来源

新建 `srs/cards/ms.csv`，只有表头行 `id,lang,lesson,front,back,example,example_zh,note,tags`，UTF-8，LF 换行，末尾一个换行。

### 5. verify.cjs

- `emptyState()` 的 newPerDay 加 `ms:10`。
- CSV 一致性测试改为遍历 LANGS（`ms.csv` 为空表头，解析结果 0 行，与 cards-data 里 0 条 ms 一致）。
- 新增测试「任务 M0：第三种语言注册与旧进度兼容」，覆盖：
  1. `validateState` 接受只有 es、ru 的旧进度，返回的 newPerDay.ms 为 10；`ms` 为 -1 或 'x' 时报错。
  2. 页面初始化后课程页出现「马来语课程」段且顺序在「俄语课程」之后；`[data-lesson]` 数量仍为 59。
  3. 复习页下拉框有 `ms · 马来语` 选项；设置页有 `limit-ms` 输入框；提交 `{es:15,ru:10,ms:7}` 后 state.settings.newPerDay.ms 为 7，非法值报错且不改进度。
  4. 统计页有马来语一行。
  5. 序列化往返后 state-data 的 cards 与 log 和文件里的逐字节一致（只允许 settings 多出 ms）。
- 现有测试里检查 `page.indexOf('西语课程')<page.indexOf('俄语课程')` 的地方保持通过。

`node srs/verify.cjs` 全部通过。

### 6. README

`srs/README.md`：「卡片来自 `cards/es.csv` 和 `cards/ru.csv`」一句后加 `cards/ms.csv`（马来语，课程从任务 M1 起追加）；「课程按语言分组」一段末尾加一句：语言列表由脚本开头的 LANGS 和 LANG_INFO 决定，2026-09-30 起加入马来语 ms。

## 不做的事

- 不加任何 ms 课程、阅读、卡片。
- 不改样式，不改标签页结构，不改 SM-2、保存、合并逻辑。
- 不改 `isLetter`、`clozeExample`、`spellingResult` 里针对 ru 的重音处理；马来语走和西语相同的拉丁字母路径。
- 不改页脚「v1 冻结至 2026-12-06 复盘」的文字。

## 完成标准

`node srs/verify.cjs` 通过；`git diff --stat` 只涉及 `srs/index.html`、`srs/cards/ms.csv`（新建）、`srs/verify.cjs`、`srs/README.md`；index.html 的 diff 里 cards-data 块无改动，state-data 块只多一行 `"ms": 10`。最后用一段话报告：改了哪些函数、新增测试的名称、verify 通过的测试数。
