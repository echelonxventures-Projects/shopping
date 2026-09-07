// Tests: notifications — localized templates w/ fallback chain, variable
// interpolation, quiet hours, retry queue, fallback channel, never-throws (P1-NOT-001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotificationsService } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(here, '../packs/notifications-core.json'), 'utf8'));
const svc = () => new NotificationsService(pack);

const VARS = { orderId: 'ord-123', total: '45.50', currency: 'USD', trackingUrl: 'https://t.example/xyz' };

test('localized templates from pack: en-US exact, fr-FR exact, hi-IN exact', () => {
  const s = svc();
  const en = s.render('order.confirmation', 'email', 'en-US', VARS);
  assert.equal(en.subject, 'Order ord-123 confirmed');
  assert.match(en.body, /ord-123 totalling 45\.50 USD/);
  const fr = s.render('order.confirmation', 'email', 'fr-FR', VARS);
  assert.equal(fr.subject, 'Commande ord-123 confirmée');
  const hi = s.render('order.confirmation', 'email', 'hi-IN', VARS);
  assert.ok(hi.subject.includes('ord-123'));
});

test('locale fallback chain: exact → language prefix → first for channel', () => {
  const s = svc();
  // en-GB has no exact entry → falls to en-US (language prefix)
  const gb = s.render('order.confirmation', 'email', 'en-GB', VARS);
  assert.equal(gb.locale, 'en-US');
  // de-DE has no German at all → falls to the channel's first entry
  const de = s.render('order.confirmation', 'email', 'de-DE', VARS);
  assert.ok(['en-US', 'fr-FR', 'hi-IN'].includes(de.locale));
});

test('channel-specific templates: SMS body without subject', () => {
  const s = svc();
  const sms = s.render('order.confirmation', 'sms', 'en-US', VARS);
  assert.equal(sms.subject, null);
  assert.match(sms.body, /ord-123 confirmed/);
});

test('quiet hours from pack policy: sms/push held 23:15, email unaffected', () => {
  const s = svc();
  assert.equal(s.quietHoursApply('sms', '2026-09-06T23:15:00Z'), true);
  assert.equal(s.quietHoursApply('push', '2026-09-06T23:15:00Z'), true);
  assert.equal(s.quietHoursApply('email', '2026-09-06T23:15:00Z'), false);
  assert.equal(s.quietHoursApply('sms', '2026-09-06T12:00:00Z'), false);
  // overnight window: 05:30 is inside 22:00–08:00
  assert.equal(s.quietHoursApply('sms', '2026-09-06T05:30:00Z'), true);
});

test('send contract: unknown template NEVER throws — retries then falls back then fails-permanent', () => {
  const s = svc();
  // unknown template on email, retries EXHAUSTED (attempt=3=max) → fallback also fails → failed-permanent, no throw
  const r1 = s.send({ template: 'nonexistent-template', channel: 'email', locale: 'en-US', vars: VARS, attempt: 3, at: '2026-09-06T12:00:00Z' });
  assert.equal(r1.status, 'failed-permanent');
  // mid-retry (attempt 1) → queued for the scheduler, never throws
  const r1b = s.send({ template: 'nonexistent-template', channel: 'email', locale: 'en-US', vars: VARS, at: '2026-09-06T12:00:00Z' });
  assert.equal(r1b.status, 'queued');
  // known template but wrong channel (sms lacks order.shipped) → fallback email succeeds
  const r2 = s.send({ template: 'order.shipped', channel: 'sms', locale: 'en-US', vars: VARS, attempt: 3, at: '2026-09-06T12:00:00Z' });
  assert.equal(r2.status, 'sent');
  assert.equal(r2.fallbackUsed, true);
  assert.equal(r2.channel, 'email');
});

test('happy send: rendered + delivered + outbox recorded', () => {
  const s = svc();
  const r = s.send({ template: 'order.confirmation', channel: 'email', locale: 'fr-FR', vars: VARS, at: '2026-09-06T12:00:00Z' });
  assert.equal(r.status, 'sent');
  assert.equal(s.outboxDump().length, 1);
});

test('quiet-hours send: queued (held), not failed — resumes after window', () => {
  const s = svc();
  const r = s.send({ template: 'order.confirmation', channel: 'sms', locale: 'en-US', vars: VARS, at: '2026-09-06T23:30:00Z' });
  assert.equal(r.status, 'queued');
  assert.equal(r.quietHoursHeld, true);
});
