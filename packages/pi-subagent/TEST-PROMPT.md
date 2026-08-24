# pi-subagent 全功能测试提示词

> 用法：确保已安装并启用 pi-subagent 插件（配置项可全默认），在当前工作区（my-pi-plugins，git 仓库）**新建会话**，把下面的内容整体粘贴给主 agent。

---

## 任务：系统测试 pi-subagent 插件的全部功能

你在测试一个新安装的插件 `pi-subagent`（Windows 子代理运行时）。请严格按照下面的步骤执行测试，每一步完成后简要说明结果和你的观察。测试过程中你会使用 `subagent` 工具。

### 0. 前置检查
1. 调用 `subagent(action:"list")`，确认工具可用（应返回"暂无子代理任务"）。
2. 用 curl 或浏览器访问 `http://127.0.0.1:18765/api/health`，确认 HTTP API 已启动（应返回 `{"ok":true,...}`）。

### 1. 单任务 + 会话标题 + 回调（scout）
- 调用：`subagent(agent:"scout", task:"快速了解 my-pi-plugins 仓库的结构：有哪些插件、plugins.json 是什么、README 怎么组织", title:"仓库结构探索")`
- **预期**：立即返回 runId，并提示"完成/失败时会自动通知"。**不要等待**，继续做第 2 步。
- 之后应收到【子代理通知】回调消息，包含探索摘要。收到后说明"回调功能正常"。

### 2. 后台运行验证（worker 在独立目录干活）
- 提交 `subagent(agent:"worker", task:"在 ./packages/pi-subagent 目录下创建一个文件 test-artifact.txt，内容写三行：插件名、你用的模型、当前时间。然后读取确认存在。", title:"worker 后台任务")`
- **预期**：同样立即返回，主 agent 继续干活（可以顺便执行一次 `ls packages/`），等回调自动到来。
- 回调后调用 `subagent(action:"result", runId:"<id>")` 查看完整输出，确认文件已创建。

### 3. 并行 + 队列（一次提交 5 个任务）
- 调用：
  ```
  subagent(tasks:[
    {agent:"scout", task:"列出 plugins.json 里所有插件 id 和它们的 install 类型", title:"T3a 插件清单"},
    {agent:"reviewer", task:"审查 packages/pi-subagent/extensions/control.ts 的代码质量（只读）", title:"T3b 审查 control"},
    {agent:"scout", task:"统计 packages/ 下每个插件目录的文件数量", title:"T3c 文件统计"},
    {agent:"reviewer", task:"审查 packages/pi-web 的 README 是否完整", title:"T3d 审查 pi-web README"},
    {agent:"worker", task:"在 packages/pi-subagent 下追加一行 '--- test parallel ---' 到 test-artifact.txt 文件末尾（先读再追加，不要覆盖）", title:"T3e 并行写入"}
  ])
  ```
- **预期**：返回 5 个 runId。观察它们陆续完成并各自回调。若并发未满则同时运行，否则排队。
- 全部完成后调用 `subagent(action:"list")` 确认 5 个都是"已完成"。

### 4. 模型覆盖
- 调用 `subagent(agent:"scout", task:"只回答你当前使用的模型 id", model:"<你当前主 agent 使用的模型，如 deepseek-v4-flash-0731>", title:"模型覆盖测试")`
- **预期**：回调里能看到该模型名（result 或通知中）。调用 `subagent(action:"result", runId:"<id>")` 确认 result.model 与你指定的一致。

### 5. 暂停 / 继续
- 提交一个耗时较长的任务：`subagent(agent:"worker", task:"写一个 Node 脚本计算斐波那契数列前 40 项并输出，然后用 bash 执行它", title:"暂停测试任务")`
- 先 `subagent(action:"list")` 确认状态为**运行中**（若还在排队/未启动，等 2 秒重查），再调用 `subagent(action:"pause", runId:"<id>")` → 应返回"已暂停"；`subagent(action:"list")` 应显示"已暂停"。
- 调用 `subagent(action:"continue", runId:"<id>")` → "已继续"；等待它完成。

### 6. 停止
- 再提交一个任务（随便什么），运行中调用 `subagent(action:"stop", runId:"<id>")` → "已停止"；`list` 显示"已停止"，且不会收到它的完成回调。

### 7. 失败 + 自动重试 + 断点恢复（核心场景）
- **7a 失败**：提交 `subagent(agent:"worker", task:"回复：这个任务应该失败", model:"nonexistent/model-xyz", retry:0, title:"失败测试")` —— 用不存在的模型强制失败。
- **预期**：收到失败回调，含失败原因，并提示可 `resume`。`list` 显示"失败"。
- **7b 恢复**：调用 `subagent(action:"resume", runId:"<id>")` → "已恢复，从断点继续"。
- **预期**：它会用正确模型续跑并完成（resume 时未指定 model，回退到继承主 agent）。收到完成回调后，用 `subagent(action:"result", runId:"<id>")` 查看：输出应包含"这个任务应该失败"相关内容（证明上下文未丢失）。
- 说明为什么这个场景重要：模型报错不会让之前的工作白做。

### 8. worktree 隔离 + 合并
- 调用 `subagent(agent:"worker", task:"在仓库根目录创建一个文件 worktree-demo.txt 写入 'worktree test'，并读取确认", worktree:true, title:"worktree 演示")`
- **预期**：完成后回调会提示"在 worktree 中运行，改动未合并"。`list` 或 `result` 能看到 worktree 路径。
- 调用 `subagent(action:"merge", runId:"<id>")` → "已合并分支，worktree 已清理"。
- 确认 `worktree-demo.txt` 出现在主分支工作区（git status 可看到）。

### 9. 双向工具回调（contact_supervisor ↔ subagent_supervisor）
- 提交任务：`subagent(agent:"worker", task:"分三步：1) bash 执行 ls packages/ | wc -l 统计插件目录数；2) 调用 contact_supervisor({reason:'need_decision', message:'统计完成，请确认是否继续'}) 并阻塞等待回复，不要提前结束；3) 收到回复后把回复内容写入 packages/pi-subagent/supervisor-reply.txt 并读取确认", title:"双向回调测试")`
- **预期**：子代理运行中，`%TEMP%/pi-subagent-supervisor-channels/<runId>-worker-0/requests/` 下出现 `<uuid>.json`（含 `orchestratorSessionId` 与主会话 id 一致）。
- 主 agent 调用 `subagent_supervisor({action:"pending"})` → 能看到该请求；`subagent_supervisor({action:"reply", replyTo:"<id>", message:"确认继续，验证码 X"})` → 返回“Replied to supervisor request”。
- **预期**：子代理解除阻塞继续，`supervisor-reply.txt` 出现回复内容（含验证码 X），run 完成。
- 可选：再测 `progress_update`（单向不等待）与 `contact_supervisor` 超时（`PI_SUBAGENT_SUPERVISOR_TIMEOUT_MS` 设小值）。

### 10. HTTP API 验收
- 依次用 curl 访问（或让用户浏览器打开）：
  - `http://127.0.0.1:18765/api/runs` → 应有本次所有测试 run 的列表
  - `http://127.0.0.1:18765/api/runs/<任意完成runId>/events?offset=0` → 原始事件流 JSON 行（含 thinking/toolCall 内容）
  - `http://127.0.0.1:18765/api/runs/<任意runId>/result` → 最终输出与用量统计
  - `http://127.0.0.1:18765/api/supervisor` → 通道诊断（started/timer/pending/sessionId/root）

### 11. 清理
- 删除测试产物：`packages/pi-subagent/test-artifact.txt`、`packages/pi-subagent/supervisor-reply.txt`、`worktree-demo.txt`（用 bash rm）。
- 清理通道残留：`rm -rf %TEMP%/pi-subagent-supervisor-channels/*/`。
- 测试中失败的 `nonexistent/model-xyz` 相关 run 记录保留在 `~/.pi/subagent/runs/` 供查看；如需清理可删除该目录下对应 run 目录。

### 最终总结
按这个格式汇报：
- 每项功能测试结果：✅ 通过 / ❌ 失败（附现象）
- 回调是否全部送达、是否有多发/漏发
- HTTP API 数据是否完整（尤其 events 里的思考内容）
- 任何异常观察（端口占用、状态不对、卡住等）
