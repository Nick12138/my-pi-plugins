/**
 * pi-pixie — Pixie 委派/回调工具的插件侧壳（引擎仍在 PiAbyss Host 侧）。
 *
 * - `pixie_dispatch`：仅在常驻小精灵会话注册/激活。Host 在该会话注入环境
 *   标记 PIABYSS_PIXIE_RESIDENT=1；普通会话不注册该工具。执行 = POST
 *   /api/pixie/dispatch（Host 环回控制面），成功后立即返回受理结果。
 * - `pixie_report`：注册在每个非小精灵会话上，但由激活门控保持在 active
 *   tools 之外——扩展在 before_agent_start 调 GET
 *   /api/pixie/dispatch-state?sessionId=<当前会话id>，仅 armed 时把它加入
 *   active tools，保持「普通工作区会话看不到该工具」的安全语义。端口环境
 *   变量缺失或请求失败一律视为未 armed，且不影响 agent 启动。
 *
 * 两个工具都经 node:http 直连 127.0.0.1:<PIABYSS_PIXIE_HTTP_PORT>（禁用
 * 全局 fetch：Host 的代理设置会拦截环回请求）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildPixieDispatchTool, buildPixieReportTool, PIXIE_DISPATCH_NAME } from "../src/pixie-tools.js";
import { createPixieReportActivationExtension } from "../src/activation.js";
import { PIXIE_RESIDENT_ENV } from "../src/http-client.js";

export default function (pi: ExtensionAPI) {
	const resident = process.env[PIXIE_RESIDENT_ENV] === "1";

	if (resident) {
		// 常驻小精灵会话：委派工具始终激活；report 工具与小精灵会话无关，
		// 不注册也不参与门控。
		pi.registerTool(buildPixieDispatchTool());
		// 每轮开始时用 setActiveTools 把 dispatch 钉回 active tools：
		// 即便其他扩展或用户操作剪掉了它，小精灵会话也必须始终可用。
		pi.on("before_agent_start", () => {
			let active: string[];
			try {
				active = pi.getActiveTools();
			} catch {
				return;
			}
			if (!active.includes(PIXIE_DISPATCH_NAME)) {
				pi.setActiveTools([...active, PIXIE_DISPATCH_NAME]);
			}
		});
		return;
	}

	// 普通会话（含被委派的工作区会话）：注册 report 工具，由激活门控在
	// 每个 before_agent_start 统一加入/剪除 active tools。
	pi.registerTool(buildPixieReportTool());
	createPixieReportActivationExtension()(pi);
}
