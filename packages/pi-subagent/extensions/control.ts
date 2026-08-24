/** 进程控制（Windows）：停止/暂停/继续，全部通过 taskkill 实现。 */
import { execFile } from "node:child_process";

function taskkill(args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile("taskkill", args, { windowsHide: true }, (err, stdout, stderr) => {
			if (err) resolve(stderr || err.message);
			else resolve(stdout);
		});
	});
}

/** 停止：强制终止进程树 */
export async function stopProcess(pid: number): Promise<string> {
	return taskkill(["/PID", String(pid), "/T", "/F"]);
}

/** 暂停：挂起进程（Windows 7+ 的 taskkill /SUSPEND） */
export async function pauseProcess(pid: number): Promise<string> {
	return taskkill(["/PID", String(pid), "/SUSPEND"]);
}

/** 继续：恢复被挂起的进程 */
export async function continueProcess(pid: number): Promise<string> {
	return taskkill(["/PID", String(pid), "/RESUME"]);
}
