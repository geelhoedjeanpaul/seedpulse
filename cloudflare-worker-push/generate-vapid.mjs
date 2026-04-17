#!/usr/bin/env node
/**
 * Generate a VAPID ECDSA P-256 keypair for the SeedPulse push worker.
 * Usage:  node generate-vapid.mjs
 *
 * Outputs:
 *   - VAPID_PUBLIC_KEY  → paste into wrangler.toml [vars]
 *   - VAPID_PRIVATE_JWK → paste into `wrangler secret put VAPID_PRIVATE_JWK` stdin
 *
 * Keep the private JWK private — never commit it. Anyone with it can send pushes
 * as your origin.
 */
import { webcrypto } from 'node:crypto';
const { subtle } = webcrypto;

function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return Buffer.from(s, 'binary').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const kp = await subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true, ['sign', 'verify']
);
const rawPub = await subtle.exportKey('raw', kp.publicKey);
const privJwk = await subtle.exportKey('jwk', kp.privateKey);

console.log('━━━ VAPID keypair generated ━━━\n');
console.log('VAPID_PUBLIC_KEY (paste into wrangler.toml):');
console.log(b64url(rawPub) + '\n');

console.log('VAPID_PRIVATE_JWK (paste when `wrangler secret put VAPID_PRIVATE_JWK` prompts):');
console.log(JSON.stringify(privJwk) + '\n');

console.log('Steps:');
console.log('  1. Copy VAPID_PUBLIC_KEY into wrangler.toml under [vars].VAPID_PUBLIC_KEY');
console.log('  2. Run:   wrangler secret put VAPID_PRIVATE_JWK');
console.log('            …and paste the JWK JSON when prompted.');
console.log('  3. Run:   wrangler secret put TRIGGER_KEY');
console.log('            …and paste any random string (used to gate /trigger-test).');
console.log('  4. Deploy: wrangler deploy');
