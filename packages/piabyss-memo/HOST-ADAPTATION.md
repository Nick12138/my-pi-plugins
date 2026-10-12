# piabyss-memo v0.4.0 桌面端（PiAbyss Host）适配说明

插件端已完成「计划功能」与「状态收敛」，`packages/piabyss-memo` 升至
**0.4.0**（叠加在已发布的 v0.3.0「更名方寸间 + 取消记录类别」之上，
本文档只覆盖 v0.4.0 新增部分）。本文档是桌面端重新适配的完整依据；
插件端实现以 `packages/piabyss-memo/src/recurrence.ts`（规则校验与
时刻计算）、`src/memo-store.ts`（字段与语义）为权威，建议 Host 侧逻辑
与其对齐。

## 一、数据格式变更（notes.json）

`schemaVersion` 保持 1 不变，每条记录新增 4 个可空字段
（type 类别字段已在 v0.3.0 取消，此处不再赘述）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `dueAt` | number \| null | 一次性截止时刻（epoch ms）。周期记录不使用。null = 无截止 |
| `recurrence` | MemoRecurrence \| null | 周期规则（形状见下）。null = 非周期记录。**清除（置 null）= 停用周期** |
| `nextDueAt` | number \| null | 周期记录**当前轮次**应处理的时刻（epoch ms）。持久化字段，展示/逾期判断直接读它，不要按规则现算。非周期记录恒为 null |
| `lastDoneAt` | number \| null | 周期记录最近一轮完成时刻；从未完成过为 null |

`recurrence` 形状（**结构化规则，非 cron**）：

```jsonc
{
  "frequency": "daily | weekly | monthly",
  "interval": 1,            // 每 N 天/周/月；缺省 1，上限 365
  "weekdays": [1],          // weekly 必填：ISO 星期 1=周一 … 7=周日（去重升序）
  "monthDay": null,          // monthly 必填：1..31；短月无此日则跳过该月（不夹到月末）
  "time": "13:00",           // 发生当天时刻，24 小时制 "HH:mm"
  "tz": "Asia/Shanghai",     // IANA 时区；缺省 Asia/Shanghai；绝不依赖设备本地时区
  "until": null,             // 周期终点（epoch ms，含端点）；null = 无限期
  "startDate": null          // interval 对齐锚点；null 时以记录 createdAt 为锚
}
```

校验规则（Host 表单应做同等约束）：
- `frequency` 必须是三个枚举之一；
- weekly 必须给非空 `weekdays`（1..7）；monthly 必须给 `monthDay`（1..31）；
  非对应频率的这两个字段强制清空；
- `time` 必须匹配 `^([01]\d|2[0-3]):([0-5]\d)$`；
- `tz` 必须是合法 IANA 时区；
- `until` / `startDate` / `dueAt` 为正的毫秒时间戳或 null。

## 二、状态收敛：archived 移除（v0.4.0）

状态只有 **`open` / `in_progress` / `done`** 三种。

- v2 旧数据（本地或云端）里的 `archived` 在**读取时自动迁移为 `done`**
  （`completedAt` 保持 null，因为归档时间未知）——迁移由
  `normalizeNoteDefaults` 完成，插件端已在本地读取与云端拉取两处生效；
  v0.3.0 之前写入的 `type` 字段也在该函数中统一剔除（与 v0.3.0 行为一致）；
- 「归档停用」的旧语义改由「**清除周期规则（recurrence: null）+ 正常完成**」表达；
- Host 写入端不要再产生 `archived`；接收到 `archived` 状态的更新请求应报错。

## 三、周期记录的完成语义（核心，UI 按此改）

### complete（「用 Agent 处理」后的完成 / 桌面端完成按钮）

对周期记录（`recurrence != null`），complete **不再置 `status = done`**：

1. 正常写入 `result`（本轮总结，覆盖式）与 `sessionId`；
2. `lastDoneAt` = 本轮完成时刻；
3. `nextDueAt` = 滚到**严格晚于当前时刻**的下一个发生时刻（错过多轮直接
   跳到未来，skip 策略不补跑）；
4. `status` 回到 `open`，`completedAt` 保持 null；
5. 若周期已过 `until`（含端点）：`nextDueAt` 置 null、`status = done`、
   `completedAt` 补上——记录自然终结，`recurrence` 规则保留供追溯。

### update（编辑表单 / 手动改状态）

- **直接把周期记录置 `done` 必须被拒绝**（防误操作，报错文案建议与插件端
  一致：「周期记录不能直接标记完成：请用 complete 提交本轮总结（自动滚动
  下一轮），或先清除周期规则（update 传 recurrence: null）转为普通记录」）；
- 同一次更新里**先清周期再置 done** 则允许（明确表达「停用并完结」）——
  即 patch 处理顺序应为：先 `dueAt` / `recurrence`，后 `status`；
- 更新 `recurrence` 为非 null 时**必须重算** `nextDueAt`（以 `Date.now()` 为
  起点、`createdAt` 为锚）；
- 清除 `recurrence` 时同步清空 `nextDueAt`；
- reopen（置 `open`）周期记录时，若 `nextDueAt` 为 null 则重算（覆盖云端
  同步下来的缺字段记录）。

### 桌面端 UI 建议改动点

- 列表/详情：展示 `dueAt`（截止）、`recurrence`（人读描述）、`nextDueAt`
  （下一轮）、`lastDoneAt`（上次处理）；`open` 状态且 `nextDueAt`/`dueAt`
  早于当前时刻 → 逾期标记（红点/置顶）；
- 周期记录的「完成」按钮文案建议改为「完成本轮」，完成后给出
  「下一轮：xxx」提示；
- 新建/编辑表单：新增计划设置（截止时间 / 周期规则子表单，字段与校验
  同第一节）；编辑周期后 `nextDueAt` 需重算；
- 周期记录不提供「归档」，改提供「停用周期」（= 清除 recurrence）。

## 四、Host 侧 memo-store 对齐清单

`pi-host/src/memo-store.ts`（磁盘格式权威）需要同步（在 v0.3.0 适配的
基础上）：

1. `MemoNote` 类型加 4 个新字段（可空，与第一节一致）；
2. `MemoNoteStatus` 收敛为三种；`requireStatus` 拒绝 `archived`；
3. 读取时的旧数据兼容：等价于插件端导出的 `normalizeNoteDefaults`
   （补 null + archived→done + 非法 recurrence 清 null），**本地读取与
   云端拉取（若 Host 还留有同步代码）两处都要**；
4. `create` / `update` / `completeWithResult` 的周期语义按第三节对齐；
5. **写入必须整条保留未知字段**（v3 靠整条 JSON 读写天然满足；若 Host 有
   白名单式序列化，务必把新字段加入白名单，否则桌面端一次编辑就会把
   计划字段冲掉）；
6. 时区计算建议直接移植插件端 `src/recurrence.ts`（纯函数、无第三方依赖，
  `normalizeRecurrence` + `nextOccurrence`，含 DST 处理与单测）。

## 五、云同步

- 插件端 LWW 引擎对计划字段**零改动**：整条覆盖天然携带新字段；
- 云端可能是旧版本设备写入的数据（缺计划字段、甚至 `archived` 状态），
  拉取后经 `normalizeNoteDefaults` 就地补齐/迁移，Host 无需额外处理；
- `nextDueAt` 是持久化字段：两台设备并发各完成一轮时，LWW 后写者胜，
  可能丢一轮 `lastDoneAt` 更新——备忘录场景并发概率极低，接受此权衡。

## 六、agent 工具（piabyss_memo）行为变化

- `update` 新增参数 `dueAt`（支持 `YYYY-MM-DD`、`YYYY-MM-DD HH:mm`
  设备本地时间或完整 ISO；`null` 清除）与 `recurrence`（结构化对象；
  `null` 清除）；
- `complete` 对周期记录返回「本轮已完成 + 下一轮时刻」文案，并明确提示
  agent 不要把周期记录置 done；
- `list` 输出增加 `due / recurs / next / last done` 字段与 `OVERDUE` 标记。

## 七、插件端变更文件与验证

| 文件 | 变更 |
| --- | --- |
| `src/recurrence.ts` | 新增：规则类型 / `normalizeRecurrence` 校验归一 / `nextOccurrence` 时区计算（含 DST） |
| `src/memo-store.ts` | 新字段、archived 移除与迁移、complete 周期滚动、update 守卫与重算、`normalizeNoteDefaults` 导出 |
| `src/memo-sync.ts` | 仅 `parseCloudNotes` 改用 `normalizeNoteDefaults`，合并策略零改动 |
| `extensions/piabyss-memo.ts` | update 计划参数、complete 周期文案、list 计划展示、工具描述约束 |
| `tests/recurrence.test.ts` | 新增 16 例（时区/DST/interval 锚点/月末跳过/until 含端点） |
| `tests/memo-store.test.ts` | 新增周期语义与迁移用例，磁盘形状断言更新 |
| `tests/memo-sync.test.ts` | 云端旧数据（archived、缺计划字段）迁移用例；修复在已配置环境（PiAbyss Host 内）跑测试时 env 泄漏导致的误报 |

验证：`vitest run` 全仓 192 例通过；`tsc --noEmit` 零错误。
