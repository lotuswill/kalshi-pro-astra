// ═══════════════════════════════════════════════════════════════
// PEM KEY LOADER — accept any sane RSA private key format.
//
// WebCrypto's importKey only speaks PKCS#8 ("BEGIN PRIVATE KEY"),
// but RSA keys in the wild — including freshly generated Kalshi API
// keys and anything from `openssl genrsa` — are usually PKCS#1
// ("BEGIN RSA PRIVATE KEY"). A valid PKCS#1 key fed to a pkcs8-only
// importer fails with an opaque DataError, which surfaced as the
// dreaded "Failed to generate auth signature. Check your API key…"
// even when the key was fine.
//
// This module classifies the PEM and, for PKCS#1, wraps the DER in
// the PKCS#8 envelope (SEQ { ver 0, rsaEncryption AlgorithmId,
// OCTET STRING pkcs1 }) so WebCrypto accepts it. Unsupported formats
// (passphrase-encrypted, OpenSSH, EC) throw errors that say exactly
// what to do instead.
// ═══════════════════════════════════════════════════════════════

// Classify a PEM by its armor header.
export function pemType(pem = "") {
  const s = String(pem);
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(s)) return "encrypted";
  if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(s)) return "openssh";
  if (/-----BEGIN EC PRIVATE KEY-----/.test(s)) return "ec";
  if (/-----BEGIN RSA PRIVATE KEY-----/.test(s)) return "pkcs1";
  if (/-----BEGIN PRIVATE KEY-----/.test(s)) return "pkcs8";
  if (/-----BEGIN [\w\s]*PUBLIC KEY-----/.test(s)) return "public";
  return "unknown";
}

// PEM armor → raw DER bytes.
export function pemToDer(pem = "") {
  const body = String(pem)
    .replace(/-----BEGIN [\w\s]+-----/g, "")
    .replace(/-----END [\w\s]+-----/g, "")
    .replace(/\s/g, "");
  if (!body) throw friendly("The private key field looks empty — paste the full PEM including the BEGIN/END lines.");
  let bin;
  try { bin = atob(body); } catch { throw friendly("The private key isn't valid base64 — it may have been corrupted in copy/paste. Re-paste the whole key file."); }
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// DER length field (definite form).
function derLen(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}

// AlgorithmIdentifier for rsaEncryption (OID 1.2.840.113549.1.1.1, NULL params).
const RSA_ALGO_ID = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

// Wrap a PKCS#1 RSAPrivateKey DER in the PKCS#8 PrivateKeyInfo envelope.
export function pkcs1ToPkcs8(pkcs1Der) {
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLen(pkcs1Der.length), ...pkcs1Der];
  const content = [...version, ...RSA_ALGO_ID, ...octet];
  return Uint8Array.from([0x30, ...derLen(content.length), ...content]);
}

function friendly(msg) { const e = new Error(msg); e.friendly = true; return e; }

// The one entry point: any supported PEM → PKCS#8 DER ready for
// crypto.subtle.importKey("pkcs8", …). Throws user-facing errors for
// everything WebCrypto can't take.
export function pemToPkcs8Der(pem) {
  const t = pemType(pem);
  switch (t) {
    case "pkcs8": return pemToDer(pem);
    case "pkcs1": return pkcs1ToPkcs8(pemToDer(pem));
    case "encrypted": throw friendly("This private key is passphrase-protected (BEGIN ENCRYPTED PRIVATE KEY). Export it without a passphrase: openssl pkcs8 -in key.pem -topk8 -nocrypt -out key-plain.pem");
    case "openssh": throw friendly("This is an OpenSSH-format key (from ssh-keygen). Kalshi needs a plain RSA key — use the key file Kalshi gave you, or convert: ssh-keygen -p -m PEM -f key");
    case "ec": throw friendly("This is an EC key — Kalshi request signing needs the RSA private key from your Kalshi API-key download.");
    case "public": throw friendly("That's the PUBLIC key. Paste the PRIVATE key file Kalshi gave you when the API key was created (it's only downloadable once — if it's gone, generate a new API key).");
    default: throw friendly("Unrecognized key format — paste the full PEM exactly as downloaded from Kalshi, including the -----BEGIN…----- and -----END…----- lines.");
  }
}
