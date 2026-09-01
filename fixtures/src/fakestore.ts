import type { Express } from 'express';

import {
  type ControlRequest,
  type FixtureHandle,
  readRecord,
  startFixture,
  type StartFixtureOptions,
} from './harness.js';
import { documentShell, escapeHtml, NORMAL_STATE, notFoundPage } from './pages.js';

export type StockState = 'in_stock' | 'out_of_stock';

export interface ProductInput {
  readonly title: string;
  readonly price: number;
  readonly stock: StockState;
}

export interface Product extends ProductInput {
  readonly id: string;
}

export interface FakestoreControl {
  setProduct(id: string, input: ProductInput): Promise<Product>;
  product(id: string): Promise<Product>;
}

const STOCK_LABELS: Record<StockState, string> = {
  in_stock: 'In stock',
  out_of_stock: 'Out of stock',
};

function parseProduct(id: string, body: unknown): Product | string {
  const record = readRecord(body);
  const { title, price, stock } = record;

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
 * An out-of-stock product renders its availability and no price at all. Real
 * storefronts do this, and it makes an extractor that assumes a price is always
 * present fail loudly instead of recording the last one it saw.
 */
function renderProduct(product: Product): string {
  const price =
    product.stock === 'in_stock'
      ? [
          '          <dt class="pd-term">Price</dt>',
          `          <dd class="pd-value" data-testid="product-price" aria-label="Price">$${product.price.toFixed(2)}</dd>`,
        ]
      : [];

  return documentShell({
    title: product.title,
    state: NORMAL_STATE,
    main: [
      '      <article class="pd-card">',
      `        <h1 class="pd-title" data-testid="product-title">${escapeHtml(product.title)}</h1>`,
      '        <dl class="pd-facts">',
      ...price,
      '          <dt class="pd-term">Availability</dt>',
      `          <dd class="pd-value" data-testid="product-stock" aria-label="Availability">${STOCK_LABELS[product.stock]}</dd>`,
      '        </dl>',
      '      </article>',
    ].join('\n'),
  });
}

export function startFakestoreFixture(
  options: StartFixtureOptions = {},
): Promise<FixtureHandle<FakestoreControl>> {
  const products = new Map<string, Product>();

  const mount = (app: Express): void => {
    app.get('/product/:id', (request, response) => {
      const product = products.get(request.params.id);
      if (product === undefined) {
        response.status(404).type('text/html').send(notFoundPage('product'));
        return;
      }
      response.type('text/html').send(renderProduct(product));
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
    setProduct: (id, input) => request<Product>('POST', `/__test/product/${id}`, input),
    product: (id) => request<Product>('GET', `/__test/product/${id}`),
  });

  return startFixture('fakestore', mount, buildControl, options);
}
