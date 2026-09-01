import type { Express } from 'express';

import {
  buildInstanceControl,
  type ControlRequest,
  type FixtureHandle,
  type InstanceControl,
  mountInstanceRoutes,
  readRecord,
  startFixture,
  type StartFixtureOptions,
} from './harness.js';
import {
  buildModeControl,
  createModeState,
  type FixtureMode,
  type ModeControl,
  type ModeSeed,
} from './modes.js';
import { escapeHtml, type Layout, notFoundPage, type PageContent } from './pages.js';

export interface ArticleInput {
  readonly headline: string;
  readonly body: string;
}

export interface Article extends ArticleInput {
  readonly id: string;
}

/** Everything a fakenews instance knows, as `GET /__test/state` reports it. */
export interface FakenewsState {
  readonly mode: FixtureMode;
  readonly escalationToken: string;
  readonly articles: readonly Article[];
}

export interface FakenewsSeed extends ModeSeed {
  readonly articles?: readonly Article[];
}

export interface FakenewsControl
  extends ModeControl,
    InstanceControl<FakenewsState, FakenewsSeed> {
  setArticle(id: string, input: ArticleInput): Promise<Article>;
  article(id: string): Promise<Article>;
}

function parseArticle(id: string, body: unknown): Article | string {
  const { headline, body: text } = readRecord(body);

  if (typeof headline !== 'string' || headline.trim() === '') {
    return 'headline must be a non-empty string';
  }
  if (typeof text !== 'string') {
    return 'body must be a string';
  }
  return { id, headline, body: text };
}

function articlePage(article: Article, layout: Layout): PageContent {
  const paragraphClass = layout === 'normal' ? '' : ' class="Story__para"';
  const paragraphs = article.body
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim() !== '')
    .map(
      (paragraph) =>
        `${layout === 'normal' ? '          ' : '            '}<p${paragraphClass}>${escapeHtml(paragraph)}</p>`,
    );

  const heading = (className: string): string =>
    `        <h1 class="${className}" data-testid="article-headline">${escapeHtml(article.headline)}</h1>`;

  const main =
    layout === 'normal'
      ? [
          '      <article class="fn-story">',
          heading('fn-headline'),
          '        <div class="fn-body" data-testid="article-body" role="region" aria-label="Article body">',
          ...paragraphs,
          '        </div>',
          '      </article>',
        ]
      : [
          '      <section class="Story" id="story-root">',
          '        <header class="Story__head">',
          heading('Story__title'),
          '        </header>',
          '        <div class="Story__content" id="story-content">',
          '          <div class="Story__prose" data-testid="article-body" role="region" aria-label="Article body">',
          ...paragraphs,
          '          </div>',
          '        </div>',
          '      </section>',
        ];

  return { title: article.headline, main: main.join('\n') };
}

export function startFakenewsFixture(
  options: StartFixtureOptions = {},
): Promise<FixtureHandle<FakenewsControl>> {
  const articles = new Map<string, Article>();
  const modes = createModeState();
  let baseline: Article[] = [];

  /** Validates the `articles` field of a whole-instance seed without applying it. */
  const parseSeedArticles = (body: Record<string, unknown>): Article[] | string | undefined => {
    const raw = body.articles;
    if (raw === undefined) {
      return undefined;
    }
    if (!Array.isArray(raw)) {
      return 'articles must be an array';
    }
    const parsed: Article[] = [];
    for (const entry of raw) {
      const id = readRecord(entry).id;
      if (typeof id !== 'string' || id.trim() === '') {
        return 'each seeded article needs a non-empty id';
      }
      const article = parseArticle(id, entry);
      if (typeof article === 'string') {
        return article;
      }
      parsed.push(article);
    }
    return parsed;
  };

  const mount = (app: Express): void => {
    modes.mount(app);

    mountInstanceRoutes<FakenewsState>(app, {
      state: () => ({
        mode: modes.current(),
        escalationToken: modes.token(),
        articles: [...articles.values()],
      }),
      seed: (body) => {
        const record = readRecord(body);
        const parsed = parseSeedArticles(record);
        if (typeof parsed === 'string') {
          return parsed;
        }
        const refusal = modes.seed(record);
        if (refusal !== undefined) {
          return refusal;
        }
        if (parsed !== undefined) {
          articles.clear();
          for (const article of parsed) {
            articles.set(article.id, article);
          }
        }
        baseline = [...articles.values()];
        return undefined;
      },
      reset: () => {
        articles.clear();
        for (const article of baseline) {
          articles.set(article.id, article);
        }
        modes.reset();
      },
    });

    app.get('/article/:id', (request, response) => {
      const article = articles.get(request.params.id);
      if (article === undefined) {
        response.status(404).type('text/html').send(notFoundPage('article'));
        return;
      }
      modes.serve(request, response, (layout) => articlePage(article, layout));
    });

    app.get('/__test/article/:id', (request, response) => {
      const article = articles.get(request.params.id);
      if (article === undefined) {
        response.status(404).json({ error: 'no such article' });
        return;
      }
      response.json(article);
    });

    app.post('/__test/article/:id', (request, response) => {
      const parsed = parseArticle(request.params.id, request.body);
      if (typeof parsed === 'string') {
        response.status(400).json({ error: parsed });
        return;
      }
      articles.set(parsed.id, parsed);
      response.json(parsed);
    });
  };

  const buildControl = (request: ControlRequest): FakenewsControl => ({
    ...buildModeControl(request),
    ...buildInstanceControl<FakenewsState, FakenewsSeed>(request),
    setArticle: (id, input) => request<Article>('POST', `/__test/article/${id}`, input),
    article: (id) => request<Article>('GET', `/__test/article/${id}`),
  });

  return startFixture('fakenews', mount, buildControl, options);
}
