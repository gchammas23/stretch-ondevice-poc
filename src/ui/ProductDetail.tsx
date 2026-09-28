import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ListItem } from '../lists/types';
import { queryKey } from '../lists/types';
import type { ProductDetails } from '../onDevice/productPage';
import { onRetailerSite } from '../onDevice/retailerSearch';
import { storeLine } from '../onDevice/storeIdentity';
import { bytesText, reasonWords } from '../onDevice/scrapeFeed';
import type { Product } from '../onDevice/types';
import { exactFrom } from '../pricing/exact';
import type { SearchResult } from '../pricing/pricingEngine';
import { readerWords } from '../onDevice/profiles';
import { changeText, hostOf, receiptFor, sourceWords, whenLabel } from '../pricing/receipt';
import { compareSizes, type SizeNote } from '../pricing/sizes';
import { storeNote } from '../state/storeInfo';
import { useApp, useHistory, useRetailer, useSettings, useStoreChoices, useStoreName, useUsuals, useWatch } from '../state/AppProvider';
import { announce, hiddenFromScreenReaders } from './a11y';
import { Chip, SaleChip, Sparkline } from './bits';
import { Pill, ProductThumb, tap } from './controls';
import { deviceWord } from './device';
import { Icon } from './Icon';
import { RetailerBadge } from './RetailerBadge';
import { ScreenHeader } from './ScreenHeader';
import { colors, fonts, money, radius, shadow } from './theme';
import { useNow } from './useNow';

export interface ProductDetailProps {
  retailerId: string;
  product: Product;
  /** The search the product came from, for the receipt. Missing when it was frozen on a trip. */
  result?: SearchResult;
  /** The same item, or the same search, at the other stores. */
  elsewhere: { retailerId: string; product: Product }[];
  openElsewhere: (retailerId: string, product: Product) => void;
  /** The list item it's for, when opened from a list: then it can become the usual, or the exact product. */
  item?: { listId: string; item: ListItem };
}

interface Live {
  state: 'reading' | 'done' | 'failed' | 'none';
  details?: ProductDetails;
  ms?: number;
  reason?: string;
}

/**
 * A product, as the phone read it: opens at once with what the search read, then reads the product's own page on
 * the store's site, hidden, for more. Also how the price was read, its history, and the same item elsewhere.
 */
export function ProductDetail({ retailerId, product, result, elsewhere, openElsewhere, item }: ProductDetailProps) {
  const insets = useSafeAreaInsets();
  const { store, search } = useApp();
  const cfg = useRetailer(retailerId);
  const settings = useSettings();
  const choices = useStoreChoices();
  const usuals = useUsuals();
  const watch = useWatch();
  const history = useHistory();
  const now = useNow(30_000);
  const { width, fontScale } = useWindowDimensions();
  const [live, setLive] = useState<Live>(() => (cfg && product.url ? { state: 'reading' } : { state: 'none' }));

  // The phone reads the product's own page on the store's site, hidden, like a search.
  useEffect(() => {
    if (!cfg || !product.url) return;
    let alive = true;
    const t0 = Date.now();
    search.readProduct(cfg, product).then(
      (details) => {
        if (!alive) return;
        setLive({ state: 'done', details, ms: Date.now() - t0 });
        if (details.count) announce(`Read ${details.count} ${details.count === 1 ? 'detail' : 'details'} from ${cfg.name}’s page`);
      },
      (e: unknown) => {
        if (!alive) return;
        setLive({ state: 'failed', reason: (e as { reason?: string })?.reason ?? String(e) });
        announce(`Couldn’t read the product’s page on ${cfg.name}`);
      },
    );
    return () => {
      alive = false;
    };
  }, [cfg, product, search]);

  const name = cfg?.name ?? retailerId;
  const nameOf = useStoreName();
  const storeKey = choices.find((c) => c.config.id === retailerId)?.storeKey ?? '';
  const points = history.points(retailerId, storeKey, product.id);
  const change = history.change(retailerId, storeKey, product.id);
  const receipt = receiptFor(result, name, hostOf(cfg?.searchUrl ?? product.url ?? ''), now);
  const details = live.details;
  const watched = watch.find((w) => w.retailerId === retailerId && w.productId === product.id);
  const usual = item ? usuals[queryKey(item.item.name)]?.[retailerId] === product.id : false;
  const exact = item?.item.exact;
  const isExact = !!exact && exact.retailerId === retailerId && exact.productId === product.id;
  const gtin = product.gtin ?? details?.gtin;

  const sizes = compareSizes([{ retailerId, product }, ...elsewhere]);
  const mine: SizeNote | undefined = sizes[retailerId];
  const images = [product.imageUrl, ...(details?.images ?? [])].filter((u): u is string => !!u);
  const photoWidth = width - 32;
  const pagePrice = details?.price;

  const toggleWatch = () => {
    tap();
    if (watched) store.unwatch(retailerId, product.id);
    else store.watchProduct(retailerId, storeKey, product);
  };

  return (
    <View style={styles.screen}>
      <ScreenHeader />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <Photos images={images} width={photoWidth} product={product} />

        <View style={styles.storeLine}>
          <RetailerBadge retailerId={retailerId} name={name} size={28} />
          <Text style={styles.storeName}>{name}</Text>
          <Text style={[styles.small, styles.flex]} numberOfLines={fontScale > 1.3 ? undefined : 1}>
            · {storeNote(retailerId, settings)}
          </Text>
        </View>
        <Text style={styles.name} accessibilityRole="header">
          {product.name}
        </Text>
        {details?.brand || details?.size || mine?.size ? (
          <Text style={styles.small}>{[details?.brand, details?.size ?? mine?.size?.text].filter(Boolean).join(' · ')}</Text>
        ) : null}

        <View style={styles.priceRow}>
          <Text style={styles.price}>{product.price !== null ? money(product.price) : 'No price'}</Text>
          {mine?.unitPrice ? <Text style={styles.unit}>{mine.unitPrice.text}</Text> : null}
        </View>
        <View style={styles.chips}>
          <SaleChip product={product} />
          {mine?.cheapestPerUnit ? <Chip label="Lowest per unit of your stores" icon="ruler" tone="green" /> : null}
          {mine?.bigger ? <Chip label={`Bigger pack: ${mine.bigger.times}× ${nameOf(mine.bigger.than)}’s`} tone="blue" /> : null}
          {mine?.smaller ? <Chip label={`Smaller pack than ${nameOf(mine.smaller.than)}’s`} tone="plain" /> : null}
          {change ? <Chip label={changeText(change, now)} tone={change.delta < 0 ? 'green' : 'red'} /> : null}
          {details?.rating ? (
            <Chip
              label={`${details.rating.value.toFixed(1)}${details.rating.count ? ` · ${details.rating.count.toLocaleString('en-US')} reviews` : ''}`}
              icon="star"
            />
          ) : null}
        </View>

        <View style={styles.actions}>
          {/* An item compared on the same product everywhere doesn't use a usual: the section below chooses for it. */}
          {item && !exact ? (
            usual ? (
              <Pill
                label={`Your usual for ${item.item.name}`}
                accessibilityLabel={`Your usual for ${item.item.name}`}
                checked
                icon="heart"
                small
                variant="outline"
                onPress={() => store.forgetUsual(item.item.name, retailerId)}
              />
            ) : (
              <Pill
                label="Make this my usual"
                accessibilityLabel={`Your usual for ${item.item.name}`}
                checked={false}
                icon="heart"
                small
                variant="dark"
                onPress={() => {
                  tap();
                  store.setPick(item.listId, item.item.id, retailerId, product.id);
                }}
              />
            )
          ) : null}
          <Pill
            label={watched ? 'Watching the price' : 'Watch the price'}
            accessibilityLabel="Watch the price"
            checked={!!watched}
            icon="clock"
            small
            variant={watched ? 'dark' : 'outline'}
            onPress={toggleWatch}
          />
          {cfg && product.url && onRetailerSite(cfg, product.url) ? (
            <Pill
              label={`View on ${name}`}
              icon="external"
              small
              variant="outline"
              onPress={() => void search.viewProduct(cfg, product.url!).catch(() => {})}
            />
          ) : null}
        </View>
        {usual && !exact ? <Text style={styles.hint}>Used for “{item!.item.name}” in every list. Tap to go back to Stretch’s match.</Text> : null}
        {watched ? (
          <Text style={styles.hint}>
            Watching since {money(watched.addedPrice)}. Stretch tells you when this phone reads a lower price
            {watched.drop ? `: it dropped from ${money(watched.drop.from)} to ${money(watched.drop.to)} ${whenLabel(watched.drop.at, now)}` : ''}.
          </Text>
        ) : null}

        {item ? (
          <Section icon="copy" title="The same product everywhere">
            {isExact ? (
              <>
                <Text style={styles.body}>
                  Your other stores are compared on this exact product for “{item.item.name}”
                  {gtin ? ', by its barcode where they publish one, else by its name and size' : ', by its name and size'}.
                </Text>
                <Pill
                  label="Back to the best match at each store"
                  small
                  variant="outline"
                  onPress={() => store.setExact(item.listId, item.item.id, null)}
                  style={styles.alignStart}
                />
              </>
            ) : (
              <>
                <Text style={styles.small}>
                  Compare this exact product at your other stores, instead of each store’s best match for “{item.item.name}”.
                  {exact ? ` Now: ${exact.name}.` : ''}
                </Text>
                <Pill
                  label="Compare this exact product"
                  small
                  variant="dark"
                  onPress={() => {
                    tap();
                    store.setExact(item.listId, item.item.id, exactFrom({ ...product, gtin }, retailerId));
                  }}
                  style={styles.alignStart}
                />
              </>
            )}
          </Section>
        ) : null}

        <Section icon="phone" title="How this price was read">
          {receipt ? (
            <>
              <Text style={styles.body}>
                {receipt.saved ? receipt.when : `${receipt.when} on this ${deviceWord}`}
                {result?.at ? ` (${new Date(result.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})` : ''}.
              </Text>
              <Text style={styles.body}>{receipt.how}</Text>
              {result?.store ? (
                <Text style={styles.body}>
                  Prices for {storeLine(result.store)}
                  {result.store.address && result.store.name ? `, ${result.store.address}` : ''}.
                </Text>
              ) : null}
              <Text style={styles.small}>
                {receipt.ms !== undefined ? `The search took ${(receipt.ms / 1000).toFixed(1)} s` : ''}
                {receipt.ms !== undefined && result?.found ? ` and returned ${result.found} product${result.found === 1 ? '' : 's'}` : ''}
                {receipt.ms !== undefined && receipt.bytes ? `, using about ${bytesText(receipt.bytes)} of data` : ''}
                {receipt.ms !== undefined ? '.' : ''}
                {receipt.source ? ` The prices were in ${sourceWords(receipt.source)}.` : ''}
                {receipt.reader ? ` ${readerWords(receipt.reader, name)}` : ''}
              </Text>
              {receipt.note ? <Text style={styles.small}>{receipt.note}</Text> : null}
              <Pill
                label="X-ray: the data behind this price"
                icon="eye"
                small
                variant="outline"
                onPress={() => router.push({ pathname: '/xray', params: { retailerId, productId: product.id } })}
                style={styles.alignStart}
              />
            </>
          ) : (
            <Text style={styles.body}>Kept from when you started shopping, so the list doesn’t change mid-trip.</Text>
          )}
          {pagePrice !== undefined && product.price !== null ? (
            Math.abs(pagePrice - product.price) < 0.01 ? (
              <View style={styles.check}>
                <Icon name="check" size={16} color={colors.green} strokeWidth={2.6} />
                <Text style={[styles.small, styles.flex, { color: colors.green }]}>The product’s own page shows the same price, just now.</Text>
              </View>
            ) : (
              <Text style={[styles.small, { color: colors.amber }]}>
                The product’s own page shows {money(pagePrice)}. Prices can differ between the search and the product page, or by store.
              </Text>
            )
          ) : null}
        </Section>

        <Section icon="clock" title="Price history">
          {points.length >= 2 ? (
            <>
              <Sparkline points={points} width={photoWidth - 32} />
              {points
                .slice(-4)
                .reverse()
                .map((p) => (
                  <View key={p.at} style={styles.historyRow}>
                    <Text style={styles.body}>{money(p.price)}</Text>
                    <Text style={styles.small}>
                      {p.seen - p.at > 60_000 ? `${whenLabel(p.at, now)} to ${whenLabel(p.seen, now)}` : whenLabel(p.at, now)}
                    </Text>
                  </View>
                ))}
            </>
          ) : (
            <Text style={styles.small}>
              {points.length
                ? `${money(points[0].price)} since ${whenLabel(points[0].at, now)}. Changes show up here as this phone checks again.`
                : 'Changes show up here as this phone checks prices again.'}
            </Text>
          )}
        </Section>

        {elsewhere.length ? (
          <Section icon="store" title={item ? `${item.item.name} at your other stores` : 'At your other stores'}>
            {elsewhere.map(({ retailerId: rid, product: p }) => {
              const note = sizes[rid];
              return (
                <Pressable
                  key={rid}
                  accessibilityRole="button"
                  onPress={() => openElsewhere(rid, p)}
                  style={({ pressed }) => [styles.other, pressed && styles.pressed]}
                >
                  <RetailerBadge retailerId={rid} name={nameOf(rid)} size={32} />
                  <View style={styles.flex}>
                    <Text style={styles.otherName} numberOfLines={2}>
                      {p.name}
                    </Text>
                    <Text style={styles.small}>
                      {nameOf(rid)}
                      {note?.unitPrice ? ` · ${note.unitPrice.text}` : ''}
                      {note?.cheapestPerUnit ? ' · lowest per unit' : ''}
                    </Text>
                  </View>
                  <Text style={styles.otherPrice}>{p.price !== null ? money(p.price) : ''}</Text>
                </Pressable>
              );
            })}
          </Section>
        ) : null}

        <Section icon="globe" title={`From ${hostOf(product.url ?? cfg?.homeUrl ?? '')}`}>
          {live.state === 'reading' ? (
            <View style={styles.check}>
              <ActivityIndicator size="small" color={colors.orange} />
              <Text style={[styles.small, styles.flex]}>Reading this product’s page on {name}’s site, on this {deviceWord}…</Text>
            </View>
          ) : live.state === 'none' ? (
            <Text style={styles.small}>{name} didn’t give a link to this product’s own page.</Text>
          ) : live.state === 'failed' ? (
            <Text style={styles.small}>Couldn’t read the product’s page ({reasonWords(live.reason)}). View it on {name} instead.</Text>
          ) : details && details.count ? (
            <>
              <Text style={styles.small}>
                Read {details.count} {details.count === 1 ? 'detail' : 'details'} from its page in {((live.ms ?? 0) / 1000).toFixed(1)} s, from{' '}
                {details.sources.join(' and ')}.
              </Text>
              {details.description ? <Description text={details.description} /> : null}
              {details.highlights.length ? (
                <View style={styles.bullets}>
                  {details.highlights.map((h) => (
                    <Text key={h} style={styles.body} accessibilityLabel={h}>
                      • {h}
                    </Text>
                  ))}
                </View>
              ) : null}
              {details.ingredients ? (
                <>
                  <Text style={styles.label}>Ingredients</Text>
                  <Description text={details.ingredients} lines={3} />
                </>
              ) : null}
              {details.inStock !== undefined ? <Text style={styles.small}>{details.inStock ? 'In stock' : 'Out of stock'}, the page says.</Text> : null}
            </>
          ) : (
            <Text style={styles.small}>Its page loaded, but didn’t describe the product in a way the phone could read.</Text>
          )}
          {gtin ? <Text style={styles.small}>Barcode {gtin}</Text> : null}
        </Section>
      </ScrollView>
    </View>
  );
}

function Photos({ images, width, product }: { images: string[]; width: number; product: Product }) {
  const [page, setPage] = useState(0);
  if (!images.length) {
    return (
      <View style={[styles.photo, { width, height: width * 0.7 }]}>
        <ProductThumb product={null} size={96} />
      </View>
    );
  }
  return (
    <View>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        style={{ width }}
      >
        {images.map((uri, i) => (
          <View key={uri} style={[styles.photo, { width, height: width * 0.7 }]}>
            <Image
              source={{ uri }}
              style={styles.photoImage}
              resizeMode="contain"
              accessible
              alt={images.length > 1 ? `${product.name}, photo ${i + 1} of ${images.length}` : product.name}
              accessibilityIgnoresInvertColors
            />
          </View>
        ))}
      </ScrollView>
      {images.length > 1 ? (
        // Each photo says which one it is.
        <View style={styles.dots} {...hiddenFromScreenReaders}>
          {images.map((uri, i) => (
            <View key={uri} style={[styles.dot, i === page && styles.dotOn]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Description({ text, lines = 6 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 60;
  return (
    <View style={styles.description}>
      <Text style={styles.body} numberOfLines={open || !long ? undefined : lines}>
        {text}
      </Text>
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? 'Less of the description' : 'More of the description'}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
        >
          <Text style={styles.more}>{open ? 'Less' : 'More'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Section({ icon, title, children }: { icon: React.ComponentProps<typeof Icon>['name']; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Icon name={icon} size={17} color={colors.orange} />
        <Text style={styles.cardTitle} accessibilityRole="header">
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1 },
  pressed: { opacity: 0.8 },
  alignStart: { alignSelf: 'flex-start' },
  photo: { backgroundColor: colors.card, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  photoImage: { width: '86%', height: '86%' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 8 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#D9D5CE' },
  dotOn: { backgroundColor: colors.orange },
  storeLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  storeName: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  name: { fontFamily: fonts.display, fontSize: 24, lineHeight: 30, color: colors.ink },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.ink },
  label: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink, marginTop: 4 },
  hint: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  price: { fontFamily: fonts.semibold, fontSize: 28, color: colors.ink },
  unit: { fontFamily: fonts.medium, fontSize: 15, color: colors.muted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 16, gap: 8, ...shadow.card },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  cardTitle: { flex: 1, fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  check: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  historyRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  other: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  otherName: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 20, color: colors.ink },
  otherPrice: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  description: { gap: 4 },
  more: { fontFamily: fonts.semibold, fontSize: 14, color: colors.orangeText },
  bullets: { gap: 4 },
});
