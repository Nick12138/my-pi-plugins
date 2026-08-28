/**
 * OCR (Baidu) — pi plugin port of the baidu_ocr skill.
 *
 * Calls Baidu Cloud OCR endpoints to recognize text in images. Quota follows
 * the Baidu console: unpaid personal accounts get ~1,000 free calls/month
 * (enterprise ~2,000) and 2 QPS; after enabling pay-as-you-go it becomes
 * 10 QPS with per-call billing. 高精度版（accurate_basic）额度与标准版相同.
 *
 * Tools:
 *   - ocr_image       : single image, accuracy switch
 *                       (standard general_basic / accurate accurate_basic).
 *                       Optional outputPath appends a txt record.
 *   - ocr_images      : batch. Bounded concurrency (default 2 — safe for
 *                       unpaid 2 QPS accounts; max 10) with per-image error
 *                       isolation. Optional outputPath appends the WHOLE
 *                       request as ONE txt record.
 *   - ocr_certificate : structured recognition for certificates
 *                       (business_license / idcard / driving_license /
 *                       vehicle_license / vat_invoice) returning fields
 *                       instead of free text; idcard needs side=front/back.
 *                       Optional outputPath appends one txt record.
 *
 * Always sends detect_direction=true, paragraph=true, probability=true on the
 * general endpoints so rotated / sideways photos still get usable results
 * (direction + average probability are reported back).
 *
 * Error handling:
 *   - Baidu error codes are mapped to actionable hints (17 = daily quota
 *     exhausted, 18 = QPS limit → lower concurrency / open pay-as-you-go,
 *     19 = total quota, 216630/216631 = blurry image, ...).
 *   - Stale/invalid access token (100/110/111) is invalidated and re-fetched
 *     once before giving up.
 *
 * Output behaviour:
 *   - Results are ALWAYS returned to the conversation (tool return value).
 *   - When outputPath is provided, the request record is APPENDED to that txt
 *     file (UTF-8, BOM added on file creation so 记事本/WPS detect encoding;
 *     missing parent directories are created). Disk records always keep the
 *     full text; the conversation copy may be truncated per image in batch.
 *
 * Configuration (environment variables, usually set from the plugin's
 * config UI — see plugins.json in the repo root):
 *   - BAIDU_OCR_API_KEY    : required (text, secret)
 *   - BAIDU_OCR_SECRET_KEY : required (text, secret)
 *
 * Notes:
 *   - Image base64 must not exceed 4MB; longest side should not exceed 4096px.
 *   - Access tokens are cached in-memory (30-day validity per Baidu) and the
 *     concurrent token fetch is de-duplicated, so a batch only ever issues one
 *     token request.
 *   - Baidu officially does NOT offer a batch interface for local files; the
 *     documented recommendation is multi-threaded calls within the QPS limit,
 *     which is exactly what ocr_images implements.
 *   - This plugin never prints, returns, or writes the API keys anywhere.
 */

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const OCR_ENDPOINTS = {
	general: "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic",
	accurate: "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic",
	business_license: "https://aip.baidubce.com/rest/2.0/ocr/v1/business_license",
	idcard: "https://aip.baidubce.com/rest/2.0/ocr/v1/idcard",
	driving_license: "https://aip.baidubce.com/rest/2.0/ocr/v1/driving_license",
	vehicle_license: "https://aip.baidubce.com/rest/2.0/ocr/v1/vehicle_license",
	vat_invoice: "https://aip.baidubce.com/rest/2.0/ocr/v1/vat_invoice",
} as const;

const BASE64_LIMIT = 4 * 1024 * 1024; // Baidu caps base64 payload at 4MB
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 2; // unpaid accounts: 2 QPS; paid (pay-as-you-go): 10 QPS
const MAX_CONCURRENCY = 10;
// Per-image context cap for batch when outputPath is set (disk record keeps full text)
const CONTEXT_TRUNCATE_CHARS = 1200;

const SEP_HEAVY = "=".repeat(48);
const SEP_LIGHT = "-".repeat(48);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Accuracy = "standard" | "accurate";

const CERTIFICATE_TYPES = [
	"business_license",
	"idcard",
	"driving_license",
	"vehicle_license",
	"vat_invoice",
] as const;
type CertificateType = (typeof CERTIFICATE_TYPES)[number];

interface TokenResponse {
	access_token?: string;
	expires_in?: number;
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

interface ImageOutcome {
	absPath: string;
	ok: boolean;
	result?: OcrResponse;
	error?: string;
}

/** Certificate type → display label and field-name → Chinese label map. */
interface CertificateDef {
	label: string;
	fieldLabels: Record<string, string>;
}

// Keywords that hint at the dedicated ocr_certificate endpoint.
const CERTIFICATE_HINTS: Array<{ keyword: RegExp; type: CertificateType }> = [
	{ keyword: /营业执照|统一社会信用代码|经营范围|登记机关/, type: "business_license" },
	{ keyword: /居民身份证|公民身份号码/, type: "idcard" },
	{ keyword: /发票代码|发票号码/, type: "vat_invoice" },
	{ keyword: /驾驶证|准驾车型/, type: "driving_license" },
	{ keyword: /行驶证|机动车行驶证/, type: "vehicle_license" },
];

// Field maps follow Baidu API docs; unmapped keys fall back to the raw key.
const CERTIFICATE_DEFS: Record<CertificateType, CertificateDef> = {
	business_license: {
		label: "营业执照",
		fieldLabels: {
			register: "注册号",
			credit_code: "统一社会信用代码",
			company: "企业名称",
			type: "类型",
			address: "地址",
			legal_person: "法定代表人",
			capital: "注册资本",
			establish_date: "成立日期",
			business_scope: "经营范围",
			validity_period: "有效期限",
			certificate_id: "证件编号",
		},
	},
	idcard: {
		label: "居民身份证",
		fieldLabels: {
			name: "姓名",
			sex: "性别",
			nation: "民族",
			birth: "出生",
			address: "住址",
			id_number: "身份证号码",
			issue_authority: "签发机关",
			validity: "有效期限",
		},
	},
	driving_license: {
		label: "驾驶证",
		fieldLabels: {
			name: "姓名",
			sex: "性别",
			nationality: "国籍",
			address: "住址",
			id_number: "证件号码",
			birth_date: "出生日期",
			issue_date: "初次领证日期",
			class: "准驾车型",
			valid_from: "有效起始日期",
			valid_to: "有效截止日期",
			valid_for: "有效期至（长期）",
			issuing_authority: "签发机关",
			record: "档案编号",
		},
	},
	vehicle_license: {
		label: "行驶证",
		fieldLabels: {
			vehicle_type: "车辆类型",
			plate_no: "号牌号码",
			owner: "所有人",
			address: "住址",
			use_character: "使用性质",
			model: "品牌型号",
			vin: "车辆识别代号",
			engine_no: "发动机号码",
			register_date: "注册日期",
			issue_date: "发证日期",
			issue_authority: "签发机关",
			file_no: "档案编号",
		},
	},
	vat_invoice: {
		label: "增值税发票",
		fieldLabels: {
			InvoiceType: "发票类型",
			InvoiceCode: "发票代码",
			InvoiceNum: "发票号码",
			InvoiceDate: "开票日期",
			AmountInFiguers: "合计金额(小写)",
			AmountInWords: "合计金额(大写)",
			Type: "发票类型",
			CheckCode: "校验码",
			Province: "省份",
			City: "城市",
			PurchaserName: "购买方名称",
			PurchaserRegisterNum: "购买方纳税人识别号",
			SellerName: "销售方名称",
			SellerRegisterNum: "销售方纳税人识别号",
			Password: "密码区",
			CommodityName: "商品名称",
			CommodityType: "商品种类",
			CommodityPrice: "单价",
			CommodityNum: "数量",
			CommodityAmount: "金额",
			CommodityTaxRate: "税率",
			CommodityTaxAmount: "税额",
			Remarks: "备注",
			MakerName: "开票人",
			Payee: "收款人",
			Checker: "复核人",
		},
	},
};

// ---------------------------------------------------------------------------
// Low-level plumbing
// ---------------------------------------------------------------------------

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

// Access token cache: 30-day validity (Baidu default), keyed by API key pair;
// in-flight fetch is shared across concurrent calls (single token request per batch).
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
let tokenInflight: Promise<string> | null = null;
let tokenInflightKey = "";

async function getAccessTokenCached(apiKey: string, secretKey: string): Promise<string> {
	const cacheKey = `${apiKey}\u0000${secretKey}`;
	const hit = tokenCache.get(cacheKey);
	if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
	if (tokenInflight && tokenInflightKey === cacheKey) return tokenInflight;

	tokenInflightKey = cacheKey;
	tokenInflight = (async () => {
		const data = await postForm<TokenResponse>(
			TOKEN_URL,
			{ grant_type: "client_credentials", client_id: apiKey, client_secret: secretKey },
			undefined,
		);
		if (!data.access_token) {
			throw new Error(
				`Access token failed: ${data.error_description || data.error || "unknown error"} ` +
					"(check API Key / Secret Key and account permissions)",
			);
		}
		tokenCache.set(cacheKey, {
			token: data.access_token,
			expiresAt: Date.now() + (data.expires_in ?? 2_592_000) * 1000,
		});
		return data.access_token;
	})().finally(() => {
		tokenInflight = null;
		tokenInflightKey = "";
	});
	return tokenInflight;
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

const TOKEN_ERROR_CODES = [100, 110, 111];

/** Map Baidu error codes to actionable hints (quota / QPS / image quality). */
function baiduErrorHint(code: number, msg: string): string {
	const hints: Record<number, string> = {
		4: "集群超限额，稍后重试",
		17: "当日可用额度已用尽（免费测试资源：个人认证约 1000 次/月，企业认证 2000 次/月，标准版与高精度版共用各自额度）——去控制台核对配额，或开通按量后付费继续使用",
		18: "QPS 超限（未付费账号通常 2 QPS）——把 ocr_images 的 concurrency 降到 2，或开通按量后付费升到 10 QPS / 购买 QPS 叠加包",
		19: "请求总量超限——去控制台核对配额",
		100: "access_token 无效或过期，已自动重取并重试（仍失败则检查 API Key / Secret Key）",
		110: "access_token 无效，已自动重取并重试（仍失败则检查 API Key / Secret Key）",
		111: "access_token 过期，已自动重取并重试",
		216102: "图片格式不支持（支持 jpg/png/bmp/gif）",
		216103: "图片太小或质量过差，识别不出有效文字",
		216200: "图片为空或格式错误",
		216201: "图片格式错误",
		216202: "图片大小错误（base64 ≤ 4MB、最长边 ≤ 4096px）",
		216203: "图片转码失败",
		216630: "图片模糊/过暗，识别质量差——换更清晰的图，或改用 high accuracy 档",
		216631: "识别失败（图片质量问题）",
		282000: "百度内部错误，稍后重试",
		336000: "百度内部错误，稍后重试",
	};
	const base = `Baidu OCR error ${code}: ${msg || "unknown error"}`;
	const hint = hints[code];
	return hint ? `${base} —— ${hint}` : base;
}

/** Drop the cached access token so the next call fetches a fresh one. */
function invalidateToken(apiKey: string, secretKey: string): void {
	const cacheKey = `${apiKey}\u0000${secretKey}`;
	tokenCache.delete(cacheKey);
	if (tokenInflightKey === cacheKey) {
		tokenInflight = null;
		tokenInflightKey = "";
	}
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

async function loadImageBase64(imagePath: string): Promise<{ absPath: string; encoded: string }> {
	const absPath = path.resolve(imagePath);
	const info = await stat(absPath).catch(() => null);
	if (!info?.isFile()) throw new Error(`Image not found: ${absPath}`);

	const encoded = (await readFile(absPath)).toString("base64");
	if (encoded.length > BASE64_LIMIT) {
		throw new Error(
			`Image base64 exceeds the 4MB limit (${Math.round(encoded.length / 1024 / 1024)}MB). ` +
				"Compress the image (and keep the longest side ≤ 4096px) before retrying.",
		);
	}
	return { absPath, encoded };
}

/** POST to an OCR endpoint with cached token + one retry on stale token. */
async function callOcr(url: string, params: Record<string, string>, signal?: AbortSignal): Promise<OcrResponse> {
	const creds = readCredentials();
	if ("error" in creds) throw new Error(creds.error);

	const token = await getAccessTokenCached(creds.apiKey, creds.secretKey);
	let result = await postForm<OcrResponse>(
		`${url}?access_token=${encodeURIComponent(token)}`,
		params,
		signal,
	);
	if (result.error_code != null && TOKEN_ERROR_CODES.includes(result.error_code)) {
		invalidateToken(creds.apiKey, creds.secretKey);
		const freshToken = await getAccessTokenCached(creds.apiKey, creds.secretKey);
		result = await postForm<OcrResponse>(
			`${url}?access_token=${encodeURIComponent(freshToken)}`,
			params,
			signal,
		);
	}
	if (result.error_code != null) {
		throw new Error(baiduErrorHint(result.error_code, result.error_msg || ""));
	}
	return result;
}

async function recognizeGeneral(
	imagePath: string,
	accuracy: Accuracy,
	signal?: AbortSignal,
): Promise<{ absPath: string; result: OcrResponse }> {
	const { absPath, encoded } = await loadImageBase64(imagePath);
	const endpoint = accuracy === "accurate" ? OCR_ENDPOINTS.accurate : OCR_ENDPOINTS.general;
	const result = await callOcr(
		endpoint,
		{ image: encoded, detect_direction: "true", paragraph: "true", probability: "true" },
		signal,
	);
	return { absPath, result };
}

async function recognizeCertificate(
	imagePath: string,
	type: CertificateType,
	side: "front" | "back",
	signal?: AbortSignal,
): Promise<{ absPath: string; result: OcrResponse }> {
	const { absPath, encoded } = await loadImageBase64(imagePath);
	const params: Record<string, string> = { image: encoded };
	if (type === "idcard") params.id_card_side = side;
	const result = await callOcr(OCR_ENDPOINTS[type], params, signal);
	return { absPath, result };
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]);
		}
	});
	await Promise.all(runners);
	return results;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function joinText(result: OcrResponse): string {
	return (result.words_result ?? [])
		.map((i) => (typeof i.words === "string" ? i.words : ""))
		.join("\n")
		.trim();
}

function avgProbability(result: OcrResponse): number | null {
	const probs = (result.words_result ?? [])
		.map((i) => i.probability?.average)
		.filter((p): p is number => typeof p === "number" && Number.isFinite(p));
	return probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null;
}

function metaLine(result: OcrResponse): string {
	const parts = [
		typeof result.direction === "number" ? `Direction: ${result.direction}` : null,
		`Lines: ${
			typeof result.words_result_num === "number"
				? result.words_result_num
				: (result.words_result ?? []).length
		}`,
	];
	const prob = avgProbability(result);
	if (prob != null) parts.push(`Avg probability: ${prob.toFixed(3)}`);
	return parts.filter(Boolean).join(" | ");
}

/** Certificate keywords detected in the text → suggest ocr_certificate types. */
function certificateHints(text: string): string {
	return CERTIFICATE_HINTS.filter((h) => h.keyword.test(text))
		.map((h) => `${CERTIFICATE_DEFS[h.type].label}（ocr_certificate type: ${h.type}）`)
		.join("、 ");
}

function formatSingleResult(result: OcrResponse): string {
	const text = joinText(result);
	const lines = [metaLine(result), "", text || "(no text recognized — check image clarity and size limits)"];
	const hints = certificateHints(text);
	if (hints) {
		lines.push(
			"",
			`检测到证照关键词（${hints}）——若需要结构化字段，用 ocr_certificate 复核，并交叉核对关键字段与图片原文。`,
		);
	}
	return lines.join("\n");
}

/** Per-image block shared by txt records and the batch conversation copy. */
function formatImageBlock(entry: ImageOutcome, index: number | null, truncateTo?: number): string {
	const label = index == null ? entry.absPath : `[${index}] ${entry.absPath}`;
	if (!entry.ok || !entry.result) {
		return [SEP_LIGHT, label, SEP_LIGHT, `(识别失败) ${entry.error ?? "unknown error"}`].join("\n");
	}

	const fullText = joinText(entry.result);
	const hints = certificateHints(fullText);
	let text = fullText;
	if (truncateTo != null && text.length > truncateTo) {
		text = `${text.slice(0, truncateTo)}\n…(已截断，完整文本共 ${fullText.length} 字符)`;
	}

	const lines = [
		SEP_LIGHT,
		label,
		metaLine(entry.result),
		SEP_LIGHT,
		text || "(no text recognized — check image clarity and size limits)",
	];
	if (hints) {
		lines.push("", `Certificate keywords: ${hints} — re-check with ocr_certificate and cross-check key fields against the image.`);
	}
	return lines.join("\n");
}

/** Structured certificate fields: words_result object → localized field lines. */
function formatCertificateFields(
	wordsResult: Record<string, { words?: string }> | undefined,
	def: CertificateDef,
): string {
	if (!wordsResult) return "";
	return Object.entries(wordsResult)
		.map(([key, value]) => {
			const text = typeof value?.words === "string" ? value.words : "";
			return `${def.fieldLabels[key] ?? key}: ${text}`;
		})
		.join("\n");
}

interface VatInvoiceResponse extends OcrResponse {
	commodity_list?: Array<Record<string, { words?: string }>>;
}

function formatCertificateResult(result: OcrResponse, def: CertificateDef): string {
	const wordsResult = (result as { words_result?: Record<string, { words?: string }> }).words_result;
	const lines: string[] = [];
	const fields = formatCertificateFields(wordsResult, def);
	if (fields) lines.push(fields);

	const commodities = (result as VatInvoiceResponse).commodity_list;
	if (Array.isArray(commodities) && commodities.length) {
		lines.push("", "商品明细：");
		commodities.forEach((item, i) => {
			const row = formatCertificateFields(item, def).replace(/\n/g, "；");
			lines.push(`  ${i + 1}. ${row}`);
		});
	}

	return lines.join("\n") || "(未识别出结构化字段 — 检查图片清晰度/方向，或临时用通用识别兜底)";
}

function timestamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Append one request record to the txt file. Creates missing dirs; BOM on creation. */
async function appendTxtRecord(outputPath: string, content: string): Promise<string> {
	const abs = path.resolve(outputPath);
	await mkdir(path.dirname(abs), { recursive: true });
	let prefix = "";
	try {
		await stat(abs);
	} catch {
		prefix = "\uFEFF"; // UTF-8 BOM so 记事本/WPS detect encoding
	}
	await appendFile(abs, `${prefix}${content}\n\n`, "utf8");
	return abs;
}

// ---------------------------------------------------------------------------
// Request records (persisted to outputPath, appended per request)
// ---------------------------------------------------------------------------

function buildSingleRecord(absPath: string, result: OcrResponse): string {
	const header = [SEP_HEAVY, `[${timestamp()}] 单张识别`, SEP_HEAVY, ""].join("\n");
	return `${header}${formatImageBlock({ absPath, ok: true, result }, null)}`;
}

function buildBatchRecord(outcomes: ImageOutcome[]): string {
	const succeeded = outcomes.filter((o) => o.ok).length;
	const header = [
		SEP_HEAVY,
		`[${timestamp()}] 批量识别请求：共 ${outcomes.length} 张，成功 ${succeeded}，失败 ${outcomes.length - succeeded}`,
		SEP_HEAVY,
		"",
	].join("\n");
	const blocks = outcomes.map((o, i) => formatImageBlock(o, i + 1));
	return `${header}${blocks.join("\n\n")}`;
}

function buildCertificateRecord(
	absPath: string,
	type: CertificateType,
	def: CertificateDef,
	side: "front" | "back",
	result: OcrResponse,
): string {
	const sideNote = type === "idcard" ? ` · ${side === "front" ? "正面" : "反面"}` : "";
	const header = [
		SEP_HEAVY,
		`[${timestamp()}] 证照识别 · ${def.label}（${type}${sideNote}）`,
		SEP_HEAVY,
		"",
		SEP_LIGHT,
		absPath,
		SEP_LIGHT,
		"",
	].join("\n");
	return `${header}${formatCertificateResult(result, def)}`;
}

// ---------------------------------------------------------------------------
// Tool parameter helpers
// ---------------------------------------------------------------------------

const accuracyParam = Type.Optional(
	Type.Union(
		[Type.Literal("standard"), Type.Literal("accurate")],
		{
			description:
				"Recognition accuracy: standard = 通用文字识别标准版 (faster); accurate = 高精度版 — 更准但更慢. Default standard. 免费额度两档相同（个人 1000 次/月、企业 2000 次/月，以控制台为准）",
			default: "standard",
		},
	),
);

function normalizeAccuracy(value: unknown): Accuracy {
	return value === "accurate" ? "accurate" : "standard";
}

function normalizeCertificateType(value: unknown): CertificateType {
	if ((CERTIFICATE_TYPES as readonly unknown[]).includes(value)) {
		return value as CertificateType;
	}
	throw new Error(
		`ocr_certificate: unsupported type "${String(value)}" — expected one of ${CERTIFICATE_TYPES.join(", ")}`,
	);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ocr_image",
		label: "OCR (Baidu)",
		description:
			"Recognize text in an image file with Baidu Cloud OCR. Standard edition by default, switch accuracy=\"accurate\" for the 高精度版 endpoint " +
			"(same free quota, better on blurry/stamped scans). Direction detection, paragraph info and recognition probability are " +
			"always requested, so sideways/rotated photos still work. " +
			"Optional outputPath: appends a txt record (absolute image path + recognized text) to that file; " +
			"results are always returned to the conversation too. For multiple images use ocr_images, for certificates use ocr_certificate. " +
			"Quota per Baidu console: unpaid ~1000 calls/month (personal) / ~2000 (enterprise), 2 QPS; " +
			"pay-as-you-go raises QPS to 10. Requires BAIDU_OCR_API_KEY and BAIDU_OCR_SECRET_KEY (env / plugin config). " +
			"Limits: base64 ≤ 4MB, longest side ≤ 4096px.",
		promptSnippet:
			"Recognize text in an image via Baidu OCR (accuracy: standard/accurate; optional txt output)",
		promptGuidelines: [
			"Use ocr_image for a single image; ocr_images for multiple; ocr_certificate for structured certificate fields.",
			"Use accuracy=\"accurate\" when the scan is blurry, stamped-over or otherwise hard to read; keep \"standard\" otherwise (faster).",
			"Pass outputPath when results should persist to a txt file — the file is APPENDED per request, one record holds the absolute image path + recognized text.",
			"When the result mentions 营业执照/身份证/发票/驾驶证/行驶证 keywords, prefer ocr_certificate for structured fields; always cross-check important fields against the raw result or the image.",
			"Never print or log the API keys; they live only in the process environment.",
		],
		parameters: Type.Object({
			imagePath: Type.String({
				description: "Path to the image file (jpg/png/bmp/gif; base64 ≤ 4MB; longest side ≤ 4096px)",
			}),
			accuracy: accuracyParam,
			outputPath: Type.Optional(
				Type.String({
					description:
						"Optional txt file to append this result to (absolute image path + recognized text). " +
						"Missing parent directories are created; the record is appended, never overwrites. " +
						"Results are also returned to the conversation.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			try {
				const { absPath, result } = await recognizeGeneral(
					params.imagePath,
					normalizeAccuracy(params.accuracy),
					signal,
				);
				const items = result.words_result ?? [];
				const contextText = formatSingleResult(result);
				const details: Record<string, unknown> = {
					source: absPath,
					accuracy: normalizeAccuracy(params.accuracy),
					lineCount:
						typeof result.words_result_num === "number" ? result.words_result_num : items.length,
					direction: result.direction,
				};
				let finalText = contextText;
				if (params.outputPath) {
					try {
						const savedTo = await appendTxtRecord(
							params.outputPath,
							buildSingleRecord(absPath, result),
						);
						details.output = savedTo;
						finalText = `${contextText}\n\n已落盘（追加模式）: ${savedTo}`;
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						details.outputError = message;
						finalText = `${contextText}\n\n落盘失败: ${message}`;
					}
				}
				return toolResult(finalText, details);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return toolResult(`OCR failed: ${message}`, { error: message });
			}
		},
	});

	pi.registerTool({
		name: "ocr_images",
		label: "OCR Batch (Baidu)",
		description:
			"Recognize text in MULTIPLE image files with Baidu Cloud OCR (standard edition; accuracy=\"accurate\" switches all images to 高精度版, " +
			"same free quota as standard). Processes images with bounded concurrency (default 2 — safe for unpaid 2 QPS accounts; max 10) " +
			"and per-image error isolation — one bad image never fails the batch. " +
			"Optional outputPath: appends the WHOLE request as ONE txt record (absolute image path + full text " +
			"per image); never one file per image. Results are always returned to the conversation, but per-image " +
			"text is truncated to 1200 chars when outputPath is set (the disk record keeps full text). " +
			"Quota per Baidu console: unpaid ~1000 calls/month (personal) / ~2000 (enterprise); 2 QPS unpaid, " +
			"10 QPS with pay-as-you-go. Baidu has no batch endpoint — concurrent single-image calls are the " +
			"documented approach. Requires BAIDU_OCR_API_KEY and BAIDU_OCR_SECRET_KEY (env / plugin config). " +
			"Limits per image: base64 ≤ 4MB, longest side ≤ 4096px; each image costs one API call against your quota.",
		promptSnippet:
			"Recognize text in many images via Baidu OCR batch (concurrency, accuracy, optional single txt output)",
		promptGuidelines: [
			"Use ocr_images for multiple images; each image is one API call, results are per-image and one failure does not abort the rest.",
			"Set concurrency (1-10, default 2; unpaid accounts are capped at 2 QPS so keep it low, pay-as-you-go allows up to 10) to trade speed vs Baidu QPS limits on your account tier.",
			"Set accuracy=\"accurate\" for blurry/stamped scans across the whole batch; standard is faster for clean photos.",
			"Pass outputPath to persist the whole request as ONE appended txt record (path + text); useful for批量证照/证书 folders.",
			"When results mention 营业执照/身份证/发票/驾驶证/行驶证 keywords, re-check key fields with ocr_certificate or against the image.",
			"Never print or log the API keys; they live only in the process environment.",
		],
		parameters: Type.Object({
			imagePaths: Type.Array(
				Type.String({
					description: "Path to an image file (jpg/png/bmp/gif; base64 ≤ 4MB; longest side ≤ 4096px)",
				}),
				{ description: "Image paths to recognize; each image = one API call against your Baidu quota" },
			),
			accuracy: accuracyParam,
			outputPath: Type.Optional(
				Type.String({
					description:
						"Optional txt file; the WHOLE request is appended as ONE record (per-image absolute path + full text). " +
						"When set, the conversation copy truncates per-image text to 1200 chars (disk keeps full text). " +
						"Missing parent directories are created; records are appended, never overwrites.",
				}),
			),
			concurrency: Type.Optional(
				Type.Number({
					description: `Max parallel Baidu requests, 1-${MAX_CONCURRENCY} (default ${DEFAULT_CONCURRENCY}; unpaid accounts are 2 QPS, pay-as-you-go 10 QPS) — reduce to 2 on error 18`,
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const imagePaths = params.imagePaths.map((p) => p.trim()).filter(Boolean);
			if (!imagePaths.length) {
				return toolResult("Batch OCR failed: imagePaths is empty.", { error: "imagePaths is empty" });
			}
			const concurrency = Math.max(
				1,
				Math.min(MAX_CONCURRENCY, Math.round(params.concurrency ?? DEFAULT_CONCURRENCY)),
			);
			const accuracy = normalizeAccuracy(params.accuracy);

			const outcomes = await mapWithConcurrency(imagePaths, concurrency, async (p) => {
				try {
					const { absPath, result } = await recognizeGeneral(p, accuracy, signal);
					return { absPath, ok: true, result } satisfies ImageOutcome;
				} catch (err) {
					return {
						absPath: path.resolve(p),
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					} satisfies ImageOutcome;
				}
			});

			const succeeded = outcomes.filter((o) => o.ok).length;
			const failed = outcomes.length - succeeded;
			const hints = [
				...new Set(
					outcomes
						.filter((o) => o.ok && o.result)
						.map((o) => certificateHints(joinText(o.result as OcrResponse)))
						.filter(Boolean),
				),
			].join("、 ");

			const headerLines = [
				`批量识别完成：共 ${outcomes.length} 张，成功 ${succeeded}，失败 ${failed}` +
					`（并发 ${concurrency}，${accuracy === "accurate" ? "高精度" : "标准"}档）`,
			];
			if (hints) {
				headerLines.push(
					`检测到证照关键词：${hints} — 需要结构化字段时用 ocr_certificate，并交叉核对关键字段。`,
				);
			}

			const truncateTo = params.outputPath ? CONTEXT_TRUNCATE_CHARS : undefined;
			const contextText = [
				...headerLines,
				"",
				outcomes.map((o, i) => formatImageBlock(o, i + 1, truncateTo)).join("\n\n"),
			].join("\n");

			const details: Record<string, unknown> = {
				total: outcomes.length,
				succeeded,
				failed,
				concurrency,
				accuracy,
				results: outcomes.map((o) => ({
					source: o.absPath,
					ok: o.ok,
					lines:
						o.ok && o.result
							? typeof o.result.words_result_num === "number"
								? o.result.words_result_num
								: (o.result.words_result ?? []).length
							: undefined,
				})),
			};

			let finalText = contextText;
			if (params.outputPath) {
				try {
					const savedTo = await appendTxtRecord(params.outputPath, buildBatchRecord(outcomes));
					details.output = savedTo;
					finalText = `${contextText}\n\n已落盘（按请求追加，含完整文本）: ${savedTo}`;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					details.outputError = message;
					finalText = `${contextText}\n\n落盘失败: ${message}`;
				}
			}
			return toolResult(finalText, details);
		},
	});

	pi.registerTool({
		name: "ocr_certificate",
		label: "OCR Certificate (Baidu)",
		description:
			"Recognize a certificate/bill image with the matching dedicated Baidu endpoint and return STRUCTURED FIELDS " +
			"(not free text): type=business_license 营业执照 / idcard 身份证 / driving_license 驾驶证 / " +
			"vehicle_license 行驶证 / vat_invoice 增值税发票. For idcard pass side=front (正面+头像) or back (反面签发机关+有效期). " +
			"Optional outputPath appends one txt record (absolute image path + localized fields). Results always go to the conversation too. " +
			"Quota per Baidu console (each certificate endpoint has its own free tier, typically personal ~1000 次/月 / enterprise ~2000 次/月). " +
			"Requires BAIDU_OCR_API_KEY and BAIDU_OCR_SECRET_KEY (env / plugin config). " +
			"Limits: base64 ≤ 4MB, longest side ≤ 4096px.",
		promptSnippet:
			"Recognize a certificate/bill (营业执照/身份证/驾驶证/行驶证/发票) with structured fields via Baidu OCR",
		promptGuidelines: [
			"Use ocr_certificate when the image is a 营业执照/身份证/驾驶证/行驶证/增值税发票 and structured fields are wanted.",
			"idcard requires side (front/back); other types ignore it.",
			"Dedicated endpoints infer fields — always cross-check important fields (credit codes, id numbers, amounts) against the raw result or the image.",
			"Pass outputPath to append one txt record per request (path + localized fields).",
			"Never print or log the API keys; they live only in the process environment.",
		],
		parameters: Type.Object({
			imagePath: Type.String({
				description: "Path to the certificate/bill image (jpg/png/bmp/gif; base64 ≤ 4MB; longest side ≤ 4096px)",
			}),
			type: Type.Union(
				CERTIFICATE_TYPES.map((t) => Type.Literal(t)),
				{ description: "证照类型：business_license 营业执照 / idcard 身份证 / driving_license 驾驶证 / vehicle_license 行驶证 / vat_invoice 增值税发票" },
			),
			side: Type.Optional(
				Type.Union(
					[Type.Literal("front"), Type.Literal("back")],
					{ description: "身份证面别（仅 type=idcard 生效）：front=正面（人像+姓名），back=反面（签发机关+有效期限）。默认 front", default: "front" },
				),
			),
			outputPath: Type.Optional(
				Type.String({
					description:
						"Optional txt file to append this record to (absolute image path + localized structured fields). " +
						"Missing parent directories are created; the record is appended, never overwrites.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			try {
				const side = params.side === "back" ? "back" : "front";
				const type = normalizeCertificateType(params.type);
				const { absPath, result } = await recognizeCertificate(params.imagePath, type, side, signal);
				const def = CERTIFICATE_DEFS[type];
				const fields = formatCertificateResult(result, def);
				const sideNote = type === "idcard" ? (side === "front" ? "(正面)" : "(反面)") : "";
				const contextText = `${def.label}识别完成${sideNote}（${type}）\n\n${fields}`;

				const details: Record<string, unknown> = {
					source: absPath,
					type,
					side: type === "idcard" ? side : undefined,
				};

				let finalText = contextText;
				if (params.outputPath) {
					try {
						const savedTo = await appendTxtRecord(
							params.outputPath,
							buildCertificateRecord(absPath, type, def, side, result),
						);
						details.output = savedTo;
						finalText = `${contextText}\n\n已落盘（追加模式）: ${savedTo}`;
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						details.outputError = message;
						finalText = `${contextText}\n\n落盘失败: ${message}`;
					}
				}
				return toolResult(finalText, details);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return toolResult(`OCR failed: ${message}`, { error: message });
			}
		},
	});
}