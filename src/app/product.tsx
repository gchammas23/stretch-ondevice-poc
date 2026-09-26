import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { queryKey } from '../lists/types';
import { normalizeBarcode } from '../onDevice/barcode';
import type { Product } from '../onDevice/types';
import { priceCheckAnswers } from '../pricing/priceCheck';
import { QUICK_RUN, usePricingRun, useStoreChoices } from '../state/AppProvider';
import { ProductDetail } from '../ui/ProductDetail';
import { ScreenHeader } from '../ui/ScreenHeader';

/**
 * `q` is the search the product came from; `code` is set when the price check started from a barcode, and `like`
 * when it started from a product to find everywhere (with `code` if that product has a barcode).
 */
type Params = { store: string; q: string; product: string; code?: string; like?: string };

/** A product from a price check: the other stores are what the price check shows for them. */
export default function SearchProductScreen() {
  const { store, q, product, code, like } = useLocalSearchParams<Params>();
  const run = usePricingRun(QUICK_RUN);
  const choices = useStoreChoices();
  if (!store || !q || !product) return <ScreenHeader title="Product" />;
  const result = run?.results[store]?.[queryKey(q)];
  const found = result?.products.find((p) => p.id === product);
  if (!found) return <ScreenHeader title="Product" subtitle="This product isn’t in the latest results anymore." />;

  const barcode = code ? normalizeBarcode(code) : null;
  const known = like ? { name: like, ...(barcode ? { gtin: barcode } : {}) } : undefined;
  const answers = priceCheckAnswers(run, choices.map((c) => c.config), known?.name ?? barcode ?? q, barcode, known).filter(
    (a) => a.retailerId !== store && a.status === 'found' && a.product,
  );
  const elsewhere = answers.map((a) => ({ retailerId: a.retailerId, product: a.product! }));
  const open = (rid: string, p: Product) => {
    const q2 = answers.find((a) => a.retailerId === rid)?.query ?? q;
    router.push({ pathname: '/product', params: { store: rid, q: q2, product: p.id, ...(barcode ? { code: barcode } : {}), ...(like ? { like } : {}) } });
  };

  return (
    <ProductDetail key={`${store}|${product}`} retailerId={store} product={found} result={result} elsewhere={elsewhere} openElsewhere={open} />
  );
}
