# LanguageStudy

多语言学习的工作目录。方法层和语言层分开：`framework/` 写「怎么学任何语言」，每门语言一个目录写「这门语言怎么学」，日志统一放 `log/`。

## 当前状态

| 项 | 内容 |
|---|---|
| 起点 | 2026-09-07（第 0 周，2026-W37） |
| 在学 | 西班牙语（第 1 周起）、俄语（第 1–4 周只做字母和读音，第 5 周起正式起步） |
| 阶段 | 探索期：第 1–12 周，2026-09-14 至 2026-12-06；第 12 周结束时复盘 |
| 每周投入 | 5–10 小时，计划基线 7 小时 |
| 范围 | 当前只学读写，不学发音和听力。听说内容收在各语言 profile 的「以后加听说时」一节，探索期复盘时决定是否加 |
| 已掌握 | 中文、英语 |

## 目录

| 路径 | 用途 |
|---|---|
| [framework/principles.md](framework/principles.md) | 六条原则、阶段划分、SRS 工具选择、加新语言的规则 |
| [framework/weekly-cycle.md](framework/weekly-cycle.md) | 每周时间表：7 小时基线、5 小时保底、10 小时加码、维持模式 |
| [framework/metrics-and-review.md](framework/metrics-and-review.md) | 记录字段、汇总命令、周志、月度检查点、探索期出口规则 |
| [framework/templates/](framework/templates/) | 新语言启动模板、周志、错题本、月度复盘模板 |
| [spanish/profile.md](spanish/profile.md) | 西语：迁移分析、难点地图、文字与拼写要点、资源候选、探索期目标 |
| [spanish/roadmap.md](spanish/roadmap.md) | 西语：阶段总表、探索期逐周计划 |
| [spanish/errors.md](spanish/errors.md) | 西语错题本 |
| [russian/profile.md](russian/profile.md) | 俄语：同上 |
| [russian/roadmap.md](russian/roadmap.md) | 俄语：同上 |
| [russian/errors.md](russian/errors.md) | 俄语错题本 |
| [srs/index.html](srs/index.html) | 自建 SRS 页面：复习、课程（两门语言第 1–12 周共 24 课）、阅读（分级短文，答题得分写进进度）、统计、设置。卡片和进度嵌在文件里 |
| [srs/cards/](srs/cards/) | 卡片来源 CSV，改完在页面里导入再保存 |
| [srs/README.md](srs/README.md) | 页面用法：打开、保存、手机进度合并、加卡片 |
| [log/time.csv](log/time.csv) | 统一时间记录，一行一条 |
| [log/2026-W37.md](log/2026-W37.md) | 本周周志（第 0 周任务清单） |

## 每天怎么用

0. 在 `srs/index.html` 里复习和阅读：电脑用 Chrome 打开本地文件，手机打开 https://jerusalem1187.github.io/LanguageStudy/srs/index.html 。阅读标签里每周两篇分级短文，答完 4 题记得分。每天结束点「保存」，再 `git commit` 和 `git push`。仓库里的课程或页面更新后，先关掉旧页面再重新打开。
1. 学完记一行到 `log/time.csv`。
2. 输出练习里的错误记到对应语言的 `errors.md`。
3. 周日 15 分钟：跑汇总命令，填周志，按 `weekly-cycle.md` 定下周用基线还是保底。
4. 每月最后一个周日：填月度复盘（替代那周的周志）。

## 加新语言

1. 复制 `framework/templates/language-profile.md` 到 `<语言代码>/profile.md`，填完。
2. 按 profile 写 `<语言代码>/roadmap.md`（阶段总表 + 第一阶段逐周计划）。
3. 复制 `framework/templates/error-log.md` 到 `<语言代码>/errors.md`。
4. `time.csv` 的 lang 列用新代码（ISO 639-1，如 de、fr、ja）。
5. 周志和月度复盘模板的表里加一行。
6. 时机：只在已有语言之一到 B1 后再加。原因见 `principles.md`。
