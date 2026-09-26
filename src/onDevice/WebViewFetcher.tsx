import React, { createContext, memo, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Linking, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { focusOn, useScreenReader } from '../ui/a11y';
import { Icon } from '../ui/Icon';
import { colors, fonts, radius, shadow } from '../ui/theme';
import { useNow } from '../ui/useNow';
import { sameSite } from './webviewScript';
import { WebViewPool } from './webviewPool';
import type { WebViewQueue } from './webviewQueue';

export type { BrowseJob, WebViewJob, WebViewPayload } from './webviewQueue';

const PoolContext = createContext<WebViewPool | null>(null);

/** The app's WebView lanes, one per retailer. */
export function useWebViewPool(): WebViewPool {
  const pool = useContext(PoolContext);
  if (!pool) throw new Error('useWebViewPool must be used inside <WebViewFetcherProvider>');
  return pool;
}

/**
 * Where a lane's page is drawn in the live view: its top-left corner, how far it's scaled down, and, when only its
 * top part shows, how tall that part is (in page points).
 */
interface Tile {
  x: number;
  y: number;
  scale: number;
  height?: number;
}

const LIVE = { margin: 10, pad: 12, gap: 8, header: 30, label: 36, feedLine: 18, feedLines: 3, cols: 4, maxTileHeight: 150 };

/** The live view's panel and the tiles inside it, for this screen size. */
function liveLayout(width: number, height: number, bottomInset: number) {
  const tileSlot = (width - 2 * LIVE.margin - 2 * LIVE.pad - (LIVE.cols - 1) * LIVE.gap) / LIVE.cols;
  const scale = Math.min(tileSlot / width, LIVE.maxTileHeight / height);
  const tileW = width * scale;
  const tileH = height * scale;
  const panelH = LIVE.pad + LIVE.header + LIVE.gap + tileH + LIVE.label + LIVE.feedLines * LIVE.feedLine + LIVE.pad;
  const top = height - bottomInset - LIVE.margin - panelH;
  const tiles: Tile[] = Array.from({ length: LIVE.cols }, (_, i) => ({
    x: LIVE.margin + LIVE.pad + i * (tileW + LIVE.gap),
    y: top + LIVE.pad + LIVE.header + LIVE.gap,
    scale,
  }));
  return { top, panelH, tileW, tileH, tiles };
}

/** Presenter mode's stage: a 2 × 2 grid of the pages' top parts, where their results are, big enough to read. */
export const STAGE = { header: 150, margin: 16, gap: 10, label: 22, share: 0.42 };

export function stageLayout(width: number, height: number, topInset: number) {
  const top = topInset + STAGE.header;
  const areaH = height * STAGE.share;
  const tileW = (width - 2 * STAGE.margin - STAGE.gap) / 2;
  const tileH = (areaH - STAGE.gap) / 2 - STAGE.label;
  const scale = tileW / width;
  const tiles: Tile[] = Array.from({ length: 4 }, (_, i) => ({
    x: STAGE.margin + (i % 2) * (tileW + STAGE.gap),
    y: top + Math.floor(i / 2) * (tileH + STAGE.label + STAGE.gap),
    scale,
    height: tileH / scale,
  }));
  return { top, height: areaH, tileW, tileH, tiles };
}

/**
 * Hosts one WebView per retailer lane. They stay hidden while they search. One at a time covers the app when a
 * retailer shows a bot check (the user finishes it; code never answers a check) or when the user opens a site to
 * pick a store or look at a product. Other lanes keep searching behind it. With Watch it scrape on, the hidden pages
 * are drawn small, live, in a panel over the app.
 */
export function WebViewFetcherProvider({ children }: { children: React.ReactNode }) {
  const [pool] = useState(() => new WebViewPool());
  const { lanes, presented, live } = useSyncExternalStore(pool.subscribe, pool.getSnapshot);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const layout = useMemo(() => liveLayout(width, height, insets.bottom), [width, height, insets.bottom]);
  const stage = useMemo(() => stageLayout(width, height, insets.top), [width, height, insets.top]);
  // The live view is only something to look at, and it covers the bottom of every screen: not with a screen reader.
  const screenReader = useScreenReader();
  const liveView = screenReader ? 'off' : live;
  // Pages worth watching: loaded, and not already on screen as a sheet.
  const watched = (liveView === 'open' || liveView === 'stage') && !presented ? lanes.filter((l) => l.getSnapshot()).slice(0, LIVE.cols) : [];
  const tiles = liveView === 'stage' ? stage.tiles : layout.tiles;

  return (
    <PoolContext.Provider value={pool}>
      <View style={styles.root}>
        {/* While a sheet covers the app, screen readers only see the sheet. */}
        <View style={styles.root} accessibilityElementsHidden={!!presented} importantForAccessibility={presented ? 'no-hide-descendants' : 'auto'}>
          {children}
        </View>
        {liveView === 'open' && !presented ? <LivePanel pool={pool} watched={watched} layout={layout} /> : null}
        {liveView === 'min' && !presented ? <LivePill pool={pool} bottom={insets.bottom + 14} /> : null}
        {lanes.map((lane) => {
          const at = watched.indexOf(lane);
          return <LaneWebView key={lane.key} lane={lane} shown={lane === presented} tile={at === -1 ? null : tiles[at]} />;
        })}
      </View>
    </PoolContext.Provider>
  );
}

const LaneWebView = memo(function LaneWebView({ lane, shown, tile }: { lane: WebViewQueue; shown: boolean; tile: Tile | null }) {
  const load = useSyncExternalStore(lane.subscribe, lane.getSnapshot);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const webRef = useRef<WebView>(null);

  useEffect(() => {
    lane.attach((script) => webRef.current?.injectJavaScript(script));
    return lane.detach;
  }, [lane]);

  if (!load) return null;
  const browsing = load.phase === 'browse';
  const visible = shown && (browsing || load.phase === 'challenge');
  const viewing = browsing && load.purpose === 'view';
  const signingIn = browsing && load.purpose === 'signin';
  // The user's own coupons, on the store's page: like a sign-in page, it gets nothing from the app.
  const account = browsing && load.purpose === 'account';

  // Only the style changes between hidden, tile and sheet, so the page itself is never reloaded.
  const style = visible
    ? [styles.sheet, { paddingTop: insets.top }]
    : tile
      ? [
          styles.tile,
          {
            left: tile.x,
            top: tile.y,
            width,
            height: tile.height ?? height,
            transform: [{ scale: tile.scale }],
            borderRadius: 14 / tile.scale,
            borderWidth: 1 / tile.scale,
          },
        ]
      : styles.hidden;

  return (
    <View pointerEvents={visible ? 'auto' : 'none'} aria-hidden={!visible} accessibilityViewIsModal={visible} style={style}>
      {visible ? (
        <SheetBar
          title={
            signingIn
              ? `Sign in to ${load.retailerName}`
              : account
                ? `Your coupons at ${load.retailerName}`
                : browsing
                  ? load.retailerName
                  : `${load.retailerName} wants to check you're not a bot`
          }
        >
          <Text style={styles.body}>
            {signingIn
              ? `Sign in on ${load.retailerName}’s own page, then tap Done. Stretch adds nothing to this page and reads nothing on it: your password stays between you and ${load.retailerName}.`
              : account
                ? `${load.retailerName}’s own page for your coupons. Stretch adds nothing to it and reads nothing on it. Clip what you like here, then tap Done, and the phone reads your coupons again.`
                : viewing
              ? `${load.retailerName}’s own page for this product, opened on this phone.`
              : browsing
                ? 'Search here, then tap Read products.'
                : 'Complete the check below. Pricing continues on its own, and other stores keep going meanwhile.'}
          </Text>
          <View style={styles.actions}>
            {browsing && !viewing && !signingIn && !account ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  const script = lane.readPage();
                  if (script) webRef.current?.injectJavaScript(script);
                }}
                style={styles.primary}
              >
                <Text style={styles.primaryText}>Read products</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => (browsing ? lane.closeBrowse() : lane.cancel())}
              style={viewing || signingIn || account ? styles.primary : styles.secondary}
            >
              <Text style={viewing || signingIn || account ? styles.primaryText : styles.secondaryText}>
                {signingIn || account ? 'Done' : browsing ? 'Close' : `Skip ${load.retailerName}`}
              </Text>
            </Pressable>
            {viewing ? (
              <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(load.url).catch(() => {})} style={styles.secondary}>
                <Text style={styles.secondaryText}>Open in browser</Text>
              </Pressable>
            ) : null}
          </View>
        </SheetBar>
      ) : null}
      <WebView
        key={`${load.id}:${load.round}`}
        ref={webRef}
        source={{ uri: load.url, headers: load.cookie ? { Cookie: load.cookie } : undefined }}
        injectedJavaScriptBeforeContentLoaded={load.beforeScript}
        injectedJavaScript={load.script}
        onMessage={(event) => lane.receive(event.nativeEvent.data)}
        onLoadStart={lane.loadStarted}
        onLoadEnd={() => {
          const script = lane.scriptAfterNavigation();
          if (script) webRef.current?.injectJavaScript(script);
        }}
        onError={lane.networkError}
        onContentProcessDidTerminate={lane.pageLost}
        onRenderProcessGone={lane.pageLost}
        // Hidden loads stay on the retailer's domain; a user browsing can go wherever sign-in or store pickers lead. A hidden
        // read of the user's account that's sent to a sign-in page stops before it loads (see allows in webviewQueue.ts).
        onShouldStartLoadWithRequest={(req) => lane.allows(req.url, req.isTopFrame) && (browsing || !req.isTopFrame || sameSite(req.url, load.url))}
        allowsBackForwardNavigationGestures={browsing}
        originWhitelist={['https://*']}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        mediaPlaybackRequiresUserAction
        style={styles.web}
      />
    </View>
  );
});

/** The bar above a page on screen. It takes the screen reader's focus when it appears, since it can appear at any time. */
function SheetBar({ title, children }: { title: string; children: React.ReactNode }) {
  const titleRef = useRef<Text>(null);
  useEffect(() => focusOn(titleRef, 400), []);
  return (
    <View style={styles.bar}>
      <Text ref={titleRef} style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

/** What a lane is doing, in a word or two (it fits under a small tile). */
export function laneStatus(lane: WebViewQueue): string {
  const load = lane.getSnapshot();
  if (!load) return 'No page';
  if (load.phase === 'challenge') return 'Bot check';
  if (load.phase === 'browse') return 'On screen';
  if (load.phase === 'hidden') return 'Loading page';
  return lane.replaysInFlight() ? 'Reusing page' : 'Page kept';
}

function LivePanel({ pool, watched, layout }: { pool: WebViewPool; watched: WebViewQueue[]; layout: ReturnType<typeof liveLayout> }) {
  const feed = useSyncExternalStore(pool.feed.subscribe, pool.feed.getSnapshot);
  // Keeps the tiles' statuses current: a replay starting or ending doesn't change the page itself.
  useNow(500);
  return (
    <View style={[styles.panel, { top: layout.top, height: layout.panelH, left: LIVE.margin, right: LIVE.margin }]}>
      <View style={[styles.panelHead, { height: LIVE.header }]}>
        <View style={styles.liveDot} />
        <Text style={styles.panelTitle} accessibilityRole="header" maxFontSizeMultiplier={1.2}>
          Live from this phone
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Make the live view small" hitSlop={12} onPress={() => pool.setLiveView('min')}>
          <Icon name="down" size={20} color={colors.muted} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Close the live view" hitSlop={12} onPress={() => pool.setLiveView('off')}>
          <Icon name="close" size={20} color={colors.muted} />
        </Pressable>
      </View>
      <View style={[styles.tiles, { height: layout.tileH + LIVE.label, marginTop: LIVE.gap }]}>
        {watched.length ? (
          watched.map((lane) => (
            <View key={lane.key} style={{ width: layout.tileW }}>
              {/* The page itself is drawn over this space by its lane (see LaneWebView). */}
              <View style={[styles.tileSpace, { height: layout.tileH }]} />
              <Text style={styles.tileName} numberOfLines={1} maxFontSizeMultiplier={1.2}>
                {lane.label}
              </Text>
              <Text style={styles.tileStatus} numberOfLines={1} maxFontSizeMultiplier={1.2}>
                {laneStatus(lane)}
              </Text>
            </View>
          ))
        ) : (
          <Text style={styles.empty} maxFontSizeMultiplier={1.2}>
            Store pages show up here while prices are checked. Stores with an official API don’t need one.
          </Text>
        )}
      </View>
      <View style={styles.feed}>
        {feed.slice(0, LIVE.feedLines).map((e) => (
          <Text key={e.id} style={[styles.feedLine, !e.ok && { color: colors.red }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
            <Text style={styles.feedStore}>{e.retailer}</Text> · {e.what} · {e.text}
          </Text>
        ))}
        {!feed.length ? (
          <Text style={styles.feedLine} maxFontSizeMultiplier={1.2}>
            Nothing checked yet.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function LivePill({ pool, bottom }: { pool: WebViewPool; bottom: number }) {
  const feed = useSyncExternalStore(pool.feed.subscribe, pool.feed.getSnapshot);
  const last = feed[0];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Show the live view"
      onPress={() => pool.setLiveView('open')}
      style={[styles.pill, { bottom }]}
    >
      <View style={styles.liveDot} />
      <Text style={styles.pillText} numberOfLines={1} maxFontSizeMultiplier={1.2}>
        {last ? `${last.retailer} · ${last.what}` : 'Live view'}
      </Text>
      <Icon name="up" size={16} color={colors.ink} />
    </Pressable>
  );
}

const fill = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Full-size but invisible and behind the app, so the page lays out like a real phone screen.
  hidden: { ...fill, opacity: 0, zIndex: -1 },
  // Full-size too, drawn small from its top-left corner inside the live view.
  tile: { position: 'absolute', transformOrigin: 'top left', zIndex: 21, overflow: 'hidden', borderColor: colors.line, backgroundColor: '#ffffff' },
  sheet: { ...fill, backgroundColor: colors.cream, zIndex: 30 },
  bar: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 14,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.cream,
  },
  title: { fontFamily: fonts.display, fontSize: 21, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21, color: colors.muted },
  actions: { flexDirection: 'row', gap: 16, alignItems: 'center', marginTop: 6 },
  primary: { minHeight: 44, justifyContent: 'center', backgroundColor: colors.orangeButton, borderRadius: radius.pill, paddingVertical: 10, paddingHorizontal: 18 },
  primaryText: { fontFamily: fonts.semibold, color: '#ffffff', fontSize: 15 },
  secondary: { minHeight: 44, justifyContent: 'center', paddingVertical: 10 },
  secondaryText: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  web: { flex: 1 },
  panel: {
    position: 'absolute',
    zIndex: 20,
    backgroundColor: colors.cream,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: '#F7C2B3',
    paddingHorizontal: LIVE.pad,
    paddingTop: LIVE.pad,
    ...shadow.float,
  },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  panelTitle: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.orange },
  tiles: { flexDirection: 'row', gap: LIVE.gap },
  tileSpace: { borderRadius: 14, backgroundColor: colors.chip },
  tileName: { fontFamily: fonts.semibold, fontSize: 12, color: colors.ink, marginTop: 5 },
  tileStatus: { fontFamily: fonts.body, fontSize: 11, color: colors.muted },
  empty: { flex: 1, alignSelf: 'center', fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.muted, textAlign: 'center' },
  feed: { gap: 2 },
  feedLine: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16, color: colors.muted },
  feedStore: { fontFamily: fonts.semibold, color: colors.ink },
  pill: {
    position: 'absolute',
    left: 16,
    zIndex: 20,
    maxWidth: 260,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.cream,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: '#F7C2B3',
    paddingVertical: 9,
    paddingHorizontal: 14,
    ...shadow.float,
  },
  pillText: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.ink },
});
