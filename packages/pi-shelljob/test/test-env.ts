/** 测试环境隔离：必须作为每个测试文件的【第一个 import】。
 * 把任务目录与控制面根重定向到临时目录，避免与运行中的宿主互相干扰：
 * - 宿主的监控循环会扫描共享的 ~/.pi/shelljob/jobs，把测试里刚被 kill、
 *   还没 settle 的任务误判为「遗留僵尸」强行接管（历史上导致 smoke 用例随机挂）；
 * - control 测试会重写共享的 ~/.pi/shelljob/token，导致 PiDeck 界面的停止按钮鉴权失效。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shelljob-test-"));
process.env.SHELLJOB_JOBS_ROOT ??= path.join(root, "jobs");
process.env.SHELLJOB_CONTROL_ROOT ??= root;
