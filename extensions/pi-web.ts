/**
 * pi-web — minimal web search plugin for pi
 *
 * Two search engines, nothing else:
 *   - Tavily  : needs TAVILY_API_KEY env var
 *   - Exa MCP : free hosted endpoint, no key, no sign-up
 *
 * Default ("auto") picks Tavily when its key exists, otherwise Exa MCP.
 * If Tavily fails (network, HTTP error, bad response) it falls back to
 * Exa MCP automatically — unless the caller forced provider="tavily".
 *
 * Registering `web_search` conflicts with the `pi-web-access` package;
 * enable only one of them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_MCP_TOOL = "web_search_exa";
const REQUEST_TIMEOUT_MS = 45_000;
const SNIPPET_MAX_CHARS = 400;
const MAX_RESULTS_CAP = 10;

type Provider = "tavily" | "exa";

interface WebResult {
	title: string;
	url: string;
	snippet: string;
}

function clampNumResults(value: number | undefined): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 5;
	return Math.min(Math.max(n, 1), MAX_RESULTS_CAP);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

// ── Tavily ───────────────────────────────────────────────────────────────

async function searchTavily(query: string, numResults: number, apiKey: string, signal?: AbortSignal): Promise<WebResult[]> {
	const res = await fetch(TAVILY_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			query,
			max_results: numResults,
			search_depth: "basic",
			include_answer: false,
		}),
		signal: requestSignal(signal),
	});

	if (!res.ok) {
		const body = (await res.text()).slice(0, 200);
		throw new Error(`Tavily HTTP ${res.status}: ${body}`);
	}

	const data = (await res.json()) as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> };
	const items = Array.isArray(data.results) ? data.results : [];

	return items
		.map((item) => ({
			title: typeof item.title === "string" ? item.title.trim() : "",
			url: typeof item.url === "string" ? item.url.trim() : "",
			snippet: typeof item.content === "string" ? item.content : "",
		}))
		.filter((item) => item.url.length > 0);
}

// ── Exa MCP ──────────────────────────────────────────────────────────────

interface McpRpcResponse {
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: { code?: number; message?: string };
}

/** Exa MCP answers as SSE ("data: {...}" lines) or plain JSON — accept both. */
function parseRpcBody(body: string): McpRpcResponse {
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const parsed = JSON.parse(payload) as McpRpcResponse;
			if (parsed?.result || parsed?.error) return parsed;
		} catch {
			// keep scanning
		}
	}
	try {
		const parsed = JSON.parse(body) as McpRpcResponse;
		if (parsed?.result || parsed?.error) return parsed;
	} catch {
		// fall through
	}
	throw new Error("Exa MCP returned an unreadable response");
}

/** web_search_exa output is text blocks: "Title: … / URL: … / … / Highlights|Text: …" separated by "---". */
function parseExaMcpText(text: string): WebResult[] {
	return text
		.split(/(?=^Title: )/m)
		.map((block) => {
			const title = block.match(/^Title: (.+)$/m)?.[1]?.trim() ?? "";
			const url = block.match(/^URL: (.+)$/m)?.[1]?.trim() ?? "";

			let snippet = "";
			const textIdx = block.indexOf("\nText: ");
			const highlightMatch = block.match(/\nHighlights:\s*\n/);
			if (textIdx >= 0) {
				snippet = block.slice(textIdx + 7);
			} else if (highlightMatch?.index != null) {
				snippet = block.slice(highlightMatch.index + highlightMatch[0].length);
			}
			snippet = snippet.replace(/\n---\s*$/, "").trim();

			return { title, url, snippet };
		})
		.filter((r) => r.url.length > 0);
}

async function searchExaMcp(query: string, numResults: number, signal?: AbortSignal): Promise<WebResult[]> {
	const res = await fetch(`${EXA_MCP_URL}?tools=${EXA_MCP_TOOL}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: EXA_MCP_TOOL, arguments: { query, numResults } },
		}),
		signal: requestSignal(signal),
	});

	if (!res.ok) {
		const body = (await res.text()).slice(0, 200);
		const hint = res.status === 429 ? " (rate limited — retry later or set TAVILY_API_KEY)" : "";
		throw new Error(`Exa MCP HTTP ${res.status}${hint}: ${body}`);
	}

	const rpc = parseRpcBody(await res.text());
	if (rpc.error) {
		const code = typeof rpc.error.code === "number" ? ` ${rpc.error.code}` : "";
		throw new Error(`Exa MCP error${code}: ${rpc.error.message || "unknown"}`);
	}
	if (rpc.result?.isError) {
		const text = rpc.result.content?.find((c) => c?.type === "text")?.text?.trim();
		throw new Error(text || "Exa MCP returned an error");
	}

	const text = rpc.result?.content?.find((c) => c?.type === "text" && (c.text ?? "").trim().length > 0)?.text;
	if (!text) throw new Error("Exa MCP returned empty content");

	const results = parseExaMcpText(text);
	if (results.length === 0) throw new Error("Exa MCP returned no parseable results");
	return results;
}

// ── Formatting ───────────────────────────────────────────────────────────

function formatResults(provider: Provider, results: WebResult[], note?: string): string {
	const lines = results.map((r, i) => {
		const snippet = r.snippet.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX_CHARS);
		return `${i + 1}. ${r.title || "Untitled"}\n   ${r.url}${snippet ? `\n   ${snippet}` : ""}`;
	});

	const header = [
		note ? `Note: ${note}` : "",
		`Provider: ${provider === "tavily" ? "Tavily" : "Exa MCP (free)"}`,
	].filter(Boolean);

	return [...header, "", lines.join("\n\n") || "No results found."].join("\n").trim();
}

// ── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and return a numbered list of results (title, URL, snippet). " +
			"Auto mode uses Tavily when the TAVILY_API_KEY environment variable is set, " +
			"otherwise the free Exa MCP endpoint. No configuration is required.",
		promptSnippet: "Search the web (Tavily when TAVILY_API_KEY is set, otherwise free Exa MCP)",
		promptGuidelines: [
			"Use web_search when the user asks to look something up on the web or asks about current events.",
			"Pass provider=\"tavily\" or provider=\"exa\" to web_search to force a specific engine; the default is auto.",
			"If web_search returns an error, try rewording the query or forcing the other provider once instead of giving up.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			numResults: Type.Optional(Type.Number({ description: "Number of results, 1–10 (default 5)" })),
			provider: Type.Optional(StringEnum(["auto", "tavily", "exa"] as const)),
		}),

		async execute(_toolCallId, params, signal) {
			const numResults = clampNumResults(params.numResults);
			const tavilyKey = process.env.TAVILY_API_KEY?.trim() || null;
			const choice = (params.provider ?? "auto") as "auto" | Provider;
			const provider: Provider = choice === "auto" ? (tavilyKey ? "tavily" : "exa") : choice;

			const rethrowIfAborted = () => {
				if (signal?.aborted) throw new Error("Search aborted");
			};

			if (provider === "tavily") {
				if (!tavilyKey) {
					return toolResult(
						"Tavily was selected but TAVILY_API_KEY is not set. " +
							'Set the environment variable and retry, or call web_search with provider="exa" (free).',
						{ provider: "tavily", count: 0, error: "missing-key" },
					);
				}
				try {
					const results = await searchTavily(params.query, numResults, tavilyKey, signal);
					return toolResult(formatResults("tavily", results), { provider: "tavily", count: results.length });
				} catch (tavilyErr) {
					rethrowIfAborted();
					const tavilyMessage = messageOf(tavilyErr);

					if (choice === "tavily") {
						return toolResult(
							`Tavily search failed: ${tavilyMessage}\n(no fallback, because provider was forced)`,
							{ provider: "tavily", count: 0, error: tavilyMessage },
						);
					}

					// auto mode: fall back to Exa MCP
					try {
						const results = await searchExaMcp(params.query, numResults, signal);
						return toolResult(
							formatResults("exa", results, `Tavily failed (${tavilyMessage}); fell back to Exa MCP.`),
							{ provider: "exa", count: results.length, fallback: true },
						);
					} catch (exaErr) {
						rethrowIfAborted();
						return toolResult(
							`Both providers failed.\nTavily: ${tavilyMessage}\nExa MCP: ${messageOf(exaErr)}`,
							{ provider: "none", count: 0, error: "all-failed" },
						);
					}
				}
			}

			try {
				const results = await searchExaMcp(params.query, numResults, signal);
				return toolResult(formatResults("exa", results), { provider: "exa", count: results.length });
			} catch (err) {
				rethrowIfAborted();
				return toolResult(`Exa MCP search failed: ${messageOf(err)}`, {
					provider: "exa",
					count: 0,
					error: messageOf(err),
				});
			}
		},
	});
}
