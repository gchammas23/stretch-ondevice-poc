import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { itemKey, type GroceryList } from '../../../../lists/types';
import { dayOf } from '../../../../onDevice/adPage';
import type { Product } from '../../../../onDevice/types';
import { adHits } from '../../../../pricing/ads';
import { ago, staleness } from '../../../../pricing/age';
import { basketFor, type BasketLine } from '../../../../pricing/basket';
import { bytesText, reasonWords } from '../../../../onDevice/scrapeFeed';
import { couponHits, couponsFitting, couponsWords, type CouponCredit } from '../../../../pricing/coupons';
import { exactFrom } from '../../../../pricing/exact';
import { inStoreCaveat, MODE_WORDS, orderable, planOffers } from '../../../../pricing/onlineCost';
import { changeText, hostOf, receiptFor } from '../../../../pricing/receipt';
import { compareSizes, type SizeNote } from '../../../../pricing/sizes';
import { swapSavings, swapsFor, type Swap } from '../../../../pricing/swaps';
import { startTrip } from '../../../../pricing/trips';
import { storeNote } from '../../../../state/storeInfo';
import {
  useApp,
  useComparison,
  useCouponBook,
  useCoupons,
  useFeeBook,
  useFeeContexts,
  useFeeReads,
  useHistory,
  useList,
  usePricingRun,
  useRetailer,
  useSavingsReads,
  useSettings,
  useStoreChoices,
  useStoreName,
  useUsuals,
  useWeeklyAds,
} from '../../../../state/AppProvider';
import { announce, useFooterHeight } from '../../../../ui/a11y';
import { AdNote, CouponNote } from '../../../../ui/AdsCoupons';
import { Chip, SaleChip } from '../../../../ui/bits';
import { Pill, ProductThumb, QtyStepper, tap } from '../../../../ui/controls';
import { Icon } from '../../../../ui/Icon';
import { RetailerBadge } from '../../../../ui/RetailerBadge';
import { ScreenHeader } from '../../../../ui/ScreenHeader';
import { OnlineBreakdown } from '../../../../ui/ShopMode';
import { colors, fonts, money, radius, shadow } from '../../../../ui/theme';
import { useNow } from '../../../../ui/useNow';

/** Price changes older than this aren't news on the basket (the product page still shows them). */
const CHANGE_NEWS_MS = 7 * 24 * 60 * 60_000;

export default function BasketScreen() {
  const { id, retailerId } = useLocalSearchParams<{ id: string; retailerId: string }>();
  const list = useList(id);
  if (!list || !retailerId) return <ScreenHeader title="Basket" subtitle="This list was deleted." />;
  return <BasketView key={`${list.id}|${retailerId}`} list={list} retailerId={retailerId} />;
}

function BasketView({ list, retailerId }: { list: GroceryList; retailerId: string }) {
  const insets = useSafeAreaInsets();
  const { store, engine, checkFees, clipCoupons } = useApp();
  const settings = useSettings();
  const retailer = useRetailer(retailerId);
  const run = usePricingRun(list.id);
  const usuals = useUsuals();
  const history = useHistory();
  const choices = useStoreChoices();
  const { pick, running, baskets, mode, costAt, online: orders, orderCost, countCoupons, coupons: credits } = useComparison(list, run);
  const basket = basketFor(list, retailerId, run?.results[retailerId], usuals);
  const name = retailer?.name ?? retailerId;
  // Ordering online: this basket's order, its fees and where they came from, read once the stores' prices are in.
  useFeeReads(!running);
  const fees = useFeeBook();
  const ctxOf = useFeeContexts();
  const online = costAt(retailerId, basket.total);
  // Clipped coupons that fit come off the total only when the user counts them, and it says so.
  const credit = credits[retailerId];
  const couponsOff = countCoupons ? (credit?.amount ?? 0) : 0;
  const orderTotal = Math.round(((online?.available ? online.total : basket.total) - couponsOff) * 100) / 100;
  const how = !online ? '' : online.available ? MODE_WORDS[mode] : 'in store only';
  const withCoupons = couponsOff ? ', with coupons' : '';
  const nameOf = useStoreName();
  const [open, setOpen] = useState<string | null>(null);
  const now = useNow(60_000);
  // This week's ad and the account's coupons here, read on the phone once this store's prices are in.
  useSavingsReads(!running);
  const ads = useWeeklyAds();
  const couponLists = useCoupons();
  const couponBook = useCouponBook();
  const inAd = adHits(basket, ads[retailerId], dayOf(now));
  const couponFor = couponHits(basket, couponLists[retailerId], dayOf(now));
  const adCount = Object.keys(inAd).length;
  const clip = async (couponId: string) => {
    tap();
    const got = await clipCoupons(retailerId, [couponId]);
    announce(got.clipped ? 'Coupon clipped.' : `Couldn’t clip it here: ${reasonWords(got.reason)}.`);
  };
  const stale = staleness(run, retailerId);
  const storeKey = choices.find((c) => c.config.id === retailerId)?.storeKey ?? '';
  const host = hostOf(retailer?.searchUrl ?? '');
  // Why older prices couldn't be updated: what the store's page showed.
  const why = Object.values(run?.results[retailerId] ?? {}).find((r) => r.stale && r.status === 'done' && r.detail)?.detail;
  const resultOf = (line: BasketLine) => run?.results[retailerId]?.[itemKey(line.item)];

  /** How this store's pick for the item compares with the other stores' picks for it. */
  const sizeNoteOf = (line: BasketLine): SizeNote | undefined => {
    if (!line.product) return undefined;
    const others = baskets
      .filter((b) => b.retailerId !== retailerId)
      .map((b) => ({ retailerId: b.retailerId, product: b.lines.find((l) => l.item.id === line.item.id)?.product ?? null }))
      .filter((o): o is { retailerId: string; product: Product } => !!o.product);
    return compareSizes([{ retailerId, product: line.product }, ...others])[retailerId];
  };

  const remove = (line: BasketLine) =>
    Alert.alert(`Remove ${line.item.name} from ${list.name}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => store.removeItem(list.id, line.item.id) },
    ]);
  const choose = (line: BasketLine, product: Product) => {
    tap();
    store.setPick(list.id, line.item.id, retailerId, product.id);
    // An item compared on the same product everywhere is compared on the one chosen now: a usual alone wouldn't change
    // it (the same product comes first, see lineFor).
    const exact = !!line.item.exact;
    if (exact) store.setExact(list.id, line.item.id, exactFrom(product, retailerId));
    setOpen(null);
    announce(`${line.item.name}: now ${product.name}${exact ? ', compared at every store' : ''}`);
  };
  const details = (line: BasketLine, product: Product) =>
    router.push({ pathname: '/list/[id]/product', params: { id: list.id, store: retailerId, item: line.item.id, product: product.id } });

  // Cheaper products of the same size in what the phone already read here, the store's own brand first.
  const swaps = swapsFor(basket, (line) => resultOf(line)?.products ?? line.alternatives, retailer?.storeBrands);
  const lineOf = (swap: Swap) => basket.lines.find((l) => l.item.id === swap.item.id)!;
  const swapAll = () => {
    tap();
    for (const swap of swaps) store.setPick(list.id, swap.item.id, retailerId, swap.to.id);
    announce(`${swaps.length} swaps made: ${money(swapSavings(swaps))} less`);
  };

  const shown = basket.lines.filter((l) => l.status === 'found' || l.status === 'pending');
  const missing = basket.lines.filter((l) => l.status === 'missing');
  const failed = basket.lines.filter((l) => l.status === 'failed');
  const [footerHeight, onFooterLayout] = useFooterHeight(110 + insets.bottom);
  const shopHint = !basket.found ? `None of the items were found at ${name}` : !basket.complete ? `Available when ${name} finishes checking` : undefined;

  return (
    <View style={styles.screen}>
      <ScreenHeader />
      <ScrollView contentContainerStyle={{ paddingBottom: footerHeight + 16 }}>
        <View style={styles.head}>
          <View style={styles.headRow}>
            <RetailerBadge retailerId={retailerId} name={name} size={52} />
            <View style={styles.flex}>
              <Text style={styles.headTitle} accessibilityRole="header" accessibilityLabel={`${name}, ${money(orderTotal)}${how ? ` ${how}` : ''}${withCoupons}`}>
                {name} <Text style={styles.headDot}>•</Text> {money(orderTotal)}
              </Text>
              {couponsOff ? (
                <Text style={styles.small}>
                  {money(couponsOff)} off with {credit!.count} clipped {credit!.count === 1 ? 'coupon' : 'coupons'}
                </Text>
              ) : null}
              {online?.available && online.extra ? (
                <Text style={styles.small}>
                  {how} · {money(basket.total)} in store
                </Text>
              ) : null}
              <Text style={styles.small}>{storeNote(retailerId, settings)}</Text>
            </View>
          </View>
          {mode === 'store' && inStoreCaveat(name, retailer?.online) ? <Text style={styles.small}>{inStoreCaveat(name, retailer?.online)}</Text> : null}
          {stale.oldestAt ? (
            <Text style={styles.staleNote}>
              Some prices are from {ago(now - stale.oldestAt)}
              {stale.refreshing ? ', updating now.' : ': they couldn’t be updated.'}
            </Text>
          ) : null}
          {stale.oldestAt && !stale.refreshing && why ? <Text style={styles.small}>{why}</Text> : null}
          <View style={styles.headChips}>
            {pick?.retailerId === retailerId ? (
              <View style={styles.pickChip}>
                <Icon name="sparkle" size={14} color={colors.blue} />
                <Text style={styles.pickChipText}>{running ? 'Leading so far' : 'Stretch’s pick'}</Text>
              </View>
            ) : null}
            {basket.onSale ? (
              <Chip label={`${basket.onSale} on sale · save ${money(basket.saleSavings)}`} icon="tag" tone="orange" />
            ) : null}
            {adCount ? <Chip label={`${adCount} in this week’s ad`} icon="star" tone="blue" /> : null}
          </View>
          {retailer?.coupons ? <CouponsLine name={name} credit={credit} counted={countCoupons} signedIn={!!settings.signedInAt[retailerId]} read={!!couponLists[retailerId]} /> : null}
        </View>
        {online && basket.found ? (
          <OnlineBreakdown
            cost={online}
            name={name}
            rules={retailer?.online}
            read={fees.get(retailerId)}
            reading={fees.reading === retailerId}
            offers={online.available ? planOffers(retailerId, online.way, basket.total, ctxOf(retailerId)) : []}
            now={now}
            onReadAgain={() => void checkFees(true, [retailerId])}
          />
        ) : null}
        {swaps.length ? <SwapsCard swaps={swaps} storeName={name} onSwap={(swap) => choose(lineOf(swap), swap.to)} onSwapAll={swapAll} /> : null}

        <View style={styles.lines}>
          {shown.map((line) => {
            if (line.status === 'pending') {
              return (
                <View key={line.item.id} style={styles.line}>
                  <ProductThumb product={null} size={64} />
                  <View style={styles.flex}>
                    <Text style={styles.term}>{line.item.name}</Text>
                    <View style={styles.checking}>
                      <ActivityIndicator size="small" color={colors.orange} />
                      <Text style={styles.small}>Checking {name}…</Text>
                    </View>
                  </View>
                </View>
              );
            }
            const product = line.product!;
            const note = sizeNoteOf(line);
            const result = resultOf(line);
            const receipt = receiptFor(result, name, host, now);
            const change = history.change(retailerId, storeKey, product.id, CHANGE_NEWS_MS);
            const sizeBits = [note?.size?.text, note?.unitPrice?.text].filter(Boolean).join(' · ');
            return (
              <View key={line.item.id} style={styles.lineWrap}>
                <View style={styles.line}>
                  <Pressable
                    onPress={() => details(line, product)}
                    style={({ pressed }) => [styles.lineMain, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityHint="Opens the product: how its price was read, and more from the store’s page"
                  >
                    <ProductThumb product={product} size={64} />
                    <View style={styles.flex}>
                      <Text style={styles.productName} numberOfLines={2}>
                        {product.name}
                      </Text>
                      <View style={styles.termRow}>
                        <Text style={styles.term}>{line.item.name}</Text>
                        {line.usual ? (
                          <>
                            <Icon name="heart" size={12} color={colors.orangeText} strokeWidth={2.4} />
                            <Text style={styles.usual}>Your usual</Text>
                          </>
                        ) : null}
                      </View>
                      <Text style={styles.price}>
                        {money(product.price!)}
                        {line.item.qty > 1 ? <Text style={styles.small}>{`  ·  ${money(line.lineTotal)} for ${line.item.qty}`}</Text> : null}
                      </Text>
                      {sizeBits ? <Text style={styles.unit}>{sizeBits}</Text> : null}
                      <View style={styles.chips}>
                        <SaleChip product={product} />
                        {note?.bigger ? <Chip label={`Bigger pack: ${note.bigger.times}× ${nameOf(note.bigger.than)}’s`} tone="blue" /> : null}
                        {note?.smaller ? <Chip label={`Smaller pack than ${nameOf(note.smaller.than)}’s`} /> : null}
                        {note?.cheapestPerUnit && baskets.length > 1 ? <Chip label="Lowest per unit" icon="ruler" tone="green" /> : null}
                        {change ? <Chip label={changeText(change, now)} tone={change.delta < 0 ? 'green' : 'red'} /> : null}
                        {line.exact === 'barcode' ? <Chip label="Same product · barcode" icon="check" tone="green" /> : null}
                        {line.exact === 'name' ? <Chip label="Same product · name and size" icon="check" tone="green" /> : null}
                      </View>
                      {line.prefMiss.length ? (
                        <Text style={styles.prefMiss}>No {line.prefMiss.join(', ')} match here: this is the closest.</Text>
                      ) : null}
                      {line.stale ? (
                        <View style={styles.checking}>
                          {line.refreshing ? <ActivityIndicator size="small" color={colors.orange} /> : null}
                          <Text style={[styles.unit, !line.refreshing && { color: colors.amber }]}>
                            Price from {ago(now - (result?.at ?? now))}
                            {line.refreshing ? ' · updating' : ' · couldn’t update'}
                          </Text>
                        </View>
                      ) : receipt ? (
                        <Text style={styles.receipt}>
                          {receipt.when} · {receipt.short}
                          {receipt.bytes ? ` · ${bytesText(receipt.bytes)}` : ''}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                  <QtyStepper
                    qty={line.item.qty}
                    itemName={line.item.name}
                    onChange={(qty) => store.setQty(list.id, line.item.id, qty)}
                    onRemove={() => remove(line)}
                  />
                </View>
                {inAd[line.item.id] || couponFor[line.item.id] ? (
                  <View style={styles.savingsNotes}>
                    {inAd[line.item.id] ? <AdNote hit={inAd[line.item.id]} ad={ads[retailerId]} productPrice={product.price ?? undefined} /> : null}
                    {couponFor[line.item.id] ? (
                      <CouponNote
                        hit={couponFor[line.item.id]}
                        itemName={line.item.name}
                        storeName={name}
                        counted={countCoupons}
                        clipping={couponBook.marked(`${retailerId}|${couponFor[line.item.id].coupon.id}`)}
                        onClip={() => void clip(couponFor[line.item.id].coupon.id)}
                      />
                    ) : null}
                  </View>
                ) : null}
                {line.alternatives.length ? (
                  <Pressable
                    onPress={() => setOpen(open === line.item.id ? null : line.item.id)}
                    style={styles.similar}
                    hitSlop={TEXT_BUTTON_SLOP}
                    accessibilityRole="button"
                    accessibilityLabel={`Similar items to ${line.item.name}`}
                    accessibilityState={{ expanded: open === line.item.id }}
                  >
                    <Text style={styles.similarText}>Similar items</Text>
                    <Icon name={open === line.item.id ? 'up' : 'down'} size={14} color={colors.muted} />
                  </Pressable>
                ) : null}
                {open === line.item.id ? (
                  <Alternatives products={line.alternatives} onChoose={(p) => choose(line, p)} onDetails={(p) => details(line, p)} />
                ) : null}
              </View>
            );
          })}
        </View>

        {missing.length ? (
          <View style={styles.group}>
            <Text style={styles.section} accessibilityRole="header">
              Not found at {name}
            </Text>
            {missing.map((line) => (
              <View key={line.item.id} style={styles.lineWrap}>
                <View style={styles.missing}>
                  <View style={styles.flex}>
                    <Text style={styles.missingName}>{line.item.name}</Text>
                    <Text style={styles.small}>
                      {line.exactMissing
                        ? line.refreshing
                          ? `Looking for the same product at ${name}…`
                          : `The same product isn’t in ${name}’s results.`
                        : line.noMatch
                          ? `${name}’s results didn’t name it, so none was picked.`
                          : 'No results'}
                    </Text>
                  </View>
                  {line.alternatives.length ? (
                    <Pressable
                      onPress={() => setOpen(open === line.item.id ? null : line.item.id)}
                      style={styles.similarInline}
                      hitSlop={TEXT_BUTTON_SLOP}
                      accessibilityRole="button"
                      accessibilityLabel={`Choose one for ${line.item.name}`}
                      accessibilityState={{ expanded: open === line.item.id }}
                    >
                      <Text style={styles.similarText}>Choose one</Text>
                      <Icon name={open === line.item.id ? 'up' : 'down'} size={14} color={colors.muted} />
                    </Pressable>
                  ) : null}
                </View>
                {open === line.item.id ? (
                  <Alternatives products={line.alternatives} onChoose={(p) => choose(line, p)} onDetails={(p) => details(line, p)} />
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {failed.length ? (
          <View style={styles.group}>
            <Text style={styles.section} accessibilityRole="header">
              Couldn’t check at {name}
            </Text>
            {failed.map((line) => (
              <View key={line.item.id} style={styles.failedRow}>
                <Text style={styles.missingName}>{line.item.name}</Text>
                <Text style={styles.small}>{resultOf(line)?.detail ?? resultOf(line)?.reason ?? ''}</Text>
              </View>
            ))}
            <Pill label={`Try ${name} again`} small variant="outline" icon="refresh" onPress={() => engine.retry(list.id, retailerId)} style={styles.retry} />
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]} onLayout={onFooterLayout}>
        <View style={styles.flex}>
          <Text style={styles.footerName}>
            {name}
            {how ? <Text style={styles.small}>{` · ${how}`}</Text> : null}
          </Text>
          <Text
            style={styles.footerTotal}
            accessibilityLabel={`${money(orderTotal)}${how ? ` ${how}` : ''}${withCoupons}, ${basket.found} of ${basket.itemCount} items`}
          >
            {money(orderTotal)} <Text style={styles.small}>/ {basket.found} of {basket.itemCount} items{couponsOff ? ' · with coupons' : ''}</Text>
          </Text>
        </View>
        <Pill
          label="Shop here"
          accessibilityLabel={`Shop here at ${name}`}
          accessibilityHint={shopHint}
          variant="dark"
          disabled={!basket.complete || !basket.found}
          onPress={() => {
            // Ordering online, the trip counts this order's fees, and its savings are against stores that take it too.
            const order = online?.available ? { mode, fees: online.extra, costOf: orderCost } : undefined;
            startTrip(store, list, [retailerId], basket, order ? orderable(baskets, orders) : baskets, order);
            router.dismissTo(`/list/${list.id}`);
          }}
        />
      </View>
    </View>
  );
}

function Alternatives({
  products,
  onChoose,
  onDetails,
}: {
  products: Product[];
  onChoose: (p: Product) => void;
  onDetails: (p: Product) => void;
}) {
  const { fontScale } = useWindowDimensions();
  const big = fontScale > 1.3;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.alts}>
      {products.map((p) => (
        <View key={p.id} style={[styles.alt, { width: 124 * Math.min(fontScale, 2) }]}>
          <Pressable
            onPress={() => onChoose(p)}
            style={({ pressed }) => [styles.altChoose, pressed && { opacity: 0.8 }]}
            accessibilityRole="button"
            accessibilityLabel={`Choose ${p.name}, ${p.price !== null ? money(p.price) : 'no price'}${p.sponsored ? ', sponsored' : p.inStock === false ? ', out of stock' : ''}`}
          >
            <ProductThumb product={p} size={72} />
            <Text style={[styles.altName, big && styles.altNameBig]} numberOfLines={big ? undefined : 3}>
              {p.name}
            </Text>
            <Text style={styles.altPrice}>{p.price !== null ? money(p.price) : ''}</Text>
            {p.sponsored ? <Text style={styles.altTag}>Sponsored</Text> : p.inStock === false ? <Text style={styles.altTag}>Out of stock</Text> : null}
          </Pressable>
          <Pressable onPress={() => onDetails(p)} hitSlop={TEXT_BUTTON_SLOP} accessibilityRole="button" accessibilityLabel={`Details for ${p.name}`}>
            <Text style={styles.altDetails}>Details</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

/** Text-sized buttons reach 44 pt to touch. */
const TEXT_BUTTON_SLOP = { top: 10, bottom: 10, left: 6, right: 6 };

/**
 * The account's coupons at this store, in a line: how many fit the basket and what the clipped ones take off, whether
 * that counts in the total, or that signing in comes first. Opens Weekly ads and coupons.
 */
function CouponsLine({ name, credit, counted, signedIn, read }: { name: string; credit?: CouponCredit; counted: boolean; signedIn: boolean; read: boolean }) {
  const text = !signedIn
    ? `Sign in to ${name} for its digital coupons on this basket.`
    : !read
      ? `Your ${name} coupons haven’t been read yet.`
      : !couponsFitting(credit)
        ? `None of your ${name} coupons is for this basket.`
        : `${couponsWords(credit!)} ${counted ? 'Counted in the total.' : 'Not counted in the total.'}`;
  return (
    <Pressable
      onPress={() => router.push('/ads')}
      style={({ pressed }) => [styles.couponsLine, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityHint="Opens weekly ads and coupons"
    >
      <Icon name="tag" size={15} color={colors.green} />
      <Text style={[styles.small, styles.flexText]}>{text}</Text>
      <Icon name="forward" size={15} color={colors.faint} />
    </Pressable>
  );
}

/** Cheaper products of the same size at this store, to swap to one by one or all at once. */
function SwapsCard({ swaps, storeName, onSwap, onSwapAll }: { swaps: Swap[]; storeName: string; onSwap: (s: Swap) => void; onSwapAll: () => void }) {
  const [open, setOpen] = useState(false);
  const own = swaps.filter((s) => s.storeBrand).length;
  const brands = !own ? '' : own === swaps.length ? (own === 1 ? ', its own brand' : ', all its own brand') : `, ${own} of them its own brand`;
  return (
    <View style={styles.swapCard}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.swapHead, pressed && styles.pressed]}
      >
        <Icon name="tag" size={17} color={colors.green} />
        <View style={styles.flex}>
          <Text style={styles.swapTitle}>Cheaper swaps: save {money(swapSavings(swaps))} more</Text>
          <Text style={styles.small}>
            {swaps.length} {swaps.length === 1 ? 'item has' : 'items have'} a cheaper product of the same size at {storeName}
            {brands}, in what this phone already read: no extra searching.
          </Text>
        </View>
        <Icon name={open ? 'up' : 'down'} size={18} color={colors.muted} />
      </Pressable>
      {open
        ? swaps.map((swap) => (
            <View key={swap.item.id} style={styles.swapRow}>
              <ProductThumb product={swap.to} size={48} />
              <View style={styles.flex}>
                <Text style={styles.term}>{swap.item.name}</Text>
                <Text style={styles.swapName} numberOfLines={2}>
                  {swap.to.name}
                </Text>
                <Text style={styles.small}>
                  {money(swap.to.price!)} instead of {money(swap.from.price!)}
                  {swap.storeBrand ? ' · store brand' : ''}
                </Text>
              </View>
              <Pill
                label={`Save ${money(swap.saves)}`}
                accessibilityLabel={`Swap ${swap.item.name} to ${swap.to.name}: save ${money(swap.saves)}`}
                small
                variant="outline"
                onPress={() => onSwap(swap)}
              />
            </View>
          ))
        : null}
      {open && swaps.length > 1 ? <Pill label={`Make all ${swaps.length} swaps`} small variant="dark" onPress={onSwapAll} style={styles.swapAll} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  swapCard: { marginHorizontal: 16, marginBottom: 12, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: '#BFE3CC', padding: 14, gap: 10 },
  swapHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  swapTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  swapRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  swapName: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 20, color: colors.ink },
  swapAll: { alignSelf: 'flex-start' },
  savingsNotes: { marginLeft: 82, marginTop: 2, gap: 2 },
  couponsLine: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  flexText: { flex: 1 },
  flex: { flex: 1, gap: 3 },
  pressed: { opacity: 0.8 },
  small: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.muted },
  head: { paddingHorizontal: 20, gap: 14, paddingBottom: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headTitle: { fontFamily: fonts.semibold, fontSize: 22, color: colors.ink },
  headDot: { color: colors.faint },
  headChips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  pickChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.blueTint,
    borderColor: colors.blueLine,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pickChipText: { fontFamily: fonts.medium, fontSize: 14, color: colors.blue },
  lines: { paddingHorizontal: 16, paddingTop: 8 },
  lineWrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, paddingBottom: 12 },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingTop: 16, paddingHorizontal: 4 },
  lineMain: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  productName: { fontFamily: fonts.medium, fontSize: 16, lineHeight: 21, color: colors.ink },
  term: { fontFamily: fonts.body, fontSize: 14, color: colors.muted },
  termRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5 },
  usual: { fontFamily: fonts.medium, fontSize: 14, color: colors.orangeText },
  price: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink, marginTop: 4 },
  unit: { fontFamily: fonts.body, fontSize: 13, color: colors.muted },
  receipt: { fontFamily: fonts.body, fontSize: 12, color: colors.muted, marginTop: 2 },
  prefMiss: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.amber, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 3 },
  staleNote: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.amber },
  checking: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  similar: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 10,
    marginLeft: 82,
  },
  similarInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  similarText: { fontFamily: fonts.medium, fontSize: 13, color: colors.ink },
  alts: { gap: 10, paddingHorizontal: 4, paddingTop: 12, paddingBottom: 4 },
  alt: { width: 124, gap: 6, backgroundColor: colors.card, borderRadius: radius.md, padding: 10, ...shadow.card },
  altChoose: { gap: 6 },
  altName: { fontFamily: fonts.body, fontSize: 13, lineHeight: 17, color: colors.ink, minHeight: 51 },
  altNameBig: { lineHeight: undefined, minHeight: 0 },
  altPrice: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  altTag: { fontFamily: fonts.body, fontSize: 12, color: colors.amber },
  altDetails: { fontFamily: fonts.semibold, fontSize: 13, color: colors.orangeText },
  group: { paddingHorizontal: 20, paddingTop: 18, gap: 4 },
  section: { fontFamily: fonts.semibold, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase', color: colors.muted, marginBottom: 4 },
  missing: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12 },
  failedRow: { gap: 3, paddingVertical: 10 },
  missingName: { fontFamily: fonts.body, fontSize: 16, color: colors.ink },
  retry: { alignSelf: 'flex-start', marginTop: 8 },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 20,
    paddingTop: 14,
    backgroundColor: '#F2F1EC',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  footerName: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  footerTotal: { fontFamily: fonts.semibold, fontSize: 18, color: colors.ink },
});
