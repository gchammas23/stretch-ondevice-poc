// Pure functions only, so the tests run them in Node.
//
// Whether a store's result is really the item on the list. The store's own search order is trusted, but the result
// has to name the item: Stretch's App Store reviews tell of "avocado" matching dog leg warmers. Deliberately lenient:
// it rejects results that are plainly something else, it doesn't rank variants.

/** Words that don't have to appear in a product's name. */
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'to', 'by', 'fresh']);

/** Names that mean the same thing, folded into one word before comparing. */
const SAME: [RegExp, string][] = [
  [/\b(hot ?dogs?|hamburgers?|burgers?|sliders?|sandwich|hoagies?|subs?) (bun|roll)s?\b/g, '$1 bun'],
  [/\bhot ?dogs?\b|\bfrank(furter)?s?\b|\bwien(er|ie)s?\b|\bweiners?\b/g, 'hotdog'],
  [/\bcatsup\b/g, 'ketchup'],
  [/\bsoft drinks?\b|\bcolas?\b/g, 'soda'],
  [/\byoghurts?\b/g, 'yogurt'],
  [/\bdoughnuts?\b/g, 'donut'],
  [/\bcoriander\b/g, 'cilantro'],
  [/\bcourgettes?\b/g, 'zucchini'],
  [/\bgreen onions?\b/g, 'scallion'],
  [/\bchickpeas?\b/g, 'garbanzo'],
  [/\bbath tissue\b/g, 'toilet paper'],
  [/\bserviettes?\b/g, 'napkin'],
];

/** Things a grocery search turns up that aren't groceries, unless they were asked for. */
const NOT_GROCERIES =
  /\b(artificial|fake|faux|plush|costumes?|ornaments?|stickers?|decals?|posters?|t ?shirts?|tee shirts?|shirts?|hoodies?|socks?|leg ?warmers?|pillows?|blankets?|keychains?|figurines?|toys?|squishy|squishmallows?|earrings?|necklaces?|bracelets?|pajamas?|apparel|wall art|phone case)\b/g;
// Not "pet": PET is also an evaporated milk brand.
const PETS = /\b(dogs?|cats?|pupp(y|ies)|kittens?)\b/g;

function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

function fold(text: string): string {
  let out = normalize(text);
  for (const [pattern, replacement] of SAME) out = out.replace(pattern, replacement);
  return out;
}

const words = (text: string) => text.split(' ').filter(Boolean);

/** The word and its likely singulars: "berries" → berries, berry, berrie; "tomatoes" → tomatoes, tomato, tomatoe. */
function forms(word: string): string[] {
  const out = [word];
  if (word.length > 4 && word.endsWith('ies')) out.push(`${word.slice(0, -3)}y`, word.slice(0, -1));
  if (word.length > 3 && word.endsWith('es')) out.push(word.slice(0, -2));
  if (word.length > 2 && word.endsWith('s') && !word.endsWith('ss')) out.push(word.slice(0, -1));
  return out;
}

const sameWord = (a: string, b: string) => {
  const fa = forms(a);
  return forms(b).some((f) => fa.includes(f));
};

/** The query's words that a product should name, in order: stop words and numbers left out. */
export function queryWords(query: string): string[] {
  return words(fold(query)).filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

/** Every word of a text, as matching compares them: folded ("hot dogs" is "hotdog"), stop words left out, numbers kept. */
export function allWords(text: string): string[] {
  return words(fold(text)).filter((w) => !STOP_WORDS.has(w));
}

/** Whether two words are the same word, singular or plural ("berries" and "berry"). */
export { sameWord };

/** Words in `name` that aren't groceries, and weren't asked for in `query`. */
function offTopic(name: string, query: string): boolean {
  const q = fold(query);
  const n = fold(name);
  const asked = (hits: string[]) => hits.some((h) => q.includes(` ${h} `));
  const junk = n.match(NOT_GROCERIES)?.map((h) => h.trim()) ?? [];
  if (junk.length && !asked(junk)) return true;
  const pets = n.match(PETS)?.map((h) => h.trim()) ?? [];
  return pets.length > 0 && !(q.match(PETS)?.length ?? 0);
}

/**
 * True when the product plausibly is the item: it names the item's last word (the thing itself: "buns" in
 * "hot dog buns"), at least half of the other words (so "pancake mix" isn't trail mix), and isn't something else
 * entirely (a toy, a shirt, pet food). A query with no usable words matches anything.
 */
export function isMatch(name: string, query: string): boolean {
  const want = queryWords(query);
  if (!want.length) return true;
  if (offTopic(name, query)) return false;
  const have = words(fold(name));
  const named = (w: string) => have.some((h) => sameWord(w, h));
  const head = want[want.length - 1];
  if (!named(head)) return false;
  const others = want.slice(0, -1);
  return others.filter(named).length >= Math.ceil(others.length / 2);
}
