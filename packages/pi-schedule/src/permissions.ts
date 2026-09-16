/**
 * 权限档位 → 工具白名单。
 *
 * 语义与「只读 / 可写 / 全权」三档严格对应，且是**结构性生效**：
 * 白名单直接传给 createAgentSession({ tools })，越权工具在会话里根本不存在，
 * 不依赖 prompt 措辞约束（无人值守场景绝不能弹窗确认）。
 */
import { ScheduleError } from "./schedule.ts";
import type { PermissionTier } from "./types.ts";

/** 只读：检索/阅读，不含任何执行或写入。 */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** 可写：只读 + 改文件，但仍**不含 bash**（不能跑命令/脚本/提交）。 */
export const WRITE_TOOLS = [...READ_ONLY_TOOLS, "edit", "write"] as const;

/**
 * full 档返回 undefined = 不传白名单，交给 pi 用默认工具集
 * （read/bash/edit/write/grep/find/ls + 已加载的扩展工具）。
 */
export function toolsForPermission(tier: PermissionTier): string[] | undefined {
	switch (tier) {
		case "read_only":
			return [...READ_ONLY_TOOLS];
		case "write":
			return [...WRITE_TOOLS];
		case "full":
			return undefined;
		default:
			// 关键：未知档位必须报错，绝不能回退成「不传白名单」——那等于 full 权限。
			throw new ScheduleError(`未知权限档位：${String(tier)}（可选 read_only / write / full）`);
	}
}

/** 审计用：把实际生效的白名单记成字符串数组（full 记 ["*"]）。 */
export function toolsForAudit(tier: PermissionTier): string[] {
	return toolsForPermission(tier) ?? ["*"];
}

export function isPermissionTier(value: unknown): value is PermissionTier {
	return value === "read_only" || value === "write" || value === "full";
}

/** 校验并返回权限档位；非法值报错（防止未知值被当成 full，HTTP 层会映射为 400）。 */
export function assertPermissionTier(value: unknown): PermissionTier {
	if (!isPermissionTier(value)) {
		throw new ScheduleError(`permission 非法：${String(value)}（可选 read_only / write / full）`);
	}
	return value;
}

export const PERMISSION_LABEL: Record<PermissionTier, string> = {
	read_only: "只读",
	write: "可写",
	full: "全权",
};
