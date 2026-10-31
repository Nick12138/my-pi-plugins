/**
 * checks.mjs — 识别结果的确定性校验（纯函数，worker 与扩展层共用）。
 *
 * 为什么需要：OCR / 视觉模型对证照的错字集中在数字与字形相近的汉字上，人工肉眼很难发现
 * （实测同一张营业执照，WPS 给 915101000806054398，视觉模型给 91510100MA6CQ54398——
 *  前者校验位通过，后者不通过）。统一社会信用代码有国标校验位（GB 32100-2015），
 * 可以用它当免费的“识别置信度”：校验不过 → 100% 是识别错了。
 *
 * 只做「标注」，不改写原文：错的是原件还是识别，最终仍需人核对。
 */

const USCC_CHARSET = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

/**
 * 统一社会信用代码校验位是否正确（GB 32100-2015）。
 * @param {string} code 18 位代码
 * @returns {boolean}
 */
export function usccCheckDigitOk(code) {
	if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(code)) return false;
	let sum = 0;
	for (let i = 0; i < 17; i++) {
		const v = USCC_CHARSET.indexOf(code[i]);
		if (v < 0) return false;
		sum += v * USCC_WEIGHTS[i];
	}
	const expect = USCC_CHARSET[(31 - (sum % 31)) % 31];
	return expect === code[17];
}

/**
 * 扫描文本里的统一社会信用代码候选并标注校验位结论。
 * 只认 91/92/93 开头（企业/个体/农合社），避免把 18 位身份证、银行卡号误判进来。
 * @param {string} text
 * @returns {{ checked: string[]; suspicious: string[] }}
 */
export function auditUscc(text) {
	const checked = [];
	const suspicious = [];
	for (const m of String(text).matchAll(/9[123][0-9A-HJ-NPQRTUWXY]{16}/g)) {
		const code = m[0];
		if (checked.includes(code)) continue;
		checked.push(code);
		if (!usccCheckDigitOk(code)) suspicious.push(code);
	}
	return { checked, suspicious };
}

/**
 * 给文本追加校验警告（没有可疑代码时原样返回）。
 * @param {string} text
 * @returns {string}
 */
export function appendUsccWarnings(text) {
	const body = String(text ?? "");
	const { checked, suspicious } = auditUscc(body);
	if (!suspicious.length) return body;
	const lines = [
		"",
		"> ⚠️ 统一社会信用代码校验位不通过（GB 32100 校验算法），以下号码 100% 存在识别错字，请对照原件核对：",
		...suspicious.map((c) => `> - \`${c}\``),
	];
	if (checked.length > suspicious.length) {
		lines.push(`> （另 ${checked.length - suspicious.length} 个号码校验通过，可优先采信）`);
	}
	return body.replace(/\s*$/, "") + "\n" + lines.join("\n");
}
