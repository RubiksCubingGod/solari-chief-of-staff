import type { Express } from 'express';

import {
  type ControlRequest,
  type FixtureHandle,
  readRecord,
  startFixture,
  type StartFixtureOptions,
} from './harness.js';
import { documentShell, escapeHtml, NORMAL_STATE, notFoundPage } from './pages.js';

export interface ArticleInput {
  readonly headline: string;
  readonly body: string;
}

export interface Article extends ArticleInput {
  readonly id: string;
}

export interface FakenewsControl {
  setArticle(id: string, input: ArticleInput): Promise<Article>;
  article(id: string): Promise<Article>;
}

function parseArticle(id: string, body: unknown): Article | string {
  const record = readRecord(body);
  const { headline, body: text } = record;

  if (typeof headline !== 'string' || headline.trim() === '') {
    return 'headline must be a non-empty string';
  }
  if (typeof text !== 'string') {
    return 'body must be a string';
  }
  return { id, headline, body: text };
}

function renderArticle(article: Article): string {
  const paragraphs = article.body
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim() !== '')
    .map((paragraph) => `          <p>${escapeHtml(paragraph)}</p>`);

  return documentShell({
    title: article.headline,
    state: NORMAL_STATE,
    main: [
      '      <article class="fn-story">',
      `        <h1 class="fn-headline" data-testid="article-headline">${escapeHtml(article.headline)}</h1>`,
      '        <div class="fn-body" data-testid="article-body" role="region" aria-label="Article body">',
      ...paragraphs,
      '        </div>',
      '      </article>',
    ].join('\n'),
  });
}

export function startFakenewsFixture(
  options: StartFixtureOptions = {},
): Promise<FixtureHandle<FakenewsControl>> {
  const articles = new Map<string, Article>();

  const mount = (app: Express): void => {
    app.get('/article/:id', (request, response) => {
      const article = articles.get(request.params.id);
      if (article === undefined) {
        response.status(404).type('text/html').send(notFoundPage('article'));
        return;
      }
      response.type('text/html').send(renderArticle(article));
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
    setArticle: (id, input) => request<Article>('POST', `/__test/article/${id}`, input),
    article: (id) => request<Article>('GET', `/__test/article/${id}`),
  });

  return startFixture('fakenews', mount, buildControl, options);
}
