/**
 * OCR (Baidu) — pi plugin port of the baidu_ocr skill.
 *
 * Calls the Baidu Cloud OCR general_basic endpoint (standard edition,
 * 50,000 free calls/day) to recognize text in images.
 *
 * Always sends detect_direction=true, paragraph=true, probability=true so
 * rotated / sideways photos get a usable result and recognition quality is
 * inspectable (direction + average probability are reported back).
 *
 * Certificates (certificate flow in the original skill):
 *   When the recognized text contains keywords like 营业执照 / 居民身份证,
 *   the tool output hints at which dedicated Baidu OCR endpoint would give a
 *   more structured result. Cross-check important fields against the image.
 *
 * Configuration (environment variables, usually set from the plugin's
 * config UI — see plugins.json in the repo root):
 *   - BAIDU_OCR_API_KEY    : required (text, secret)
 *   - BAIDU_OCR_SECRET_KEY : required (text, secret)
 *
 * Notes:
 *   - Image base64 must not exceed 4MB; longest side should not exceed 4096px.
 *   - This plugin never prints, returns, or writes the API keys anywhere.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const OCR_URL = "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic";
const BASE64_LIMIT = 4 * 1024 * 1024; // Baidu caps base64 payload at 4MB
const REQUEST_TIMEOUT_MS = 60_000;

const CERTIFICATE_HINTS: Array<{ keyword: RegExp; endpoint: string; label: string }> = [
	{ keyword: /营业执照|统一社会信用代码|经营范围|登记机关/, endpoint: "business_license", label: "营业执照识别" },
	{ keyword: /居民身份证|公民身份号码/, endpoint: "idcard", label: "身份证识别" },
	{ keyword: /发票代码|发票号码/, endpoint: "vat_invoice", label: "发票识别" },
	{ keyword: /驾驶证|准驾车型/, endpoint: "driving_license", label: "驾驶证识别" },
	{ keyword: /行驶证|机动车行驶证/, endpoint: "vehicle_license", label: "行驶证识别" },
];

interface TokenResponse {
	access_token?: string;
	error?: string;
	error_description?: string;
}

interface WordsItem {
	words?: string;
	probability?: { average?: number };
}

interface OcrResponse {
	error_code?: number;
	error_msg?: string;
	direction?: number;
	paragraphs?: number;
	words_result_num?: number;
	words_result?: WordsItem[];
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function readCredentials(): { apiKey: string; secretKey: string } | { error: string } {
	const apiKey = process.env.BAIDU_OCR_API_KEY?.trim();
	const secretKey = process.env.BAIDU_OCR_SECRET_KEY?.trim();
	if (!apiKey || !secretKey) {
		return {
			error:
				"BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY is not set. " +
				"Create an OCR app at https://console.bce.baidu.com/ai/ (文字识别 → 应用列表 → 创建应用), " +
				"then paste both keys into this plugin's config.",
		};
	}
	return { apiKey, secretKey };
}

async function postForm<T>(url: string, data: Record<string, string>, signal?: AbortSignal): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(data).toString(),
		signal: requestSignal(signal),
	});
	const text = await res.text();
	let parsed: T;
	try {
		parsed = JSON.parse(text) as T;
	} catch {
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
	}
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
	return parsed;
}

async function getAccessToken(apiKey: string, secretKey: string, signal?: AbortSignal): Promise<string> {
	const data = await postForm<TokenResponse>(
		TOKEN_URL,
		{ grant_type: "client_credentials", client_id: apiKey, client_secret: secretKey },
		signal,
	);
	if (!data.access_token) {
		throw new Error(
			`Access token failed: ${data.error_description || data.error || "unknown error"} ` +
				"(check API Key / Secret Key and account permissions)",
		);
	}
	return data.access_token;
}

async function recognize(imagePath: string, signal?: AbortSignal): Promise<OcrResponse> {
	const creds = readCredentials();
	if ("error" in creds) throw new Error(creds.error);

	const abs = path.resolve(imagePath);
	const info = await stat(abs).catch(() => null);
	if (!info?.isFile()) throw new Error(`Image not found: ${abs}`);

	const encoded = (await readFile(abs)).toString("base64");
	if (encoded.length > BASE64_LIMIT) {
		throw new Error(
			`Image base64 exceeds the 4MB limit (${Math.round(encoded.length / 1024 / 1024)}MB). ` +
				"Compress the image (and keep the longest side ≤ 4096px) before retrying.",
		);
	}

	const token = await getAccessToken(creds.apiKey, creds.secretKey, signal);
	const result = await postForm<OcrResponse>(
		`${OCR_URL}?access_token=${encodeURIComponent(token)}`,
		{ image: encoded, detect_direction: "true", paragraph: "true", probability: "true" },
		signal,
	);
	if (result.error_code != null) {
		throw new Error(`Baidu OCR error ${result.error_code}: ${result.error_msg || "unknown error"}`);
	}
	return result;
}

function formatResult(result: OcrResponse): string {
	const items = result.words_result ?? [];
	const words = items.map((i) => (typeof i.words === "string" ? i.words : ""));
	const text = words.join("\n").trim();

	const probs = items
		.map((i) => i.probability?.average)
		.filter((p): p is number => typeof p === "number" && Number.isFinite(p));
	const avgProb = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null;

	const hints = CERTIFICATE_HINTS.filter((h) => h.keyword.test(text))
		.map((h) => `${h.label}（${h.endpoint}）`)
		.join("、 ");

	const header = [
		typeof result.direction === "number" ? `Direction: ${result.direction}` : null,
		typeof result.words_result_num === "number" ? `Lines: ${result.words_result_num}` : null,
		avgProb != null ? `Avg probability: ${avgProb.toFixed(3)}` : null,
	].filter(Boolean);

	const lines = [...header, "", text || "(no text recognized — check image clarity and size limits)"];
	if (hints) {
		lines.push(
			"",
			`Certificate keywords detected: consider re-checking with ${hints}. ` +
				"Structured endpoints may add inferred fields — cross-check important fields against this raw result or the original image.",
		);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ocr_image",
		label: "OCR (Baidu)",
		description:
			"Recognize text in an image file with Baidu Cloud OCR (general_basic, standard edition, " +
			"50k free calls/day). Direction detection, paragraph info and recognition probability are " +
			"always requested, so sideways/rotated photos still work. " +
			"Requires BAIDU_OCR_API_KEY and BAIDU_OCR_SECRET_KEY (env / plugin config). " +
			"Limits: base64 ≤ 4MB, longest side ≤ 4096px.",
		promptSnippet: "Recognize text in an image via Baidu OCR (needs BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY)",
		promptGuidelines: [
			"Use ocr_image when the user asks to extract/recognize text from a local image, screenshot, or photo.",
			"When the result mentions 营业执照/身份证/发票/驾驶证/行驶证 keywords, treat dedicated endpoints as more structured but not verbatim — cross-check important fields against the raw result or the image.",
			"Never print or log the API keys; they live only in the process environment.",
		],
		parameters: Type.Object({
			imagePath: Type.String({ description: "Path to the image file (jpg/png/bmp/gif; base64 ≤ 4MB; longest side ≤ 4096px)" }),
		}),

		async execute(_toolCallId, params, signal) {
			try {
				const result = await recognize(params.imagePath, signal);
				const items = result.words_result ?? [];
				return toolResult(formatResult(result), {
					source: path.resolve(params.imagePath),
					lineCount: typeof result.words_result_num === "number" ? result.words_result_num : items.length,
					direction: result.direction,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return toolResult(`OCR failed: ${message}`, { error: message });
			}
		},
	});
}
