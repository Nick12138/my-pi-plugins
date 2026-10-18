/**
 * console-decode 单测：Windows 控制台代码页（GBK 等）与 UTF-8 输出的解码。
 * 用预构造的 GBK/UTF-8 Buffer 验证，不依赖真实代码页设置。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { codePageLabel, decodeWithCodePage } from "../src/console-decode.ts";

// 「中文测试」的 GBK 编码字节（cmd.exe echo 输出即此类字节）
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
const UTF8_ZHONGWEN = Buffer.from("中文测试", "utf8"); // node -e 等现代程序的输出

test("codePageLabel：已知映射 + 未知回退 utf-8", () => {
	assert.equal(codePageLabel(65001), "utf-8");
	assert.equal(codePageLabel(936), "gbk");
	assert.equal(codePageLabel(950), "big5");
	assert.equal(codePageLabel(932), "shift-jis");
	assert.equal(codePageLabel(949), "euc-kr");
	assert.equal(codePageLabel(1252), "windows-1252");
	assert.equal(codePageLabel(437), "utf-8", "未知代码页回退 utf-8");
});

test("decodeWithCodePage：936 控制台的 GBK 输出正确解码", () => {
	assert.equal(decodeWithCodePage(GBK_ZHONGWEN, 936), "中文测试");
	assert.equal(decodeWithCodePage(GBK_ZHONGWEN, 65001) === "中文测试", false, "按 utf-8 解 GBK 字节必然乱码（这正是旧 bug）");
});

test("decodeWithCodePage：936 控制台上程序直出 UTF-8 不乱码（strict 试解优先）", () => {
	assert.equal(decodeWithCodePage(UTF8_ZHONGWEN, 936), "中文测试");
});

test("decodeWithCodePage：65001 与 null（非 Windows）按 utf-8", () => {
	assert.equal(decodeWithCodePage(UTF8_ZHONGWEN, 65001), "中文测试");
	assert.equal(decodeWithCodePage(UTF8_ZHONGWEN, null), "中文测试");
});

test("decodeWithCodePage：ASCII 输出任何路径下不变", () => {
	const ascii = Buffer.from("hello world 123");
	assert.equal(decodeWithCodePage(ascii, 936), "hello world 123");
	assert.equal(decodeWithCodePage(ascii, 65001), "hello world 123");
	assert.equal(decodeWithCodePage(ascii, null), "hello world 123");
});

test("decodeWithCodePage：空 Buffer 与非法字节不抛异常", () => {
	assert.equal(decodeWithCodePage(Buffer.alloc(0), 936), "");
	assert.doesNotThrow(() => decodeWithCodePage(Buffer.from([0xff, 0xfe, 0x41]), 936), "非法字节解码为替换符但不抛错");
});
