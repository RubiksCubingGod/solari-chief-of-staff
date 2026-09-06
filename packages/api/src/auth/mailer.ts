import type { RuntimeEnvironment } from '../config.js';

/**
 * The seam between "a link was issued" and "a link was delivered".
 *
 * ARCHITECTURE leaves the email vendor open until the hosting decision lands,
 * and this sprint proves the flow rather than the vendor. A port rather than a
 * direct call means the flow is provable end to end today — the dev and CI
 * implementation keeps the link instead of sending it — and the vendor, when it
 * is chosen, is one implementation of this interface and changes no route.
 */

export interface MagicLinkMail {
  /** The address the link was minted for. */
  readonly to: string;
  /** The link itself, which is the whole credential. */
  readonly link: string;
  readonly expiresAt: Date;
}

export interface MailerPort {
  send(mail: MagicLinkMail): Promise<void>;
}

/**
 * The dev and CI implementation: it records what it was asked to send and
 * sends nothing.
 *
 * A test reads the link out of `sent` the way a person would read it out of
 * their inbox, which is what lets the accepted path be proven without a mail
 * server anywhere in the picture. It is also the honest thing for a developer's
 * machine to do: mailing a real address from a workstation is a surprise
 * nobody asked for.
 */
export interface RecordingMailer extends MailerPort {
  /** Every link this mailer was handed, oldest first. */
  readonly sent: readonly MagicLinkMail[];
  /** The most recent link, which is what a test almost always wants. */
  last(): MagicLinkMail | undefined;
  clear(): void;
}

export function createRecordingMailer(): RecordingMailer {
  const sent: MagicLinkMail[] = [];
  return {
    sent,
    send: (mail) => {
      sent.push(mail);
      return Promise.resolve();
    },
    last: () => sent.at(-1),
    clear: () => {
      sent.length = 0;
    },
  };
}

/**
 * Raised by the production mailer, which has no vendor behind it yet.
 *
 * Deliberately a failure at send time rather than a silent success: a
 * deployment whose users are told "check your email" while nothing is sent has
 * a bug that looks exactly like a working system, and this is the sprint that
 * would be blamed for it. The refusal is a 500 on the request that provoked it
 * and says nothing about the address, so it costs the enumeration guarantee
 * nothing.
 */
export class MailerNotConfiguredError extends Error {
  constructor() {
    super(
      'No email vendor is configured, so the magic link could not be delivered. ' +
        'The vendor decision is open (see packages/../.nah dashboard-read README).',
    );
    this.name = 'MailerNotConfiguredError';
  }
}

export function createUnconfiguredMailer(): MailerPort {
  return {
    send: () => Promise.reject(new MailerNotConfiguredError()),
  };
}

/**
 * The mailer a running server gets. Recording everywhere but production, where
 * an unchosen vendor has to be a loud failure rather than a quiet one.
 */
export function createMailer(runtimeEnvironment: RuntimeEnvironment): MailerPort {
  return runtimeEnvironment === 'production' ? createUnconfiguredMailer() : createRecordingMailer();
}
