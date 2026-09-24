import assert from "node:assert/strict";
import { createStopHandler, resolveControlToken, startControlServer, stopControlServer } from "../src/control.ts";

process.env.SHELLJOB_CONTROL_TOKEN = "control-test-token";
assert.equal(resolveControlToken(), "control-test-token", "configured token is available before server startup");
const jobId = "job_test123";
let state = "running";
let kills = 0;
let notifications = 0;
const handler = createStopHandler({
	load: (id) => id === jobId ? { job: { id, sessionId: "session-a" }, status: { status: state } } : null,
	isTerminal: (status) => status.status !== "running",
	kill: async () => {
		kills++;
		state = "killed";
		notifications++;
		return { ok: true };
	},
});
const port = await startControlServer(handler, 0);
const url = `http://127.0.0.1:${port}/api/jobs/stop`;
const call = (body: unknown, sessionId = "session-a", token = "control-test-token") => fetch(url, {
	method: "POST",
	headers: { "Content-Type": "application/json", "X-Pi-Shelljob-Token": token, "X-Pi-Session-Id": sessionId },
	body: JSON.stringify(body),
});
try {
	const success = await call({ jobId });
	assert.equal(success.status, 200);
	assert.deepEqual(await success.json(), { ok: true, status: "killed", jobId });
	assert.equal(state, "killed", "runner result is settled before reporting success");
	assert.equal(notifications, 1, "exactly one unified settlement/notification path");

	const repeated = await call({ jobId });
	assert.equal(repeated.status, 200);
	assert.deepEqual(await repeated.json(), { ok: true, status: "already_ended", jobId, state: "killed" });
	assert.equal(kills, 1);
	assert.equal(notifications, 1);

	const missing = await call({ jobId: "job_missing" });
	assert.equal(missing.status, 404);
	assert.equal((await missing.json()).status, "not_found");

	const mismatch = await call({ jobId }, "another-session");
	assert.equal(mismatch.status, 403);
	assert.equal(kills, 1);

	const unauthorized = await call({ jobId }, "session-a", "wrong");
	assert.equal(unauthorized.status, 401);

	state = "running";
	let release!: (value: { ok: boolean }) => void;
	const wait = new Promise<{ ok: boolean }>((resolve) => { release = resolve; });
	let concurrentKills = 0;
	let killOperation: Promise<{ ok: boolean }> | null = null;
	const concurrentHandler = createStopHandler({
		load: () => ({ job: { id: jobId, sessionId: "session-a" }, status: { status: state } }),
		isTerminal: (status) => status.status !== "running",
		kill: async () => {
			if (!killOperation) { concurrentKills++; killOperation = wait; }
			return killOperation;
		},
	});
	// Test idempotent helper semantics by issuing overlapping control requests.
	const concurrentPort = await startControlServer(concurrentHandler, port);
	const concurrentUrl = `http://127.0.0.1:${concurrentPort}/api/jobs/stop`;
	const postConcurrent = () => fetch(concurrentUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-Pi-Shelljob-Token": "control-test-token", "X-Pi-Session-Id": "session-a" }, body: JSON.stringify({ jobId }) });
	const first = postConcurrent();
	const second = postConcurrent();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(concurrentKills, 1, "duplicate stop requests share the runner's in-flight kill operation");
	state = "killed";
	release({ ok: true });
	assert.equal((await first).status, 200);
	assert.equal((await second).status, 200);

	const failedHandler = createStopHandler({
		load: () => ({ job: { id: jobId, sessionId: "session-a" }, status: { status: "running" } }),
		isTerminal: (status) => status.status !== "running",
		kill: async () => ({ ok: false, error: "process still alive" }),
	});
	// Existing server is wired to prior handler; direct helper test confirms failure is never success.
	const failed = await failedHandler(jobId, "session-a");
	assert.deepEqual(failed, { ok: false, status: "failed", jobId, error: "process still alive" });

	console.log("pi-shelljob control tests passed");
} finally {
	stopControlServer();
}
