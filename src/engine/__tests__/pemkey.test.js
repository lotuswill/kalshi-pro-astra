import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { pemType, pemToDer, pkcs1ToPkcs8, pemToPkcs8Der } from "../pemkey.js";

// Real keypair, exported in both PEM dialects.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS8_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const PKCS1_PEM = privateKey.export({ type: "pkcs1", format: "pem" });

async function importAndSign(der) {
  const key = await globalThis.crypto.subtle.importKey(
    "pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
  const sig = await globalThis.crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 }, key, new TextEncoder().encode("1699999999999GET/trade-api/v2/portfolio/balance"));
  return new Uint8Array(sig);
}

describe("pemType", () => {
  it("classifies the formats", () => {
    expect(pemType(PKCS8_PEM)).toBe("pkcs8");
    expect(pemType(PKCS1_PEM)).toBe("pkcs1");
    expect(pemType("-----BEGIN ENCRYPTED PRIVATE KEY-----\nxx\n-----END ENCRYPTED PRIVATE KEY-----")).toBe("encrypted");
    expect(pemType("-----BEGIN OPENSSH PRIVATE KEY-----\nxx\n-----END OPENSSH PRIVATE KEY-----")).toBe("openssh");
    expect(pemType("-----BEGIN PUBLIC KEY-----\nxx\n-----END PUBLIC KEY-----")).toBe("public");
    expect(pemType("not a key")).toBe("unknown");
  });
});

describe("pemToPkcs8Der — the fix for 'Failed to generate auth signature'", () => {
  it("a PKCS#8 key imports and signs", async () => {
    const sig = await importAndSign(pemToPkcs8Der(PKCS8_PEM));
    expect(sig.length).toBe(256); // 2048-bit RSA
  });
  it("a PKCS#1 key (BEGIN RSA PRIVATE KEY) is wrapped and ALSO imports and signs", async () => {
    const sig = await importAndSign(pemToPkcs8Der(PKCS1_PEM));
    expect(sig.length).toBe(256);
  });
  it("the raw PKCS#1 DER would have failed without the wrapper (regression guard)", async () => {
    await expect(importAndSign(pemToDer(PKCS1_PEM))).rejects.toThrow();
  });
  it("Windows CRLF and stray spaces in the pasted PEM don't matter", async () => {
    const messy = PKCS1_PEM.replace(/\n/g, "\r\n") + "\r\n  ";
    const sig = await importAndSign(pemToPkcs8Der(messy));
    expect(sig.length).toBe(256);
  });
  it("unsupported formats throw errors that say what to do", () => {
    expect(() => pemToPkcs8Der("-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----")).toThrow(/passphrase/);
    expect(() => pemToPkcs8Der("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----")).toThrow(/OpenSSH/);
    expect(() => pemToPkcs8Der("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")).toThrow(/PUBLIC/);
    expect(() => pemToPkcs8Der("garbage")).toThrow(/Unrecognized/);
    expect(() => pemToPkcs8Der("-----BEGIN RSA PRIVATE KEY-----\n%%%\n-----END RSA PRIVATE KEY-----")).toThrow(/base64/);
  });
  it("pkcs1ToPkcs8 builds a well-formed envelope even for large keys (multi-byte lengths)", () => {
    const der = pemToDer(PKCS1_PEM);
    const wrapped = pkcs1ToPkcs8(der);
    expect(wrapped[0]).toBe(0x30);           // SEQUENCE
    expect(wrapped.length).toBeGreaterThan(der.length + 20);
  });
});
