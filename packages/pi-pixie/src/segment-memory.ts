/**
 * 换段后的记忆接线：新段的第一条用户消息之前，注入「运行契约 + 段索引 + 上一段收尾」。
 *
 * 与 activation.ts 的分工：那边只管工具可见性，这边只管上下文内容，两者都只在
 * 小精灵常驻会话里做事。注入时机用会话条目本身判定（没有用户消息、也没有本插件
 * 的卡片），不靠进程内状态——Host 重启、段索引丢失都不会重复灌卡片或灌错轮。
 *
 * v0.10 起卡片里内嵌 `<pixie-context>` 运行契约（委派/回调/automation 规范）：
 * 契约此前由桌面宿主在 prompt 前导里注入，只有走桌面端界面发消息才带；
 * 裸 `pi` CLI 打开小精灵工作区时模型完全拿不到。现在归插件，因此**没有历史段
 * 也要注入**——全新工作区恰恰是最需要契约的场景。
 *
 * 任何一步失败都退化成「不注入」，绝不抛出——卡片没了不影响 agent 启动。
 *
 * 过渡期防双写：未升级的桌面宿主仍会把同款 `<pixie-context>` 包在首条用户
 * 消息外层。这里看一眼本轮 prompt：已带契约就只出回顾部分（卡片仍要注入，段索引
 * 与收尾不能丢），避免段首出现两份契约。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPixieResidentSession } from "./activation.js";
import { PIXIE_CONTEXT_TAG } from "./pixie-context.js";
import {
	DEFAULT_INDEX_SEGMENTS,
	PIXIE_SEGMENT_CUSTOM_TYPE,
	buildHandoffCard,
	needsHandoffCard,
	sessionPathFromCtx,
} from "./segments.js";

/** 本轮 prompt 是否已被旧 Host 包上契约前导（只认开标签，不做全文比对）。 */
export function promptCarriesContext(event: unknown): boolean {
	const prompt = (event as { prompt?: unknown } | undefined)?.prompt;
	return typeof prompt === "string" && prompt.includes(`<${PIXIE_CONTEXT_TAG}>`);
}

export function createPixieSegmentMemoryExtension(options: {
	isResident?: (ctx?: ExtensionContext) => boolean;
	getSessionDir?: (ctx?: unknown) => string | null;
	getSessionFile?: (ctx?: unknown) => string | null;
	needsCard?: (ctx?: unknown) => boolean;
	maxSegments?: number;
	/** 已知工作区来源目录；默认按 env 解析 agentDir。 */
	agentDir?: string;
	/** 时间锚点；默认现跑 new Date()。 */
	now?: () => Date;
} = {}): (pi: ExtensionAPI) => void {
	const isResident = options.isResident ?? isPixieResidentSession;
	const getSessionDir = options.getSessionDir ?? ((ctx?: unknown) => sessionPathFromCtx(ctx, "getSessionDir"));
	const getSessionFile = options.getSessionFile ?? ((ctx?: unknown) => sessionPathFromCtx(ctx, "getSessionFile"));
	const needsCard = options.needsCard ?? needsHandoffCard;
	const maxSegments = options.maxSegments ?? DEFAULT_INDEX_SEGMENTS;

	return (pi: ExtensionAPI): void => {
		pi.on("before_agent_start", async (_event, ctx) => {
			try {
				if (!isResident(ctx)) return;
				if (!needsCard(ctx)) return;
				const sessionDir = getSessionDir(ctx);
				if (!sessionDir) return;
				const card = buildHandoffCard({
					sessionDir,
					currentFile: getSessionFile(ctx),
					maxSegments,
					agentDir: options.agentDir,
					now: options.now?.(),
					// 旧 Host 已给这一轮包上契约 → 卡片只补回顾，不重复契约。
					context: promptCarriesContext(_event) ? "" : undefined,
				});
				return { message: { customType: PIXIE_SEGMENT_CUSTOM_TYPE, content: card, display: true } };
			} catch {
				return;
			}
		});
	};
}
