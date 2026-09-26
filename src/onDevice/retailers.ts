import type { OnlinePlan, OnlineRules, RetailerConfig, RetailerConfigBundle, Strategy } from './types';
import { DEFAULT_CHALLENGE_MARKERS } from './webviewScript';

const BY_NUMBER = 'Its store number, as its store finder lists it: it goes in the search requests its page makes. Empty: the site picks.';

/** Most retailers: the page loads, then prices arrive from the retailer's own API, so only the WebView sees them. */
function webviewRetailer(
  id: string,
  name: string,
  searchUrl: string,
  homeUrl: string,
  note: string,
): RetailerConfig {
  return {
    id,
    name,
    enabled: true,
    searchUrl,
    homeUrl,
    cookieTemplate: '',
    strategies: ['webview'],
    parser: 'autoDetect',
    waitFor: 'auto',
    challengeMarkers: DEFAULT_CHALLENGE_MARKERS,
    timeoutMs: 20000,
    storeHint: BY_NUMBER,
    note,
  };
}

/**
 * Instacart's membership, taken where Instacart runs a store's online shop or its delivery. What it takes off differs
 * by store, so each store's rules add its own perks; one switch covers them all.
 */
const INSTACART_PLUS: Omit<OnlinePlan, 'pickup' | 'delivery'> = {
  id: 'instacart-plus',
  name: 'Instacart+',
  perYear: 99,
  perMonth: 9.99,
  note: 'free delivery on orders of $10 or more and a lower service fee where Instacart delivers; lower prices on Costco Same-Day',
};

/**
 * Online orders on Kroger's platform, the same at every chain it runs (checked 2026-09-25: the same help pages, word
 * for word, on each chain's site). Pickup: "FREE on orders of $35 or more, otherwise there's a service fee of $4.95".
 * Delivery: "the standard delivery fee of $9.95", varying by day and time slot (Instacart delivers since November
 * 2025). Boost, $99 a year, makes delivery free on orders of $35 or more; Boost Essential, $69, next-day only. Online
 * prices are the in-store ones: "Online prices reflect the in-store price on the day you place your order."
 */
function krogerOnline(host: string, boost = true): OnlineRules {
  return {
    checked: '2026-09-25',
    feesUrl: `https://${host}/hc/help/faqs/ways-to-shop/delivery`,
    pickupFeesUrl: `https://${host}/hc/help/faqs/ways-to-shop/pickup`,
    pickup: { fee: 4.95, freeOver: 35 },
    delivery: { fee: 9.95 },
    ...(boost
      ? {
          plans: [
            { id: 'kroger-boost', name: 'Kroger Boost', perYear: 99, perMonth: 12.99, delivery: { freeOver: 35 }, note: 'free delivery in as little as 2 hours on orders of $35 or more, at Kroger’s chains' },
            {
              id: 'kroger-boost-essential',
              name: 'Kroger Boost Essential',
              perYear: 69,
              perMonth: 8.99,
              delivery: { freeOver: 35 },
              note: 'free next-day delivery on orders of $35 or more (not same-day), at Kroger’s chains',
            },
          ],
        }
      : {}),
    note: 'delivery fees vary by day and time slot; Instacart delivers',
  };
}

/**
 * Online orders on Albertsons' platform, the same at every chain it runs (checked 2026-09-25 on safeway.com's FAQ,
 * the same on albertsons.com, vons.com and jewelosco.com). Pickup is free on orders of $30 or more; under that, and
 * for delivery under $30, there's a fee it doesn't publish. Delivery depends on the time slot: $3.95 for a 4-hour
 * window up to $9.95 for 1 hour (reported 2023; "a cost of $9.95 or less" in its 2026 terms). FreshPass, $99 a year,
 * makes delivery free on orders of $30 or more, at every Albertsons chain. Its store pages say "Same prices, deals &
 * rewards online as in-store".
 */
function albertsonsOnline(domain: string): OnlineRules {
  return {
    checked: '2026-09-25',
    feesUrl: `https://www.${domain}/faq/online-shopping.html`,
    pickup: { fee: 0 },
    delivery: { fee: 3.95, feeMax: 9.95 },
    plans: [{ id: 'freshpass', name: 'FreshPass', perYear: 99, perMonth: 12.99, delivery: { freeOver: 30 }, note: 'free delivery on orders of $30 or more, at Albertsons’ chains' }],
    note: 'orders under $30 pay a fee it doesn’t publish; delivery costs more in shorter time slots',
  };
}

/**
 * Weekly ads and digital coupons on Kroger's platform, the same paths at every chain it runs (researched 2026-09-26 from
 * scrapers' code dated 2026, not tried from a phone). The shoppable ad lists the preferred store's deals (its data comes
 * from a "shoppable-weekly-deals" request: mainlineCopy, salePrice, retailPrice, validFrom, validTill); without a
 * store it asks for one. The coupons page lists coupons without signing in, each saying whether it's on the card
 * ("addedToCard"), with the barcodes it's good for; signing in is at login.kroger.com.
 */
function krogerSavings(host: string, name: string): Pick<RetailerConfig, 'ad' | 'coupons'> {
  return {
    ad: { url: `https://${host}/weeklyad/shoppable`, note: 'the weekly ad of the store set on its site' },
    coupons: { url: `https://${host}/savings/cl/coupons/`, program: `${name} digital coupons`, clipButtons: ['clip', 'load to card', 'clip coupon'] },
  };
}

/**
 * Weekly ads and coupons on Albertsons' platform, the same at every chain it runs (researched 2026-09-26). Its
 * set-store link sets the store on the site and opens the weekly ad; the coupons page ("Deals+", Safeway for U) lists
 * the account's offers, each with a status of C (clipped) or U. It asks to sign in otherwise.
 */
function albertsonsSavings(domain: string, name: string): Pick<RetailerConfig, 'ad' | 'coupons'> {
  return {
    ad: { url: `https://www.${domain}/weeklyad`, storeUrl: `https://www.${domain}/set-store.html?storeId={{storeId}}&target=weeklyad` },
    coupons: { url: `https://www.${domain}/foru/coupons-deals.html`, program: `${name} for U coupons`, clipButtons: ['clip coupon', 'clip'] },
  };
}

/** Kroger's own brands, sold at every chain it runs. */
const KROGER_BRANDS = ['Kroger', 'Simple Truth Organic', 'Simple Truth', 'Private Selection', 'Heritage Farm', 'Home Chef'];
/** Albertsons' own brands, sold at every chain it runs. */
const ALBERTSONS_BRANDS = ['Signature Select', 'Signature Farms', 'Signature Cafe', 'O Organics', 'Lucerne', 'Open Nature', 'Waterfront Bistro', 'Primo Taglio'];

/**
 * A chain Kroger runs on kroger.com's platform: the same search page, store finder and official API (`apiChain`
 * picks its stores there). Rules only, no code: none of them has been tried yet.
 */
function krogerSister(id: string, name: string, host: string, apiChain: string[], region: string): RetailerConfig {
  return {
    ...webviewRetailer(
      id,
      name,
      `https://${host}/search?query={{query}}&searchType=default_search`,
      `https://${host}/`,
      `Kroger’s platform, like Kroger: its official API when its keys are set, else the website. ${region}.`,
    ),
    strategies: ['api', 'webview'],
    api: 'kroger',
    apiChain,
    storeHint: 'Official API: a ZIP code (nearest store) or a locationId. Website: its store number goes in the search requests its page makes.',
    storeFinder: { url: `https://${host}/stores/search` },
    sisterOf: 'kroger',
    region,
    storeBrands: KROGER_BRANDS,
    member: { program: `${name} card`, label: 'with Card' },
    // Boost's terms list Kroger's chains, but not Food 4 Less.
    online: krogerOnline(host, id !== 'food4less'),
    ...krogerSavings(host, name),
  };
}

/**
 * A chain Albertsons runs on safeway.com's platform: the same search page, and a store finder that answers with
 * JSON (checked 2026-09-25 for every chain below: grocery stores, type 5655, with numbers and distances).
 */
function albertsonsSister(id: string, name: string, domain: string, region: string): RetailerConfig {
  return {
    ...webviewRetailer(
      id,
      name,
      `https://www.${domain}/shop/search-results.html?q={{query}}`,
      `https://www.${domain}/`,
      `Albertsons’ platform, like Safeway. Prices arrive after the page loads. ${region}.`,
    ),
    storeFinder: { url: `https://local.${domain}/search.html`, jsonUrl: `https://local.${domain}/locator?q={{zip}}&storetype=5655` },
    sisterOf: 'safeway',
    region,
    storeBrands: ALBERTSONS_BRANDS,
    member: { program: `${name} for U`, label: 'Club Price' },
    online: albertsonsOnline(domain),
    ...albertsonsSavings(domain, name),
  };
}

/** A store the user added from a search link: the general product reader, no per-store code. */
export function customRetailer(id: string, name: string, searchUrl: string, homeUrl: string, host: string): RetailerConfig {
  return { ...webviewRetailer(id, name, searchUrl, homeUrl, `Added by you from ${host}.`), addedByUser: true };
}

/**
 * Defaults shipped inside the app. In production the Stretch config service serves the same shape,
 * and these only apply when the service can't be reached.
 * Notes record what one request from a datacenter saw on 2026-09-24. None of these has been tried on a phone yet.
 */
export const BUNDLED_CONFIG: RetailerConfigBundle = {
  version: 'bundled-2026-09-25',
  retailers: [
    {
      id: 'walmart',
      name: 'Walmart',
      enabled: true,
      searchUrl: 'https://www.walmart.com/search?q={{query}}',
      homeUrl: 'https://www.walmart.com/',
      // Paste the store cookies from a Proxyman capture here, with the store number replaced by {{storeId}}.
      // See README, "Pin the store". Left empty, Walmart picks a store from the phone's location.
      cookieTemplate: '',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      strategies: ['fetch', 'webview'],
      parser: 'walmartNextData',
      waitFor: 'nextData',
      challengeMarkers: DEFAULT_CHALLENGE_MARKERS,
      timeoutMs: 15000,
      storeHint: 'Store number, used with the cookie template in retailers.ts. Your stores sets it on walmart.com’s store finder instead.',
      // Checked 2026-09-25: lists the stores nearest the ZIP, nearest first, each with "Make this my store".
      storeFinder: { url: 'https://www.walmart.com/store-finder?location={{zip}}&distance=50', auto: true },
      note: 'Results are in the page HTML, so a plain request can work. Our datacenter test got the bot check.',
      storeBrands: ['Great Value', 'Marketside', 'Sam’s Choice', "Sam's Choice", 'bettergoods', 'Freshness Guaranteed'],
      // Checked 2026-09-25 on walmart.com's help pages (the fees page below is in the HTML a browser gets):
      // "Pick up orders over $35 for free", with a $6.99 fee under $35 (business.walmart.com); "Standard Delivery from
      // store: $9.95 delivery fee", busier time slots costing more; Walmart+ waives it on orders of $35 or more, and
      // members pay $6.99 under $35. No service fee, and no word of online prices being higher.
      online: {
        checked: '2026-09-25',
        feesUrl: 'https://www.walmart.com/help/article/the-walmart-site-and-app-experience/27f2678cb25a40a7b57a359fec3ca67f',
        pickup: { fee: 6.99, freeOver: 35 },
        delivery: { fee: 9.95 },
        plans: [{ id: 'walmart-plus', name: 'Walmart+', perYear: 98, perMonth: 12.95, delivery: { freeOver: 35, fee: 6.99 } }],
      },
      // No weekly ad and no digital coupons (researched 2026-09-26): its food rollbacks stand in for the ad, read from the
      // page's own data for the store set on its site.
      ad: { url: 'https://www.walmart.com/shop/deals/food/rollbacks', note: 'Walmart has no weekly ad: these are its food rollbacks' },
    },
    {
      ...webviewRetailer(
        'target',
        'Target',
        'https://www.target.com/s?searchTerm={{query}}',
        'https://www.target.com/',
        'The page loads, but prices arrive afterwards from Target’s own API.',
      ),
      // Target's help pages point here. Whether it takes a ZIP in the URL is unconfirmed, so the phone types it in.
      storeFinder: { url: 'https://www.target.com/store-locator/find-stores' },
      storeBrands: ['Good & Gather', 'Market Pantry', 'Favorite Day', 'Archer Farms', 'Simply Balanced'],
      member: { program: 'Target Circle', label: 'Circle price' },
      // Checked 2026-09-25 on target.com's help pages (fees in the page's HTML): Drive Up and Order Pickup are free;
      // same-day delivery (by Shipt) is "$9.99 delivery fee per order over $35" for non-members, at "the same item
      // pricing ... as in your local Target store"; Circle 360 drops the fee on orders of $35 or more.
      online: {
        checked: '2026-09-25',
        feesUrl: 'https://www.target.com/help/articles/delivery-options/same-day-delivery',
        pickup: { fee: 0 },
        delivery: { fee: 9.99, minimum: 35 },
        plans: [
          {
            id: 'target-circle-360',
            name: 'Target Circle 360',
            perYear: 99,
            perMonth: 10.99,
            delivery: { freeOver: 35 },
            note: 'free same-day delivery on orders of $35 or more; $49 a year with a Target Circle Card',
          },
        ],
      },
      // Researched 2026-09-26: the weekly ad's items come from Target's own API (title, price, reg_price, circle_offer),
      // for the store the site has; it changes on Sundays. Circle deals are saved to the account ("Save offer"); most
      // apply at checkout by themselves.
      ad: { url: 'https://www.target.com/weekly-ad' },
      coupons: { url: 'https://www.target.com/deals/all?facet=circle_deals', program: 'Target Circle deals', clipButtons: ['save offer', 'save deal', 'activate', 'add'] },
    },
    {
      ...webviewRetailer(
        'kroger',
        'Kroger',
        'https://www.kroger.com/search?query={{query}}&searchType=default_search',
        'https://www.kroger.com/',
        'Uses the official Products API when credentials are set (see README), then the website. The website blocked our datacenter test.',
      ),
      strategies: ['api', 'webview'],
      api: 'kroger',
      storeHint: 'Official API: a ZIP code (nearest store) or a Kroger locationId. Website: its store number goes in the search requests its page makes.',
      storeFinder: { url: 'https://www.kroger.com/stores/search' },
      apiChain: ['KROGER'],
      storeBrands: KROGER_BRANDS,
      member: { program: 'Kroger card', label: 'with Card' },
      online: krogerOnline('www.kroger.com'),
      ...krogerSavings('www.kroger.com', 'Kroger'),
    },
    {
      ...webviewRetailer(
        'costco',
        'Costco',
        'https://www.costco.com/s?keyword={{query}}',
        'https://www.costco.com/',
        'The page loads, but prices arrive afterwards.',
      ),
      // Checked 2026-09-25: a ZIP in the URL is ignored, so the phone types it in.
      storeFinder: { url: 'https://www.costco.com/warehouse-locations' },
      storeBrands: ['Kirkland Signature'],
      member: { program: 'Costco membership', label: 'member price' },
      // Checked 2026-09-25 on costco.com/same-day.html: Same-Day delivery (through Instacart, for members) has a $35
      // minimum and no separate fee: "Prices include a service and delivery fee", and "Item pricing is higher than your
      // local warehouse". Costco gives no figure: 13.5%, and 10% with Instacart+, are a third party's (Jan 2026). No
      // curbside pickup.
      online: {
        checked: '2026-09-25',
        feesUrl: 'https://www.costco.com/same-day.html',
        delivery: { fee: 0, minimum: 35 },
        markup: {
          pct: 13.5,
          ways: ['delivery'],
          said: 'its Same-Day prices are higher than in its warehouses, to cover Instacart’s service and delivery fees',
        },
        plans: [{ ...INSTACART_PLUS, delivery: { markup: 10 } }],
        note: 'Same-Day delivery is for members, through Instacart; there’s no curbside pickup',
      },
      // No weekly ad: its member savings run about a month ("Valid 9/21/26 - 10/18/26"), and apply by themselves at
      // checkout, so there's nothing to clip (checked 2026-09-26).
      ad: { url: 'https://www.costco.com/warehouse-savings.html', note: 'Costco has no weekly ad: these are its monthly member savings' },
    },
    // The store finders below answered from a U.S. connection on 2026-09-25 (Meijer's with a bot check). Listing
    // stores from them on a phone is untested: a finder that changes is fixed in the store rules file.
    {
      ...webviewRetailer(
        'traderjoes',
        'Trader Joe’s',
        'https://www.traderjoes.com/home/search?q={{query}}&section=products',
        'https://www.traderjoes.com/',
        'Blocked our datacenter test.',
      ),
      storeFinder: { url: 'https://locations.traderjoes.com/' },
      storeBrands: ['Trader Joe’s', "Trader Joe's"],
      // Its FAQ, checked 2026-09-25: "We do not offer curbside pickup or delivery", nor through Instacart.
      online: { checked: '2026-09-25', note: 'it doesn’t sell online' },
    },
    {
      ...webviewRetailer('heb', 'H-E-B', 'https://www.heb.com/search?q={{query}}', 'https://www.heb.com/', 'Sent our datacenter test a bot-check page.'),
      storeFinder: { url: 'https://www.heb.com/store-locations' },
      storeBrands: ['H-E-B', 'Hill Country Fare', 'Central Market'],
      // Checked 2026-09-25: its help pages publish no amounts ("shown on your checkout page"), so these are estimates
      // with no page to read: curbside is free on orders of $35 or more, with a "$2.95 small basket surcharge" under
      // that (its newsroom; still reported in 2025 and 2026); delivery had a $5 fee. H-E-B says "online prices may vary
      // from ads or in-store prices", and heb.com's prices are the ones the phone reads, so nothing is added on top.
      online: {
        checked: '2026-09-25',
        pickup: { fee: 0, smallUnder: 35, smallFee: 2.95 },
        delivery: { fee: 5 },
        note: 'heb.com’s prices are its online ones, which H-E-B says may vary from in-store prices',
      },
      // Researched 2026-09-26 (heb.com blocks datacenters): the weekly ad's deals as product cards, and its digital coupons,
      // clipped with a "Clip" button once signed in.
      ad: { url: 'https://www.heb.com/weekly-ad/deals' },
      coupons: { url: 'https://www.heb.com/digital-coupon/coupon-selection/all-coupons', program: 'H-E-B digital coupons' },
    },
    {
      ...webviewRetailer(
        'publix',
        'Publix',
        'https://www.publix.com/search?searchTerm={{query}}',
        'https://www.publix.com/',
        'Common terms redirect to a category page. Prices arrive after the page loads. Shows a notice instead outside the U.S.',
      ),
      storeFinder: { url: 'https://www.publix.com/locations' },
      storeBrands: ['Publix', 'GreenWise'],
      // Checked 2026-09-25: publix.com says "Publix's delivery and curbside pickup item prices are higher than item
      // prices in physical store locations", with no figure (10% is an estimate), in a pop-up a hidden page doesn't show,
      // so there's no page to read. Both go through Instacart, which gives the figures: pickup $1.99 for non-members,
      // delivery from $3.99, a $10 minimum and a service fee on delivery (10%, an estimate, as for ALDI).
      online: {
        checked: '2026-09-25',
        pickup: { fee: 1.99 },
        delivery: { fee: 3.99, minimum: 10, service: { pct: 10 } },
        markup: { pct: 10, ways: ['pickup', 'delivery'], said: 'its delivery and curbside pickup prices are higher than in its stores' },
        plans: [{ ...INSTACART_PLUS, delivery: { freeOver: 10, service: { pct: 5 } } }],
        note: 'Instacart delivers and does curbside pickup, at some stores',
      },
      // Researched 2026-09-26: the weekly ad comes from Publix's own API for the store set on its site (title, savings
      // "Buy 1 Get 1 FREE", wa_startDateFormatted); it changes on Wednesdays. Digital coupons need Club Publix.
      ad: { url: 'https://www.publix.com/savings/weekly-ad/view-all' },
      coupons: { url: 'https://www.publix.com/savings/digital-coupons', program: 'Publix digital coupons' },
    },
    {
      ...webviewRetailer(
        'aldi',
        'ALDI',
        'https://www.aldi.us/store/aldi/s?k={{query}}',
        'https://www.aldi.us/',
        'Runs on Instacart’s platform. Prices arrive after the page loads.',
      ),
      storeFinder: { url: 'https://info.aldi.us/stores' },
      // Checked 2026-09-25 on help.aldi.us (drawn by scripts: the phone reads it once they've run) and in its Instacart
      // storefront: pickup from $1.99, delivery from $3.99 (more for 1-hour windows and orders under $35), a $10 minimum,
      // and on delivery a service fee Instacart doesn't publish: 10% is an estimate, between the 5% and 15% it has been
      // reported at. ALDI says its online prices may be higher, to cover personal shopping, and its storefront shows
      // those prices (the same for pickup and delivery), so nothing is added: its own In-Store mode ran 10.7% lower
      // (the median of 78 items, in one area).
      online: {
        checked: '2026-09-25',
        feesUrl: 'https://help.aldi.us/faqs/article/Online-Ordering-Fees',
        pickup: { fee: 1.99, minimum: 10 },
        delivery: { fee: 3.99, minimum: 10, service: { pct: 10 } },
        markup: {
          pct: 10.7,
          ways: ['pickup', 'delivery'],
          said: 'its online prices may be higher than in its stores, to cover personal shopping',
          included: true,
        },
        plans: [{ ...INSTACART_PLUS, pickup: { freeOver: 10 }, delivery: { freeOver: 10, service: { pct: 5 } } }],
        note: 'Instacart runs its online shop',
      },
      // Its weekly ad moved to its Instacart storefront in March 2026 (researched 2026-09-26; the tiles page is as at
      // Sprouts, unconfirmed here). ALDI has no digital coupons.
      ad: { url: 'https://www.aldi.us/store/aldi/flyers/weekly' },
      storeBrands: [
        'Friendly Farms', 'Simply Nature', 'Millville', 'Clancy’s', "Clancy's", 'Specially Selected', 'Happy Farms', 'Baker’s Corner', "Baker's Corner",
        'Southern Grove', 'L’oven Fresh', "L'oven Fresh", 'Priano', 'Never Any!', 'Kirkwood', 'Appleton Farms', 'Countryside Creamery', 'Stonemill', 'Reggano',
        'Barissimo', 'Carlini', 'Chef’s Cupboard', "Chef's Cupboard", 'Fit & Active', 'Season’s Choice', "Season's Choice",
      ],
    },
    {
      ...webviewRetailer(
        'wholefoods',
        'Whole Foods',
        'https://www.wholefoodsmarket.com/grocery/search?k={{query}}',
        'https://www.wholefoodsmarket.com/',
        'The page loads, but prices arrive afterwards.',
      ),
      // Opens the site's store picker.
      storeFinder: { url: 'https://www.wholefoodsmarket.com/stores' },
      storeBrands: ['365 by Whole Foods Market', 'Whole Foods Market', '365'],
      member: { program: 'Prime', label: 'Prime member deal' },
      // Checked 2026-09-25 on Amazon's help page (fees in the HTML a browser gets) and its May 2026 news: pickup is
      // free; delivery is $13.95 an order, $9.95 with Prime ("a $9.95 service fee"), and free on orders of $35 or more
      // with Amazon's grocery subscription ($25 in some areas). "The same competitive everyday pricing in-store and
      // online."
      online: {
        checked: '2026-09-25',
        feesUrl: 'https://www.amazon.com/gp/help/customer/display.html?nodeId=GJEJZVFZM4TE4HSP',
        pickup: { fee: 0 },
        delivery: { fee: 13.95 },
        plans: [
          { id: 'amazon-prime', name: 'Prime', perYear: 139, perMonth: 14.99, delivery: { fee: 9.95 }, note: 'Whole Foods delivery for $9.95 an order' },
          {
            id: 'amazon-grocery',
            name: 'Amazon grocery subscription',
            perYear: 99.99,
            perMonth: 9.99,
            delivery: { freeOver: 35, fee: 9.95 },
            note: 'with Prime: free Whole Foods delivery on orders of $35 or more ($25 in some areas)',
          },
        ],
      },
      // Checked 2026-09-26: the sales flyer is empty without a store id; with one, its promotions are in the page's own
      // data (productName, salePrice, primePrice, startDate, endDate). No coupons to clip on the website.
      ad: { url: 'https://www.wholefoodsmarket.com/sales-flyer?store-id={{storeId}}' },
    },
    {
      ...webviewRetailer(
        'safeway',
        'Safeway',
        'https://www.safeway.com/shop/search-results.html?q={{query}}',
        'https://www.safeway.com/',
        'Albertsons platform, shared with Albertsons, Vons and Jewel-Osco. Prices arrive after the page loads.',
      ),
      // Checked 2026-09-25: asked for JSON, its finder lists the grocery stores (type 5655) nearest the ZIP, with
      // their store numbers and distances.
      storeFinder: { url: 'https://local.safeway.com/search.html', jsonUrl: 'https://local.safeway.com/locator?q={{zip}}&storetype=5655' },
      storeBrands: ALBERTSONS_BRANDS,
      member: { program: 'Safeway for U', label: 'Club Price' },
      online: albertsonsOnline('safeway.com'),
      ...albertsonsSavings('safeway.com', 'Safeway'),
    },
    {
      ...webviewRetailer(
        'meijer',
        'Meijer',
        'https://www.meijer.com/shopping/search.html?text={{query}}',
        'https://www.meijer.com/',
        'Blocked our datacenter test.',
      ),
      storeFinder: { url: 'https://www.meijer.com/shopping/store-locator.html' },
      storeBrands: ['Meijer', 'True Goodness', 'Frederik’s by Meijer', "Frederik's by Meijer"],
      // Checked 2026-09-25 (its page is drawn by scripts and blocks datacenters, so from archived copies): "Free pickup
      // on orders of $35+", with $4.95 under that (third parties, 2023 and Feb 2026); delivery by Shipt, "Fees vary by
      // location": $9.95 an order (reported 2023). "Get the same low prices as in store." Shipt's own membership only
      // counts in Shipt's app.
      online: {
        checked: '2026-09-25',
        feesUrl: 'https://www.meijer.com/shopping/services/more-ways-to-meijer.html',
        pickup: { fee: 4.95, freeOver: 35 },
        delivery: { fee: 9.95 },
        note: 'delivery by Shipt; fees vary by location',
      },
      // Researched 2026-09-26: the weekly ad is a flyer service's, called from Meijer's own page (name, price_text,
      // pre_price_text, sale_story, valid_from); mPerks coupons are clipped with "Clip" once signed in.
      ad: { url: 'https://www.meijer.com/shopping/weeklyad.html' },
      coupons: { url: 'https://www.meijer.com/shopping/coupons.html', program: 'mPerks coupons' },
    },
    {
      ...webviewRetailer(
        'wegmans',
        'Wegmans',
        'https://www.wegmans.com/shop/search?query={{query}}',
        'https://www.wegmans.com/',
        'The page loads, but prices arrive afterwards.',
      ),
      storeFinder: { url: 'https://www.wegmans.com/stores' },
      storeBrands: ['Wegmans'],
      // Checked 2026-09-25 on wegmans.com (both pages in their HTML, and read correctly by feePage.ts): online "prices
      // remain about 15% above in-store prices", for pickup and delivery; a $10 minimum; no pickup fee; through Dec 31,
      // 2026 "waiving our service fees and reducing standard delivery costs to $4.99"; free delivery with Instacart+.
      // The phone reads its in-store prices (wegmans.com opens in its In Store mode), so the 15% is added.
      online: {
        checked: '2026-09-25',
        feesUrl: 'https://www.wegmans.com/grocery-delivery-pickup/',
        pickupFeesUrl: 'https://www.wegmans.com/service/faq/online-grocery-ordering-delivery-pickup-/',
        pickup: { fee: 0, minimum: 10 },
        delivery: { fee: 4.99, minimum: 10 },
        markup: { pct: 15, ways: ['pickup', 'delivery'], said: 'its online prices are about 15% above its in-store prices', stated: true },
        plans: [{ ...INSTACART_PLUS, delivery: { freeOver: 10 } }],
        note: 'Instacart delivers; through Dec 31, 2026, service fees are waived and delivery is $4.99',
      },
      // No weekly ad: a few flyers a year (checked 2026-09-26). Its digital coupons need a Shoppers Club account.
      coupons: { url: 'https://www.wegmans.com/shop/coupons', program: 'Wegmans digital coupons', clipButtons: ['clip', 'clip coupon'] },
    },
    {
      ...webviewRetailer(
        'sprouts',
        'Sprouts',
        'https://shop.sprouts.com/store/sprouts/s?k={{query}}',
        'https://shop.sprouts.com/',
        'Runs on Instacart’s platform. Prices arrive after the page loads.',
      ),
      storeFinder: { url: 'https://www.sprouts.com/stores/' },
      storeBrands: ['Sprouts Farmers Market', 'Sprouts'],
      // Checked 2026-09-25 on sprouts.com/pricing (in its HTML, and read correctly by feePage.ts): pickup "$3.99" under
      // $35, free over it, with no service fee; delivery "Fast" $7.99, "Later" $1.99 ("Super Saver", the slowest, free),
      // a $10 minimum (Instacart's), and a service fee it doesn't publish (10%, an estimate, as for ALDI). "No markups":
      // its Instacart-run shop has its everyday in-store prices.
      online: {
        checked: '2026-09-25',
        feesUrl: 'https://www.sprouts.com/pricing/',
        pickup: { fee: 3.99, freeOver: 35 },
        delivery: { fee: 1.99, feeMax: 7.99, minimum: 10, service: { pct: 10 } },
        plans: [{ ...INSTACART_PLUS, delivery: { freeOver: 10, service: { pct: 5 } } }],
        note: 'Instacart runs its online shop, at its everyday in-store prices; the slowest delivery can be free',
      },
      // Checked 2026-09-26: sprouts.com/weekly-ad moved to its Instacart storefront, whose flyer shows the items as tiles.
      // Digital coupons need a Sprouts account.
      ad: { url: 'https://shop.sprouts.com/store/sprouts/flyers/weekly' },
      coupons: { url: 'https://shop.sprouts.com/store/sprouts/pages/in-store-deals', program: 'Sprouts digital coupons' },
    },
    // Chains that run on a parent's platform: rules only.
    krogerSister('ralphs', 'Ralphs', 'www.ralphs.com', ['RALPHS'], 'Southern California'),
    krogerSister('fredmeyer', 'Fred Meyer', 'www.fredmeyer.com', ['FRED MEYER', 'FRED'], 'Oregon, Washington, Idaho and Alaska'),
    krogerSister('kingsoopers', 'King Soopers', 'www.kingsoopers.com', ['KING SOOPERS'], 'Colorado and Wyoming'),
    krogerSister('frys', 'Fry’s', 'www.frysfood.com', ['FRYS', 'FRY'], 'Arizona'),
    krogerSister('smiths', 'Smith’s', 'www.smithsfoodanddrug.com', ['SMITHS', 'SMITH'], 'Utah, Nevada and New Mexico'),
    krogerSister('qfc', 'QFC', 'www.qfc.com', ['QFC'], 'Seattle and Portland areas'),
    krogerSister('dillons', 'Dillons', 'www.dillons.com', ['DILLONS'], 'Kansas'),
    krogerSister('marianos', 'Mariano’s', 'www.marianos.com', ['MARIANOS', 'MARIANO'], 'Chicago area'),
    krogerSister('picknsave', 'Pick ’n Save', 'www.picknsave.com', ['PICK N SAVE', 'PICKNSAVE'], 'Wisconsin'),
    krogerSister('food4less', 'Food 4 Less', 'www.food4less.com', ['FOOD 4 LESS', 'FOOD4LESS'], 'Southern California and Chicago areas'),
    albertsonsSister('albertsons', 'Albertsons', 'albertsons.com', 'Western and Southern states'),
    albertsonsSister('vons', 'Vons', 'vons.com', 'Southern California and Nevada'),
    albertsonsSister('jewelosco', 'Jewel-Osco', 'jewelosco.com', 'Chicago area'),
    albertsonsSister('acme', 'Acme', 'acmemarkets.com', 'Philadelphia, New Jersey and nearby'),
    albertsonsSister('shaws', 'Shaw’s', 'shaws.com', 'New England'),
    albertsonsSister('starmarket', 'Star Market', 'starmarket.com', 'Boston area'),
    albertsonsSister('randalls', 'Randalls', 'randalls.com', 'Houston and Austin'),
    albertsonsSister('tomthumb', 'Tom Thumb', 'tomthumb.com', 'Dallas–Fort Worth'),
    albertsonsSister('pavilions', 'Pavilions', 'pavilions.com', 'Southern California'),
  ],
};

const STRATEGIES: Strategy[] = ['fetch', 'webview', 'api'];

function isStoreFinder(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.url === 'string' &&
    f.url.startsWith('https://') &&
    (f.jsonUrl === undefined || (typeof f.jsonUrl === 'string' && f.jsonUrl.startsWith('https://'))) &&
    (f.auto === undefined || typeof f.auto === 'boolean') &&
    (f.buttons === undefined || (Array.isArray(f.buttons) && f.buttons.every((b) => typeof b === 'string')))
  );
}

export function isRetailerConfig(v: unknown): v is RetailerConfig {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.enabled === 'boolean' &&
    typeof r.searchUrl === 'string' &&
    r.searchUrl.startsWith('https://') &&
    typeof r.homeUrl === 'string' &&
    r.homeUrl.startsWith('https://') &&
    typeof r.cookieTemplate === 'string' &&
    Array.isArray(r.strategies) &&
    r.strategies.length > 0 &&
    r.strategies.every((s) => STRATEGIES.includes(s as Strategy)) &&
    typeof r.parser === 'string' &&
    (r.api === undefined || r.api === 'kroger') &&
    (r.waitFor === undefined || r.waitFor === 'nextData' || r.waitFor === 'auto') &&
    (r.pageScript === undefined || typeof r.pageScript === 'string') &&
    (r.replay === undefined || typeof r.replay === 'boolean') &&
    Array.isArray(r.challengeMarkers) &&
    r.challengeMarkers.every((m) => typeof m === 'string') &&
    typeof r.timeoutMs === 'number' &&
    typeof r.storeHint === 'string' &&
    isStoreFinder(r.storeFinder) &&
    typeof r.note === 'string' &&
    (r.addedByUser === undefined || typeof r.addedByUser === 'boolean') &&
    (r.sisterOf === undefined || typeof r.sisterOf === 'string') &&
    (r.region === undefined || typeof r.region === 'string') &&
    (r.apiChain === undefined || isStrings(r.apiChain)) &&
    (r.storeBrands === undefined || isStrings(r.storeBrands)) &&
    (r.member === undefined || isMember(r.member)) &&
    (r.online === undefined || isOnlineRules(r.online)) &&
    (r.ad === undefined || isAdRules(r.ad)) &&
    (r.coupons === undefined || isCouponRules(r.coupons))
  );
}

const isLink = (v: unknown): boolean => typeof v === 'string' && v.startsWith('https://');

/** A store's weekly ad in a rules file: https:// links. */
const isAdRules = (v: unknown): boolean =>
  isRecord(v) && isLink(v.url) && (v.storeUrl === undefined || isLink(v.storeUrl)) && (v.note === undefined || typeof v.note === 'string');

/** A store's coupons in a rules file: an https:// link and the program's name. */
const isCouponRules = (v: unknown): boolean =>
  isRecord(v) && isLink(v.url) && typeof v.program === 'string' && !!v.program && (v.clipButtons === undefined || isStrings(v.clipButtons));

const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A dollar figure or a percentage: a number, not below zero. */
const isAmount = (v: unknown, max = 1000): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const optAmount = (v: unknown, max?: number): boolean => v === undefined || isAmount(v, max);

const isService = (v: unknown): boolean => isRecord(v) && isAmount(v.pct, 100) && optAmount(v.min) && optAmount(v.max);

function isSchedule(v: unknown): boolean {
  return (
    isRecord(v) &&
    isAmount(v.fee) &&
    optAmount(v.feeMax) &&
    optAmount(v.freeOver) &&
    optAmount(v.minimum) &&
    optAmount(v.smallFee) &&
    optAmount(v.smallUnder) &&
    (v.service === undefined || isService(v.service))
  );
}

const isPerks = (v: unknown): boolean =>
  isRecord(v) &&
  optAmount(v.freeOver) &&
  optAmount(v.fee) &&
  optAmount(v.markup, 100) &&
  (v.service === undefined || v.service === null || isService(v.service));

const isPlan = (v: unknown): boolean =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  !!v.id &&
  typeof v.name === 'string' &&
  optAmount(v.perYear) &&
  optAmount(v.perMonth) &&
  (v.pickup === undefined || isPerks(v.pickup)) &&
  (v.delivery === undefined || isPerks(v.delivery)) &&
  (v.note === undefined || typeof v.note === 'string');

/** A store's online fees in a rules file: every figure a number, every page an https:// link. */
function isOnlineRules(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const m = v.markup;
  return (
    typeof v.checked === 'string' &&
    (v.feesUrl === undefined || (typeof v.feesUrl === 'string' && v.feesUrl.startsWith('https://'))) &&
    (v.pickupFeesUrl === undefined || (typeof v.pickupFeesUrl === 'string' && v.pickupFeesUrl.startsWith('https://'))) &&
    (v.pickup === undefined || isSchedule(v.pickup)) &&
    (v.delivery === undefined || isSchedule(v.delivery)) &&
    (m === undefined ||
      (isRecord(m) &&
        isAmount(m.pct, 100) &&
        Array.isArray(m.ways) &&
        m.ways.every((w) => w === 'pickup' || w === 'delivery') &&
        typeof m.said === 'string' &&
        (m.stated === undefined || typeof m.stated === 'boolean') &&
        (m.included === undefined || typeof m.included === 'boolean'))) &&
    (v.plans === undefined || (Array.isArray(v.plans) && v.plans.every(isPlan))) &&
    (v.note === undefined || typeof v.note === 'string')
  );
}

function isMember(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.program === 'string' && typeof m.label === 'string' && (m.signInUrl === undefined || (typeof m.signInUrl === 'string' && m.signInUrl.startsWith('https://')));
}

/** Where the store rules in use came from, for Store health. */
export interface RulesStatus {
  source: 'bundled' | 'served';
  /** The file asked for, when there is one. */
  url?: string;
  version: string;
  checkedAt?: number;
  /** Why the file wasn't used, in words. */
  error?: string;
}

/** The first thing wrong with a rules file, in words, or null when it's usable. */
export function rulesProblem(json: unknown): string | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return 'It isn’t a JSON object.';
  const b = json as Partial<RetailerConfigBundle>;
  if (typeof b.version !== 'string' || !b.version) return 'It has no "version".';
  if (!Array.isArray(b.retailers) || !b.retailers.length) return 'It has no "retailers".';
  const bad = b.retailers.findIndex((r) => !isRetailerConfig(r));
  if (bad === -1) return null;
  const id = (b.retailers[bad] as { id?: unknown } | null)?.id;
  return `Store ${bad + 1}${typeof id === 'string' ? ` (${id})` : ''} is missing a field, or has one of the wrong kind.`;
}

/**
 * Fetches store rules from `url` (a file on the Stretch backend, or for this POC one you host, like a GitHub Gist's
 * raw link). Any problem comes back in words, and the caller keeps the rules it has. The file must be HTTPS and
 * trusted: a pageScript runs inside retailer pages, so treat the file like code.
 */
export async function fetchRules(url: string, timeoutMs = 10_000): Promise<{ bundle: RetailerConfigBundle } | { error: string }> {
  if (!/^https:\/\//i.test(url.trim())) return { error: 'The link must start with https://' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.trim(), { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) return { error: `The link answered with HTTP ${res.status}.` };
    let json: unknown;
    try {
      json = JSON.parse(await res.text());
    } catch {
      return { error: 'The link didn’t return JSON.' };
    }
    const problem = rulesProblem(json);
    return problem ? { error: problem } : { bundle: json as RetailerConfigBundle };
  } catch {
    return { error: controller.signal.aborted ? 'The link didn’t answer in time.' : 'Couldn’t reach the link.' };
  } finally {
    clearTimeout(timer);
  }
}
