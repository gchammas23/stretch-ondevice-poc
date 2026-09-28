/// <reference types="node" />
import assert from 'node:assert/strict';
import type { LoadTiming } from '../src/onDevice/timing';
import { WebViewQueue } from '../src/onDevice/webviewQueue';

const nonceOf = (script: string) => /var NONCE = "([^"]+)"/.exec(script)![1];
const job = (over: Partial<Parameters<WebViewQueue['run']>[0]> = {}) => ({
  url: 'https://www.walmart.com/search?q=milk', cookie: 'store=1', challengeMarkers: ['/blocked?'], timeoutMs: 200, retailerName: 'Walmart', ...over,
});
let passed = 0;
const t = async (name: string, fn: () => unknown) => { await fn(); passed++; console.log('ok -', name); };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await t('data with the right nonce resolves; wrong nonce is ignored', async () => {
    const q = new WebViewQueue();
    let renders = 0; q.subscribe(() => renders++);
    const p = q.run(job());
    const s = q.getSnapshot()!;
    assert.equal(s.phase, 'hidden'); assert.equal(s.cookie, 'store=1');
    q.receive(JSON.stringify({ nonce: 'forged', kind: 'data', nextDataText: 'x' }));
    q.receive('not json'); q.receive(42);
    assert.ok(q.getSnapshot(), 'still running');
    q.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'data', href: 'h', nextDataText: '{"a":1}' }));
    assert.deepEqual(await p, { href: 'h', nextDataText: '{"a":1}', sources: undefined, pageResult: undefined });
    assert.equal(q.getSnapshot(), null);
    assert.ok(renders >= 2);
  });

  await t('bot check: shows, then passes, then reloads with a new round and nonce before resolving', async () => {
    const q = new WebViewQueue();
    q.challengeGraceMs = 0;
    const p = q.run(job());
    const first = q.getSnapshot()!;
    q.receive(JSON.stringify({ nonce: nonceOf(first.script), kind: 'challenge' }));
    await tick();
    const checking = q.getSnapshot()!;
    assert.equal(checking.phase, 'challenge');
    assert.notEqual(checking, first, 'new snapshot object so React re-renders');
    assert.equal(nonceOf(q.scriptAfterNavigation()!), nonceOf(first.script), 'reinjection uses same nonce');
    q.receive(JSON.stringify({ nonce: nonceOf(first.script), kind: 'challenge' })); // still on the check page
    assert.equal(q.getSnapshot()!.phase, 'challenge');
    q.receive(JSON.stringify({ nonce: nonceOf(first.script), kind: 'data', nextDataText: 'from-redirect' }));
    const reload = q.getSnapshot()!;
    assert.equal(reload.phase, 'hidden'); assert.equal(reload.round, 1);
    assert.notEqual(nonceOf(reload.script), nonceOf(first.script));
    assert.equal(q.scriptAfterNavigation(), null);
    q.receive(JSON.stringify({ nonce: nonceOf(first.script), kind: 'data', nextDataText: 'stale' })); // old load ignored
    q.receive(JSON.stringify({ nonce: nonceOf(reload.script), kind: 'data', nextDataText: 'fresh' }));
    assert.equal((await p).nextDataText, 'fresh');
  });

  await t('timeout, network error, page error and cancel all reject with their reason', async () => {
    const q = new WebViewQueue();
    q.challengeGraceMs = 0;
    await assert.rejects(q.run(job({ timeoutMs: 20 })), /timeout/);
    const p2 = q.run(job()); q.networkError(); await assert.rejects(p2, /network/);
    const p3 = q.run(job()); q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'error', error: 'no_payload' })); await assert.rejects(p3, /no_payload/);
    const p4 = q.run(job()); q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'challenge' }));
    await tick();
    q.networkError(); // ignored while the user is on the check page
    assert.equal(q.getSnapshot()!.phase, 'challenge');
    q.cancel(); await assert.rejects(p4, /challenge_cancelled/);
  });

  await t('jobs run one at a time, in order', async () => {
    const q = new WebViewQueue();
    const a = q.run(job({ url: 'https://www.walmart.com/search?q=a' }));
    const b = q.run(job({ url: 'https://www.walmart.com/search?q=b' }));
    assert.match(q.getSnapshot()!.url, /q=a/);
    q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'data', nextDataText: 'A' }));
    assert.match(q.getSnapshot()!.url, /q=b/);
    q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'data', nextDataText: 'B' }));
    assert.deepEqual([(await a).nextDataText, (await b).nextDataText], ['A', 'B']);
    await tick(250); // no stray timers fire after completion
    assert.equal(q.getSnapshot(), null);
  });

  await t('browse: visible, captures responses, Read resolves with the page data, Close resolves null', async () => {
    const q = new WebViewQueue();
    const visit = q.browse({ url: 'https://www.target.com/', retailerName: 'Target' });
    const s = q.getSnapshot()!;
    assert.equal(s.phase, 'browse');
    assert.ok(s.beforeScript && s.beforeScript.includes('__stretchCapture'));
    assert.equal(s.script, 'true;', 'no automatic read while the user browses');
    const read = q.readPage()!;
    assert.match(read, /var MODE = "read"/);
    q.receive(JSON.stringify({ nonce: nonceOf(read), kind: 'challenge' })); // ignored while browsing
    q.networkError(); // ignored while browsing
    assert.equal(q.getSnapshot()!.phase, 'browse');
    q.receive(JSON.stringify({ nonce: nonceOf(read), kind: 'data', href: 'h', sources: [{ label: 'x', text: '{}' }, { bad: 1 }, 'junk'] }));
    assert.deepEqual((await visit)!.sources, [{ label: 'x', text: '{}' }], 'malformed sources dropped');

    const closed = q.browse({ url: 'https://www.heb.com/', retailerName: 'H-E-B' });
    q.closeBrowse();
    assert.equal(await closed, null);
    assert.equal(q.readPage(), null);

    // A store's sign-in page gets nothing at all: no capture, no script, no Read products.
    const signIn = q.browse({ url: 'https://www.kroger.com/', retailerName: 'Kroger', purpose: 'signin' });
    const page = q.getSnapshot()!;
    assert.deepEqual([page.phase, page.purpose, page.beforeScript, page.script, q.readPage()], ['browse', 'signin', undefined, 'true;', null]);
    q.closeBrowse();
    assert.equal(await signIn, null);
  });

  await t('capture hook only on loads that need it', async () => {
    const q = new WebViewQueue();
    const a = q.run(job());
    assert.equal(q.getSnapshot()!.beforeScript, undefined, 'Walmart-style loads skip it');
    q.cancel();
    await assert.rejects(a);
    const b = q.run(job({ waitFor: 'auto' }));
    assert.ok(q.getSnapshot()!.beforeScript);
    assert.match(q.getSnapshot()!.script, /WAIT_FOR = "auto"/);
    q.cancel();
    await assert.rejects(b);
  });

  await t('streamed results: once accepted, the load finishes shortly after, stops the page, and ignores leftovers', async () => {
    const q = new WebViewQueue();
    const injected: string[] = [];
    q.attach((s) => injected.push(s));
    const seen: number[] = [];
    const p = q.run(job({ waitFor: 'auto', timeoutMs: 5000, keepPage: true, accept: (payload) => { seen.push(payload.sources!.length); return payload.sources!.length >= 2; } }));
    const s = q.getSnapshot()!;
    assert.match(s.script, /PROGRESS = true/);
    const nonce = nonceOf(s.script);
    q.receive(JSON.stringify({ nonce, kind: 'progress', title: 'milk - Shop', sources: [{ label: 'response https://api/a', text: '{"a":1}' }] }));
    q.receive(JSON.stringify({ nonce, kind: 'progress', sources: [{ label: 'response https://api/b', text: '{"b":1}' }] }));
    q.receive(JSON.stringify({ nonce, kind: 'progress', sources: [{ label: 'response https://api/c', text: '{"c":1}' }] }));
    assert.deepEqual(seen, [1, 2], 'not asked again while settling');
    const payload = await p;
    assert.deepEqual(payload.sources!.map((x) => x.label), ['response https://api/c', 'response https://api/b', 'response https://api/a'], 'newest first, all that arrived');
    assert.equal(payload.title, 'milk - Shop');
    assert.match(injected[injected.length - 1], /__stretchDone = /, 'the page is told to stop');
    assert.equal(q.getSnapshot()!.phase, 'idle', 'page kept for replays');
    q.receive(JSON.stringify({ nonce, kind: 'data', sources: [] })); // The page's own final post: ignored.
    assert.equal(q.getSnapshot()!.phase, 'idle');

    const r = q.run(job({ waitFor: 'auto', accept: () => false }));
    const n2 = nonceOf(q.getSnapshot()!.script);
    q.receive(JSON.stringify({ nonce: n2, kind: 'progress', sources: [{ label: 'response https://api/x', text: '{}' }] }));
    q.receive(JSON.stringify({ nonce: n2, kind: 'data', title: 'Final', sources: [{ label: 'response https://api/x', text: '{}' }] }));
    assert.equal((await r).title, 'Final', 'not accepted: the page’s own post decides, as before');
  });

  await t('store task: runs the store script, again after each navigation; Skip on a store visit rejects', async () => {
    const q = new WebViewQueue();
    const p = q.run(job({ task: { kind: 'setStore', buttons: ['make this my store'] } }));
    const s = q.getSnapshot()!;
    assert.match(s.script, /__stretchStoreTask/);
    assert.equal(s.beforeScript, undefined, 'no response capture needed');
    assert.equal(q.scriptAfterNavigation(), s.script, 're-injected after navigations');
    q.receive(JSON.stringify({ nonce: nonceOf(s.script), kind: 'data', pageResult: { label: 'Secaucus Supercenter' } }));
    assert.deepEqual((await p).pageResult, { label: 'Secaucus Supercenter' });

    const list = q.run(job({ waitFor: 'auto', task: { kind: 'listStores', zip: '10001' } }));
    const l = q.getSnapshot()!;
    assert.match(l.script, /__stretchStoreList/, 'a store finder: the ZIP is typed in and its stores read');
    assert.match(l.beforeScript ?? '', /__stretchCapture/, 'with the response capture, for the list it fetches');
    assert.equal(q.scriptAfterNavigation(), l.script, 're-injected after the page reloads with the results');
    q.receive(JSON.stringify({ nonce: nonceOf(l.script), kind: 'data', sources: [], pageResult: { cards: [] } }));
    assert.deepEqual((await list).pageResult, { cards: [] });
  });

  await t('lighter pages: hidden loads block images; a bot check reloads the page in full for the user', async () => {
    const q = new WebViewQueue();
    q.challengeGraceMs = 0;
    const p = q.run(job({ waitFor: 'auto', light: true }));
    const first = q.getSnapshot()!;
    assert.match(first.beforeScript ?? '', /__stretchLight/);
    assert.match(first.beforeScript ?? '', /__stretchCapture/, 'with the response capture');
    q.receive(JSON.stringify({ nonce: nonceOf(first.script), kind: 'challenge' }));
    await tick();
    const shown = q.getSnapshot()!;
    assert.deepEqual([shown.phase, shown.round], ['challenge', first.round + 1], 'remounted: loaded again');
    assert.doesNotMatch(shown.beforeScript ?? '', /__stretchLight/, 'with images, for the check');
    q.receive(JSON.stringify({ nonce: nonceOf(shown.script), kind: 'data', nextDataText: 'x' }));
    const after = q.getSnapshot()!;
    assert.equal(after.phase, 'hidden');
    q.receive(JSON.stringify({ nonce: nonceOf(after.script), kind: 'data', href: 'h', usage: { bytes: 123_456, files: 40, estimated: 3 } }));
    assert.equal((await p).bytes, 123_456, 'the page’s data count comes back');
  });

  await t('reported bot checks fail the load once their grace is over, without covering the app', async () => {
    const q = new WebViewQueue();
    q.challengeGraceMs = 0;
    const p = q.run(job({ reportChallenge: true }));
    q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'challenge' }));
    await assert.rejects(p, /challenge/);
    assert.equal(q.getSnapshot(), null);
  });

  await t('bot check grace: a check the page passes by itself stays hidden, and the load goes on from the page it moved to', async () => {
    const q = new WebViewQueue();
    q.challengeGraceMs = 50;
    const timing: LoadTiming = { queuedAt: Date.now() };
    const p = q.run(job({ reportChallenge: true, timing }));
    const first = q.getSnapshot()!;
    q.receive(JSON.stringify({ nonce: nonceOf(first.script), kind: 'challenge' }));
    q.receive(JSON.stringify({ nonce: nonceOf(first.script), kind: 'challenge' })); // the same page, again: one grace
    await tick(10);
    assert.equal(q.getSnapshot(), first, 'still hidden, the same load');
    assert.equal(nonceOf(q.scriptAfterNavigation()!), nonceOf(first.script), 'injected again into the page it moves on to');
    q.loadStarted(); // The check let it through: the real page is loading.
    assert.equal(timing.check?.unseen, true);
    q.receive(JSON.stringify({ nonce: nonceOf(first.script), kind: 'data', href: 'h', nextDataText: '{"a":1}' }));
    assert.equal((await p).nextDataText, '{"a":1}');
    assert.ok(timing.check!.to! >= timing.check!.from, 'the check span ended when the page moved on');
    await tick(60);
    assert.equal(q.getSnapshot(), null, 'the grace timer had nothing left to do');

    // Without the browser's word that a page began loading, the data itself says the check passed.
    const quiet: LoadTiming = { queuedAt: Date.now() };
    const p2 = q.run(job({ timing: quiet }));
    q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'challenge' }));
    q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'data', href: 'h', nextDataText: '{}' }));
    await p2;
    assert.deepEqual([quiet.check?.unseen, typeof quiet.check?.to], [true, 'number']);
  });

  await t('bot check grace: a check that stays is shown after it for a search, reported for a hidden read; time out meanwhile counts as the check', async () => {
    const q = new WebViewQueue();
    q.challengeGraceMs = 30;
    const p = q.run(job());
    q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'challenge' }));
    assert.equal(q.getSnapshot()!.phase, 'hidden', 'not shown yet');
    await tick(50);
    assert.equal(q.getSnapshot()!.phase, 'challenge', 'shown once the grace is over');
    q.cancel();
    await assert.rejects(p, /challenge_cancelled/);

    const p2 = q.run(job({ reportChallenge: true }));
    q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'challenge' }));
    await tick(10);
    assert.ok(q.getSnapshot(), 'still running during the grace');
    await assert.rejects(p2, /challenge/);

    q.challengeGraceMs = 1000;
    const p3 = q.run(job({ reportChallenge: true, timeoutMs: 30 }));
    q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'challenge' }));
    await assert.rejects(p3, (e: Error) => e.message === 'challenge', 'the check, not a timeout');
    const p4 = q.run(job({ timeoutMs: 30 }));
    q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'challenge' }));
    await tick(50);
    assert.equal(q.getSnapshot()!.phase, 'challenge', 'shown, with the check’s own time');
    q.cancel();
    await assert.rejects(p4, /challenge_cancelled/);
  });

  await t('streamed results carry the most data the page counted', async () => {
    const q = new WebViewQueue();
    const r = q.run(job({ waitFor: 'auto', timeoutMs: 3000, accept: (x) => (x.sources?.length ?? 0) >= 2 }));
    const n = nonceOf(q.getSnapshot()!.script);
    q.receive(JSON.stringify({ nonce: n, kind: 'progress', sources: [{ label: 'response https://api/a', text: '{}' }], usage: { bytes: 900_000 } }));
    q.receive(JSON.stringify({ nonce: n, kind: 'progress', sources: [{ label: 'response https://api/b', text: '{}' }], usage: { bytes: 1_400_000 } }));
    assert.equal((await r).bytes, 1_400_000);
  });

  await t('suggest: typed into the kept page like a replay, answered by nonce, not counted as one; no page, no suggestions', async () => {
    const q = new WebViewQueue();
    const injected: string[] = [];
    q.attach((script) => injected.push(script));
    await assert.rejects(q.suggest('mil', 200), /no_page/);
    const load = q.run(job({ keepPage: true, waitFor: 'loaded' }));
    const pending = q.suggest('mil', 500);
    assert.equal(injected.length, 0, 'waits for the page');
    q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'data', href: 'https://www.walmart.com/' }));
    await load;
    await tick();
    assert.equal(injected.length, 1);
    assert.ok(injected[0].includes('"mil"') && injected[0].includes("'suggest'"), 'the suggestion script, with what was typed');
    q.receive(JSON.stringify({ kind: 'suggest', nonce: nonceOf(injected[0]), items: ['milk', 7, 'whole milk'], how: 'list' }));
    assert.deepEqual(await pending, { items: ['milk', 'whole milk'], how: 'list' });
    assert.equal(q.stats.replays, 0);
    assert.ok(q.hasPage(), 'the page stays for more');
    q.reset();
  });

  await t('Skip on a bot check: the page loads waiting behind it at the same site fail too, others don’t; searches waiting see when', async () => {
    const q = new WebViewQueue();
    q.challengeGraceMs = 0;
    const first = q.run(job());
    const behind = q.run(job({ url: 'https://www.walmart.com/search?q=eggs' }));
    const task = q.run(job({ url: 'https://www.walmart.com/store-finder', task: { kind: 'listStores', zip: '10001' } }));
    const elsewhere = q.run(job({ url: 'https://www.target.com/s?searchTerm=milk' }));
    const before = Date.now();
    q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'challenge' }));
    await tick();
    assert.equal(q.getSnapshot()!.phase, 'challenge');
    q.cancel();
    await assert.rejects(first, /challenge_cancelled/);
    await assert.rejects(behind, /challenge_cancelled/, 'it would only meet the check again');
    assert.ok(q.skippedAt >= before);
    assert.match(q.getSnapshot()!.url, /store-finder/, 'a store finder task isn’t a search: it goes on');
    q.cancel();
    await assert.rejects(task);
    assert.match(q.getSnapshot()!.url, /target\.com/, 'another site’s page (the pages lane) goes on');
    const skipped = q.skippedAt;
    q.cancel();
    await assert.rejects(elsewhere);
    assert.equal(q.skippedAt, skipped, 'ending a load that isn’t on a check isn’t a Skip');
  });

  await t('reset: a page loading at a reset finishes, but isn’t kept, nor counted as the lane’s page', async () => {
    const q = new WebViewQueue();
    const load = q.run(job({ keepPage: true }));
    const resets = q.resets;
    q.reset();
    q.receive(JSON.stringify({ nonce: nonceOf(q.getSnapshot()!.script), kind: 'data', nextDataText: '{}' }));
    assert.equal((await load).nextDataText, '{}', 'its search gets its answer');
    assert.deepEqual([q.hasPage(), q.getSnapshot(), q.resets], [false, null, resets + 1]);
  });

  console.log(`\n${passed} queue tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
