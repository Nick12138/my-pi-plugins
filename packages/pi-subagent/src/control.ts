/** 进程控制（Windows）：停止用 taskkill，暂停/继续用 ntdll 的 NtSuspendProcess/NtResumeProcess。
 *
 * 注意：taskkill 并不支持 /SUSPEND /RESUME（那是 Sysinternals pssuspend 的用法），
 * 旧实现用它挂起进程必然失败但错误被吞掉，导致“已暂停”只是改了状态标签、进程照跑。
 * 这里改为 PowerShell P/Invoke ntdll 的 NtSuspendProcess/NtResumeProcess 递归挂起进程树。
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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

/** 定位 powershell.exe（优先 SystemRoot 完整路径，兜底依赖 PATH） */
let psPath: string | undefined;
function resolvePowerShell(): string | undefined {
	if (psPath) return psPath;
	const sysRoot = process.env.SystemRoot;
	const full = sysRoot ? path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "";
	if (full && fs.existsSync(full)) {
		psPath = full;
		return psPath;
	}
	psPath = "powershell.exe"; // 兜底：依赖 PATH
	return psPath;
}

/**
 * 挂起/恢复目标 pid 的整个进程树（递归收集子进程后逐个调用 NtSuspendProcess/NtResumeProcess）。
 * 成功返回空串；失败返回错误文本。
 */
function suspendResumeTree(pid: number, mode: "suspend" | "resume"): Promise<string> {
	const ps = resolvePowerShell();
	if (!ps) return Promise.resolve("找不到 powershell.exe，无法挂起/恢复进程");
	const script = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Native {
    [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
    [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
function Invoke-OnTree([int]$RootPid, [string]$Mode) {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $targets = New-Object 'System.Collections.Generic.List[int]'
    function Add-Tree([int]$p) {
        if ($targets.Contains($p)) { return }
        $targets.Add($p)
        foreach ($c in $all) { if ($c.ParentProcessId -eq $p) { Add-Tree ([int]$c.ProcessId) } }
    }
    Add-Tree $RootPid
    # 根进程打不开（已退出/权限不足）直接报错，避免“暂停成功”但什么都没挂起
    $rootHandle = [Native]::OpenProcess(0x0800, $false, [uint32]$RootPid)
    if ($rootHandle -eq [IntPtr]::Zero) { throw "cannot open root pid $RootPid (process may have exited)" }
    [Native]::CloseHandle($rootHandle) | Out-Null
    foreach ($t in $targets) {
        $h = [Native]::OpenProcess(0x0800, $false, [uint32]$t) # PROCESS_SUSPEND_RESUME
        if ($h -ne [IntPtr]::Zero) {
            try {
                if ($Mode -eq 'suspend') { $r = [Native]::NtSuspendProcess($h) } else { $r = [Native]::NtResumeProcess($h) }
            } finally {
                [Native]::CloseHandle($h) | Out-Null
            }
            if ($r -ne 0) { throw "NTSTATUS $r on pid $t (mode $Mode)" }
        }
    }
    "OK"
}
try {
    Invoke-OnTree ${pid} ${mode}
} catch {
    # 错误文本输出到 stdout（避免 CLIXML/GBK 乱码），退出码非 0
    "ERROR: $($_.Exception.Message)"
    exit 1
}
`;
	return new Promise((resolve) => {
		execFile(
			ps,
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-EncodedCommand",
				Buffer.from(script, "utf16le").toString("base64"),
			],
			{ windowsHide: true, timeout: 30000 },
			(err, stdout, stderr) => {
				if (err) {
					// 脚本出错时退出码非 0：优先用 stdout 里的 ERROR 行（干净、无编码乱码）
					const out = stdout.trim();
					if (out.startsWith("ERROR:")) resolve(out.slice(6).trim());
					else resolve(stderr.trim() || err.message);
				} else if (stdout.trim().startsWith("OK")) resolve("");
				else if (stdout.trim().startsWith("ERROR:")) resolve(stdout.trim().slice(6).trim());
				else resolve(stdout.trim() || "挂起/恢复失败（未知错误）");
			},
		);
	});
}

/** 暂停：挂起进程树（NtSuspendProcess）。成功返回空串，失败返回错误文本。 */
export async function pauseProcess(pid: number): Promise<string> {
	return suspendResumeTree(pid, "suspend");
}

/** 继续：恢复被挂起的进程树（NtResumeProcess）。成功返回空串，失败返回错误文本。 */
export async function continueProcess(pid: number): Promise<string> {
	return suspendResumeTree(pid, "resume");
}
