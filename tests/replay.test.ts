/// <reference types="node" />
import assert from 'node:assert/strict';
import { autoDetect } from '../src/onDevice/parsers';
import { applyTemplate, learnTemplate, looksRelevant, replaceQuery, replayPayload, substitute } from '../src/onDevice/replay';
import { BUNDLED_CONFIG } from '../src/onDevice/retailers';
import type { CapturedRequest } from '../src/onDevice/types';

const target = BUNDLED_CONFIG.retailers.find((r) => r.id === 'target')!;
const walmart = BUNDLED_CONFIG.retailers.find((r) => r.id === 'walmart')!;
const markers = target.challengeMarkers;
const get = (url: string, extra: Partial<CapturedRequest> = {}): CapturedRequest => ({ method: 'GET', url, headers: {}, credentials: 'same-origin', ...extra });
const product = (name: string) => ({ retailer: 't', storeId: '', id: name, name, price: 1 });

let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log('ok -', name); };

t('replaceQuery: whole words only, any joiner, keeps case style', () => {
  assert.deepEqual(replaceQuery('q=tea&x=steak', 'tea', 'milk'), { text: 'q=milk&x=steak', count: 1 });
  assert.equal(replaceQuery('/s/hot-dogs', 'hot dogs', 'hot dog buns').text, '/s/hot-dog-buns');
  assert.equal(replaceQuery('HOT DOGS and hot+dogs', 'Hot Dogs', 'Ketchup').text, 'KETCHUP and ketchup');
  assert.equal(replaceQuery('Hot Dogs', 'hot dogs', 'Iced Tea').text, 'Iced Tea', 'mixed case keeps the new query as typed');
  assert.equal(replaceQuery('a8tea9', 'tea', 'milk').count, 0, 'not inside an id');
  assert.equal(replaceQuery('anything', '  ', 'milk').count, 0);
});

t('substitute: URL query values, "+" spacing, path segments, hash', () => {
  const req = get('https://redsky.example.com/v1/plp_search?key=abc&keyword=hot+dogs&page=%2Fs%2Fhot+dogs&count=24#top');
  const { request, count } = substitute(req, 'hot dogs', 'iced tea');
  assert.equal(count, 2);
  assert.equal(request.url, 'https://redsky.example.com/v1/plp_search?key=abc&keyword=iced+tea&page=%2Fs%2Ficed+tea&count=24#top');
  const path = substitute(get('https://www.example.com/search/hot%20dogs/page/1'), 'hot dogs', 'ketchup');
  assert.deepEqual([path.request.url, path.count], ['https://www.example.com/search/ketchup/page/1', 1]);
  const host = substitute(get('https://milk.example.com/api?q=bread'), 'milk', 'eggs');
  assert.equal(host.count, 0, 'the host is never touched');
});

t('substitute: GraphQL variables in the URL and JSON bodies stay valid JSON', () => {
  const vars = encodeURIComponent(JSON.stringify({ query: 'hot dogs', first: 20 }));
  const gql = substitute(get(`https://www.example.com/graphql?operationName=Search&variables=${vars}`), 'hot dogs', 'say "cheese"');
  const sent = new URL(gql.request.url).searchParams.get('variables')!;
  assert.deepEqual(JSON.parse(sent), { query: 'say "cheese"', first: 20 });

  const post = substitute(get('https://api.example.com/search', { method: 'POST', body: JSON.stringify({ filters: { term: 'Hot Dogs' }, size: 24 }) }), 'hot dogs', 'mustard');
  assert.deepEqual([JSON.parse(post.request.body!), post.count], [{ filters: { term: 'mustard' }, size: 24 }, 1]);

  const form = substitute(get('https://api.example.com/search', { method: 'POST', body: 'q=hot+dogs&n=5', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), 'hot dogs', 'buns');
  assert.equal(form.request.body, 'q=buns&n=5');
});

t('learnTemplate: page data, a request that carries the query, nothing else', () => {
  assert.deepEqual(learnTemplate({ kind: 'document' }, 'milk'), { kind: 'document' });
  const api = get('https://api.example.com/search?q=whole%20milk&store=12');
  assert.equal(learnTemplate({ kind: 'response', request: api }, 'whole milk')?.kind, 'json');
  assert.equal(learnTemplate({ kind: 'response', request: get('https://api.example.com/prices?ids=1,2,3') }, 'whole milk'), null, 'no query in it');
  assert.equal(learnTemplate({ kind: 'response', request: { ...api, method: 'POST', opaqueBody: true } }, 'whole milk'), null, 'unreadable body');
  assert.equal(learnTemplate({ kind: 'response' }, 'whole milk'), null, 'no request recorded');
  assert.equal(learnTemplate({ kind: 'other' }, 'whole milk'), null);
  assert.equal(learnTemplate(undefined, 'whole milk'), null);
});

t('applyTemplate: page data refetches the search URL; API requests swap the query and keep headers', () => {
  const doc = applyTemplate({ kind: 'document' }, walmart, 'hot dogs', '');
  assert.deepEqual([doc?.expect, doc?.url, doc?.credentials], ['document', 'https://www.walmart.com/search?q=hot%20dogs', 'same-origin']);
  const request = get('https://api.example.com/search?q=milk&store=12', { headers: { 'x-api-key': 'k' }, credentials: 'include' });
  const json = applyTemplate({ kind: 'json', request, query: 'milk' }, target, 'eggs', '');
  assert.deepEqual(json, { expect: 'json', method: 'GET', url: 'https://api.example.com/search?q=eggs&store=12', credentials: 'include', headers: { 'x-api-key': 'k' } });
});

t('replayPayload: HTTP errors, bot checks and the wrong kind of response are unusable', () => {
  const ok = { status: 200, url: 'https://api.example.com/search?q=eggs', type: 'application/json', text: '{"items":[]}' };
  assert.deepEqual(replayPayload(ok, 'json', markers), { href: ok.url, sources: [{ label: 'replay https://api.example.com/search?q=eggs', text: '{"items":[]}' }] });
  assert.equal(replayPayload({ ...ok, status: 429 }, 'json', markers), null);
  assert.equal(replayPayload({ ...ok, text: '<html>' }, 'json', markers), null);
  assert.equal(replayPayload({ ...ok, url: 'https://www.example.com/blocked?url=x' }, 'json', markers), null);
  const doc = { status: 200, url: 'https://www.walmart.com/search?q=eggs', type: 'text/html', nextDataText: '{"a":1}', ld: ['{"b":2}'], title: 'eggs - Walmart.com', short: '' };
  assert.deepEqual(replayPayload(doc, 'document', markers), { href: doc.url, nextDataText: '{"a":1}', sources: [{ label: 'ld+json', text: '{"b":2}' }] });
  assert.equal(replayPayload({ ...doc, title: 'Robot or human?' }, 'document', markers), null);
  assert.equal(replayPayload({ ...doc, short: '<div id="px-captcha"></div>', nextDataText: null, ld: [] }, 'document', markers), null);
  assert.equal(replayPayload({ ...doc, nextDataText: null, ld: [] }, 'document', markers), null, 'no data at all');
});

t('looksRelevant: a top result must mention the query (plurals folded); short queries pass', () => {
  assert.equal(looksRelevant([product('Oscar Mayer Wieners'), product('Ball Park Beef Hot Dog, 8 ct')], 'hot dogs'), true);
  assert.equal(looksRelevant([product('Heinz Tomato Ketchup'), product('French’s Mustard')], 'hot dogs'), false);
  assert.equal(looksRelevant([product('Wild Blueberry Pancakes')], 'blueberries'), true);
  assert.equal(looksRelevant([product('Tropicana Orange Juice')], 'OJ'), true);
  assert.equal(looksRelevant([], 'hot dogs'), true);
});

t('autoDetect reports where products came from, with the request for captured responses', () => {
  const request = get('https://api.example.com/search?q=milk');
  const list = JSON.stringify({ results: [{ id: 'a', name: 'Milk A', price: 3 }, { id: 'b', name: 'Milk B', price: 4 }] });
  const fromApi = autoDetect({ sources: [{ label: `response ${request.url}`, text: list, request }] }, { retailer: 't', storeId: '' });
  assert.deepEqual(fromApi.origin, { kind: 'response', request });
  const fromPage = autoDetect({ nextDataText: list }, { retailer: 't', storeId: '' });
  assert.deepEqual(fromPage.origin, { kind: 'document' });
  const fromGlobal = autoDetect({ sources: [{ label: '__APOLLO_STATE__', text: list }] }, { retailer: 't', storeId: '' });
  assert.deepEqual(fromGlobal.origin, { kind: 'other' });
});

console.log(`\n${passed} replay tests passed`);
