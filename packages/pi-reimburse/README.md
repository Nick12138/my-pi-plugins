# pi-reimburse · 报销管家 💰

个人报销管理 + 云同步插件（纯 pi 插件，不依赖 PiAbyss）。帮用户登记和追踪
个人垫付的报销单——什么时候、什么项目、花了多少钱、票据齐不齐、报销到账
没有。数据落盘在 `~/.pi/reimburse/`，跨会话、跨工作区共享同一份个人数据。

## 报销单模型（v2）

字段：**类别**（差旅/交通/餐饮/办公用品/招待/其他）、**日期**、**项目名称**、
**事宜**、**费用**（元）、**票据**、**备注**，外加状态流转
`pending（待报销）→ reimbursed（已到账，自动记到账时间）`。

**票据两种模式**（二选一使用）：

| 模式 | 组成 | 说明 |
|---|---|---|
| 直票 | `invoiceImage`（发票/车票图片） | 一张图直接挂到报销单上 |
| 替票组合 | `transactionImage`（交易截图）+ `substituteReceiptId`（替票） | 交易截图各归各的报销单，**替票是共享实体，可被多条报销单引用**（如 2 笔报销共用同一张替票、各有不同截图） |

替票独立登记（`receipt_add`：说明 + 可选面额 + 图片），删除前必须先解除
所有报销单引用（有引用时删除会报 CONFLICT）。

**图片托管**：登记/关联时从本地路径**复制**进 `~/.pi/reimburse/images/`，
原图可删不影响数据；图片引用挂在记录上，随云同步上传/补齐。

## 工具

### `reimburse` —— 报销单与替票

```
reimburse({
  action: "add" | "list" | "get" | "update" | "delete"
        | "receipt_add" | "receipt_list" | "receipt_update" | "receipt_delete",
  id?,                  // update/get/delete 必填（receipt_* 操作替票）
  category?,            // 类别（add 必填）
  date?,                // YYYY-MM-DD（add 可选，默认今天）
  project?,             // 项目名称
  subject?,             // 事宜（add/receipt_add 必填）
  amount?,              // 费用/替票面额（元）
  note?,                // 备注
  status?,              // update 流转状态
  month?,               // list 按发生月过滤
  invoiceImagePath?,    // 发票/车票图片本地路径（update 传 null 清除）
  transactionImagePath?,// 交易截图本地路径（update 传 null 清除）
  substituteReceiptId?, // 关联替票 id（update 传 null 解除）
  imagePath?,           // 替票图片（receipt_*）
})
```

- `list` 支持按状态 / 月份 / 类别 / 项目名（前缀包含）过滤，末尾附未到账汇总。
- `delete` 是**软删除**（墓碑）：记录体保留供云同步传播删除，30 天后由同步
  引擎物理清除（本地图片 + 云端对象）。

### `reimburse_sync` —— R2 云同步控制

```
reimburse_sync({
  action: "config" | "test" | "sync_now" | "status",
  accountId?, accessKeyId?, secretAccessKey?, bucket?, autoSync?,
})
```

- `config`：读取/保存 R2 配置（只覆盖传入字段；secretAccessKey 输出永远打码）；
- `test`：连接测试（不落盘不改动状态）；
- `sync_now`：立即双向同步，返回统计；
- `status`：最近同步状态 + 数据概况。
- `autoSync` 开启时，`reimburse` 每次成功变更后 5 秒防抖后台同步；进程启动
  10 秒后还会做一次启动同步（每次进程只一次）。

## 云同步设计（与 PiAbyss 备忘录同一套策略）

- **后端**：Cloudflare R2（S3 兼容），对象键固定前缀 `reimburse/`：
  - `reimburse/claims.json`（全量报销单 + 替票，单文件）
  - `reimburse/images/claims/<claimId>/<fileName>`
  - `reimburse/images/receipts/<receiptId>/<fileName>`
- **R2 客户端**：`node:crypto` 自实现 SigV4（与 PiAbyss Host 的 r2-client.ts
  同源移植），不引 AWS SDK；fetch 可注入便于测试。
- **策略**：逐条记录 LWW（`updatedAt` 新者胜，打平保本地）+ 删除墓碑。
  报销单与替票各自独立合并；删除后另一台设备的更新（updatedAt 更新）会
  复活记录；墓碑 TTL 30 天。
- **图片**：同步时从云端补齐本地缺失的图片（云端也没有 → 丢弃引用防悬空）；
  上传按 sha256 内容指纹跳过未变化对象（指纹缓存 `upload-hashes.json`，
  切换桶/账号整体作废）。
- **状态落盘**：`sync-config.json`（配置 + lastSyncAt/Ok/Error）。
- **已知取舍**：时钟漂移影响胜负判断；图片跟随记录整体胜负，不做单图合并；
  云端文件不含自增 id 游标（本地 readFile/replaceAll 有 max 防御）。

## 磁盘格式

`~/.pi/reimburse/claims.json`：

```json
{
  "schemaVersion": 2,
  "nextClaimId": 3,
  "nextReceiptId": 1,
  "claims": [ ... ],
  "receipts": [ ... ]
}
```

- 写入走「临时文件 + rename」原子替换；损坏 JSON 视为空库并留 `.corrupt` 备份。
- **v1 → v2 自动迁移**：`title→事宜`、类别补“其他”、项目名称留空、
  票据字段补 null；id 接续 v1 的 nextId，替票簿从空开始。

## 开发

```bash
npx vitest run            # 运行测试（含本包 45 个用例）
```
