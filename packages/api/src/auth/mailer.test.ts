import { describe, expect, it } from 'vitest';

import {
  MailerNotConfiguredError,
  createMailer,
  createRecordingMailer,
  createUnconfiguredMailer,
  type MagicLinkMail,
} from './mailer.js';

/**
 * The seam between "a link was issued" and "a link was delivered", and the
 * difference the runtime environment makes to it.
 */

const MAIL: MagicLinkMail = {
  to: 'owner@example.test',
  link: 'http://api.test/auth/callback?token=abc',
  expiresAt: new Date('2026-01-01T00:15:00.000Z'),
};

describe('the recording mailer', () => {
  it('keeps what it was asked to send, oldest first, and sends nothing', async () => {
    const mailer = createRecordingMailer();

    await mailer.send(MAIL);
    await mailer.send({ ...MAIL, to: 'other@example.test' });

    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[0]?.to).toBe('owner@example.test');
    // A test reads `last()` the way a person reads the newest thing in their
    // inbox, which is what almost every assertion actually wants.
    expect(mailer.last()?.to).toBe('other@example.test');
  });

  it('has nothing to report before it has been asked for anything', () => {
    expect(createRecordingMailer().last()).toBeUndefined();
  });

  it('forgets on request, so one test cannot read the post of another', async () => {
    const mailer = createRecordingMailer();
    await mailer.send(MAIL);

    mailer.clear();

    expect(mailer.sent).toEqual([]);
    expect(mailer.last()).toBeUndefined();
  });
});

describe('the unconfigured mailer', () => {
  it('fails loudly rather than succeeding quietly', async () => {
    // Deliberately not a silent success: a deployment whose users are told
    // "check your email" while nothing is sent has a bug that looks exactly
    // like a working system.
    await expect(createUnconfiguredMailer().send(MAIL)).rejects.toBeInstanceOf(
      MailerNotConfiguredError,
    );
  });

  it('says nothing about the address in the refusal', async () => {
    const failure: unknown = await createUnconfiguredMailer()
      .send(MAIL)
      .catch((error: unknown) => error);

    // The refusal becomes a 500 on the request that provoked it. If it named
    // the address, that 500 would be an answer to "does this person have an
    // account here" - which the whole flow is built not to give.
    expect((failure as Error).message).not.toContain(MAIL.to);
    expect((failure as Error).message).toContain('No email vendor is configured');
  });
});

describe('createMailer', () => {
  it('records everywhere a vendor has not been chosen yet', async () => {
    for (const environment of ['development', 'test'] as const) {
      const mailer = createMailer(environment);
      await expect(mailer.send(MAIL)).resolves.toBeUndefined();
    }
  });

  it('refuses in production, where an unchosen vendor has to be loud', async () => {
    await expect(createMailer('production').send(MAIL)).rejects.toBeInstanceOf(
      MailerNotConfiguredError,
    );
  });
});
