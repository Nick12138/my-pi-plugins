/**
 * pi-pixie — Pixie 委派/回调/询问/打盹工具的插件侧壳（引擎仍在 PiAbyss Host）。
 *
 * v4（工作区化）：四个工具都注册到每个会话的工具注册表，可见性完全由
 * before_agent_start 的 active-tools 门控统一管理（src/activation.ts）：
 *
 * - 小精灵工作区会话（ctx.cwd == 解析后工作区路径；旧 Host 兼容
 *   PIABYSS_PIXIE_RESIDENT=1）：`pixie_dispatch` + `pixie_rest` 钉回 active
 *   tools，`pixie_report`/`pixie_ask` 移出——即便其他扩展或用户操作剪掉了
 *   它们，小精灵会话也必须始终可用。
 * - 普通会话（含被委派的工作区会话）：dispatch/rest 移出；`pixie_report` +
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
	buildPixieReportTool,
	buildPixieRestTool,
} from "../src/pixie-tools.js";
import { createPixieReportActivationExtension } from "../src/activation.js";

export default function (pi: ExtensionAPI) {
	// 注册表全量注册：不在 active tools 中 = 模型不可见（与 v3 report 语义一致）。
	pi.registerTool(buildPixieDispatchTool());
	pi.registerTool(buildPixieReportTool());
	pi.registerTool(buildPixieAskTool());
	pi.registerTool(buildPixieRestTool());

	// 每轮开始时统一评估角色（cwd 匹配 / 旧 env 标记）与 armed 门控。
	createPixieReportActivationExtension()(pi);
}
