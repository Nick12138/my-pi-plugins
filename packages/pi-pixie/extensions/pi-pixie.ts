/**
 * pi-pixie — Pixie 委派/回调/询问/打盹/回读/查岗/插话/叫停/重试工具的插件侧壳
 * （委派引擎仍在 PiAbyss Host；打盹后的记忆在插件侧，见 src/segment-memory.ts）。
 *
 * v4（工作区化）→ v4.1（队列 + 查岗 + 插话 + 叫停 + 重试）：全部工具注册到
 * 每个会话的工具注册表，可见性完全由 before_agent_start 的 active-tools
 * 门控统一管理（src/activation.ts）：
 *
 * - 小精灵工作区会话（ctx.cwd == 解析后工作区路径；旧 Host 兼容
 *   PIABYSS_PIXIE_RESIDENT=1）：dispatch/rest/recall/status/interject/stop/retry
 *   钉回 active tools，report/ask 移出——小精灵的指挥台工具从第一轮就可用。
 * - 普通会话（含被委派的工作区会话）：指挥台工具移出；`pixie_report` +
 *   `pixie_ask` 由 armed 门控加入/剪除——仅已派发（armed）会话可见。
 *
 * 所有工具都经 node:http 直连 127.0.0.1:<PIABYSS_PIXIE_HTTP_PORT>（禁用全局
 * fetch：Host 的代理设置会拦截环回请求），v4 起附带 token 鉴权头
 * （PIABYSS_PIXIE_HTTP_TOKEN → X-Piabyss-Pixie-Token）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildPixieAskTool,
	buildPixieDispatchTool,
	buildPixieInterjectTool,
	buildPixieRecallTool,
	buildPixieReportTool,
	buildPixieRestTool,
	buildPixieRetryTool,
	buildPixieSessionsTool,
	buildPixieStatusTool,
	buildPixieStopTool,
} from "../src/pixie-tools.js";
import { createPixieReportActivationExtension } from "../src/activation.js";
import { createPixieSegmentMemoryExtension } from "../src/segment-memory.js";

export default function (pi: ExtensionAPI) {
	// 注册表全量注册：不在 active tools 中 = 模型不可见（与 v3 report 语义一致）。
	pi.registerTool(buildPixieDispatchTool());
	pi.registerTool(buildPixieReportTool());
	pi.registerTool(buildPixieAskTool());
	pi.registerTool(buildPixieRestTool());
	pi.registerTool(buildPixieRecallTool());
	pi.registerTool(buildPixieStatusTool());
	pi.registerTool(buildPixieSessionsTool());
	pi.registerTool(buildPixieInterjectTool());
	pi.registerTool(buildPixieStopTool());
	pi.registerTool(buildPixieRetryTool());

	// 每轮开始时统一评估角色（cwd 匹配 / 旧 env 标记）与 armed 门控。
	createPixieReportActivationExtension()(pi);
	// 打盹后的记忆：新段首轮注入段索引 + 上一段收尾（只读本地会话目录，不经 Host）。
	createPixieSegmentMemoryExtension()(pi);
}
