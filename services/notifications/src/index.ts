// @aether/service-notifications — multi-channel templating, localization,
// retry/fallback, quiet hours; NEVER blocks commerce (async by contract)
// (P1-NOT-001). Module-as-a-Product: channels, templates, policies are PACK DATA.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AetherModule, HostPort, BillingPort } from '@aether/kernel-module/src/index.ts';

export interface NotificationChannel {
  id: string;
  kind: string;
  rateLimitPerMin: number;
}

export interface TemplateEntry {
  locale: string;
  channel: string;
  subject: string | null;
  body: string;
}

export interface NotificationsPack {
  pack: { name: string };
  channels: NotificationChannel[];
  templates: Record<string, TemplateEntry[]>;
  policies: {
    neverBlockCheckout: boolean;
    retry: { maxAttempts: number; backoffMs: number[] };
    fallbackChannel: string;
    quietHours: { enabled: boolean; from: string; to: string; channels: string[] };
  };
}

export interface RenderedNotification {
  template: string;
  channel: string;
  locale: string;
  subject: string | null;
  body: string;
}

export interface DeliveryResult {
  notificationId: string;
  channel: string;
  status: 'sent' | 'queued' | 'failed-permanent';
  attempts: number;
  fallbackUsed: boolean;
  quietHoursHeld: boolean;
}

export class NotificationsService {
  private pack: NotificationsPack;
  private outbox: DeliveryResult[] = [];
  private seq = 0;

  constructor(pack: NotificationsPack) {
    this.pack = pack;
  }

  /** resolve template by (template, channel, locale) with locale fallback chain */
  render(template: string, channel: string, locale: string, vars: Record<string, string>): RenderedNotification {
    const entries = this.pack.templates[template];
    if (!entries) throw new Error(`Unknown template "${template}" — register in pack`);
    // exact locale > language prefix > any locale for the channel
    const candidates = entries.filter((e) => e.channel === channel);
    const exact = candidates.find((e) => e.locale === locale);
    const lang = candidates.find((e) => e.locale.split('-')[0] === locale.split('-')[0]!);
    const chosen = exact ?? lang ?? candidates[0];
    if (!chosen) {
      throw new Error(`No template "${template}" for channel "${channel}" — register in pack`);
    }
    const sub = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
    return {
      template, channel, locale: chosen.locale,
      subject: chosen.subject ? sub(chosen.subject) : null,
      body: sub(chosen.body),
    };
  }

  /** quiet-hours evaluation (policy data): channels held until window ends */
  quietHoursApply(channel: string, atIso: string): boolean {
    const q = this.pack.policies.quietHours;
    if (!q.enabled || !q.channels.includes(channel)) return false;
    const hhmm = atIso.slice(11, 16);
    const [from, to] = [q.from, q.to];
    if (from <= to) return hhmm >= from && hhmm < to;
    return hhmm >= from || hhmm < to; // overnight window
  }

  /**
   * send — the CONTRACT: failures never throw (never block commerce, §5);
   * failed sends go to retry queue or fallback channel per pack policy.
   */
  send(input: { template: string; channel: string; locale: string; vars: Record<string, string>; attempt?: number; at: string }): DeliveryResult {
    const notificationId = `ntf-${++this.seq}`;
    const { retry, fallbackChannel } = this.pack.policies;
    const attempt = input.attempt ?? 1;
    try {
      if (this.quietHoursApply(input.channel, input.at)) {
        const held: DeliveryResult = { notificationId, channel: input.channel, status: 'queued', attempts: attempt, fallbackUsed: false, quietHoursHeld: true };
        this.outbox.push(held);
        return held;
      }
      const rendered = this.render(input.template, input.channel, input.locale, input.vars);
      const sent: DeliveryResult = { notificationId, channel: rendered.channel, status: 'sent', attempts: attempt, fallbackUsed: false, quietHoursHeld: false };
      this.outbox.push(sent);
      return sent;
    } catch {
      if (attempt < retry.maxAttempts) {
        const queued: DeliveryResult = { notificationId, channel: input.channel, status: 'queued', attempts: attempt, fallbackUsed: false, quietHoursHeld: false };
        this.outbox.push(queued);
        return queued; // retried by scheduler with backoffMs[attempt-1]
      }
      // permanent failure on the primary channel → fallback channel (pack policy)
      if (input.channel !== fallbackChannel) {
        try {
          this.render(input.template, fallbackChannel, input.locale, input.vars);
          const fb: DeliveryResult = { notificationId, channel: fallbackChannel, status: 'sent', attempts: attempt, fallbackUsed: true, quietHoursHeld: false };
          this.outbox.push(fb);
          return fb;
        } catch {
          /* fall through to permanent */
        }
      }
      const failed: DeliveryResult = { notificationId, channel: input.channel, status: 'failed-permanent', attempts: attempt, fallbackUsed: false, quietHoursHeld: false };
      this.outbox.push(failed);
      return failed;
    }
  }

  outboxDump(): DeliveryResult[] {
    return [...this.outbox];
  }
}

const notificationsModule: AetherModule = {
  manifest: JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../module.json'), 'utf8')),
  async create(_host: HostPort, billing: BillingPort, packs: Record<string, unknown>) {
    const pack = Object.values(packs)[0] as NotificationsPack;
    const svc = new NotificationsService(pack);
    const meter = (ev: string) => billing.meter(ev);
    return {
      render: (t: string, c: string, l: string, v: Record<string, string>) => svc.render(t, c, l, v),
      send: (i: { template: string; channel: string; locale: string; vars: Record<string, string>; attempt?: number; at: string }) => (meter('notification.sent'), svc.send(i)),
      quietHoursApply: (c: string, at: string) => svc.quietHoursApply(c, at),
      outboxDump: () => svc.outboxDump(),
      __raw: svc,
    };
  },
};

export default notificationsModule;
