import type { Express } from 'express';

import {
  type ControlRequest,
  type FixtureHandle,
  readRecord,
  startFixture,
  type StartFixtureOptions,
} from './harness.js';
import { buildModeControl, createModeState, type ModeControl } from './modes.js';
import { escapeHtml, type Layout, notFoundPage, type PageContent } from './pages.js';

export type StockState = 'in_stock' | 'out_of_stock';

export interface ProductInput {
  readonly title: string;
  readonly price: number;
  readonly stock: StockState;
}

export interface Product extends ProductInput {
  readonly id: string;
}

export interface FakestoreControl extends ModeControl {
  setProduct(id: string, input: ProductInput): Promise<Product>;
  product(id: string): Promise<Product>;
}

const STOCK_LABELS: Record<StockState, string> = {
  in_stock: 'In stock',
  out_of_stock: 'Out of stock',
};

function parseProduct(id: string, body: unknown): Product | string {
  const { title, price, stock } = readRecord(body);

  if (typeof title !== 'string' || title.trim() === '') {
    return 'title must be a non-empty string';
  }
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
    return 'price must be a non-negative finite number';
  }
  if (stock !== 'in_stock' && stock !== 'out_of_stock') {
    return 'stock must be in_stock or out_of_stock';
  }
  return { id, title, price, stock };
}

/**
 * The observable facts of a product, named once so both layouts render exactly
 * the same accessible names, hooks, and text. The redesign rotates the markup
 * around this list; it cannot rotate the list itself.
 */
function facts(product: Product): { label: string; testId: string; text: string }[] {
  const priced =
    product.stock === 'in_stock'
      ? [{ label: 'Price', testId: 'product-price', text: `$${product.price.toFixed(2)}` }]
      : [];
  return [
    ...priced,
    { label: 'Availability', testId: 'product-stock', text: STOCK_LABELS[product.stock] },
  ];
}

/**
 * An out-of-stock product renders its availability and no price at all. Real
 * storefronts do this, and it makes an extractor that assumes a price is always
 * present fail loudly instead of recording the last one it saw.
 */
function productPage(product: Product, layout: Layout): PageContent {
  const rows = facts(product);
  const valueClass = layout === 'normal' ? 'pd-value' : 'ProductView__val';
  const termClass = layout === 'normal' ? 'pd-term' : 'ProductView__key';
  const entries = rows.flatMap((row) => [
    `          <dt class="${termClass}">${row.label}</dt>`,
    `          <dd class="${valueClass}" data-testid="${row.testId}" aria-label="${row.label}">${row.text}</dd>`,
  ]);

  const heading = (className: string): string =>
    `        <h1 class="${className}" data-testid="product-title">${escapeHtml(product.title)}</h1>`;

  const main =
    layout === 'normal'
      ? [
          '      <article class="pd-card">',
          heading('pd-title'),
          '        <dl class="pd-facts">',
          ...entries,
          '        </dl>',
          '      </article>',
        ]
      : [
          '      <section class="ProductView" id="pv-root">',
          '        <div class="ProductView__header">',
          heading('ProductView__name'),
          '        </div>',
          '        <div class="ProductView__body" id="pv-body">',
          '          <dl class="ProductView__list">',
          ...entries,
          '          </dl>',
          '        </div>',
          '      </section>',
        ];

  return { title: product.title, main: main.join('\n') };
}

export function startFakestoreFixture(
  options: StartFixtureOptions = {},
): Promise<FixtureHandle<FakestoreControl>> {
  const products = new Map<string, Product>();
  const modes = createModeState();

  const mount = (app: Express): void => {
    modes.mount(app);

    app.get('/product/:id', (request, response) => {
      const product = products.get(request.params.id);
      if (product === undefined) {
        // A missing product is gone in every mode. A block that could also hide
        // a 404 would let a watch confuse "blocked" with "removed", which is
        // the one distinction these fixtures exist to keep sharp.
        response.status(404).type('text/html').send(notFoundPage('product'));
        return;
      }
      modes.serve(request, response, (layout) => productPage(product, layout));
    });

    app.get('/__test/product/:id', (request, response) => {
      const product = products.get(request.params.id);
      if (product === undefined) {
        response.status(404).json({ error: 'no such product' });
        return;
      }
      response.json(product);
    });

    app.post('/__test/product/:id', (request, response) => {
      const parsed = parseProduct(request.params.id, request.body);
      if (typeof parsed === 'string') {
        response.status(400).json({ error: parsed });
        return;
      }
      products.set(parsed.id, parsed);
      response.json(parsed);
    });
  };

  const buildControl = (request: ControlRequest): FakestoreControl => ({
    ...buildModeControl(request),
    setProduct: (id, input) => request<Product>('POST', `/__test/product/${id}`, input),
    product: (id) => request<Product>('GET', `/__test/product/${id}`),
  });

  return startFixture('fakestore', mount, buildControl, options);
}
