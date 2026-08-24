/** git worktree 隔离：子代理在独立工作目录运行，成果由主代理审查后 merge。 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

function git(cwd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
			if (err) resolve({ ok: false, output: stderr || err.message });
			else resolve({ ok: true, output: stdout.trim() });
		});
	});
}

export interface WorktreeResult {
	ok: boolean;
	worktreePath?: string;
	error?: string;
}

/** 判断目录是否为 git 仓库 */
export async function isGitRepo(cwd: string): Promise<boolean> {
	const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	return r.ok && r.output === "true";
}

/** 创建隔离 worktree，分支名 subagent/<runId>，路径 <runDir>/worktree */
export async function createWorktree(cwd: string, runId: string, worktreePath: string): Promise<WorktreeResult> {
	const branch = `subagent/${runId}`;
	const r = await git(cwd, ["worktree", "add", worktreePath, "-b", branch]);
	if (!r.ok) return { ok: false, error: r.output };
	return { ok: true, worktreePath };
}

/** 合并 worktree 分支回主仓库当前分支，然后移除 worktree（保留分支，便于追溯） */
export async function mergeWorktree(cwd: string, runId: string, worktreePath: string): Promise<{ ok: boolean; output: string }> {
	const branch = `subagent/${runId}`;
	const merged = await git(cwd, ["merge", branch, "--no-edit"]);
	if (!merged.ok) return { ok: false, output: `git merge 失败：${merged.output}` };
	const removed = await git(cwd, ["worktree", "remove", "--force", worktreePath]);
	return {
		ok: removed.ok,
		output: `已合并分支 ${branch}${removed.ok ? "，worktree 已清理" : `，但 worktree 清理失败：${removed.output}`}`,
	};
}

/** 检查 worktree 目录是否还存在 */
export function worktreeExists(worktreePath: string | undefined): boolean {
	return Boolean(worktreePath) && fs.existsSync(path.resolve(worktreePath!));
}
