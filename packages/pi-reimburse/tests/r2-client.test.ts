import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  deriveSigningKey,
  getObject,
  putObject,
  signR2Request,
  testConnection,
  type R2Credentials,
} from "../src/r2-client.js";

const CREDS: R2Credentials = {
  accountId: "abc123",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  bucket: "memos",
};

describe("deriveSigningKey", () => {
  // AWS SigV4 官方文档（General Reference 派生密钥示例，IAM）的确定性向量。
  it("matches the AWS documented signing key", () => {
    const key = deriveSigningKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20120215",
      "us-east-1",
      "iam",
    );
    expect(key.toString("hex")).toBe(
      "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
    );
  });
});

describe("signR2Request", () => {
  it("builds a path-style URL and signs deterministic headers", () => {
    const signed = signR2Request(CREDS, {
      method: "PUT",
      key: "piabyss/memo/notes.json",
      body: Buffer.from("hello"),
      amzDate: "20250101T000000Z",
    });
    expect(signed.url.hostname).toBe("abc123.r2.cloudflarestorage.com");
    expect(signed.url.pathname).toBe("/memos/piabyss/memo/notes.json");
    expect(signed.headers["x-amz-date"]).toBe("20250101T000000Z");
    expect(signed.headers["x-amz-content-sha256"]).toBe(
      createHash("sha256").update("hello").digest("hex"),
    );
    expect(signed.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20250101\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // 同输入同签名（无随机性）。
    const again = signR2Request(CREDS, {
      method: "PUT",
      key: "piabyss/memo/notes.json",
      body: Buffer.from("hello"),
      amzDate: "20250101T000000Z",
    });
    expect(again.headers.Authorization).toBe(signed.headers.Authorization);
  });

  it("sorts query params and encodes keys RFC 3986 style", () => {
    const signed = signR2Request(CREDS, {
      method: "GET",
      key: "a b/中.png",
      query: { "max-keys": "1", "list-type": "2" },
      amzDate: "20250101T000000Z",
    });
    expect(signed.url.pathname).toBe("/memos/a%20b/%E4%B8%AD.png");
    expect(signed.url.search).toBe("?list-type=2&max-keys=1");
  });
});

describe("object operations (mocked fetch)", () => {
  function okResponse(body: string | null = null, status = 200): Response {
    return new Response(body, { status });
  }

  it("putObject PUTs the signed body to the right path", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await putObject(CREDS, "p/notes.json", Buffer.from("data"), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/p/notes.json".replace("/p", "/memos/p"));
    expect(init.method).toBe("PUT");
    expect(init.body).toEqual(Buffer.from("data"));
  });

  it("getObject returns null on 404 and bytes on 200", async () => {
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(
      getObject(CREDS, "missing.json", { fetchImpl: notFound as unknown as typeof fetch }),
    ).resolves.toBeNull();

    const found = vi.fn(async () => okResponse("bytes!"));
    await expect(
      getObject(CREDS, "x.json", { fetchImpl: found as unknown as typeof fetch }),
    ).resolves.toEqual(Buffer.from("bytes!"));
  });

  it("putObject throws R2Error on non-2xx", async () => {
    const denied = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(
      putObject(CREDS, "p/x", Buffer.from("d"), { fetchImpl: denied as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "R2Error", status: 403 });
  });

  it("testConnection succeeds on 200 and reports errors otherwise", async () => {
    const ok = vi.fn(async () => okResponse("<ListBucketResult/>"));
    await expect(
      testConnection(CREDS, { fetchImpl: ok as unknown as typeof fetch }),
    ).resolves.toEqual({
      ok: true,
      error: null,
    });
    const [url] = ok.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.search).toBe("?list-type=2&max-keys=1");

    const badKey = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(
      testConnection(CREDS, { fetchImpl: badKey as unknown as typeof fetch }),
    ).resolves.toEqual({
      ok: false,
      error: "连接失败（HTTP 403）",
    });

    const networkDown = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      testConnection(CREDS, { fetchImpl: networkDown as unknown as typeof fetch }),
    ).resolves.toEqual({ ok: false, error: "ECONNREFUSED" });
  });
});
