/** 测试钩子：路由器在 session_start 时被注入 scheduler.deps.onSettled，这里借道调用。 */
import { scheduler } from "../src/scheduler.ts";
import type { RunRecord } from "../src/types.ts";

export function routeSettledForTest(run: RunRecord): void {
	scheduler.deps.onSettled(run);
}
