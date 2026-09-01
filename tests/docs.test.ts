import { existsSync, readFileSync } from 'node:fs';

import {
  ANTHROPIC_KEY_VARIABLE,
  LIVE_LLM_FLAG,
  liveLlmSkipReason,
} from '@chief-of-staff/agent';
import { ConfigError, loadConfig } from '@chief-of-staff/api';
import { BOT_TRANSPORTS, BotConfigError, loadBotConfig } from '@chief-of-staff/bot';
import {
  TEST_DATABASE_URL_VARIABLE,
  TEST_POSTGRES_STARTERS,
  TEST_POSTGRES_STARTER_VARIABLE,
} from '@chief-of-staff/db/testing';
import { describe, expect, it } from 'vitest';

/**
 * Documentation that is only read by people rots silently. These assertions
 * make the README and `.env.example` fail the build when they stop describing
 * this repository: a script that no longer exists, a file that moved, a
 * variable the config loader does not actually read, or a connection string
 * that does not match the database `docker compose up` starts.
 */

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const readme = read('../README.md');
const example = read('../.env.example');
const compose = read('../docker-compose.yml');
const manifest = JSON.parse(read('../package.json')) as { scripts: Record<string, string> };

/** `KEY=value` lines, ignoring comments and blanks. */
function parseEnv(contents: string): Record<string, string> {
  const entries = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)] as const;
    });
  return Object.fromEntries(entries);
}

const documented = parseEnv(example);

describe('README.md', () => {
  it('only tells the reader to run scripts that exist', () => {
    const referenced = [...readme.matchAll(/`pnpm ([a-z:]+)`|^pnpm ([a-z:]+)$/gmu)].map(
      (match) => match[1] ?? match[2],
    );

    expect(referenced.length).toBeGreaterThan(0);
    for (const script of referenced) {
      if (script === 'install') continue;
      expect(Object.keys(manifest.scripts), `pnpm ${String(script)}`).toContain(script);
    }
  });

  it('only points at files that exist', () => {
    const paths = [...readme.matchAll(/`((?:docs|packages|scripts|tests|fixtures)\/[\w./-]+)`/gu)]
      .map((match) => match[1] ?? '')
      .filter((path) => !path.endsWith('/'));

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(existsSync(new URL(`../${path}`, import.meta.url)), path).toBe(true);
    }
  });

  it('documents the setup in the order it has to happen', () => {
    // The first shell block is the clone-to-green sequence; a step out of order
    // there is a stranger's first ten minutes wasted.
    const setup = /```bash\n([\s\S]*?)```/u.exec(readme)?.[1] ?? '';
    const steps = ['pnpm install', 'docker compose up', 'pnpm migrate', 'pnpm check'];
    const positions = steps.map((step) => setup.indexOf(step));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('.env.example', () => {
  it('is enough on its own to configure the server', () => {
    const config = loadConfig(documented);

    expect(config).toEqual({
      databaseUrl: documented['DATABASE_URL'],
      host: documented['HOST'],
      logLevel: documented['LOG_LEVEL'],
      port: Number(documented['PORT']),
      runtimeEnvironment: documented['NODE_ENV'],
    });
  });

  it('documents the connection string the server cannot start without', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(documented['DATABASE_URL']).toBeTruthy();
  });

  it('points that connection string at the database docker compose starts', () => {
    const url = new URL(String(documented['DATABASE_URL']));
    const composed = parseEnv(
      compose
        .split('\n')
        .filter((line) => line.trim().startsWith('POSTGRES_'))
        .map((line) => line.trim().replace(': ', '='))
        .join('\n'),
    );

    expect(url.username).toBe(composed['POSTGRES_USER']);
    expect(url.password).toBe(composed['POSTGRES_PASSWORD']);
    expect(url.pathname).toBe(`/${String(composed['POSTGRES_DB'])}`);
    // The compose port is overridable and defaults to 5432; the example has to
    // name the default, or the two documents disagree out of the box.
    expect(url.port).toBe('5432');
    expect(documented['POSTGRES_PORT']).toBe('5432');
  });

  it('names the test-database escape hatch the harness actually looks for', () => {
    expect(Object.keys(documented)).toContain(TEST_DATABASE_URL_VARIABLE);
    // Blank: the default path is a throwaway container, and a value left here
    // would silently redirect every integration test at a shared server.
    expect(documented[TEST_DATABASE_URL_VARIABLE]).toBe('');
  });

  it('names the starter pin, blank, alongside the rungs it can select', () => {
    expect(Object.keys(documented)).toContain(TEST_POSTGRES_STARTER_VARIABLE);
    // Blank for the same reason: a value here would pin every run on this
    // machine to one rung and hide the ladder the next machine depends on.
    expect(documented[TEST_POSTGRES_STARTER_VARIABLE]).toBe('');
    for (const rung of TEST_POSTGRES_STARTERS) {
      expect(example, rung).toContain(`\`${rung}\``);
    }
  });

  it('is enough on its own to configure the bot, once a token is filled in', () => {
    // The token is the one value in this file that cannot be documented, so a
    // stand-in is supplied here and the example leaves it blank.
    const token = '123456:example';
    const configured = loadBotConfig({ ...documented, TELEGRAM_BOT_TOKEN: token });
    const defaults = loadBotConfig({
      TELEGRAM_BOT_TOKEN: token,
      DATABASE_URL: documented['DATABASE_URL'] ?? '',
    });

    expect(configured.databaseUrl).toBe(documented['DATABASE_URL']);
    // The rate-limit numbers written above are the loader's own defaults.
    // Changing one in code and not the other fails here, rather than leaving a
    // reader to configure the bot from a file that quietly disagrees with it.
    expect(configured).toEqual(defaults);
  });

  it('leaves the bot token blank, because it is the one secret here', () => {
    expect(Object.keys(documented)).toContain('TELEGRAM_BOT_TOKEN');
    expect(documented['TELEGRAM_BOT_TOKEN']).toBe('');
    // Blank is not merely conventional: the bot refuses to start without it, so
    // a copied `.env` cannot accidentally run as somebody else's bot.
    expect(() => loadBotConfig(documented)).toThrow(BotConfigError);
  });

  it('names every transport the bot can be switched between', () => {
    for (const transport of BOT_TRANSPORTS) {
      expect(example, transport).toContain(transport);
    }
    expect(BOT_TRANSPORTS).toContain(documented['TELEGRAM_TRANSPORT']);
  });

  it('leaves both halves of the live-LLM opt-in blank', () => {
    for (const variable of [ANTHROPIC_KEY_VARIABLE, LIVE_LLM_FLAG]) {
      expect(Object.keys(documented), variable).toContain(variable);
      // Blank for the reason the Solari pair above are: a key filled in here
      // would be committed, and a flag filled in here would make every ordinary
      // `pnpm check` on this machine spend real model credit.
      expect(documented[variable], variable).toBe('');
    }
    // A file that named the variables without saying they cost money would be
    // documentation that reads as an invitation.
    expect(liveLlmSkipReason(documented)).toContain(LIVE_LLM_FLAG);
  });
});
