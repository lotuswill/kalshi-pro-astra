import { test, expect, vi } from 'vitest';
import { generateKeyPairSync, verify, constants } from 'node:crypto';
import { kalshiAuthHeaders, signKalshiMessage } from '../kalshi-auth.js';
import { pemToPkcs8Der } from '../pemkey.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ed = generateKeyPairSync('ed25519');
const edPem = ed.privateKey.export({ type: 'pkcs8', format: 'pem' });

for (const [label, pair, type, algorithm] of [
  ['RSA PKCS#1', rsa, 'pkcs1', 'RSA-PSS'],
  ['RSA PKCS#8', rsa, 'pkcs8', 'RSA-PSS'],
  ['Ed25519 PKCS#8', ed, 'pkcs8', 'Ed25519'],
]) {
  test(`${label} produces independently verifiable Kalshi headers`, async () => {
    const pem = pair.privateKey.export({ type, format: 'pem' }).replace(/\n/g, '\r\n');
    const headers = await kalshiAuthHeaders('test-key-id', pem, 'get', '/trade-api/v2/portfolio/positions?limit=200');
    const message = Buffer.from(headers['KALSHI-ACCESS-TIMESTAMP'] + 'GET/trade-api/v2/portfolio/positions');
    const signature = Buffer.from(headers['KALSHI-ACCESS-SIGNATURE'], 'base64');
    const key = algorithm === 'Ed25519' ? pair.publicKey : { key: pair.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
    expect(verify(algorithm === 'Ed25519' ? null : 'sha256', message, key, signature)).toBe(true);
    expect(headers['KALSHI-ACCESS-KEY']).toBe('test-key-id');
    expect((await signKalshiMessage(pem, 'local check')).algorithm).toBe(algorithm);
  });
}

test('valid Ed25519 key reproduces the previous RSA-only import failure', async () => {
  await expect(crypto.subtle.importKey('pkcs8', pemToPkcs8Der(edPem), { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign'])).rejects.toThrow();
  expect((await signKalshiMessage(edPem, 'local check')).algorithm).toBe('Ed25519');
});

test('invalid and unsupported keys fail before signing', async () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  await expect(signKalshiMessage(ec, 'check')).rejects.toThrow(/Unsupported private key algorithm/);
  const der = pemToPkcs8Der(edPem).subarray(0, 20);
  const truncated = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----`;
  await expect(signKalshiMessage(truncated, 'check')).rejects.toThrow(/incomplete/);
});

test('empty browser errors identify import versus signing without exposing error text', async () => {
  const importKey = vi.fn().mockRejectedValue(new DOMException('', 'DataError'));
  await expect(signKalshiMessage(edPem, 'check', { importKey })).rejects.toThrow(/Ed25519 key import failed \(DataError\)/);
  importKey.mockResolvedValue({});
  const sign = vi.fn().mockRejectedValue(new DOMException('sensitive implementation detail', 'OperationError'));
  try { await signKalshiMessage(edPem, 'check', { importKey, sign }); } catch (error) {
    expect(error.message).toContain('Ed25519 key sign failed (OperationError)');
    expect(error.message).not.toContain('sensitive');
  }
  importKey.mockRejectedValue(new DOMException('', 'NotSupportedError'));
  await expect(signKalshiMessage(edPem, 'check', { importKey })).rejects.toThrow(/Update your browser/);
  await expect(signKalshiMessage(edPem, 'check', null)).rejects.toThrow(/localhost or HTTPS/);
});
