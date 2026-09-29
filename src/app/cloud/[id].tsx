import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SIDE_WORDS } from '../../cloud/compare';
import { jobCost, jobStatus, retailerCost, storeConfirmed, type CloudItem, type CloudJob, type RetailerRun, type TermResult } from '../../cloud/jobs';
import { costWords, problemWords, reasonWords, RETAILER_NAMES, retailerLine } from '../../cloud/words';
import { sameStoreId } from '../../onDevice/storeIdentity';
import { whenLabel } from '../../pricing/receipt';
import { useCloudJob, useCloudRunner } from '../../state/CloudProvider';
import { Chip } from '../../ui/bits';
import { Pill, tap } from '../../ui/controls';
import { RetailerBadge } from '../../ui/RetailerBadge';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { colors, fonts, money, radius } from '../../ui/theme';
import { useNow } from '../../ui/useNow';

/** How many of a search's products show before "All N". */
const SHOWN = 5;

/**
 * One cloud search: each retailer's state, the store its prices are for, what it cost, and every term's products.
 * Prices a search said were for another store are flagged, and not shown as the store's.
 */
export default function CloudJobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const job = useCloudJob(id);
  const runner = useCloudRunner();
  const now = useNow(5_000);

  if (!job) {
    return (
      <View style={styles.screen}>
        <ScreenHeader title="Cloud search" subtitle="This search isn’t on the phone any more." />
      </View>
    );
  }
  const status = jobStatus(job);
  const cost = jobCost(job);
  // A comparison's side is run again with the whole comparison, so the sides stay comparable.
  const compare = job.compare;
  const retry = async (only?: RetailerRun['retailerId'][]) => {
    tap();
    const got = await runner.retry(job.id, only);
    if (!got.ok) Alert.alert('Not tried again', problemWords(got));
  };

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title={job.terms.join(', ')}
        subtitle={`${compare ? `Phone vs. cloud, ${SIDE_WORDS[compare.side].replace(/^the /, '')}’s side` : job.engine === 'agent' ? 'AI agent' : 'Scripted browser'} · started ${whenLabel(job.createdAt, now)}${
          status === 'running' ? ' · running' : job.finishedAt ? ` · took ${Math.round((job.finishedAt - job.createdAt) / 1000)} s` : ''
        }`}
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.summary}>
          {status === 'running' ? (
            <View style={styles.row}>
              <ActivityIndicator color={colors.orange} />
              <Text style={styles.summaryText}>
                Searching in the cloud. You can use the app meanwhile: a notification says when it’s done.
                {job.engine === 'agent' ? ' The agent is asked how it’s doing every 10 s.' : ''}
              </Text>
            </View>
          ) : (
            <Text style={styles.summaryText}>{status === 'interrupted' ? 'Interrupted: try it again below.' : status === 'cancelled' ? 'Cancelled.' : 'Done.'}</Text>
          )}
          <Text style={styles.meta}>
            Cost so far: {costWords(cost.usd)}
            {cost.proxyMb ? `, ${cost.proxyMb.toFixed(1)} MB through the proxy` : ''}, as Browser Use reported it.
            {job.ranAlone && job.balanceBefore !== undefined && job.balanceAfter !== undefined
              ? ` The account’s credit went from ${money(job.balanceBefore)} to ${money(job.balanceAfter)} (${costWords(job.balanceBefore - job.balanceAfter)}).`
              : ''}
          </Text>
          <View style={styles.actions}>
            {status === 'running' && !compare ? <Pill label="Cancel" small variant="outline" onPress={() => void runner.cancel(job.id)} /> : null}
            {!compare && job.retailers.some((r) => ['blocked', 'failed', 'interrupted', 'cancelled'].includes(r.status)) ? (
              <Pill label="Try the rest again" icon="refresh" small variant="dark" onPress={() => void retry()} />
            ) : null}
            {compare ? <Pill label="Open the comparison" icon="forward" small variant="outline" onPress={() => router.push(`/phone-vs-cloud/${compare.id}`)} /> : null}
          </View>
        </View>
        {job.retailers.map((r) => (
          <RetailerCard key={r.retailerId} job={job} run={r} now={now} onRetry={compare ? undefined : () => void retry([r.retailerId])} />
        ))}
      </ScrollView>
    </View>
  );
}

function RetailerCard({ job, run, now, onRetry }: { job: CloudJob; run: RetailerRun; now: number; onRetry?: () => void }) {
  const name = RETAILER_NAMES[run.retailerId];
  const cost = retailerCost(run);
  const confirmed = storeConfirmed(run);
  const how =
    run.via === 'browser' ? 'Cloud browser' : run.via === 'agent' ? 'Browser Use agent' : run.retailerId === 'kroger' ? 'Kroger’s official API, on this phone' : 'On this phone';
  const working = run.status === 'running' || run.status === 'queued';
  const done = new Set(run.results.map((r) => r.term));
  const terms = [...job.terms, ...run.results.filter((r) => !job.terms.includes(r.term)).map((r) => r.term)];
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <RetailerBadge retailerId={run.retailerId} name={name} size={30} />
        <View style={styles.flex}>
          <Text style={styles.storeName}>{name}</Text>
          <Text style={[styles.meta, run.status === 'done' ? (confirmed ? styles.good : styles.warnText) : run.status === 'running' ? null : styles.warnText]}>{retailerLine(run)}</Text>
        </View>
        {working ? <ActivityIndicator color={colors.orange} /> : null}
      </View>
      <View style={styles.chips}>
        <Chip label={`Store ${run.storeId}`} icon="store" tone="plain" />
        <Chip label={how} tone="plain" />
        {run.checkSeen ? <Chip label="Bot check seen" icon="alert" tone="orange" /> : null}
        {run.storeSet === 'button' ? <Chip label="Store set with its button" icon="check" tone="green" /> : null}
        {run.storeSet === 'already' ? <Chip label="Store already set" icon="check" tone="green" /> : null}
        {run.storeSet === 'kept' ? <Chip label="Store kept from its last run" icon="check" tone="green" /> : null}
        {run.storeSet === 'cookie' ? <Chip label="Store set in its cookies" icon="check" tone="green" /> : null}
        {run.profile === 'new' ? <Chip label="Its profile kept for next time" tone="plain" /> : null}
        {run.storeSet === 'request' ? <Chip label="Store asked for in each request" tone="plain" /> : null}
        {run.storeSet === 'agent' ? <Chip label="The agent set the store" tone="plain" /> : null}
      </View>
      <Text style={styles.meta}>
        {[
          run.startedAt ? `Started ${whenLabel(run.startedAt, now)}` : '',
          run.startedAt && run.finishedAt ? `took ${Math.round((run.finishedAt - run.startedAt) / 1000)} s` : '',
          // Driven from this phone: without its trips to the browser, about what a server's would take.
          run.startedAt && run.finishedAt && run.linkMs !== undefined ? `about ${Math.round(Math.max(0, run.finishedAt - run.startedAt - run.linkMs) / 1000)} s on a server (estimate)` : '',
          run.bytes ? `${(run.bytes / 1e6).toFixed(1)} MB metered` : '',
          cost.usd > 0 ? `cost ${costWords(cost.usd)}${cost.proxyMb ? ` (${cost.proxyMb.toFixed(1)} MB proxy)` : ''}` : '',
          run.attempts > 1 ? `try ${run.attempts}` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {run.sitePicked ? (
        <Text style={styles.meta}>
          The site had picked store {run.sitePicked} for this browser by itself; store {run.storeId} was set on it.
        </Text>
      ) : null}
      {run.detail ? <Text style={styles.detail}>{run.detail}</Text> : null}
      {run.browserId || run.runId ? (
        <Text style={styles.detail} selectable>
          {run.browserId ? `Browser ${run.browserId}` : ''}
          {run.runId ? `Run ${run.runId}${run.followUpId ? `, follow-up ${run.followUpId}` : ''}` : ''}
        </Text>
      ) : null}
      {terms.map((term) => {
        const result = run.results.find((r) => r.term === term);
        if (result) return <TermBlock key={term || '(other)'} result={result} storeId={run.storeId} />;
        return working && !done.has(term) ? (
          <Text key={term} style={styles.meta}>
            “{term}”: {run.status === 'queued' ? 'waiting' : 'searching…'}
          </Text>
        ) : null;
      })}
      {onRetry && ['blocked', 'failed', 'interrupted', 'cancelled'].includes(run.status) ? (
        <Pill label={`Try ${name} again`} icon="refresh" small variant="outline" onPress={onRetry} style={styles.alignStart} />
      ) : null}
    </View>
  );
}

function TermBlock({ result, storeId }: { result: TermResult; storeId: string }) {
  const [all, setAll] = useState(false);
  const flagged = result.storeMatches === false;
  const items = all ? result.items : result.items.slice(0, SHOWN);
  return (
    <View style={styles.term}>
      <Text style={styles.termTitle}>
        {result.term ? `“${result.term}”` : 'Other results'}
        {result.status === 'done' ? ` · ${result.found ?? result.items.length} ${result.found === 1 ? 'product' : 'products'}` : ''}
      </Text>
      {result.status !== 'done' ? <Text style={styles.warnText}>{reasonWords(result.reason) || result.status}</Text> : null}
      {result.detail ? <Text style={styles.detail}>{result.detail}</Text> : null}
      {result.siteStoreId && !sameStoreId(result.siteStoreId, storeId) ? (
        <Text style={styles.meta}>The site’s own page asked for store {result.siteStoreId} by itself.</Text>
      ) : null}
      {flagged ? (
        <Text style={styles.warnText}>
          These prices are for store {result.pageStoreId ?? '?'}, not store {storeId}: they aren’t shown as your store’s.
        </Text>
      ) : result.status === 'done' && result.pageStoreId && result.storeMatches ? (
        <Text style={styles.good}>Priced for store {result.pageStoreId}, as the store’s own data says.</Text>
      ) : null}
      {items.map((item) => (
        <ItemRow key={item.itemId} item={item} flagged={flagged || !!item.pricedAt} />
      ))}
      {result.items.length > SHOWN ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: all }} hitSlop={12} onPress={() => setAll(!all)}>
          <Text style={styles.link}>{all ? 'Fewer' : `All ${result.items.length}`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ItemRow({ item, flagged }: { item: CloudItem; flagged: boolean }) {
  const detail = [
    item.size,
    item.unitPrice,
    item.sponsored ? 'Sponsored' : '',
    item.inStock === false ? 'Out of stock' : '',
    item.atStore === false ? 'Ships only, not sold in stores' : '',
    item.pricedAt ? `Store ${item.pricedAt}’s price` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      accessibilityRole={item.url ? 'link' : undefined}
      disabled={!item.url}
      onPress={() => item.url && void Linking.openURL(item.url)}
      style={({ pressed }) => [styles.item, pressed && styles.pressed]}
    >
      <View style={styles.flex}>
        <Text style={[styles.itemName, flagged && styles.flagged]} numberOfLines={2}>
          {item.name}
        </Text>
        {detail ? <Text style={styles.meta}>{detail}</Text> : null}
      </View>
      <View style={styles.priceBox}>
        <Text style={[styles.price, flagged && styles.flagged]}>{item.price != null ? money(item.price) : '—'}</Text>
        {item.wasPrice ? <Text style={styles.was}>was {money(item.wasPrice)}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 16, gap: 12 },
  flex: { flex: 1, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pressed: { opacity: 0.8 },
  alignStart: { alignSelf: 'flex-start' },
  summary: { backgroundColor: colors.blueTint, borderRadius: radius.lg, padding: 14, gap: 8 },
  summaryText: { flex: 1, fontFamily: fonts.medium, fontSize: 15, lineHeight: 20, color: colors.ink },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: 14, gap: 10, borderWidth: 1, borderColor: colors.line },
  storeName: { fontFamily: fonts.semibold, fontSize: 17, color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  meta: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: colors.muted },
  detail: { fontFamily: fonts.body, fontSize: 12, lineHeight: 16, color: colors.faint },
  good: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 18, color: colors.green },
  warnText: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 18, color: colors.amber },
  term: { gap: 6, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  termTitle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  itemName: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, color: colors.ink },
  priceBox: { alignItems: 'flex-end' },
  price: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink },
  was: { fontFamily: fonts.body, fontSize: 12, color: colors.muted, textDecorationLine: 'line-through' },
  flagged: { color: colors.faint, textDecorationLine: 'line-through' },
  link: { fontFamily: fonts.semibold, fontSize: 14, color: colors.orangeText },
});
