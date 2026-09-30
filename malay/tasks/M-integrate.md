# 任务 M-整合：把并行生成的 M5、M6 合入 main，并替换跨轮重复词条

先读 `malay/tasks/00-common.md`。本任务在主工作树（仓库根目录）执行，只改 `srs/index.html`、`srs/cards/ms.csv`、`srs/verify.cjs`、`srs/README.md`。不要 git commit、不要 git merge、不要切换分支；读取分支内容一律用 `git show <分支>:<路径>`。

## 背景

M4、M5、M6 三轮是在三个 worktree 里并行生成的，每轮都已由 Claude 审核并提交到各自分支：

| 来源 | 内容 | 分叉点 |
|---|---|---|
| 当前 main（HEAD） | M0–M4：ms-01 至 ms-16，卡片 ms-0001 至 ms-1240，阅读线 ms-r01 至 ms-r30 | — |
| 分支 `ms-m5` | ms-17 至 ms-20，卡片 ms-1241 至 ms-1560，阅读线 ms-r31 至 ms-r38 | f025e5b（M4 之前） |
| 分支 `ms-m6` | ms-21 至 ms-24，卡片 ms-1561 至 ms-1840，阅读线 ms-r39 至 ms-r46 | f025e5b（M4 之前） |

分叉点 f025e5b 上的 `srs/` 文件是三轮的共同基线。每个分支相对基线的改动 = 该轮新增的内容 + 对旧测试的少量调整。

## 要做的事

### 1. 合并内容（顺序：main 已有内容，然后 M5，然后 M6）

- `srs/cards/ms.csv` 和 `index.html` 的 `cards-data`：在 ms-1240 之后依次追加 M5 的 ms-1241 至 ms-1560、M6 的 ms-1561 至 ms-1840，字段逐字取自分支文件（第 2 步要替换的 86 条除外）。es、ru、uz、kk 的行一个字节都不改。
- `state-data` 一个字节都不改。
- `LESSONS`：在 ms-16 之后依次加入 ms-17 至 ms-20、ms-21 至 ms-24 的条目，以及两个分支为这些课新增的辅助常量或函数（例如课内阅读常量、讲解函数），逐字取自分支。
- `READINGS`：在 ms-r30 之后依次加入 ms-r31 至 ms-r46。
- `verify.cjs`：保留 main 现有的全部测试；加入 M5、M6 分支里「任务 M5」「任务 M6」的全部测试；两个分支对共同旧测试（全站计数、阅读列表、课程数、词汇范围函数 msForms 等）做过的调整，合并成在最终数据上都成立的写法。msForms 同时包含 M4（peN-、-an、peN-an、per-an、ke-an、se-）、M5（-lah、-kah、pun 附着）、M6（ber-…-an、X-meN-X）的推导，按 00-common 的开放顺序生效。M5、M6 测试里「只检查本轮区间」的写法保留，但它们原先因为缺 M4 而放宽的地方（例如词汇范围只看当时存在的课）改为在完整数据上检查。
- `README.md`：在 M4 段落之后依次追加 M5、M6 分支里各自新增的段落，然后更新全站总数那一句（词条数、卡数、课程数、练习数、阅读篇数）。

### 2. 替换 86 张跨轮重复卡

下表每一行是一张后面轮次的卡，它的 front 与更早的卡重复（「早先 id」列）。对每一行：

- 保留 id、lesson，保留 tags 的第一个标签（词类）和主题标签，去掉与原词相关的特有标签。
- 换一个新的 front：与本课主题相符、同一词类、马来西亚标准书面语、在全部 ms 卡中（不分大小写）都没有出现过；不要选 00-common 印尼语黑名单和同形异义词里的印尼语义。
- 按 00-common 的卡片规范重写 back、example、example_zh、note：example 含新 front 原形，只用该课及之前课的词（现在 ms-01 至该课都在文件里）；meN- 动词 note 写词根与形式；名词 note 写量词；形容词 note 写「形容词，后置」。
- 原来的课文和阅读线不用改：被替换的词在更早的课里仍有卡，词汇范围检查照样通过。只有当本课的讲解专门讲到被替换的那个词时，才顺带在讲解里补提新词（可选）。

| id | 课 | 现 front | 词类 | 早先 id |
|---|---|---|---|---|
| ms-1256 | ms-17 | banjir | 名词 | ms-1121 |
| ms-1260 | ms-17 | bencana | 名词 | ms-1120 |
| ms-1266 | ms-17 | kecemasan | 名词 | ms-1119 |
| ms-1280 | ms-17 | sumbangan | 名词 | ms-1126 |
| ms-1283 | ms-17 | meneruskan | 动词 | ms-1061 |
| ms-1284 | ms-17 | membaiki | 动词 | ms-0980 |
| ms-1286 | ms-17 | memindahkan | 动词 | ms-1133 |
| ms-1287 | ms-17 | menyelamatkan | 动词 | ms-1132 |
| ms-1290 | ms-17 | memerlukan | 动词 | ms-1062 |
| ms-1291 | ms-17 | mengutamakan | 动词 | ms-1063 |
| ms-1296 | ms-17 | menyumbang | 动词 | ms-1131 |
| ms-1370 | ms-18 | mendaftar | 动词 | ms-1051 |
| ms-1400 | ms-18 | terlalu | 副词 | ms-1163 |
| ms-1401 | ms-19 | memberitahu | 动词 | ms-1144 |
| ms-1409 | ms-19 | mencadangkan | 动词 | ms-1143 |
| ms-1423 | ms-19 | yakni | 连词 | ms-1146 |
| ms-1430 | ms-19 | kenyataan | 名词 | ms-1099 |
| ms-1434 | ms-19 | sumber | 名词 | ms-1075 |
| ms-1444 | ms-19 | perbualan | 名词 | ms-1042 |
| ms-1457 | ms-19 | menilai | 动词 | ms-1064 |
| ms-1458 | ms-19 | membandingkan | 动词 | ms-1058 |
| ms-1467 | ms-19 | berunding | 动词 | ms-0990 |
| ms-1491 | ms-20 | bahkan | 副词 | ms-1148 |
| ms-1543 | ms-20 | menyunting | 动词 | ms-0984 |
| ms-1551 | ms-20 | sopan | 形容词 | ms-1188 |
| ms-1555 | ms-20 | gaya | 名词 | ms-1208 |
| ms-1607 | ms-21 | membungkus | 动词 | ms-1054 |
| ms-1610 | ms-21 | memetik | 动词 | ms-1463 |
| ms-1617 | ms-21 | mengagihkan | 动词 | ms-1134 |
| ms-1625 | ms-21 | berkongsi | 动词 | ms-1537 |
| ms-1629 | ms-21 | manis | 形容词 | ms-1182 |
| ms-1635 | ms-21 | licin | 形容词 | ms-1316 |
| ms-1663 | ms-22 | salinan | 名词 | ms-1020 |
| ms-1668 | ms-22 | pengirim | 名词 | ms-0940 |
| ms-1677 | ms-22 | skrin | 名词 | ms-1525 |
| ms-1678 | ms-22 | dokumen | 名词 | ms-1080 |
| ms-1681 | ms-22 | setiausaha | 名词 | ms-0964 |
| ms-1687 | ms-22 | membalas | 动词 | ms-1404 |
| ms-1692 | ms-22 | mencetak | 动词 | ms-1053 |
| ms-1694 | ms-22 | menyemak | 动词 | ms-1374 |
| ms-1699 | ms-22 | menangguhkan | 动词 | ms-1281 |
| ms-1700 | ms-22 | membatalkan | 动词 | ms-1282 |
| ms-1702 | ms-22 | merujuk | 动词 | ms-1460 |
| ms-1709 | ms-22 | meskipun | 连词 | ms-1245 |
| ms-1710 | ms-22 | justeru | 连词 | ms-1150 |
| ms-1719 | ms-22 | kelewatan | 名词 | ms-1264 |
| ms-1721 | ms-23 | pada mulanya | 连词 | ms-1334 |
| ms-1722 | ms-23 | selepas itu | 连词 | ms-1333 |
| ms-1724 | ms-23 | tidak lama kemudian | 连词 | ms-1385 |
| ms-1731 | ms-23 | sebaik sahaja | 连词 | ms-1327 |
| ms-1733 | ms-23 | banjir | 名词 | ms-1121 |
| ms-1735 | ms-23 | kebakaran | 名词 | ms-1118 |
| ms-1736 | ms-23 | kemalangan | 名词 | ms-1261 |
| ms-1737 | ms-23 | mangsa | 名词 | ms-1122 |
| ms-1738 | ms-23 | saksi | 名词 | ms-1449 |
| ms-1743 | ms-23 | kerosakan | 名词 | ms-1262 |
| ms-1746 | ms-23 | kenyataan | 名词 | ms-1099 |
| ms-1747 | ms-23 | sumber | 名词 | ms-1075 |
| ms-1749 | ms-23 | wawancara | 名词 | ms-1445 |
| ms-1751 | ms-23 | kawasan | 名词 | ms-1130 |
| ms-1753 | ms-23 | jurugambar | 名词 | ms-0954 |
| ms-1755 | ms-23 | bekalan | 名词 | ms-1267 |
| ms-1766 | ms-23 | merakam | 动词 | ms-1461 |
| ms-1767 | ms-23 | menerbitkan | 动词 | ms-0983 |
| ms-1768 | ms-23 | menyiarkan | 动词 | ms-1462 |
| ms-1771 | ms-23 | menafikan | 动词 | ms-1406 |
| ms-1772 | ms-23 | mengesan | 动词 | ms-1372 |
| ms-1773 | ms-23 | menyelamatkan | 动词 | ms-1132 |
| ms-1774 | ms-23 | memindahkan | 动词 | ms-1133 |
| ms-1776 | ms-23 | membaiki | 动词 | ms-0980 |
| ms-1783 | ms-23 | meneruskan | 动词 | ms-1061 |
| ms-1784 | ms-23 | berlaku | 动词 | ms-1299 |
| ms-1785 | ms-23 | beredar | 动词 | ms-1367 |
| ms-1788 | ms-23 | cemas | 形容词 | ms-1396 |
| ms-1793 | ms-23 | rosak | 形容词 | ms-1317 |
| ms-1802 | ms-24 | kemajuan | 名词 | ms-1082 |
| ms-1806 | ms-24 | kaedah | 名词 | ms-1074 |
| ms-1813 | ms-24 | rumusan | 名词 | ms-1441 |
| ms-1816 | ms-24 | pelajaran | 名词 | ms-1036 |
| ms-1817 | ms-24 | pembelajaran | 名词 | ms-1024 |
| ms-1818 | ms-24 | pengajaran | 名词 | ms-1023 |
| ms-1819 | ms-24 | ajaran | 名词 | ms-1019 |
| ms-1822 | ms-24 | bacaan | 名词 | ms-1001 |
| ms-1823 | ms-24 | pembacaan | 名词 | ms-1021 |
| ms-1824 | ms-24 | penulisan | 名词 | ms-1022 |
| ms-1825 | ms-24 | penulis | 名词 | ms-0921 |

### 3. 验证

- 新增测试「任务 M-整合：ms 全部 1840 条 front 不重复，24 课、46 篇阅读线编号连续，M5、M6 词条在 M4 之后按 id 顺序追加」。
- 新增测试「任务 M-整合：86 张替换卡的 front 在全部 ms 卡中唯一，例句含 front 且只用该课及之前的词」。
- `node srs/verify.cjs` 全部通过。
- 旧行原样检查：es、ru、uz、kk 与 ms-0001 至 ms-1240 的行与 HEAD 逐字段一致；M5、M6 中未被替换的行与各自分支逐字段一致。

## 交付

最后用一段话报告：合并了哪些块、verify.cjs 里改了哪些旧测试、86 张卡的新旧 front 对照表（每行「id 旧 → 新」）、verify 通过数。
