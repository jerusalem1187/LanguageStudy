# 马来语课程任务书：通用规范

本文件是 M0–M6 每轮任务书的共同部分。执行任何一轮之前先完整读本文件，再读该轮的任务书。执行者是 Codex（gpt-6-astra）；审核、测试和提交由 Claude 做，push 由用户做。

## 参数表（用户可改；改动后各轮任务书里引用的日期一并按此表推算）

| 参数 | 起始值 |
|---|---|
| 起始日期（第 1 周周一） | 2026-10-05 |
| 第 1–4 周 dailyTime | 每天 15 分钟 + 每周 1 次系统块 30 分钟 |
| 第 5 周起 dailyTime | 每天 20 分钟 + 每周 1 次系统块 30 分钟 |
| 每日新卡数（settings.newPerDay.ms） | 10 |
| 每课词条数 | 80；ms-12 和 ms-24 为 40 |

各周日期（按起始值）：

| 周 | dates 字段写法 | 周 | dates 字段写法 |
|---|---|---|---|
| 1 | 10-05 至 10-11 | 13 | 12-28 至 2027 年 01-03 |
| 2 | 10-12 至 10-18 | 14 | 2027 年 01-04 至 01-10 |
| 3 | 10-19 至 10-25 | 15 | 2027 年 01-11 至 01-17 |
| 4 | 10-26 至 11-01 | 16 | 2027 年 01-18 至 01-24 |
| 5 | 11-02 至 11-08 | 17 | 2027 年 01-25 至 01-31 |
| 6 | 11-09 至 11-15 | 18 | 2027 年 02-01 至 02-07 |
| 7 | 11-16 至 11-22 | 19 | 2027 年 02-08 至 02-14 |
| 8 | 11-23 至 11-29 | 20 | 2027 年 02-15 至 02-21 |
| 9 | 11-30 至 12-06 | 21 | 2027 年 02-22 至 02-28 |
| 10 | 12-07 至 12-13 | 22 | 2027 年 03-01 至 03-07 |
| 11 | 12-14 至 12-20 | 23 | 2027 年 03-08 至 03-14 |
| 12 | 12-21 至 12-27 | 24 | 2027 年 03-15 至 03-21 |

写法和现有西语、俄语课程一致：2026 年内只写月日；跨年那周写「12-28 至 2027 年 01-03」；2027 年的周写「2027 年 01-04 至 01-10」。

## 工作范围

- 只改 `srs/index.html`、`srs/cards/ms.csv`、`srs/verify.cjs`、`srs/README.md`。不改仓库其他文件，不新建其他文件。不 git commit。
- 不改 `cards-data` 里已有的行，不改 `state-data` 里的 cards 和 log，不改已有的 LESSONS 和 READINGS 条目，不改页面已有行为。新内容一律追加在对应对象或数组的末尾。
- 8 GB 内存的机器，不要并行起进程，不要把 2.8 MB 的 index.html 整个读进上下文，用脚本定位和追加。
- 完成后运行 `node srs/verify.cjs`，全部通过才算完成；把新加的检查也写进 verify.cjs（见「验证」）。

## 语言规范

- 变体：马来西亚标准马来语，拼写按 Dewan Bahasa dan Pustaka 规范。只用马来西亚拼写和常用词：kerana、boleh、wang、pejabat、universiti、stesen、kesihatan、bahawa、iaitu、Isnin、Khamis、Jumaat、Ahad、Mac、Ogos、Disember、lapan、mahu、sahaja、kereta（汽车）、basikal、kasut、bilik、tandas。印尼语形式（karena、uang、kantor、universitas、bahwa、Senin、delapan、mau、saja、sepeda、sepatu、kamar）不进 front、example 和阅读；只在 note 里作对照时才出现，前面写「印尼语作」。
- 语体：标准书面语。代词用 saya、awak、anda、dia、beliau、kami、kita、mereka；口语代词 aku、kau、engkau 和缩略 tak、nak、dah、je、ni、tu 只在 ms-20 作识别卡出现，别的课不用。
- 每个词条的 front 是所教的词形本身：教 belajar 就以 belajar 为 front，不以词根 ajar 为 front；note 写词根和词缀（「ber- + ajar；词根 ajar」）。meN- 动词的 note 写变形规则（「meN- + tulis → menulis，t 脱落」）。
- 名词 note 写常用量词（「量词 buah」）；形容词 note 写「形容词，后置」；及物动词 note 写常见宾语。
- example 是完整句子，含 front 的原形（供拼写卡挖空）；example_zh 是逐句中文。例句只用本课和之前课的词，加上专名、数字和该课已教词缀的规则派生形（见「词汇范围」）。
- 语法讲解用中文，术语用国内通行说法：前缀、后缀、词根、量词、重叠、被动、施事、及物。马来语例句用 `<span lang="ms">` 或 `<p lang="ms">` 包住，后接中文。
- 中文措辞平实，不用比喻性行话（不写「攻克」「拿下」「打通」一类词）。

## 卡片规范（`srs/cards/ms.csv` 与 `cards-data`）

- 列：`id,lang,lesson,front,back,example,example_zh,note,tags`，与 es.csv 相同。lang 为 `ms`，lesson 为 `ms-NN`。
- id 从 `ms-0001` 起四位连续编号，按课顺序追加；CSV 和 `cards-data` 由同一脚本生成，逐字段一致。
- 同语言 front 不重复（不区分大小写）。已在前面课出现过的词不再建卡；每课词表遇到重复就换同类新词补足数量。
- tags 用分号分隔。第一个标签是词类：名词、动词、形容词、代词、数词、量词、介词、连词、副词、助动词、语气词、疑问词、问候。之后可加主题标签（家庭、食物、城市、时间、学习与工作等）和来源标签：英语借词、葡语借词、闽南语借词、阿拉伯语借词、梵语借词。整句和含动词的多词短语加 `phrase`（只生成识别卡）；补足数量的词加 `补充`。
- 没有 letter 卡（马来语不做字母课）。
- back 是中文释义，多义时用「；」分隔，只列本课用到的义项。

## 课程规范（LESSONS 条目）

字段与 es-13 之后的条目相同：`name`、`lang: "ms"`、`week`、`dates`、`dailyTime`、`goal`、`writingTask`、`explanation`（返回 HTML 字符串的箭头函数）、`reading`（课内阅读对象或 null）、`exercises`（10 题）。

- `explanation` 开头一段写本周时间安排（dailyTime 的内容）和教材指引：「配合《Complete Malay》的对应单元，单元以实际教材为准」。第 10 周起加一句「时间分配以复盘结果为准」。
- 讲解含：本周语法点（每点一个 `<h4>`）、至少 3 组马来语例句和中文、本周写作任务的中文提纲（5 句写什么）、写完的自查清单（名词短语语序、词缀拼写等）。
- `exercises` 共 10 题：ms-01 为 10 道拼写与填空题；ms-02 起为 6 道语法或拼写题 + 4 道课内阅读理解题（阅读题对象同时放进 `reading.questions` 和 `exercises`，与现有课程一致）。题型：填空（`answer` 为单个词或短语）、看中文写马来语、选择题（`options` 数组，答案在选项里）。填空题的 prompt 里给出词根或提示，例如「meN- 变形：Saya ____ surat.（tulis）」。
- 课内阅读 `reading`：`{title, sentences:[{text, zh}], questions:[…]}`，篇幅和阅读线同周的规格相同（见 roadmap.md「阅读线编号」表）。

## 阅读线规范（READINGS 条目）

字段与 ru-r60 相同：`id`、`lang: "ms"`、`afterLesson`、`week`、`title`（中文）、`genre`、`words`（马来语词数，按空格分词，连字符重叠算一个词）、`sentences:[{text, zh}]`、`questions`（4 题：3 道阅读题 + 1 道推断题，选择题，答案在选项里）、`keyWords`（5 个已学词，`{word, zh}`）、`retell`（5 行中文要点）。

- 编号 `ms-rNN` 两位连续，追加在 READINGS 末尾。
- 每周两篇体裁不同；体裁在这组里轮换：人物介绍、日常生活、房间或城市描写、对话、短信或便条、通知或广告、菜谱或日程、日记、邮件、短故事、简单新闻、说明文。
- 篇幅按 roadmap.md「阅读线编号」表。
- 场景用马来西亚本地：吉隆坡、槟城、新山、马六甲，人名用马来西亚常见名（Ali、Siti、Aminah、Farid、Mei Ling、Raju 等），食物用本地食物。

## 词汇范围（阅读、课文和例句只用已学词）

允许出现的词：

1. `afterLesson` 及之前课程（含本课）的全部 front；多词 front 拆成单词后每个词都算已学。
2. 上述词的规则派生形，只限该课或之前课已教的词缀：
   - 重叠复数 X-X（ms-03 起）
   - 后附 -nya、-ku、-mu（ms-02 起）
   - ber-（ms-05 起，含 be-、bel- 变体）
   - meN-（ms-06 起，五种变形与 p / t / k / s 脱落）
   - -kan（ms-09 起）、-i（ms-10 起）、di-（ms-11 起）、ter-（ms-12 起）
   - peN-（ms-13 起）、-an、peN-an、per-an（ms-14 起）、ke-an（ms-15 起）、se-（ms-16 起）
   - 组合形式按上述各自开放时间叠加（meN-…-kan 从 ms-09 起）
3. 专名（首字母大写）、阿拉伯数字、标点。

verify.cjs 里用一个 `msForms(front, lessonIndex)` 函数生成允许集合，方法同现有 `esAttach` 一类的推导式检查；每轮的检查按这条规则写，不用固定的词表快照。

## 验证（verify.cjs）

每轮在 `srs/verify.cjs` 末尾追加该轮的 `test(...)`，命名「任务 M<n>：…」，覆盖：

1. 本轮各课的 week、dates、dailyTime、goal、writingTask 存在且日期符合参数表。
2. 每课词条数、id 连续、CSV 与 `cards-data` 同步、front 不与已有 ms 卡重复、无印尼语拼写（用一个黑名单：karena、uang、kantor、universitas、bahwa、senin、delapan、mau、saja、sepeda、sepatu、bisa（作「能」用时）、kemarin）。
3. 每课 10 题；ms-02 起含 4 道阅读题；选择题答案在选项里。
4. 阅读线篇数、编号连续、追加在末尾、词数与句数在区间内、同周体裁不同、4 题、5 个 keyWords 是已学词。
5. 所有新例句、课文、阅读线句子通过词汇范围检查。
6. 讲解 HTML 可解析；页面渲染本轮课程与阅读时不改进度。
7. 只追加不修改：用「旧行原样」的方式检查（按 id 顺序对比旧 ms 行和旧 es / ru 行与文件中的一致），不要用固定哈希或字节偏移。

`node srs/verify.cjs` 现有测试必须全部继续通过。

## 交付

完成后在 `srs/README.md` 的相应位置追加一段：本轮课程编号与周次、每课词条数与卡数、阅读篇数与篇幅、验证项数。措辞与现有段落一致。
