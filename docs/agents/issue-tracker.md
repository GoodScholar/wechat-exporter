# Issue tracker: GitHub

本仓库的需求、规格和任务记录在 GitHub Issues：
https://github.com/GoodScholar/wechat-exporter/issues

使用 `gh` CLI；在仓库目录执行时从 Git remote 推断仓库，跨目录执行时显式指定 `--repo GoodScholar/wechat-exporter`。

## 操作约定

- 创建：`gh issue create --title "标题" --body-file /path/to/body.md`。
- 读取：`gh issue view <number> --comments`；需要结构化结果时读取 number、title、body、labels、comments。
- 列表：`gh issue list --state open --json number,title,body,labels,comments`，按需增加标签和状态过滤。
- 评论：`gh issue comment <number> --body-file /path/to/comment.md`。
- 标签：`gh issue edit <number> --add-label "标签"` 或 `--remove-label "标签"`；分流角色与标签映射见 `triage-labels.md`。
- 关闭：`gh issue close <number>`；需要结论时先发表说明评论。

多行正文先写入临时 Markdown 文件，再用 `--body-file` 提交，保留真实换行。只有任务明确授权或当前调用的技能要求发布时才创建、评论或关闭远程事项。

技能要求“publish to the issue tracker”时创建 GitHub Issue；要求“fetch the relevant ticket”时运行 `gh issue view <number> --comments`。

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub 的 Issue 与 PR 共用编号。遇到含糊的编号时先用 `gh pr view <number>` 判断，失败后用 `gh issue view <number>`。

## Wayfinding operations

供 wayfinder 使用：一个带 `wayfinder:map` 标签的 Issue 保存整体地图，子 Issue 保存决策任务。

- 子任务优先使用 GitHub sub-issues；不可用时在地图正文使用任务列表，并在子任务正文顶部标注 `Part of #<map>`。
- 子任务类型标签为 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling`、`wayfinder:task`。
- 阻塞关系优先使用 GitHub 原生 issue dependencies。添加依赖时使用阻塞项的数字数据库 ID，而不是 Issue 编号或 node_id：

```bash
gh api repos/GoodScholar/wechat-exporter/issues/<blocker-number> --jq .id
gh api --method POST repos/GoodScholar/wechat-exporter/issues/<child-number>/dependencies/blocked_by -F issue_id=<blocker-database-id>
```

- 原生依赖不可用时，在任务正文顶部写 `Blocked by: #<number>, #<number>`。所有阻塞项关闭后才可领取任务。
- 查询地图的开放子任务，排除仍被阻塞或已有负责人者，按地图顺序选择。
- 领取：`gh issue edit <number> --add-assignee @me`。
- 完成决策：发表结论评论、关闭任务，再向地图追加决策摘要和来源链接。
