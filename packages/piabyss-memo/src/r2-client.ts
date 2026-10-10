/**
 * Cloudflare R2 对象存储客户端（S3 兼容 API）。
 *
 * 备忘录云同步只需要 PUT / GET / 删除 / 连接测试四个操作，为此引入
 * @aws-sdk/client-s3 得不偿失：这里用 node:crypto 自实现 AWS Signature V4
 * （R2 要求 region=auto、service=s3、path-style 寻址）。fetch 可注入以便测试。
 * 与 PiAbyss Host 的 r2-client.ts / pi-reimburse 的 r2-client.ts 同源
 * （逐行移植，签名逻辑不变）。
 */
import { createHash, createHmac } from "node:crypto";

export type R2Credentials = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export type R2RequestOptions = {
  /** 由各操作内部固定，调用方无需传入。 */
  method?: "GET" | "PUT" | "HEAD" | "DELETE";
  /** 对象键或（列举时为空串）。 */
  key?: string;
  query?: Record<string, string>;
  body?: Buffer | Uint8Array;
  /** 注入点：默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

class R2Error extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "R2Error";
    this.status = status;
  }
}

function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 编码（S3 规范要求 encodeURIComponent 之外还转义 !'()*）。 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** AWS SigV4 签名密钥派生（单独导出便于用官方向量做单测）。 */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  let key = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  key = hmacSha256(key, region);
  key = hmacSha256(key, service);
  return hmacSha256(key, "aws4_request");
}

export type SignedRequest = {
  url: URL;
  headers: Record<string, string>;
};

/**
 * 构造 SigV4 签名请求（R2：region 固定 auto、service 固定 s3、path-style）。
 * amzDate 可注入（ISO 8601 basic 格式，如 20250101T000000Z）以支持确定性测试。
 */
export function signR2Request(
  creds: R2Credentials,
  options: {
    method: R2RequestOptions["method"];
    key?: string;
    query?: Record<string, string>;
    body?: Buffer | Uint8Array;
    amzDate: string;
  },
): SignedRequest {
  const host = `${creds.accountId}.r2.cloudflarestorage.com`;
  const keyPath = options.key ? `/${options.key.split("/").map(encodeRfc3986).join("/")}` : "";
  const canonicalUri = `/${creds.bucket}${keyPath}`;
  const sortedQuery = Object.entries(options.query ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const canonicalQuery = sortedQuery
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join("&");
  const payloadHash = sha256Hex(options.body ?? "");
  const dateStamp = options.amzDate.slice(0, 8);

  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${options.amzDate}\n`;

  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    options.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(creds.secretAccessKey, dateStamp, "auto", "s3");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = new URL(
    `https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
  );
  return {
    url,
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": options.amzDate,
    },
  };
}

function requireOk(response: Response, action: string): Response {
  if (!response.ok) {
    throw new R2Error(`${action} 失败（HTTP ${response.status}）`, response.status);
  }
  return response;
}

/** ISO 8601 basic 格式的 amzDate（如 20250101T000000Z）。 */
function amzDateNow(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** 上传对象（覆盖写）。 */
export async function putObject(
  creds: R2Credentials,
  key: string,
  body: Buffer | Uint8Array,
  options: R2RequestOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signed = signR2Request(creds, { method: "PUT", key, body, amzDate: amzDateNow() });
  const response = await fetchImpl(signed.url, {
    method: "PUT",
    headers: signed.headers,
    body: body as unknown as RequestInit["body"],
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  requireOk(response, `上传对象 ${key}`);
}

/** 读取对象内容；404 返回 null。 */
export async function getObject(
  creds: R2Credentials,
  key: string,
  options: R2RequestOptions = {},
): Promise<Buffer | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signed = signR2Request(creds, { method: "GET", key, amzDate: amzDateNow() });
  const response = await fetchImpl(signed.url, {
    method: "GET",
    headers: signed.headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  if (response.status === 404) return null;
  requireOk(response, `读取对象 ${key}`);
  return Buffer.from(await response.arrayBuffer());
}

/** 删除对象；404 视为成功（幂等）。 */
export async function deleteObject(
  creds: R2Credentials,
  key: string,
  options: R2RequestOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signed = signR2Request(creds, { method: "DELETE", key, amzDate: amzDateNow() });
  const response = await fetchImpl(signed.url, {
    method: "DELETE",
    headers: signed.headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  if (response.status === 404) return;
  requireOk(response, `删除对象 ${key}`);
}

/**
 * 连接测试：列举桶内至多 1 个对象。能收到 200 即代表
 * 端点/密钥/桶名全部有效（ListObjectsV2 权限是 R2 API 令牌默认具备的）。
 */
export async function testConnection(
  creds: R2Credentials,
  options: R2RequestOptions = {},
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const signed = signR2Request(creds, {
      method: "GET",
      query: { "list-type": "2", "max-keys": "1" },
      amzDate: amzDateNow(),
    });
    const response = await fetchImpl(signed.url, {
      method: "GET",
      headers: signed.headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      return { ok: false, error: `连接失败（HTTP ${response.status}）` };
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
