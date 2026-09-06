// Tests: payments — adapter SPI, SAQ-A floor (PAN rejection), refund limits (P1-PAY-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaymentsService, PspRoutingError, type PspAdapter } from '../src/index.ts';

function fakePsp(name: string, opts: { failAuth?: boolean } = {}): PspAdapter {
  return {
    name,
    authorize: async () => (opts.failAuth ? { ok: false, reason: 'declined' } : { ok: true, pspRef: `${name}-ref-1` }),
    capture: async (ref) => ({ ok: true, pspRef: ref }),
    refund: async () => ({ ok: true }),
  };
}

test('adapter registration + config-driven routing; unknown adapter rejected', async () => {
  const p = new PaymentsService();
  p.register(fakePsp('stripe-class'));
  p.register(fakePsp('adyen-class'));
  p.route('adyen-class');
  const r = await p.authorize(10, 'USD', 'tok_visa_123');
  assert.equal(r.ok, true);
  assert.match(r.pspRef!, /adyen-class/);
  assert.throws(() => p.route('paypal-class'), PspRoutingError);
});

test('SAQ-A constitutional floor: raw PAN rejected, token accepted', async () => {
  const p = new PaymentsService();
  p.register(fakePsp('stripe-class'));
  p.route('stripe-class');
  await assert.rejects(() => p.authorize(10, 'USD', '4111111111111111'), /SAQ-A floor violation/);
  await assert.rejects(() => p.authorize(10, 'USD', '4111 1111 1111 1111'), /SAQ-A floor violation/);
  const ok = await p.authorize(10, 'USD', 'tok_network_token_99');
  assert.equal(ok.ok, true);
});

test('refund cannot exceed captured amount (ledger-backed guard)', async () => {
  const p = new PaymentsService();
  p.register(fakePsp('adyen-class'));
  p.route('adyen-class');
  const auth = await p.authorize(50, 'USD', 'tok_x');
  p.recordCapture(auth.pspRef!, 50);
  assert.equal((await p.refund(auth.pspRef!, 30)).ok, true);
  assert.equal((await p.refund(auth.pspRef!, 30)).ok, false); // 60 > 50
});

test('no PSP routed → explicit error (never silently no-op)', async () => {
  const p = new PaymentsService();
  await assert.rejects(() => p.authorize(1, 'USD', 'tok'), PspRoutingError);
});
