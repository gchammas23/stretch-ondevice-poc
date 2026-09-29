import { isObj, num, str, type Obj } from './json';
import { nutritionFromData, nutritionFromSchemaOrg, type Nutrition } from './nutrition';
import type { PagePayload, Product } from './types';

// Pure functions only: no React Native imports, so the tests run them in Node.
//
// Reads a product's own page, loaded on the phone like a search page: the structured data stores publish for search
// engines (schema.org Product), the page's own data, and its share tags. No per-store code.

export interface ProductDetails {
  /** Photos, largest set the page offers, the listing's own photo not repeated. */
  images: string[];
  description?: string;
  /** Short selling points, when the page lists them. */
  highlights: string[];
  brand?: string;
  size?: string;
  ingredients?: string;
  /** Its Nutrition Facts, when the page publishes them. */
  nutrition?: Nutrition;
  rating?: { value: number; count?: number };
  /** The price the product page shows, when it says. */
  price?: number;
  inStock?: boolean;
  /** Barcode (GTIN or UPC), when given. */
  gtin?: string;
  /** Where the details were found, in words. */
  sources: string[];
  /** How many kinds of detail were found. */
  count: number;
}

const ID_KEYS = ['usItemId', 'tcin', 'productId', 'product_id', 'itemId', 'item_id', 'sku', 'skuId', 'upc', 'gtin13', 'gtin', 'id'];

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Visible text from an HTML fragment. */
export function plainText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, '’')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function absolute(url: string, origin: string): string | undefined {
  if (/^https:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/') && origin) return `${origin}${url}`;
  return undefined;
}

function imageList(v: unknown, origin: string, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof v === 'string') {
    const url = absolute(v.trim(), origin);
    return url && !/\.svg(\?|$)/i.test(url) ? [url] : [];
  }
  if (Array.isArray(v)) return v.flatMap((x) => imageList(x, origin, depth + 1));
  if (isObj(v)) {
    for (const k of ['url', 'contentUrl', 'src', 'href', 'baseUrl', 'base_url', 'primary', 'hero', 'thumbnailUrl']) {
      const hit = imageList(v[k], origin, depth + 1);
      if (hit.length) return hit;
    }
  }
  return [];
}

const types = (o: Obj): string[] => {
  const t = o['@type'];
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : typeof t === 'string' ? [t] : [];
};

/** schema.org Product nodes in a JSON-LD document, @graph and arrays included. */
function productNodes(root: unknown, out: Obj[] = [], depth = 0): Obj[] {
  if (depth > 6) return out;
  if (Array.isArray(root)) root.forEach((x) => productNodes(x, out, depth + 1));
  else if (isObj(root)) {
    if (types(root).some((t) => /^(Product|ProductGroup|IndividualProduct)$/i.test(t))) out.push(root);
    for (const k of ['@graph', 'mainEntity', 'itemListElement', 'hasVariant', 'item']) if (root[k]) productNodes(root[k], out, depth + 1);
  }
  return out;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** How well a node fits the product: its barcode or id, else the words its name shares. */
function fit(node: Obj, product: Product): number {
  for (const k of ['sku', 'gtin', 'gtin12', 'gtin13', 'gtin14', 'productID', 'mpn']) {
    const v = node[k];
    if ((typeof v === 'string' || typeof v === 'number') && String(v) === product.id) return 100;
  }
  const name = str(node.name);
  if (!name) return 0;
  const a = words(name);
  const b = words(product.name);
  return [...a].filter((w) => b.has(w)).length;
}

interface Found {
  images: string[];
  description?: string;
  highlights: string[];
  brand?: string;
  size?: string;
  ingredients?: string;
  nutrition?: Nutrition;
  rating?: { value: number; count?: number };
  price?: number;
  inStock?: boolean;
  gtin?: string;
}

function fromLd(node: Obj, origin: string): Found {
  const offers = Array.isArray(node.offers) ? node.offers.find(isObj) : isObj(node.offers) ? node.offers : undefined;
  const brand = isObj(node.brand) ? str(node.brand.name) : str(node.brand);
  const rating = isObj(node.aggregateRating) ? node.aggregateRating : undefined;
  const ratingValue = rating ? (num(rating.ratingValue) ?? Number(str(rating.ratingValue))) : undefined;
  const ratingCount = rating ? (num(rating.reviewCount) ?? num(rating.ratingCount) ?? Number(str(rating.reviewCount) ?? str(rating.ratingCount))) : undefined;
  const price = offers ? (num(offers.price) ?? num(offers.lowPrice) ?? Number(str(offers.price) ?? str(offers.lowPrice))) : undefined;
  const availability = offers ? str(offers.availability) : undefined;
  const weight = isObj(node.weight) ? [str(node.weight.value) ?? num(node.weight.value), str(node.weight.unitText) ?? str(node.weight.unitCode)].filter(Boolean).join(' ') : str(node.weight);
  const gtin = ['gtin13', 'gtin12', 'gtin14', 'gtin', 'gtin8'].map((k) => node[k]).find((v) => typeof v === 'string' || typeof v === 'number');
  return {
    images: imageList(node.image, origin),
    description: str(node.description) ? plainText(str(node.description)!) : undefined,
    highlights: [],
    brand,
    size: str(node.size) ?? (weight || undefined),
    nutrition: nutritionFromSchemaOrg(node.nutrition),
    rating: ratingValue && ratingValue > 0 && ratingValue <= 5 ? { value: ratingValue, count: ratingCount && ratingCount > 0 ? ratingCount : undefined } : undefined,
    price: price && price > 0 ? price : undefined,
    inStock: availability ? /InStock|LimitedAvailability|OnlineOnly|InStoreOnly/i.test(availability) : undefined,
    gtin: gtin !== undefined ? String(gtin) : undefined,
  };
}

/** The object in the page's own data that is this product: the one carrying its id with the most to say. */
function productObject(root: unknown, id: string): Obj | null {
  let best: Obj | null = null;
  let size = 0;
  const visit = (v: unknown, depth: number) => {
    if (depth > 40) return;
    if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else if (isObj(v)) {
      const keys = Object.keys(v);
      if (keys.length > size && ID_KEYS.some((k) => (typeof v[k] === 'string' || typeof v[k] === 'number') && String(v[k]) === id)) {
        best = v;
        size = keys.length;
      }
      for (const child of Object.values(v)) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return best;
}

/** Details from the page's own data, looking a few levels into the product's object. */
function fromData(o: Obj, origin: string): Found {
  const found: Found = { images: [], highlights: [] };
  const visit = (v: Obj, depth: number) => {
    for (const [k, child] of Object.entries(v)) {
      if (typeof child === 'string') {
        const text = child.trim();
        if (!found.description && /^(long_?)?description(_?html)?$|^product_?description$|^downstream_?description$|^marketing_?description$/i.test(k) && text.length >= 30) {
          found.description = plainText(text);
        } else if (!found.ingredients && /ingredient/i.test(k) && text.length >= 3) found.ingredients = plainText(text);
        else if (!found.brand && /^brand(_?name)?$/i.test(k)) found.brand = text;
        else if (!found.size && /^(size|net_?content|package_?size|item_?size|unit_?size|product_?size)$/i.test(k) && text.length <= 40) found.size = text;
      } else if (typeof child === 'number') {
        if (!found.rating && /^(average_?rating|avg_?rating|rating_?value|rating|stars)$/i.test(k) && child > 0 && child <= 5) found.rating = { value: child };
        else if (found.rating && !found.rating.count && /^(review_?count|rating_?count|total_?reviews|reviews_?count|num_?reviews|count)$/i.test(k) && child > 0) {
          found.rating = { ...found.rating, count: child };
        }
      } else if (Array.isArray(child)) {
        if (/image|photo|picture|media|gallery/i.test(k)) found.images.push(...imageList(child, origin));
        else if (!found.highlights.length && /bullet|highlight|feature/i.test(k) && child.every((x) => typeof x === 'string')) {
          found.highlights = (child as string[]).map((x) => plainText(x)).filter((x) => x.length > 1).slice(0, 8);
        } else if (depth < 4) child.filter(isObj).slice(0, 5).forEach((c) => visit(c, depth + 1));
      } else if (isObj(child)) {
        if (/^(brand)$/i.test(k) && !found.brand) found.brand = str(child.name);
        else if (/image|photo|picture|media/i.test(k)) found.images.push(...imageList(child, origin));
        else if (depth < 4) visit(child, depth + 1);
      }
    }
  };
  visit(o, 0);
  found.nutrition = nutritionFromData(o);
  return found;
}

function fromMeta(text: string, origin: string): Found {
  const meta = parse(text);
  if (!isObj(meta)) return { images: [], highlights: [] };
  const description = str(meta['og:description']) ?? str(meta.description);
  const price = Number(str(meta['product:price:amount']) ?? str(meta['og:price:amount']));
  return {
    images: imageList(str(meta['og:image']) ?? '', origin),
    description: description && description.length >= 30 ? plainText(description) : undefined,
    highlights: [],
    price: price > 0 ? price : undefined,
  };
}

const originOf = (href: string | undefined) => (href && /^https?:\/\/[^/?#]+/i.exec(href)?.[0]) || '';

/** Everything the product's page says about it, from the most reliable source first. */
export function parseProductPage(payload: PagePayload, product: Product): ProductDetails {
  const origin = originOf(payload.href) || originOf(product.url);
  const parts: { from: string; found: Found }[] = [];

  const ld = (payload.sources ?? []).filter((s) => s.label === 'ld+json').flatMap((s) => productNodes(parse(s.text)));
  const node = ld.sort((a, b) => fit(b, product) - fit(a, product))[0];
  if (node) parts.push({ from: 'the structured data the store publishes', found: fromLd(node, origin) });

  const data = [
    ...(payload.nextDataText ? [payload.nextDataText] : []),
    ...(payload.sources ?? []).filter((s) => s.label !== 'ld+json' && s.label !== 'meta').map((s) => s.text),
  ];
  for (const text of data) {
    const obj = productObject(parse(text), product.id);
    if (obj) {
      parts.push({ from: 'the page’s own data', found: fromData(obj, origin) });
      break;
    }
  }

  const meta = (payload.sources ?? []).find((s) => s.label === 'meta');
  if (meta) parts.push({ from: 'the page’s share tags', found: fromMeta(meta.text, origin) });

  const pick = <K extends keyof Found>(k: K): Found[K] | undefined => parts.map((p) => p.found[k]).find((v) => v !== undefined && v !== '');
  const seen = new Set<string>(product.imageUrl ? [product.imageUrl.split('?')[0]] : []);
  const images: string[] = [];
  for (const url of parts.flatMap((p) => p.found.images)) {
    const bare = url.split('?')[0];
    if (seen.has(bare)) continue;
    seen.add(bare);
    images.push(url);
    if (images.length >= 8) break;
  }
  const details: ProductDetails = {
    images,
    description: pick('description')?.slice(0, 1500),
    highlights: parts.map((p) => p.found.highlights).find((h) => h.length) ?? [],
    brand: pick('brand'),
    size: pick('size'),
    ingredients: pick('ingredients')?.slice(0, 1200),
    nutrition: pick('nutrition'),
    rating: pick('rating'),
    price: pick('price'),
    inStock: pick('inStock'),
    gtin: pick('gtin'),
    sources: parts.filter((p) => Object.values(p.found).some((v) => (Array.isArray(v) ? v.length : v !== undefined))).map((p) => p.from),
    count: 0,
  };
  details.count = [
    details.images.length > 0,
    details.description,
    details.highlights.length > 0,
    details.brand,
    details.size,
    details.ingredients,
    details.nutrition,
    details.rating,
    details.price,
    details.inStock !== undefined,
    details.gtin,
  ].filter(Boolean).length;
  return details;
}
