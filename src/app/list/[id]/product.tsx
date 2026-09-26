import { router, useLocalSearchParams } from 'expo-router';
import React from 'react';
import { itemKey, queryKey } from '../../../lists/types';
import { useComparison, useList, usePricingRun } from '../../../state/AppProvider';
import { ProductDetail } from '../../../ui/ProductDetail';
import { ScreenHeader } from '../../../ui/ScreenHeader';

type Params = { id: string; store: string; item: string; product: string };

/** A product as one of a list's items: from the item's search, its barcode search, or the trip it was bought on. */
export default function ListProductScreen() {
  const { id, store, item, product } = useLocalSearchParams<Params>();
  const list = useList(id);
  const listItem = list?.items.find((i) => i.id === item);
  const run = usePricingRun(list?.id);
  const { baskets } = useComparison(list, run);
  if (!list || !listItem || !store || !product) return <ScreenHeader title="Product" subtitle="This item isn’t on the list anymore." />;

  const results = run?.results[store];
  const candidates = [results?.[itemKey(listItem)], listItem.exact?.gtin ? results?.[queryKey(listItem.exact.gtin)] : undefined];
  const result = candidates.find((r) => r?.products.some((p) => p.id === product));
  const tripProduct = list.trip?.lines[listItem.id]?.product;
  const found = result?.products.find((p) => p.id === product) ?? (tripProduct?.id === product ? tripProduct : null);
  if (!found) return <ScreenHeader title="Product" subtitle={`This product isn’t in the latest results for ${listItem.name}.`} />;

  const elsewhere = baskets
    .filter((b) => b.retailerId !== store)
    .flatMap((b) => {
      const line = b.lines.find((l) => l.item.id === listItem.id);
      return line?.status === 'found' && line.product ? [{ retailerId: b.retailerId, product: line.product }] : [];
    });

  return (
    <ProductDetail
      key={`${store}|${product}`}
      retailerId={store}
      product={found}
      result={result}
      elsewhere={elsewhere}
      item={{ listId: list.id, item: listItem }}
      openElsewhere={(rid, p) => router.push({ pathname: '/list/[id]/product', params: { id: list.id, store: rid, item: listItem.id, product: p.id } })}
    />
  );
}
