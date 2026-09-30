# 马来语课程任务书

给 Codex（gpt-6-astra）的实现任务。框架由 Claude（Fable）写，实现由 Codex 做，审核、测试、提交由 Claude 做，push 由用户做。

| 文件 | 内容 | 前提 |
|---|---|---|
| `00-common.md` | 通用规范与参数表：日期、语言规范、卡片与课程格式、词汇范围、验证要求 | 每轮都先读 |
| `M0-page.md` | 页面接入第三种语言，无内容 | 无 |
| `M1.md` | ms-01 至 ms-04，ms-r01 至 ms-r06 | M0 |
| `M2.md` | ms-05 至 ms-08，ms-r07 至 ms-r14 | M1 |
| `M3.md` | ms-09 至 ms-12，ms-r15 至 ms-r22 | M2 |
| `M4.md` | ms-13 至 ms-16，ms-r23 至 ms-r30 | M3 |
| `M5.md` | ms-17 至 ms-20，ms-r31 至 ms-r38 | M4 |
| `M6.md` | ms-21 至 ms-24，ms-r39 至 ms-r46 | M5 |

启动一轮（在仓库根目录，后台单进程，一次只跑一轮）：

```bash
cat malay/tasks/00-common.md malay/tasks/M1.md | codex exec -s workspace-write -C ~/Desktop/LanguageStudy -
```

每轮完成后由 Claude 审核：进度块逐字节比对（M0 允许 settings 多出 ms）、旧行原样、front 去重、印尼语拼写黑名单、CSV 与嵌入一致、篇目存在、`node srs/verify.cjs`、措辞 grep；以 fail=0 为门槛提交，再启动下一轮。

参数（起始日期、每日时长、新卡数）在 `00-common.md` 的参数表里，由用户定；改动后重新推算各轮任务书里的日期再启动。
