import type { Delivery } from '@chief-of-staff/db';

import type { SendToUser } from './outbound.js';

/**
 * The red-night notice: what the nightly live-ops gate tells the person on
 * call, through the same door every other message to a person goes through.
 *
 * Only a night that is not green is sent. A green night is the expected
 * thing, and a channel that says "fine" every morning is one that gets
 * muted the week before it says something else. The shape here is the
 * night summary the watch package computes, taken structurally so this
 * package does not have to depend on that one to say what it says.
 */

export type OpsNightColour = 'green' | 'failed' | 'errored';

export interface OpsNight {
  readonly date: string;
  readonly colour: OpsNightColour;
  readonly counts: { readonly passed: number; readonly failed: number; readonly errored: number };
  readonly cost: { readonly totalUsd: number; readonly solariUsd: number; readonly anthropicUsd: number };
  readonly costTargetUsd: number;
  readonly reasons: readonly string[];
}

export interface OpsNotificationOptions {
  /** Where the run's log is, when there is one: the first thing a person wants on a red morning. */
  readonly runUrl?: string;
}

export type OpsNotice =
  | { readonly sent: false; readonly reason: string }
  | { readonly sent: true; readonly text: string; readonly delivery: Delivery };

const money = (usd: number): string => `$${usd.toFixed(2)}`;

export function renderOpsNotification(night: OpsNight, options: OpsNotificationOptions = {}): string {
  const lines = [
    `Live ops ${night.date}: ${night.colour.toUpperCase()}`,
    `${String(night.counts.passed)} passed, ${String(night.counts.failed)} failed, ${String(night.counts.errored)} errored`,
    ...night.reasons.map((reason) => `- ${reason}`),
    `Cost ${money(night.cost.totalUsd)} of the ${money(night.costTargetUsd)} target (Solari ${money(night.cost.solariUsd)}, Anthropic ${money(night.cost.anthropicUsd)})`,
  ];
  if (options.runUrl !== undefined) lines.push(`Run: ${options.runUrl}`);
  return lines.join('\n');
}

/** Sends the night to the person on call if it is not green; says why not when it is. */
export async function notifyOpsOfNight(
  sendToUser: SendToUser,
  opsUserId: string,
  night: OpsNight,
  options: OpsNotificationOptions = {},
): Promise<OpsNotice> {
  if (night.colour === 'green') return { sent: false, reason: `${night.date} was green; nothing to say` };
  const text = renderOpsNotification(night, options);
  const delivery = await sendToUser(opsUserId, text, { dedupKey: `live-ops:${night.date}:${night.colour}` });
  return { sent: true, text, delivery };
}
