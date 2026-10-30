/** 模型串工具：解析 provider/id 形态、比对「要求 vs 实际」运行的模型。 */

/**
 * 拆出模型串里的 provider 与模型 id。
 *
 * 支持 `provider/id`（按**第一个** `/` 切）与可选的 `:thinking` 后缀（后缀留在 id 上，
 * 由 CLI 自己处理，本函数不动）。不含 `/` 或切分后任一半为空（`/xxx`、`xxx/`）时
 * 返回 `undefined`——调用方应回退到「不限定 provider」的原行为，别传空字符串。
 */
export function splitProviderModel(model: string | undefined | null): { provider: string; modelId: string } | undefined {
	if (!model) return undefined;
	const idx = model.indexOf("/");
	if (idx < 0) return undefined;
	const provider = model.slice(0, idx).trim();
	const modelId = model.slice(idx + 1).trim();
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

/** 取模型串的模型 id 部分（剥掉 `provider/` 前缀与 `:thinking` 后缀），用于同 id 比对。 */
export function bareModelId(model: string | undefined | null): string {
	if (!model) return "";
	const idx = model.indexOf("/");
	const id = idx >= 0 ? model.slice(idx + 1) : model;
	const colon = id.indexOf(":");
	return (colon >= 0 ? id.slice(0, colon) : id).trim();
}

/**
 * 「实际运行模型 ≠ 要求模型」的告警句；一致或信息不足时返回空串。
 *
 * 为什么要这个：子进程的模型由 CLI 按 `--model` 模糊解析，撞车的同 id 模型可能落到
 * 另一个 provider（本机实测 `deepseek-v4.1-flash` 同时存在于 free / workbuddy，
 * 结果 message_start.provider 是 free 而不是要求的 workbuddy）。通知与 result 里
 * 展示的一直是**响应**里的模型，静默被换掉时人看不出来，所以显式比对一次。
 * 只比模型 id 部分：provider 差异（或实际响应只回 id 不回 provider）不算不一致。
 */
export function modelMismatchWarning(requested: string | undefined | null, actual: string | undefined | null): string {
	const want = bareModelId(requested);
	const got = bareModelId(actual);
	if (!want || !got || want === got) return "";
	return `⚠️ 实际运行模型 ${actual} ≠ 要求 ${requested}`;
}
