import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { MAX_TERMS } from '../cloud/config';
import { CLOUD_RETAILERS, cleanTerms, jobStatus, type CloudJob, type CloudRetailerId } from '../cloud/jobs';
import { cloudRetailers, planRetailers } from '../cloud/plan';
import { estimateWords, jobNotice, problemWords, RETAILER_NAMES } from '../cloud/words';
import { krogerApiConfigured } from '../onDevice/krogerApi';
import { useSettings } from '../state/AppProvider';
import { useCloudJobs, useCloudRunner } from '../state/CloudProvider';
import { Pill, tap } from './controls';
import { Icon } from './Icon';
import { useNow } from './useNow';
import { colors, fonts, radius } from './theme';

/** "Walmart", "Walmart and Target", "Walmart, Target and Kroger". */
const andList = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** A search for the same terms, with the same engine, this recently, is shown rather than offered again. */
const RECENT_MS = 60 * 60_000;

/**
 * While cloud fetch is on, Walmart and Target aren't searched on this phone: this card searches `terms` there in the
 * cloud, as a background job, and shows how that search is going. With cloud fetch off, it's nothing at all.
 */
export function CloudSearchCard({ terms, from, of }: { terms: string[]; from: CloudJob['from']; of?: string }) {
  const settings = useSettings();
  const jobs = useCloudJobs();
  const runner = useCloudRunner();
  const [starting, setStarting] = useState(false);
  const now = useNow(60_000);
  const cloud = settings.cloud;
  if (!cloud.on) return null;

  const all = cleanTerms(terms);
  const clean = all.slice(0, MAX_TERMS);
  if (!clean.length) return null;
  // The stores compared in Your stores, as the rest of the app has them.
  const picked = CLOUD_RETAILERS.filter((id): id is CloudRetailerId => settings.retailerIds.includes(id));
  const plan = planRetailers(picked, settings, krogerApiConfigured());
  if (!plan.retailers.some((r) => r.via !== 'device')) return null;
  const key = clean.map((t) => t.toLowerCase()).join('\n');
  const latest = jobs.find((j) => j.engine === cloud.engine && now - j.createdAt < RECENT_MS && j.terms.map((t) => t.toLowerCase()).join('\n') === key);
  const running = latest && jobStatus(latest) === 'running';
  const names = cloudRetailers(cloud).filter((id) => picked.includes(id)).map((id) => RETAILER_NAMES[id]).join(' and ');

  const go = async () => {
    if (starting) return;
    tap();
    setStarting(true);
    try {
      const got = await runner.start({ engine: cloud.engine, terms: clean, retailers: plan.retailers, from });
      if (!got.ok) Alert.alert('Not started', problemWords(got));
    } finally {
      setStarting(false);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Icon name="cloud" size={20} color={colors.blue} />
        <Text style={styles.title}>{names}, in the cloud</Text>
        {running ? <ActivityIndicator size="small" color={colors.orange} /> : null}
      </View>
      {latest ? (
        <Text style={styles.body}>{running ? `Searching ${clean.length === 1 ? `“${clean[0]}”` : `${clean.length} items`} in the cloud: a notification says when it’s done.` : jobNotice(latest).body}</Text>
      ) : (
        <Text style={styles.body}>
          {clean.length === 1 ? `Search “${clean[0]}”` : `Search ${of ?? 'these'}${all.length > MAX_TERMS ? `’ first ${MAX_TERMS} items` : ''}`} at{' '}
          {andList(plan.retailers.map((r) => RETAILER_NAMES[r.retailerId]))} with the {cloud.engine === 'agent' ? 'AI agent' : 'scripted browser'}: costs{' '}
          {estimateWords({ terms: clean, retailers: plan.retailers })}.
        </Text>
      )}
      <View style={styles.actions}>
        {latest ? <Pill label="Open" small variant="outline" onPress={() => router.push(`/cloud/${latest.id}`)} /> : null}
        {!running ? (
          <Pill label={latest ? 'Search again' : 'Search in the cloud'} icon="cloud" small variant={latest ? 'outline' : 'orange'} busy={starting} onPress={() => void go()} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.blueTint, borderRadius: radius.lg, padding: 14, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  body: { fontFamily: fonts.body, fontSize: 14, lineHeight: 19, color: colors.ink },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
