import { pemToPkcs8Der, privateKeyAlgorithm } from './pemkey.js';

export async function signKalshiMessage(privateKeyPem, message, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('Web Crypto is unavailable. Open the app on localhost or HTTPS to use Key Vault signing.');
  const der = pemToPkcs8Der(privateKeyPem);
  const algorithm = privateKeyAlgorithm(der);
  let stage = 'import';
  try {
    const key = await subtle.importKey('pkcs8', der,
      algorithm === 'Ed25519' ? { name: 'Ed25519' } : { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
    stage = 'sign';
    const signature = await subtle.sign(
      algorithm === 'Ed25519' ? { name: 'Ed25519' } : { name: 'RSA-PSS', saltLength: 32 },
      key, new TextEncoder().encode(message));
    return { algorithm, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
  } catch (error) {
    // Do not log key material or propagate browser error text that might include it.
    const code = ['DataError', 'OperationError', 'NotSupportedError', 'InvalidAccessError', 'SyntaxError'].includes(error?.name) ? error.name : 'CryptoError';
    const advice = code === 'NotSupportedError'
      ? 'This browser does not support the key algorithm. Update your browser, or use a Kalshi RSA key with its matching Key ID.'
      : 'Run Test signing in Key Vault. Verify the complete private key file if this persists.';
    throw new Error(`${algorithm} key ${stage} failed (${code}). ${advice}`);
  }
}

export async function kalshiAuthHeaders(apiKeyId, privateKeyPem, method, path) {
  if (!apiKeyId || !privateKeyPem) return null;
  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + path.split('?')[0];
  const { signature } = await signKalshiMessage(privateKeyPem, message);
  return {
    'Content-Type': 'application/json',
    'KALSHI-ACCESS-KEY': apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature,
  };
}
