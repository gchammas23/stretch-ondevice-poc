import { queryKey } from '../lists/types';
import { aisleLabel, aisleText, compareAisles, departmentOf, type Place } from '../onDevice/aisle';
import type { Product } from '../onDevice/types';

// Pure TypeScript: the app saves it with AsyncStorage, the tests keep it in memory.
//
// Where products are in each store, beyond what its searches read (see aisle.ts): what a product's own page said, and
// where the user found it, noted while shopping. Kept by store (its number, whatever the account signed in there) and
// product. A note is kept for the list item it was bought as too, so another product picked for the same item starts
// from it.

/** Where a product is known to be, and from what. */
export interface AisleNote extends Place {
  /** 'page': the product's own page on the store's site. 'you': the user, while shopping. */
  from: 'page' | 'you';
  at: number;
}

/** Where to look for a product on a trip, and what says so: the user, the store's search results, or its product page. */
export interface Spot extends Place {
  from: 'you' | 'search' | 'page';
}

const MAX_ENTRIES = 3000;

const placeOnly = (p: Place): Place => ({ ...(p.aisle ? { aisle: p.aisle } : {}), ...(p.department ? { department: p.department } : {}) });
const isPlace = (p: Place | null | undefined): p is Place => !!p && (!!p.aisle || !!p.department);

export class AisleBook {
  private rows = new Map<string, AisleNote>();
  private listeners = new Set<() => void>();
  private changes = 0;

  constructor(private now: () => number = Date.now) {}

  static productKey(retailerId: string, storeId: string, productId: string): string {
    return `${retailerId}|${storeId}|p:${productId}`;
  }

  static itemKey(retailerId: string, storeId: string, itemName: string): string {
    return `${retailerId}|${storeId}|i:${queryKey(itemName)}`;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Goes up with every change, for re-rendering. */
  get version(): number {
    return this.changes;
  }

  get size(): number {
    return this.rows.size;
  }

  /** How many products the user noted a place for, for What stays on this phone. */
  get notes(): number {
    let n = 0;
    for (const [k, v] of this.rows) if (v.from === 'you' && k.includes('|p:')) n++;
    return n;
  }

  /** How many products' own pages said where they are. */
  get pages(): number {
    let n = 0;
    for (const v of this.rows.values()) if (v.from === 'page') n++;
    return n;
  }

  /** What a product's own page said, at the store it was searched at. The user's own note isn't replaced by it. */
  notePage(retailerId: string, product: Pick<Product, 'storeId' | 'id'>, place: Place): void {
    if (!isPlace(place)) return;
    const key = AisleBook.productKey(retailerId, product.storeId, product.id);
    if (this.rows.get(key)?.from === 'you') return;
    this.put(key, { ...placeOnly(place), from: 'page', at: this.now() });
  }

  /**
   * Where the user found a product: kept for it, and for the item it was bought as, so another product picked for the
   * same item starts there. Null forgets both.
   */
  noteYours(retailerId: string, product: Pick<Product, 'storeId' | 'id'>, itemName: string, place: Place | null): void {
    const keys = [AisleBook.productKey(retailerId, product.storeId, product.id), AisleBook.itemKey(retailerId, product.storeId, itemName)];
    if (!isPlace(place)) {
      if (keys.map((k) => this.rows.delete(k)).some(Boolean)) this.emit();
      return;
    }
    const at = this.now();
    for (const k of keys) this.put(k, { ...placeOnly(place), from: 'you', at }, false);
    this.emit();
  }

  /** The user's note for the product. */
  yours(retailerId: string, storeId: string, productId: string): AisleNote | undefined {
    const note = this.rows.get(AisleBook.productKey(retailerId, storeId, productId));
    return note?.from === 'you' ? note : undefined;
  }

  /** The user's note for another product bought as the same item there. */
  yoursForItem(retailerId: string, storeId: string, itemName: string): AisleNote | undefined {
    return this.rows.get(AisleBook.itemKey(retailerId, storeId, itemName));
  }

  /** What the product's own page said. */
  page(retailerId: string, storeId: string, productId: string): AisleNote | undefined {
    const note = this.rows.get(AisleBook.productKey(retailerId, storeId, productId));
    return note?.from === 'page' ? note : undefined;
  }

  /** Forget prices and history: what pages said goes. The user's notes stay, as their lists do. */
  forgetPages(): void {
    let changed = false;
    for (const [k, v] of this.rows) {
      if (v.from === 'page') {
        this.rows.delete(k);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  clear(): void {
    this.rows.clear();
    this.emit();
  }

  serialize(): string {
    return JSON.stringify([...this.rows]);
  }

  hydrate(json: string | null): void {
    if (!json) return;
    try {
      const rows = JSON.parse(json) as [string, AisleNote][];
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        const [k, v] = Array.isArray(row) ? row : [];
        const ok =
          typeof k === 'string' &&
          !!v &&
          (v.from === 'page' || v.from === 'you') &&
          typeof v.at === 'number' &&
          (v.aisle === undefined || typeof v.aisle === 'string') &&
          (v.department === undefined || typeof v.department === 'string') &&
          isPlace(v);
        if (ok) this.rows.set(k, v);
      }
      this.changes += 1;
    } catch {
      // A corrupt save just means noting places again.
    }
  }

  private put(key: string, note: AisleNote, emit = true): void {
    this.rows.delete(key);
    this.rows.set(key, note);
    // Map order is insertion order, so the first keys are the oldest: what pages said goes before the user's notes.
    while (this.rows.size > MAX_ENTRIES) {
      const oldest = [...this.rows].find(([, v]) => v.from === 'page')?.[0] ?? this.rows.keys().next().value!;
      this.rows.delete(oldest);
    }
    if (emit) this.emit();
  }

  private emit(): void {
    this.changes += 1;
    this.listeners.forEach((listener) => listener());
  }
}

/**
 * Where to look for a product on a trip, best first: where the user found it; its aisle as the store's data has it (its
 * search results', then its page's); where the user found another product bought as the same item; then the area the
 * store's data puts it in. `storeData` false: the latest search's prices were for another store than the one set, and
 * so would its aisles be, so only the user's notes count.
 */
export function spotFor(book: AisleBook, retailerId: string, product: Product, itemName: string, storeData = true): Spot | undefined {
  const mine = book.yours(retailerId, product.storeId, product.id);
  if (mine) return { ...placeOnly(mine), from: 'you' };
  const page = storeData ? book.page(retailerId, product.storeId, product.id) : undefined;
  if (storeData && product.aisle) return { ...placeOnly(product), from: 'search' };
  if (page?.aisle) return { ...placeOnly(page), from: 'page' };
  const item = book.yoursForItem(retailerId, product.storeId, itemName);
  if (item) return { ...placeOnly(item), from: 'you' };
  if (storeData && product.department) return { department: product.department, from: 'search' };
  if (page?.department) return { department: page.department, from: 'page' };
  return undefined;
}

/** A place in a few words, for a checklist line: "Aisle 12", or its area, "Dairy". */
export const placeLabel = (place: Place): string => (place.aisle ? aisleLabel(place.aisle) : (place.department ?? ''));

/**
 * What the user typed for where they found something: an aisle ("12", "aisle a-12"), or an area ("dairy" is Dairy).
 * Text that starts with a number and isn't an aisle ("123", "12 oz") is neither.
 */
export function noteFromText(text: string): Place | undefined {
  const aisle = aisleText(text);
  if (aisle) return { aisle };
  const department = /^\s*\d/.test(text) ? undefined : departmentOf(text);
  return department ? { department: department.charAt(0).toUpperCase() + department.slice(1) } : undefined;
}

/** Areas to note with a tap, as most grocery stores have them. */
export const AREAS = ['Produce', 'Bakery', 'Deli', 'Meat & seafood', 'Dairy', 'Frozen'];

export interface AisleSection<T> {
  key: string;
  /** "Aisle 12", "Dairy", "Aisle not known yet", "Not found here". */
  title: string;
  rows: T[];
}

/**
 * Where an area usually is on a walk through a U.S. grocery store: produce, bakery and deli near the door; meat, dairy
 * and frozen along the back and last, so cold things go in the cart late. Other areas are with the aisles, after them.
 */
const WALK: [RegExp, number][] = [
  [/produce|fruit|vegetable|floral/i, 0],
  [/bakery|bread/i, 1],
  [/deli\b|prepared/i, 2],
  [/meat|seafood|fish|poultry|butcher/i, 20],
  [/dairy|milk|\beggs?\b|cheese|yogurt/i, 21],
  [/frozen|ice cream/i, 22],
];
const AISLES = 10;
const OTHER_AREAS = 15;
const NOT_KNOWN = 30;
const NOT_FOUND = 40;

function sectionOf(spot: Place | undefined, found: boolean): { key: string; title: string; rank: number; aisle?: string } {
  if (!found) return { key: 'none', title: 'Not found here', rank: NOT_FOUND };
  if (spot?.aisle) return { key: `aisle:${spot.aisle}`, title: aisleLabel(spot.aisle), rank: AISLES, aisle: spot.aisle };
  if (spot?.department) {
    const area = spot.department;
    return { key: `area:${area.toLowerCase()}`, title: area, rank: WALK.find(([re]) => re.test(area))?.[1] ?? OTHER_AREAS };
  }
  return { key: 'unknown', title: 'Aisle not known yet', rank: NOT_KNOWN };
}

/**
 * A trip's rows by where they are, in the order a walk through the store meets them (see WALK): the areas by the door,
 * the aisles in order, other areas, then meat, dairy and frozen. Then the rows whose place isn't known yet, and those
 * the store didn't have. Each section keeps the list's order.
 */
export function aisleSections<T>(rows: T[], where: (row: T) => { spot?: Place; found: boolean }): AisleSection<T>[] {
  const sections = new Map<string, ReturnType<typeof sectionOf> & { rows: T[] }>();
  for (const row of rows) {
    const { spot, found } = where(row);
    const section = sectionOf(spot, found);
    const had = sections.get(section.key);
    if (had) had.rows.push(row);
    else sections.set(section.key, { ...section, rows: [row] });
  }
  return [...sections.values()]
    .sort((a, b) => a.rank - b.rank || (a.aisle && b.aisle ? compareAisles(a.aisle, b.aisle) : a.title.localeCompare(b.title)))
    .map(({ key, title, rows: inIt }) => ({ key, title, rows: inIt }));
}
