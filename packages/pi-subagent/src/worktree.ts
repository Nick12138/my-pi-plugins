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

/** 合并 worktree 分支回主仓库当前分支，然后移除 worktree（保留分支，便于追溯）。
 * 注意：子代理在 worktree 里的改动通常未提交（untracked/modified），
 * 直接 git merge 分支只能合并已提交内容。因此合并前先把 worktree 工作树改动
 * 以临时 identity 提交到分支上，再 merge，最后移除 worktree。 */
export async function mergeWorktree(cwd: string, runId: string, worktreePath: string): Promise<{ ok: boolean; output: string }> {
	const branch = `subagent/${runId}`;

	// 1) 提交 worktree 内的未提交改动（若有）到分支。
	// --ignore-errors：子代理可能留下无法索引的文件（如 Windows 设备名 nul），
	// 此时 add 返回非 0 但正常文件仍会 stage，不应让整个 merge 失败。
	await git(worktreePath, ["add", "-A", "--ignore-errors"]);
	const status = await git(worktreePath, ["status", "--porcelain"]);
	if (status.ok && status.output) {
		const commit = await git(worktreePath, [
			"-c", "user.name=pi-subagent",
			"-c", "user.email=pi-subagent@local",
			"commit", "-m", `subagent ${runId} changes`,
		]);
		if (!commit.ok) return { ok: false, output: `worktree 提交失败：${commit.output}` };
	}

	// 2) 合并分支到主仓库
	const merged = await git(cwd, ["merge", branch, "--no-edit"]);
	if (!merged.ok) return { ok: false, output: `git merge 失败：${merged.output}` };

	// 3) 移除 worktree（保留分支，便于追溯）
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
