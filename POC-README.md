# Stretch on-device pricing: proof of concept

A Stretch-style grocery app whose prices are read live on the phone, from each store's own website, instead of from our servers. You make a list, tap **Find a store**, and the phone searches every item at every store you compare, then shows the best basket.

Built against Expo SDK 57 (React Native 0.86, Expo Router, react-native-webview 13.16, expo-camera 57, expo-location 57, expo-sharing 57, expo-battery 57, react-native-view-shot 5.1: all in Expo Go). Type-check, lint, `expo-doctor` and an iOS Metro bundle all pass, and so do 283 unit tests. The screens were checked in a browser preview with simulated prices. The speed timeline has been run on an iPhone twice, before and after the first fixes (see "Where the time goes"); the latest changes haven't been run yet. The battery test has run once on an iPhone, from cold, before the status bar could be typed in (see "What pricing costs the battery").

## What's in the app

The flows follow Stretch's App Store screenshots.

- **Welcome.** A first launch asks where you shop (your location, or a U.S. ZIP code) and which stores to compare. Then **Watch it work**: the phone reads the price of milk at the stores just picked, live, and each price lands with how long it took, then the cheapest. Then your lists open. Skip is always there. Diagnostics can show it again.
- **Lists.** Two lists are there on first launch ("Sunday BBQ", "Pancake breakfast"). Add items the way you'd write them ("hot dog buns"), check them off, long-press to remove, tap the title to rename. Also:
  - **Paste a whole list** into the add field: every line becomes an item. Bullets, checkboxes and numbering are dropped, and "2 x eggs" or "Bread ×2" set the quantity.
  - **Add again** suggests items from finished trips and your other lists.
  - The **⋯** menu shares a list as text (with Stretch's pick), duplicates it for next week, or adds from a recipe.
  - **Tap an item** for its details: name, quantity, a note, what you want (organic, a brand, a size), the exact product if you've set one, and your usual products for it.
- **Add from a recipe.** Paste a recipe's link. The phone loads the page, hidden, and reads the recipe that the page publishes for search engines (schema.org data; no AI). Each ingredient becomes an item to tick: "2 cups whole milk" becomes Whole milk, with the line kept as a note. Salt, pepper and water start unticked. So does anything the list may already have ("Butter" for unsalted butter), which says so.
- **Price check** (the search bar on the home screen). Any product, at every store you compare, side by side, without a list: the cheapest, each store's best match and a few more, recent searches, and **Add to a list**.
  - **Suggestions as you type**: searches (your recent checks and list items, what your stores' own search boxes suggest, and common kinds like "whole milk" or "oat milk"), and products your stores already showed this phone, with their prices. Tapping a search checks it at every store.
  - **The same product everywhere**: tapping a suggested product finds that exact product at each store, by barcode where the stores publish one, else by name and size. A store without it shows its closest equivalent, marked as such: its own brand's whole milk, 1 gal, say. The cheapest shows first.
- **Scan a barcode** (the orange button next to it). The camera reads a product's barcode (EAN-13, EAN-8, UPC-A, UPC-E), or you type its digits. Each store is searched by the barcode. As soon as one store's result carries the same barcode, that names the product, and the other stores are searched by its name too. Each store's answer says how sure it is: "Same barcode", "Same name and size", or "Its top result; check the name".
- **Watchlist and deals** (home screen). **Watch the price** on any product page. Every time the phone reads that product again, for a list or a price check, a lower price shows as a banner and on the watchlist. **Check watched prices now** searches them all. Below that: what's on sale on your lists, your lists' items **in this week's ads**, your **coupons for your lists**, and other sale prices the phone has read in the last day.
- **Weekly ads and coupons** (from deals, and Your stores). Each compared store's own weekly ad, read on the phone from its site at most once a day, when it was read, and your lists' items in it. Your digital coupons at the stores you signed in to in the app: which fit your lists, which are clipped, **Clip** (only when you tap it), and **Count clipped coupons in totals**. See "Weekly ads and digital coupons".
- **Find a store.** Prices every item at each store you compare, live, and fills in as results land: which search each store is on, how many are done, and how long it's taking. Then:
  - While it runs, **the race**: a lane per store fills as its prices land, with its own stopwatch and its basket so far. When every store is in, **the podium**: the three cheapest, the winner in the middle, what it saves against the dearest store, and **Share your savings**.
  - **Stretch's pick** is the store that gets the most of your list, then the lowest total. It says how many of your items are on sale there, and what **cheaper swaps** would save on top.
  - **Count the drive**: each store's round trip (its distance from your ZIP, there and back, at 35¢ to $1 a mile) counts toward its total, so a cheaper store further away can lose. The pick says whether its prices are worth the drive: "Kroger is $5.71 cheaper on groceries, but $8.54 more to drive to: not worth it."
  - **Split trip** shows up when splitting the list between two stores saves at least $2, driving included when it counts, or gets items no single store has.
  - The banner turns into a **scorecard**: "216 prices from 4 stores in 2.9 s, on this iPhone", with each store's searches and how they were done. It can be shared.
  - **Are these prices right?** (the **price truth check**): a sample of the list's prices at each store (3, 5 or 10), each read again from the product's own page on the store's site, one page at a time. It ends on a number: "12 of 12 match".
- **How you shop** (Find a store, and Your stores): **In store**, **Pickup** or **Delivery**. Ordering online, every total is what the order really costs at that store: the items, its pickup or delivery fees (small-order and service fees, minimums and free-over thresholds included), and its higher online prices where it says they're higher, with the plans you have (Walmart+, Target Circle 360, Kroger Boost, Instacart+, FreshPass, Prime...). Stores rank by that, next to their in-store total, on the pick, each store row, the basket, the split trip, the podium and the share card. The fees come from each store's own fees page, read on the phone; until it has been read, the store rules' figures count, marked as estimates. See "What an order really costs online".
- **Basket** (tap a store). Each item becomes that store's top search result that is really the item (see "Better comparisons"). Every line shows its size and unit price, and when and how its price was read. Where they apply, it also shows a sale, a member price, a pack much bigger or smaller than at the other stores, a price change since the last read, "Your usual", **In this week's ad** with the ad's deal, and **Coupon: $1 off** with whether it's clipped. Change quantities, or open **Similar items** to swap in another result, which is then remembered.
  - **Cheaper swaps**: items whose store has a cheaper product of the same kind and size (often its own brand: Great Value, Good & Gather, Kroger…), found in the results the phone already read, so there's no extra searching. Swap one, or all at once; a swap becomes your usual.
- **Product page** (tap a product anywhere: basket, split trip, shopping, similar items). It opens at once with what the search read, then the phone reads the product's own page on the store's site, hidden, for more: photos, description, highlights, ingredients, rating and barcode. It also shows how the price was read, the price's history, and the same item at your other stores. **View on Target** opens the store's own page for it.
  - **X-ray: the data behind this price**: the exact data the store's server sent the phone for this product, with the price's line highlighted and the path to it ("price › current = 3.84"), the request that brought it (its keys and ids hidden), when, how long it took and how much data it moved. Kept in memory only, for prices read since the app opened.
- **Shop here.** The list becomes a checklist for that store (or two stores, for a split), with the products and prices as they were when you tapped it. **Done shopping** records the trip.
- **Savings tracker** (home screen). What your finished trips saved, each against the cheapest other store that had everything you bought, at its prices then.
- **Your stores** (store icon on the home screen). Which retailers are compared, **Your location** (where you are, or a U.S. ZIP code, and how far stores may be; see "Choosing a store"), **Change store** (each retailer's stores near you, to pick from), and **Add a store**. Each compared store shows which store its prices come from: its name, address and store number as far as they're known, how it was set, and whether the last search's prices were really from it (see "Which store, exactly").
  - **33 stores**: the 14 before, plus 19 regional chains that run on Kroger's and Albertsons' platforms (Ralphs, Fred Meyer, King Soopers, Fry's, Smith's, QFC, Dillons, Mariano's, Pick 'n Save, Food 4 Less; Albertsons, Vons, Jewel-Osco, Acme, Shaw's, Star Market, Randalls, Tom Thumb, Pavilions). Rules only, no code. They're folded away by family here and in the welcome.
  - **Member prices**: stores with a loyalty program (Kroger and its chains' cards, Safeway and Albertsons' "for U", Target Circle, Costco, Prime at Whole Foods) have a switch. On, the member price ("with Card", "Club Price") counts in your totals; off, it shows beside the price. **Sign in on kroger.com** opens the store's own page to sign in; the app injects nothing into that page and reads nothing on it, and the site keeps you signed in, so the phone's searches there carry your account's own prices. That's something only your phone can do: a server would need your password.
- **Store health** (link at the foot of the home screen, and in Your stores). Which stores work from this phone, how each has done over the last week, and where the store rules come from (below).
  - **How much this phone asks**: each store's searches today (full page loads, requests sent from a page already open, official API calls), its other pages (products, fees, weekly ads, coupons), its data, and its busiest hour. The app never makes more than 120 visits an hour at one store (searches, and the pages read for its weekly ad and coupons), and one page load at a time: past that, the store waits ("Paused: an hour's worth of searches here already"). Underneath, what this session's pricing took from the phone's battery (see "What pricing costs the battery").
  - **What would servers cost for this?**: the same searches from servers (residential proxies, bot checks solved, browser time) for 10k to 1M users, from this phone's own measured data and time per search, against $0 on phones. Every assumption can be changed, and the numbers shared.
  - **Phone vs. server**: the POC's argument, tested live. Each store is searched for milk from the phone two ways, its page in the phone's own browser and one plain request like a scraping server's, side by side with what one request from a datacenter got on 2026-09-24. "From a plain request: 3 of 14 stores gave prices. From this iPhone's browser: 12 of 14." See "Phone vs. server".
- **Presenter mode** (lightning icon on the home screen). A one-minute live demo, the same steps every time: pick a list, a three-second intro, then the list is priced fresh at your stores with the store pages big on screen (the top of each, in a 2 × 2 grid), a caption for each step, counters and the race. It ends on the podium, one of the winner's prices checked live against the product's own page, its X-ray, **Share your savings**, and **Could a server do this?**, which opens the phone vs. server test and starts it at once.
- **Share your savings.** A picture of a list's result, made on the phone: what the cheapest store saves against the dearest, the stores side by side, and that the prices were read live on the phone. Nothing else goes with it.
- **What stays on this phone** (link at the foot of the home screen). What the app keeps, what it sends and to whom, and what it never collects, with the actual counts. **Forget prices and history**, or **Erase everything** and start again from the welcome.
- **Diagnostics** (pulse icon). The original test screen, one search at a time with the strategy picker and "Found in" line. It also has:
  - **Start over**, for demoing the first launch: it erases everything on the phone (lists, trips, stores, prices, history) and shows the welcome. **Show the welcome again** keeps your data;
  - a **speed test**, with each search's timeline (waiting, page load, replay, reading, to the screen), where the run's time went, and its biggest costs (see "Where the time goes"), and what each run took from the battery;
  - a **battery test**: the speed test again and again, then the battery's drop per list and per search, with how sure that is (see "What pricing costs the battery");
  - the **Watch it scrape** and **Lighter hidden pages** switches;
  - what each retailer's WebView is doing, and how hard each store is pushed, with switches to turn replays off, to ask stores for as many results as their pages do, and to stop adapting to each store (below);
  - recent failures.

Headings use Fraunces as a stand-in for Canela Deck, the commercial font on stretchgroceries.com. Body text is Geist and the handwritten line is Caveat, both as on the site. Stores show colored monograms, not the retailers' logos.

Accessibility:

- **Contrast.** Text meets WCAG AA: 4.5:1 for small text, 3:1 for large text. Controls' outlines, like empty checkboxes and switches that are off, are 3:1. Stretch's orange (#F95A37) is 3.2:1 on white, so it stays for icons, ticks and accents, while orange text uses #C2462A and orange buttons #CE4A2D.
- **VoiceOver.** Every control has a label, a role and its state (checked, expanded, on or off), and screens have headings.
  - Things that happen on their own are spoken: prices checked and the pick, a price check's answer, a list priced in the background, a price drop, a recipe read, items added, a trip saved.
  - A bot check or store page that covers the app takes the focus, and hides the app behind it until it's closed.
  - A basket line's quantity is one control: swipe up or down to change it, and Remove is an action.
  - The live view stays off while a screen reader is on, since it covers the bottom of every screen.
- **Touch and text size.** Buttons and links take a 44 pt touch. Text grows with the phone's text size: prices and statuses wrap instead of being cut off, and the bars at the foot of screens make room for it.

## How prices are read

The method is the same as before: the phone does the searching, with three strategies tried in the order each retailer's rules list them.

- **Plain request.** One GET from the phone, no rendering. Only works where results are in the HTML, which today means Walmart.
- **WebView.** Loads the search page in an invisible browser. A small script keeps a copy of the JSON the page fetches for itself, and a generic reader (`autoDetect`) finds the largest list of things with a name and a price.
- **Official API.** Kroger's Products API, when you add credentials.

If a retailer shows a bot check, its WebView covers the app so you can complete it. Code never answers a check. Other stores keep searching meanwhile, and **Skip** stops that store for this run.

### What's new: parallel stores and replays

Pricing a list is one search per item per store: 6 items at 4 stores is 24 searches. Loading a retailer's whole search page 24 times, one at a time, takes minutes. Two changes make it fast without changing where the data comes from:

1. **One WebView per retailer.** Stores search in parallel, up to 4 pages loaded at once (the least recently used idle page is unloaded to make room). Each retailer still sees one page load at a time, like one person browsing.
2. **Replays.** A retailer's first search loads its search page, as before. The page then stays loaded, and later searches are sent from inside it. They go out as the same request that brought the first results, with the query swapped, and up to 3 at once. They carry the same device, cookies and origin as the page, so they read the same live prices, usually in well under a second instead of several seconds.
   - The capture script now also records how each JSON response was requested: method, URL, headers, text body and credentials. After a page load, `replay.ts` checks which response the products came from. If that request carries the query, it becomes the one to replay. If the products were in the page's own HTML (Walmart's Next.js data), the replay fetches the search page's HTML instead and reads the data out of it.
   - A replay falls back to a full page load when:
     - it gets an HTTP error or a bot-check page;
     - it isn't JSON;
     - none of its top results mention the query.
   - If a replay returns results for the query the page was loaded with (the swap was ignored) twice in a row, that retailer goes back to page loads until its page is unloaded.
   - Replays aren't used for retailers with a `pageScript` or a store cookie template, since both only work with a page load. A retailer's rules can also turn them off with `replay: false`.

Page loads themselves are quicker too:

- **Early finish.** As the page loads, its script streams each new price-bearing response back to the app. As soon as those hold at least 3 products that fit the query, the load finishes 0.7 s later. It no longer waits for the page to go quiet, which busy pages never do.
- **Early give-up.** A page that has finished loading and then gets no new data for 5 s is given up on, instead of waiting out the whole timeout. The failure says what the page showed (its title, and the data it did load), on the basket and on the Diagnostics screen.

Around that:

- **Pricing** (`src/pricing/pricingEngine.ts`) runs up to 4 stores at once, and at each as many searches at once as its tuning allows: 3 to start (6 for a store searched without a WebView, like Kroger's API), more for a fast, healthy store and fewer for a touchy one (see "Adapting to each store"). An item that can take another item's search waits for it (see "One search for items that share it").
  - A store that fails twice in a row, or whose bot check you skip, stops for this run; **Try again** resumes it.
  - A strategy that fails twice in a row rests for 10 minutes, and the next one in the list runs instead. That's typically Walmart's plain request when it gets bot-checked.
- **A slow store doesn't hold up the answer.** Stretch's pick comes from the stores that have finished, and **Shop here** works as soon as the pick's store is done. If another store is still checking, the card says so, and the pick changes if that store turns out cheaper.
- **Saved prices** count as fresh for 2 hours. Up to 24 hours old, they're shown at once, labeled with their age, while fresh ones are searched live. If a refresh fails, the older price stays, marked as such, until you tap **Try again**. **Refresh** searches everything again. Picking another store on a retailer's site discards that retailer's saved prices.

### Pricing in the background

- **When it runs.** Opening a list prices it in the background, and so does adding items (after a short pause). Only what isn't already known is searched, so **Find a store** is usually instant.
- **The banner.** When a list finishes pricing, a banner says so on whatever screen you're on: "Sunday BBQ is priced · Stretch's pick: Walmart · $96.27". It stays quiet for runs that finished in under 3 s, and when you're already on that list's Find a store screen.
- **Only while the app is open.** iOS pauses the app's WebViews soon after you switch to another app, so pricing waits. Searches the pause cut off are run again when you come back, instead of counting as failures.
- **Only your own lists.** Nothing else is searched, and no one else's lists.

### Seeing the phone do it

For demos, and for anyone who doubts the prices are real:

- **Watch it scrape** (the eye on Find a store, or the switch in Diagnostics). The hidden store pages are drawn small, live, in a panel over the app, up to four at once, each with what it's doing: loading its page, reusing it for a search, a bot check. A feed underneath lists every search as it lands, for example "Target · milk · 24 products · 0.8 s · reused its page". The panel shrinks to a pill and follows you across screens. Stores searched through an official API don't need a page, so they show up in the feed only.
- **Price receipts.** Every basket line says when its price was read and how ("Read 3 min ago · reused its page"). The product page says it in full:
  - the time;
  - whether the phone loaded the store's search page, re-sent the store's own search request from a page it had loaded, requested the page directly, or asked an official API;
  - how long it took, and which of the page's data held the products.
  Reading the product's own page then cross-checks the price ("The product's own page shows the same price, just now").
- **Scorecard and speed test.** The scorecard counts only searches run just then, not prices saved from earlier. The **speed test** in Diagnostics searches the same six items at every compared store, ignoring saved prices. It runs cold (pages unloaded, so each store's first search is a page load) or warm (reusing the pages), shows time to the first price, each store's median, and page loads against reused pages, and can be shared as text.

### Proving it works: coverage, data and health

- **Which stores work from here** (Store health → **Check all 14 stores**). Searches "milk" once at every store in the rules, and any you added, compared or not, four at a time. A bot check is noted rather than shown, so the check runs on its own. Each store gets a verdict: Works (with how many products, how long and how it read them), Bot check or blocked, No products came back, Too slow, or Failed. The results can be shared as text, and **Your stores** shows them next to the stores you don't compare.
- **Data used.** Every search counts the data it cost the phone. A page load adds up the files the page loaded, from the browser's own resource timing. Files from other sites that don't report a size are counted at a typical size for their type (an image as 25 KB, a script as 60 KB); files from the browser's cache count nothing. A replay counts its response, Kroger's API its JSON, and a plain request its HTML. The totals show in the live feed, receipts, the scorecard, the speed test and Store health.
- **The last 7 days** (Store health). Every search the phone made is logged on the phone for 14 days: store, how it went, how long it took, the data it used, and which version of the rules it ran. Per store: how many worked, the median time, bot checks, data, a bar for each day, and the last failure with its reason. After the rules change, it also counts how the store has done since.
- **Store rules from a file** (Store health → Store rules). A store's search link, where its products are and how to read them are rules, not code. To fix a store without an app update: **Share the current rules**, put them in a GitHub Gist, change the store, and paste the Gist's raw `https://` link. The app checks the file (JSON with a version and a list of stores, each with every field it needs) and uses it at once. It fetches it again when the app starts, and when you come back to the app after half an hour. A broken or unreachable file is reported, and the last good file (or the built-in rules) stays in use. Store health shows which version each search ran with.

### Phone vs. server

The POC rests on one claim: stores let a phone's browser read their prices, and not a server. **Phone vs. server** (Store health, or **Could a server do this?** at the end of presenter mode) tests it live, on the phone (`src/onDevice/phoneVsServer.ts`, `src/app/phone-vs-server.tsx`):

- **Two ways, one at a time at each store.** Each store is searched for "milk" twice: first its search page in the phone's own browser (a hidden WebView, as the app reads prices: a page load, or a request sent from its page when one is loaded), then one plain request for the same page, the way a scraping server asks: a GET with a browser's Accept headers and the same user agent as the phone's browser (expo-constants gives it), no cookies, and no scripts run. A store whose rules have no plain request gets a plain GET of its search link. Four stores at once.
- **Side by side**, store by store: what each way got (its products with prices, and the first of them; or the block: a bot check, "Blocked (403)", "Too many requests (429)", an empty page; or a page without prices in it), with its time and data. The third column is what one request from a datacenter got on 2026-09-24, word for word from the table under "Add any store" (a test checks that they match). Regional chains weren't tried from the datacenter: their parent's site is shown.
- **The summary**, under two big numbers: "From a plain request: 3 of 14 stores gave prices. From this iPhone's browser: 12 of 14." Then where each way was blocked, and the datacenter's record for the same stores. **Share** gives it all as text, store by store. VoiceOver hears the summary when the test ends, and each store as one sentence.
- **Honest about what it shows.** The plain request still leaves from the phone's own internet address, which stores trust more than a datacenter's: that makes it a server's best case, and the screen says so under the numbers. Over a VPN, both ways leave from the VPN's address, often a datacenter's itself, and the screen says that too: the plain request is then no best case, and the browser is all that differs. A page without prices in it isn't a block: most stores send their prices afterwards, from requests only a browser makes, which a server could also make (from a datacenter, or through rented home addresses: that's what **What would servers cost for this?** prices). So blocks are counted apart.
- **Which stores**: the ones you compare, or every store in the rules (13 today) and any you added, with regional chains only when compared, since they run on Kroger's and Albertsons' sites.
- **Polite.** Both searches count toward each store's 120 an hour, and a store without room for both isn't tried (it says when there's room again). A list being priced at a store goes first: the test waits up to a minute for it. Bot checks are reported, not shown. The test's searches show in the live feed and in How much this phone asks, but not in the last 7 days' rates: its plain requests go to stores the app doesn't read that way.
- The last finished test is kept on the phone, and shown in Store health (one the app closed on halfway isn't kept). **Forget prices and history** and **Erase everything** clear it.

A plain request's page is read for whatever product data it carries, as a scraper would: Next.js page data, schema.org data, JSON script blocks, and the page state its scripts set (`__APOLLO_STATE__`, `__PRELOADED_STATE__`, `__INITIAL_STATE__` or `__NUXT__`, written as JSON), the same state the browser's page script reads. A plain request that fails says what it got, on this screen and in Diagnostics' recent failures: the HTTP status, the page's size, and the words that gave a bot check away ("HTTP 403, a page of 380 characters, with “Access Denied” in it.").

### What pricing costs the battery

For "doesn't reading prices on my phone drain the battery?", the phone measures it with its own battery readings (expo-battery, in Expo Go): the level, whether it's plugged in, and Low Power Mode.

- **Each speed test run** (Diagnostics) reads the battery before and after. Its line says what the run took, next to its data ("about 3.4 MB · battery under 1%"), for the run and per search, and **Share results** includes it.
- **The battery test** (Diagnostics, under the speed test) runs the speed test 5, 10 or 15 times in a row, each from cold or warm, reading the battery before and after each run and around them all. Then it divides what the battery lost by the lists and searches: "About 0.2% a list (0.1% to 0.3%), and about 0.0083% a search (0.0042% to 0.013%)", after a line with the runs, searches and data. It offers only as many runs as fit in every compared store's hour (6 searches a run at each, of the 120 a store takes), so no store pauses mid-test and searches less. The hour rolls: when fewer than 5 runs fit, it names the busiest store, its searches in the last hour, and when there's room again. A 10-run test uses half of each store's hour. **Stop** ends it; the result, and the speed test's **Share results**, include what it did.
- **This session** (Store health, under How much this phone asks): each stretch of pricing with the app open (lists, price checks and speed tests), from a reading when it starts to one when it stops, added up. "Lists were priced for 3 min 10 s in all, and the battery dropped 1% meanwhile, the screen included." It says it's rough, and points to the battery test.

How honest it is (`src/pricing/batteryCost.ts`):

- **Steps.** A phone gives apps its battery in steps: whole percents, or 5% on some. The app assumes 5% until a reading falls between the 5% marks. A reading hides up to a step, so every figure comes with the range that leaves: the real drop is within a step either side of what the readings show. One run is too short to tell ("under 1% for this run"); ten runs share the same step ten ways. A drop under two steps is said to be mostly an upper limit.
- **The status bar.** The iPhone this was tested on gives apps 5% steps: 23% in its status bar reached the app as 25%. So where the phone gives 5% steps, the panel says the level is "as apps get it", and the battery test takes the status bar's whole percents, typed by the tester at the start and as soon as it ends. Only a whole number within a step of the phone's own reading is taken (else it was misread or mistyped). The result then comes from the status bar, about five times closer, with the phone's own figure beside it in a line; an end typed above the start gives no figure. The status bar is read by eye, so an end typed late counts the time after the test too.
- **The whole phone.** The screen and anything else running draw on the same battery: the figure is the whole phone while it priced, not the searches alone. Every result says so.
- **No estimate** when the phone was plugged in at either end or at any moment between (charging, full, or on power without charging, or its news of any); when it can't read its battery (a simulator, a computer's browser) or doesn't say whether it's plugged in; when the app left the screen meanwhile (iOS pauses it, and the time away draws on the battery too); when it started at 100% (just off the charger, a phone can show 100% for a while, so the drop would read low); and when the reading went up. The battery test won't start plugged in, unreadable or at 100%, and one plugged in or left mid-way ends after the run going on. Low Power Mode is noted when it was on.

**The first battery test on an iPhone** (2026-09-26, 10:30 PM; Walmart, Target, Kroger with its API, ALDI; every switch on): 10 runs from cold in 2 min 43 s, 240 searches, about 356 MB. The phone's readings went from 25% to 20% (its status bar showed 23% at the start): 5%, under 10%, so about 0.5% a list (under 1%) and 0.021% a search (under 0.042%), screen included. With 5% steps that's an upper limit, which is why the status bar can now be typed in. Walmart asked for a bot check: 60 searches there in under 3 minutes is about twice the rate that set it off before. And another test couldn't start at once: a 10-run test uses half of each store's hour, and other searches that hour took the rest.

### Lighter hidden pages

Hidden store pages don't need to draw anything: the prices arrive as data. With **Lighter hidden pages** on (Diagnostics; on by default), a content security policy is put into every hidden page as it starts, which stops it loading images, web fonts and video. Its scripts and data requests are untouched, so prices are read the same way. If a page shows a bot check, it's reloaded in full before it covers the app, so the check looks right. Product and recipe pages are read the same way. Turn it off and run the speed test to compare data and time.

### Where the time goes: the speed timeline

The speed test (Diagnostics) times every search from its turn in the queue to the screen, where each part happens (`src/onDevice/timing.ts`):

- **The pricing engine**: waiting for a turn (stores at once, searches at once per store).
- **The store's lane**: waiting for a page another search is loading, or for a free slot to send a request; a page load, in four parts: starting the hidden browser, the page's HTML (from the browser's own navigation timing, which the page reports; redirects included), waiting for the store's prices until they were taken as the results, and finishing (the load going on after that); a bot check; a request replayed from the kept page. A search's line in the shared text also says when its page spent time on redirects, and where it ended up when that's another address.
- **The search**: plain requests, the official API, and reading the products, including data read as it streams in while a page still loads.
- **The screen**: from the result to the screen drawing it.

Under each store, a waterfall draws each search as a bar on the run's time scale, in colors for each part (waiting in greys, a page load in shades of orange, replays in green). **Where the 11.2 s went** takes the store that finished last (its time is the run's) and counts each moment once, for its most direct cause: while a page loads, the searches waiting for it are held up by the load. Then the biggest costs in words: the page loads and their parts, each store's plain requests and API calls (how long, and how many at once), the median replay and the slowest, time spent waiting, reading products, results reaching the screen, and tries that failed. **Share results** adds every search's parts, in seconds, which switches were on, and how hard each store is pushed.

**What the first runs on an iPhone showed** (2026-09-26, Walmart, Target, Kroger with its API, ALDI; six searches each):

- All done in 10.9 to 11.9 s from cold, 7.8 s warm, with every switch on; 33.4 s with replays alone (Walmart's plain requests had started meeting bot checks by then).
- Walmart finished last in most runs. Its plain requests, each a whole search page of about 1.1 MB, take 2.6 to 7.6 s each, 3 at a time: two rounds.
- From cold, page loads took 4 to 10 s (Target 4.2 to 8.4 s, ALDI 6.2 to 10 s), mostly the store's own page waiting for its prices (1.8 to 8 s after its HTML), plus about 0.75 s the app waited after they came. ALDI's pages also spent about 1.5 s before asking for their address (redirects, likely), and moved 13 MB each, even without images.
- Replays took 1.0 to 2.4 s each (Target about 1.2 s, ALDI about 2 s), and ran in rounds of 3. Kroger's API took 1.2 to 5.4 s, the slowest being the first ones after the app opened (signing in and finding the store).
- Reading products took about 25 ms a search, and results reached the screen within 30 ms: the phone itself isn't what's slow.
- No data was saved by leaner requests: Target's lean answers came back with ads on top of the 12 asked for, which read as "the store ignores the size".

Fixed since, from those numbers:

- **Healthy stores get more at once, however slow.** Stores were only widened when their replays took under 1 s, which none did. Now any store whose last searches worked gets 6 at once (8 for an official API), so six searches go in one round; slow stores also get more time. Plain requests stay at 3 at once (see "Adapting to each store").
- **A page load ends as soon as its own answer is in.** When the response that arrived is the answer to the page's own search request (it carries the query) with a full page of results, the load ends at once instead of 0.7 s later, and replays can start.
- **Leaner requests with ads on top count.** A lean answer is "ignored" only when it has as many products as the page's own answer; 12 plus a few ads is the smaller size taken.
- **Kroger's API is warmed up** when the app opens: it signs in and looks up the store, so the first search only asks for products. Nothing is searched.
- **Pushback to a plain request counts.** A bot check or "too many requests" to any way of searching makes the store careful, even when its page then works.
- **The data meter counts answers thrown away** (a lean answer checked again, a replay that didn't work).
- The timeline's parts are more exact: waiting for prices lasts until the results were taken (not the first priced response), redirects count in loading the page, and each search notes redirects and where its page ended up.

**After those fixes** (the same day, one run from cold and one warm):

- Warm: Target 1.3 s (from 3.4 s), ALDI 1.8 s (from 4.3 s), Kroger 2.3 s (from 3.7 s); first price after 0.7 s. Every search at those stores went in one round, and Target's lean answers saved 1.2 MB of its 3.4 MB.
- Walmart set the total: 10.3 s warm, 14.0 s from cold (its plain requests took 2.6 to 10.6 s each), and on its 12th plain request in about 70 s it answered with a bot check. Its page took over (4.3 s), and it went Careful.
- From cold, Target and ALDI still searched in two rounds after their page loads: the tuning had forgotten them after 15 minutes. ALDI's page again took 1.5 s before loading and 2.9 s after its prices came, which the timeline couldn't yet explain.

Fixed after those:

- **A store's tuning remembers a day of searches.** Working searches in the last 24 hours make it Wider from its first search, so a cold start goes in one round; failures and pushback are still forgiven after 15 minutes.
- **A bot check rests that way of searching at once**, for 10 minutes: Walmart's next searches go straight to its page, whose requests carry the site's own cookies, instead of asking for another check.
- **The results are recognized past a bigger unrelated list.** A page load is finished by the largest list that fits the query, among the responses one by one, so a carousel of 20 deals can't hide 8 results; and a page load whose largest list doesn't fit the query takes the largest one that does.
- The timeline now says, per search: when the browser itself began loading the page (the start of loading, from its own event), when the page's own clock started if that was much later, when the site moved itself on to another page, whether the load ended on the page's own say (it went quiet, got nothing new, ran out of time) rather than its results streaming in, and in that case where the products were and whether that response ever streamed in.

Fixed before any phone runs, from the code:

- While a page loads, each response it streams in is read once. Before, every new response meant reading all the earlier ones again on the app's thread.
- The page's bot-check test no longer writes out the whole page (`innerHTML`) four times a second on pages with many elements: that was time taken from the store's own scripts, which fetch the prices.
- Prices streamed in are posted as the capture script keeps them, not at the page script's next look, up to 250 ms later.

### Leaner store requests

A store's own search request usually says how many results to send: `count=24`, `rows=30`, `page.size=24`, `"limit": 60`, GraphQL's `"first": 40`, `hitsPerPage=40` inside a search engine's parameters. The app keeps 12 of them (`PRODUCTS_KEPT`), and a basket offers 8 alternatives. So a replayed search asks for 12: `src/onDevice/pageSize.ts` finds the field in the URL, JSON bodies, GraphQL variables (in the URL or the body), form bodies and search-engine parameters, and rewrites it, leaving an image's size alone.

- **The first lean answer is checked.** With 9 or more relevant products (the pick and the basket's 8), it works, and later replays at that store ask that way; a store may add a few ads on top of the 12. As many products as the page's own answer means the store ignores the size: nothing to save, so it's asked as its page does from then on. An answer that's unusable, off the query or has fewer than 9 products is checked by asking as the page did: if that answer has more, the store keeps getting full requests, remembered across its page loads. The data of answers thrown away counts in the data meter too.
- **Data saved** is each lean answer against the full answer the store's page got for its own search, in the same measure as the data meter (what moved over the network, where the page can tell). It shows in the live feed, the scorecard, the speed test, Find a store's banner and Store health.
- Page loads are the store's own page, asking what it asks: only replays are lean. **Ask for only what the app keeps** (Diagnostics) turns it off, to compare. Kroger's official API already asks for 20.
- The scorecard's "products read" counts fewer products now: 12 a search where a store took the smaller size.

### Adapting to each store

Instead of fixed numbers (3 requests at once from a store's page, 3 searches at once per store, the store rules' timeouts), each store's recent searches set them (`src/onDevice/tuning.ts`: its last 20 searches from the last 15 minutes; the saved log counts after a restart):

- **Wider** for a store that's healthy (3 or more searches that worked in the last day, and none failed in the last 15 minutes), however long each takes: a slow store gains the most from not waiting in line. 6 searches and 6 requests at once, or 8 calls for an official API. A quick store's stuck page load is given up at 4 × its slower loads (at least 10 s, at most its rules' time), a stuck replay at 5 × its slower ones (4 to 10 s); a slow store (replays over 2.5 s, or page loads over 10 s) gets more time instead.
- **Plain requests stay at 3 at once**, whatever the tuning: each is a whole search page (Walmart's is about 1.1 MB), and the app counts it as a page load.
- **Usual** (3 at once, 6 for an API) until a store has 3 searches to go on, or when one of its last 10 failed.
- **Narrower** for one that's failing (2 of its last 10 searches failed, or one timed out; the phone's own hourly limit doesn't count): 2 and 2 (3 for an API), with more time (up to 1.5 × its rules' page timeout, and replays up to 15 s).
- **Careful** for one that pushes back, to any way of searching it (its page, a replay, a plain request): after a bot check, one search at a time, 3 s apart; after HTTP 429 ("too many requests"), one at a time, 5 s apart, doubling with each 429 in the window up to 30 s. Also near its hourly limit (80% of 120): one at a time.
- **A way a store isn't searched with**, asked for on purpose (Diagnostics' strategy picker, or the phone vs. server test's plain request at Target), doesn't count toward any of that, unless the store's site pushed back: a bot check or a 429 there makes it Careful as above. An official API is another door: with Kroger's keys, a bot check on kroger.com doesn't slow its API searches.
- Stores searched at once stay at 4, one WebView each, which bounds memory. It drops to 3, then 2, after a page's content process dies (the phone ran short of memory).
- None of it goes past the politeness limits: 120 searches an hour per store, and one page load at a time, hold as before. Wider only lets the same searches go out sooner.
- Diagnostics lists each compared store's tuning and why ("Wider: 6 searches and 6 requests at once, pages 20.0 s, requests 10.0 s. Healthy: its last 6 searches worked, its replays take 1.2 s"). **Adapt to each store** turns it off, to compare.

### One search for items that share it

"Milk" and "Whole milk" on one list: the store's search for milk usually lists its whole milk near the top, so "Whole milk" takes it from that search instead of a search of its own (`src/pricing/sharing.ts`). Only where it's safe:

- The item's words include every word of the other item's, and end on the same thing: "whole milk", "organic whole milk" and "almond milk" can take the search for "milk"; "hot dog buns" can't take "hot dogs'".
- One of the first 6 products of that search, priced, in stock and not an ad, says the item's words in order ("Great Value Whole Milk", not "Fairlife Whole Ultra-Filtered Milk") and names no other kind of grocery (not "Whole Milk Mozzarella"). Those products come first in the item's results.
- The item has no preferred size, no exact product and no usual product at any store: what it wants may not be in the other search.

Otherwise it's searched on its own, once the other search is done. Its receipt says where its price came from ("Found in Walmart's results for “Milk”, another item on this list"), and the scorecard counts it apart from searches.

### Suggestions from the stores

As you type a price check, two of your stores are asked what they suggest, the way their own sites do it: when Price check opens, the phone loads each store's home page, hidden and light (or uses a page of theirs already loaded), and once typing pauses it types what you've typed into the page's own search box and reads what the site suggests. It reads the site's suggestion list (the listbox that sites build for screen readers), or failing that the suggestion data the page fetched. Nothing is submitted, and a bot check leaves that store out rather than covering the app. The stores' suggestions are merged with your own searches, your list items and a built-in list of about 570 common grocery searches, and ranked so that kinds of what you typed come first ("whole milk" for "milk"); what a store sells beyond groceries ("milk frother") goes below. The live feed in **Watch it scrape** shows each ask.

### Better comparisons

- **Matching.** Stretch's App Store reviews complain of "avocado" matching dog leg warmers. A search result now has to name the item before it's picked (`src/pricing/matching.ts`):
  - It must name the item's last word ("buns" in "hot dog buns") and at least half of the rest, with plurals folded. A few common synonyms count too: franks are hot dogs, and rolls are buns.
  - It can't be plainly something else, such as a toy, a shirt or "artificial", or pet food, unless that's what you asked for.
  - The first result that fits is picked, still in the store's own order. When none fits, the line says so and **Choose one** lists the results.
- **Remembered choices.** A product you choose for an item at a store (from Similar items or its product page) is used for that item in every list at that store, marked "Your usual". Its product page can undo that.
- **Sale prices.** The regular price is read when a store shows it (Walmart's "was" price, Target's regular price, Instacart's full price, Kroger's promo), and shown as "Sale · was $4.49". Find a store says how many of your items are on sale at each store.
- **Fair sizes.** Pack sizes are read from product names ("1 gal", "12 × 12 fl oz", "18 ct") to show a unit price on every line. The store's own unit price wins when it gives one. A pack at least 1.8× bigger or smaller than another store's gets a note ("Bigger pack: 2× Target's"), and the lowest price per unit among your stores is marked.
- **Price changes.** Every price read is kept on the phone, per product and store. A fresh price that differs says so ("↓ $0.30 vs yesterday"), and the product page charts the history.
- **The exact same product.** By default each store's line is its best match for the words. On a product page opened from a list, **Compare this exact product** makes that product the one to find at every store: by barcode where both stores publish one, else by name (at least 80% of the name's words, and at least two) and a size within 3%. Its barcode is searched too, for stores that find products by barcode. A store without it says "The same product isn't in Walmart's results", with **Choose one**. On Find a store, **Compare the same products** does this for the whole list, with the pick's products; **Back to the best match at each store** undoes it.
- **What you want.** On an item's details: **Organic** and a **brand** are added to the search. A **size** ("1 gal", "12 ct", "16 oz") picks the first result within 5% of it. When no result meets them, the closest one is picked and the line says so ("No organic, 1 gal match here: this is the closest").
- **Same sizes** (Find a store → Rank stores by). By default stores are ranked by what the basket costs as sold. **Same sizes** counts each item in the smallest pack any of your stores sells, at each store's price per unit, so a store that only has the family pack isn't penalized for it, or rewarded for a tiny one. The total as sold shows underneath when it differs.

### What an order really costs online

**How you shop** is a choice on Find a store and in Your stores: **In store**, **Pickup** or **Delivery**. In store, nothing changes. For pickup or delivery, each store's total becomes what the order costs there (`src/pricing/onlineCost.ts`):

- **The items**, at the prices the phone read.
- **Online prices**, where a store says they're higher than in its stores: Wegmans (about 15%, its own figure), Publix, and Costco's Same-Day delivery. Where a store gives no figure, the percentage is an estimate, and the basket says so. ALDI's site already shows its online prices (its storefront's own in-store mode ran about 10.7% lower), so nothing is added there; in store, ALDI's total says its prices are online ones.
- **Its fees**: the pickup or delivery fee, waived above a threshold where the store waives it; a small-order fee; a service fee (a share of the order, with a floor and a ceiling); and a minimum order, flagged when the basket is under it. Tips, taxes, bag fees and faster time slots aren't counted; where a fee depends on the time slot, the cheapest counts.
- **Your plans**: Walmart+, Target Circle 360, Kroger Boost and Boost Essential, Instacart+ (one switch for every store Instacart runs or delivers for), FreshPass (every Albertsons chain), Prime and Amazon's grocery subscription (Whole Foods). Switch on the ones you have in Your stores; their perks count, the cheapest one per order. A basket shows what a plan you don't have would take off that order, and how much more would make its fee free.

Stores rank by that total, next to their in-store total, through the same `TripCosts` as driving, which still counts for pickup (not for delivery). A store cheaper on the items can lose to its fees, and the pick says so: "Walmart is $3.10 cheaper before fees, but $6.95 more in fees, so it costs more delivered." A store that doesn't take the order that way (Trader Joe's sells nothing online; Costco has no pickup) is listed last at its in-store total and can't be the pick. A split trip pays for two orders, each with its own fees and thresholds. The pick, each store row, the basket (with its breakdown), the split trip, the podium, the share card, the list's pick and the home screen say "delivered" or "for pickup". **Shop here** keeps the order's fees with the trip, and the savings tracker counts both sides' fees.

**Where the fees come from.** Each store's own fees page (`online.feesUrl` in its rules, plus `pickupFeesUrl` where pickup has a page of its own, as at Kroger's chains) is read on the phone, hidden, on the page lane like a product page: only while you shop online, and about once a week (a read that failed is tried again after 6 hours, or when you ask). The page's visible text is read with general rules (`src/onDevice/feePage.ts`): a figure is only taken from a sentence that says plainly what it is, and sentences about memberships, express time slots, tips, EBT, first-order offers or shipping are left alone, as is anything ambiguous. Figures it finds replace the store rules' estimates one by one; the rest stay, marked as estimates. The basket shows each fee's source, the sentence it was read from and when; Your stores lists each store's status, with **Read the fees pages again**. A bot check on a fees page isn't shown: the read fails quietly and the rules' figures stand. Reads show in the live feed, and in Store health as "other pages".

The store rules, checked on 2026-09-25 against each store's own pages (and reports, where a store publishes nothing):

| Store | Pickup | Delivery | Online prices | Plans | Page read on the phone |
| --- | --- | --- | --- | --- | --- |
| Walmart | $6.99, free from $35 | $9.95 | Same | Walmart+: free from $35 ($6.99 under) | its help article on fees |
| Target | Free | $9.99, $35 minimum | Same | Circle 360: free from $35 | its same-day delivery help |
| Kroger, and its 10 chains | $4.95, free from $35 | $9.95, varies by slot (Instacart delivers) | Same | Boost ($99): free from $35; Boost Essential ($69): next-day only. Not at Food 4 Less | its delivery and pickup FAQs |
| ALDI | From $1.99, $10 minimum | From $3.99, $10 minimum, service fee ~10% (estimate) | Its site shows online prices, ~10.7% above in store | Instacart+ | help.aldi.us (drawn by scripts) |
| Costco | None | Same-Day: no separate fee, $35 minimum | ~13.5% above the warehouse (estimate; 10% with Instacart+) | Instacart+ | costco.com/same-day |
| Safeway, and its 9 chains | Free (a fee under $30 isn't published) | $3.95–$9.95 by time slot | Same | FreshPass: free from $30 | its online shopping FAQ |
| Whole Foods | Free | $13.95; $9.95 with Prime | Same | Prime; grocery subscription: free from $35 | Amazon's help page |
| Sprouts | $3.99, free from $35 | $1.99–$7.99 by slot, service fee ~10% (estimate) | Same ("No markups") | Instacart+ | sprouts.com/pricing |
| Wegmans | Free, $10 minimum | $4.99, service fees waived (through Dec 31, 2026) | About 15% above (its figure) | Instacart+: free delivery | two wegmans.com pages |
| Publix | $1.99 | From $3.99, service fee ~10% (estimate) | Higher (~10%, estimate) | Instacart+ | none: its words are in a pop-up |
| Meijer | $4.95, free from $35 | $9.95 (by Shipt) | Same | none in the app | its services page (drawn by scripts) |
| H-E-B | Free from $35, $2.95 under | $5 (estimate) | Its site shows online prices, which "may vary" | none | none: no amounts published |
| Trader Joe's | None | None | | | |

A store added from a link has no fees in the rules: ordering online, its total is the items alone, and says so. A store's fees, or its page, are fixed in a rules file (see Store health).

### Weekly ads and digital coupons

**Weekly ads.** Each compared store's own weekly ad is read on the phone, hidden, on the store's own lane, so there's still one page load at a time at each store (`ad` in its rules; `src/onDevice/adPage.ts`):

- **Finding the items.** The page's script scrolls down a few screens, waits for the page's requests to go quiet, and sends back the data the page fetched for itself (not how it asked for it: its headers stay in the page), its visible words and its item cards. The largest list of sale items in that data counts, whatever its fields are called: a name, and a price or a deal ("2 for $5", "$1.99/lb", "Buy 1, get 1 free", "Save $2", "40% off"), with the price of one worked out ($2.50 for 2 for $5), the regular price, a member price or member-only flag, and the days it runs. A flyer's pieces are put together ("2/" "5.00" "lb"). When the general product reader finds clearly more products in the page's data (a deals page like Walmart's rollbacks), those count, at their prices; failing both, the item cards drawn on the page. The ad's days come from its items, else from the ad itself in the page's data (Target's promotion, a flyer's publication), else from its words ("Prices valid 9/24 – 9/30").
- **Matching.** An ad item is a list item when it names the item by the rules search results are matched with, and isn't something else made of it: "Oscar Mayer Classic Wieners" are hot dogs and "Tomato Ketchup" is ketchup, but "Milk Chocolate" isn't milk, "Peanut Butter" isn't butter and "Strawberry Jam" isn't strawberries (`src/pricing/ads.ts`). On a basket line, an ad item that names the line's own product comes first.
- **Where it shows.** **In this week's ad** on basket lines, with the deal and when it ends ("2 for $5 ($2.50 each), through Sep 29"); when it's the line's own product for less than the site shows, it says so ("The site shows $3.99: the ad's price may be in store only"). Stretch's pick says how many of your items are in its ad, other stores' rows say "3 in the ad", the deals screen lists your lists' items in each store's ad, and the home screen's deals card counts them.
- **Totals don't change.** The prices the phone reads from a store's site are what it charges there; the ad says what's on sale.
- **At most once a day per store.** A read that worked stands while the ad it read still runs (a week at most); another store (a new ZIP, or Change store) is another ad. A read that failed (a bot check, a timeout, nothing found) is tried again the next day, or when you tap **Try again**. Each read is a visit to the store's site and counts toward its hourly limit; past it, the read waits an hour. Ads are read on Find a store and in the basket once the stores' prices are in, and on the deals screen and Weekly ads and coupons: never at app launch, and a store being searched is left for later.
- **When each was read.** Weekly ads and coupons says it for every store: "Read 2 h ago: 212 sale items, running Sep 23–29. Next read when this ad ends, or in a week.", or why it couldn't be read, with its items on your lists.

**Digital coupons.** Most need the store's account (`coupons` in its rules; `src/onDevice/couponPage.ts`):

- **Signing in** is the same as for member prices: the store's own sign-in page, on screen, with nothing injected into it (Your stores, or Weekly ads and coupons). Then the phone reads the account's coupons page, hidden, on the store's lane: which coupons there are, what each is worth ("$1 off", "Buy 2, save $1", "25% off"), when it expires, its brand, the barcodes it's good for where the store lists them, and whether it's clipped. Only at stores you signed in to in the app; every six hours at most on its own, after signing in, and when you tap **Read them again**. Coupons stay on the phone.
- **Nothing is ever injected into a sign-in page.** If the store sends the hidden coupons page to a sign-in page (you're signed out), that page isn't loaded: every navigation is checked before it happens (`looksLikeSignIn` in `webviewScript.ts`), the read stops, and the app says to sign in again. A page that lists coupons for everyone, with "Sign in to clip" on each, reads as signed out.
- **On basket lines**: **Coupon: $1 off**, clipped or not, and "buy 2 for it" when the line has too few. A coupon fits a product when the barcodes it lists include the product's; otherwise when the product says the coupon's brand and the words of one of the things it's for, or, for a coupon without a brand, when the product is one of those things by the list items' rules. Each coupon comes off once, on the line it saves most; expired ones are left out (`src/pricing/coupons.ts`). The basket and the pick say how many of your coupons fit and what they take off.
- **Clipping happens only when you ask**: **Clip** on a basket line or in Weekly ads and coupons, or **Clip all N for your lists**. The phone loads the coupons page hidden, presses that coupon's own button once (found by its id, else its words), and checks that the page then says it's clipped. If it doesn't, the coupons are read again. **See them on kroger.com** opens the store's coupons page on screen, with nothing injected, to clip there; the coupons are read again after.
- **Totals count coupons only if you choose**: Weekly ads and coupons → **Count clipped coupons in totals**, off to start. On, each store's total takes off its clipped coupons that fit the basket and would come off at checkout, says "with coupons" (the pick, store rows, the basket and its footer, the list's pick, the home screen, the podium and the share card), and stores are ranked by it. Coupons not clipped never count. Split trips and trips' savings are counted without coupons.

The store rules, researched on 2026-09-26 from the stores' own help pages and scrapers' code dated 2026 (several sites block datacenters, so not every page could be opened from here, and none has been read on a phone yet):

| Store | Weekly ad | Digital coupons |
| --- | --- | --- |
| Walmart | None: its food rollbacks page stands in | None |
| Target | target.com/weekly-ad (from Target's own data; changes Sundays) | Target Circle deals ("Save offer") |
| Kroger, and its 10 chains | /weeklyad/shoppable, for the store set on the site | /savings/cl/coupons/ (clipped: "addedToCard") |
| Costco | None: its monthly member savings | None: its savings apply by themselves |
| Trader Joe's | None | None |
| H-E-B | heb.com/weekly-ad/deals | H-E-B digital coupons |
| Publix | savings/weekly-ad/view-all (Publix's own data; changes Wednesdays) | Publix digital coupons (Club Publix) |
| ALDI | Its Instacart storefront's weekly flyer (the path is as at Sprouts, unconfirmed) | None |
| Whole Foods | sales-flyer?store-id=… (needs its store set) | None on its website |
| Safeway, and its 9 chains | /weeklyad, through its set-store link when a store is set | Safeway for U (status C or U) |
| Meijer | shopping/weeklyad.html (a flyer service's data, in its own page) | mPerks |
| Wegmans | None: a few flyers a year | Wegmans digital coupons |
| Sprouts | Its Instacart storefront's weekly flyer | Sprouts digital coupons |

A store's ad or coupons page is fixed in a rules file (Store health), like its fees page.

### Add any store

**Your stores → Add a store** turns any grocery site that shows prices online into a compared store, with no code:

1. Search the site in your browser, for milk say, and paste the results page's link. The app finds the search in the link: the usual parameters (`q=`, `query=`, `searchTerm=`, `search_term=`…), or `/search/milk` paths. If it can't tell, you type what you searched for.
2. Name it.
3. **Try it**: the phone searches the site in a hidden WebView with the same general product reader as every other WebView store, and shows what it found.

The store is then compared like the others, replays included, at the store its site picks: the app knows no store finder for it. Added stores stay on the phone. **Remove** takes one away.

| Retailer | Reads with | One request from a datacenter (2026-09-24) |
| --- | --- | --- |
| Walmart | Plain request, then WebView (dedicated parser) | Bot check |
| Kroger | Official API, then WebView | Blocked (503) |
| Target | WebView, auto-detect | Page loads; prices arrive later |
| Costco | WebView, auto-detect | Page loads; prices arrive later |
| Trader Joe's | WebView, auto-detect | Blocked (403) |
| H-E-B | WebView, auto-detect | Bot check |
| Publix | WebView, auto-detect | Redirects common terms to a category page |
| ALDI | WebView, auto-detect | Loads (runs on Instacart's platform) |
| Whole Foods | WebView, auto-detect | Page loads; prices arrive later |
| Safeway | WebView, auto-detect | Page loads; prices arrive later |
| Meijer | WebView, auto-detect | Blocked (403) |
| Wegmans | WebView, auto-detect | Page loads; prices arrive later |
| Sprouts | WebView, auto-detect | Loads (runs on Instacart's platform) |

Being blocked from a datacenter is the problem this approach addresses; a phone may well get through. **Phone vs. server** (Store health) shows this table's last column beside a live test from the phone, and a test checks that the app's copy matches this table: change both together. Rules live in `src/onDevice/retailers.ts`, and in production they'd come from the Stretch backend. Walmart, Target, Kroger and ALDI are compared by default.

## Choosing a store

Unless a store is set, each retailer's site picks one from the phone's internet connection (its IP address). From outside the U.S. that's a default store, or a block. On 2026-09-25, from a non-U.S. connection:

| Retailer | What its site did |
| --- | --- |
| Walmart | Loaded, with no store chosen |
| ALDI | Loaded, defaulting to Geneva, IL (60174) |
| Costco | Loaded, defaulting to Seattle |
| Whole Foods | Loaded, defaulting to Austin, TX |
| Kroger | "Access Denied" |
| Target | A "Sorry for the wait" holding page |

**Your location** (at the top of **Your stores**, and in the welcome) sets each compared retailer's store near you. Nobody visits a store's website for it:

1. **Where you are.** **Use my location** reads the phone's location once, with permission, and keeps only its ZIP code (expo-location, included in Expo Go). Or type a U.S. ZIP code. The distance (5, 10, 25 or 50 miles; 10 to start) says how far a store may be.
2. **Its stores near you.** The phone asks each retailer itself:
   - Kroger's official API, when its keys are set, lists its stores within the distance.
   - Otherwise the retailer's own store finder (`storeFinder` in `retailers.ts`). It's asked directly for JSON where it answers with some (Safeway's, checked 2026-09-25). Otherwise it's loaded hidden, with the ZIP typed into its search box. The list is read from the data the page fetches, whatever the retailer calls its fields (number, name, address, distance or coordinates), or else from its store cards.
   - Distances come from the finder, or are measured from the ZIP code's center, which the phone's geocoder gives.
3. **None within the distance: not compared.** Nothing is searched there, and Your stores says "No Kroger within 10 mi", with how far its nearest store is. A finder that can't be read (a bot check, a changed page) doesn't drop a retailer: it's compared at the store its site picks, and Your stores says why, with **Try again**.
4. **The nearest store is set**, the way each retailer takes one:
   - **API**: Kroger's API gets its number.
   - **On its finder** (`auto: true`; Walmart): Walmart keeps the store in its cookies, so the phone presses that store's **Make this my store** on the site's finder, hidden.
   - **By number** (the rest): its number goes in each search request the page makes (`pricing_store_id` at Target, a `storeId` in a GraphQL body), in place of the site's pick. A list's first search loads the page as the site has it, and a request for the chosen store follows at once from inside that page.
5. **Change store** lists a retailer's stores in the app, nearest first, with addresses, numbers and distances; those beyond the distance are greyed out. A store picked there stays while it's in range. A new ZIP starts again from the nearest.

A new distance reuses the lists already read (a finder lists the nearest stores whatever the distance); **Find again** reads them again. A store that's already set isn't set again. When a store changes, saved prices for the old one are dropped, and once Walmart's store is set on its site, its plain request is skipped, since that doesn't send the site's cookies.

### Which store, exactly

**Your stores** names the store behind each retailer's prices, and the basket, Find a store and product pages say it too ("Secaucus Supercenter (store 3520), near 10001"). The app learns it two ways, both on the phone:

- **The list it was picked from**: the retailer's API or store finder gives its name, address, number and distance.
- **Every search**: the request that brought the prices usually carries the store's number (`pricing_store_id=1340` at Target, `filter.locationId` at Kroger, a `storeId` in a GraphQL body), and the search page's header names the store. Replays inherit both from the page they're sent from.

The last one is the check: when the store a search got prices for is the store that was set, Your stores says "The last search's prices were for this store". When the numbers differ, it warns that the site wouldn't take that store; the basket and product pages then name the store the prices actually came from. For a retailer with no store set, the site's own pick shows up the same way, by the number its searches used.

A ZIP can't make a site think the phone is in the U.S. Where a site blocks the connection (Kroger, Target above), a U.S. VPN on the phone gets past that. VPN addresses see more bot checks than a home connection, though. Kroger's API works from anywhere.

**Open site** on the Diagnostics screen opens a retailer's site and adds **Read products**. Search or browse on the site, then tap it to read whatever page you're on. That's the fastest way to see whether a retailer works at all.

## Run it on your iPhone

You need Node on a computer and Expo Go on the phone. Every native module the app uses is included in Expo Go.

1. `npm install`
2. `npx expo start`, then scan the QR code with the iPhone camera. Keep both devices on the same Wi-Fi, or use `npx expo start --tunnel`.

Testing from outside the U.S.: some retailers block or redirect foreign visitors, and a foreign IP isn't the U.S. home connection this approach relies on. Treat blocks from abroad as inconclusive.

## Kroger's official API (recommended)

Kroger's website blocks many connections, VPNs included, and its searches can't be replayed. With API credentials, Kroger is searched only through its official API: a whole list in a second or two, with or without a VPN.

1. Open developer.kroger.com and create an account. The site blocks non-U.S. connections, so keep the VPN on.
2. Go to **Manage → Apps → Register**.
   - Choose **Production**, for live prices. An app's environment can't be changed later, but you can register a second app.
   - **Certification** keys work too. When `api.kroger.com` refuses the keys, the app signs in to Kroger's certification environment (`api-ce.kroger.com`) instead and uses it from then on. Kroger provides that environment for testing, so Kroger's results say where they came from, and Diagnostics says so too: its prices may not be the stores' own.
   - Add the **Products** and **Locations** APIs.
   - If the form asks for a redirect URL, any placeholder such as `http://localhost` will do: this app never signs in as a user.
3. Copy the client ID and client secret. The secret is shown only once.
4. Copy `.env.example` to `.env`, fill in the two values, then restart with `npx expo start --clear` and reload the app in Expo Go. `EXPO_PUBLIC_` values are compiled into the bundle, so the app only sees new values after a reload.
   ```
   EXPO_PUBLIC_KROGER_CLIENT_ID=...
   EXPO_PUBLIC_KROGER_CLIENT_SECRET=...
   ```
5. In **Your stores**, set **Your location**. Kroger then lists its stores near you and uses the nearest, through its API. On the Diagnostics screen, the Store field also takes a Kroger locationId.

`EXPO_PUBLIC_` values are compiled into the app, so this is for your own testing only. Don't share a build made with them. In production the backend holds the credentials.

## Pin a Walmart store for plain requests

1. With Proxyman on, open walmart.com in Safari on the phone and choose the store.
2. Run any search, open that `walmart.com/search` request in Proxyman and copy its `Cookie` header.
3. Paste it into Walmart's `cookieTemplate` in `src/onDevice/retailers.ts`, replacing the store number with `{{storeId}}`.
4. Remove cookies one at a time until prices stop matching that store. What's left is the minimum set.

Only keep the store cookies. The rest of that header is your own browsing session. With a cookie template set, Walmart's WebView searches are page loads, not replays, since the cookie only rides the first request.

## Check a parser against a capture

No phone needed. Save a response body from Proxyman, then:

```
npx tsx scripts/parse-capture.ts walmart-search.html
npx tsx scripts/parse-capture.ts target-search-response.json autoDetect
```

## Tests

`npm test` runs all sixteen suites (283 tests) in Node:

- `tests/parsers.test.ts`: parsers (sale and member prices included), reading a product's own page, the plain-request strategy, Kroger's API mapping (its chains too), and the X-ray's data, paths and hidden URL parts.
- `tests/injected.test.ts`: the capture, extraction (product pages and fees pages' text included), replay, store-finder, store-reading and suggestion scripts, run inside jsdom.
- `tests/queue.test.ts`: one WebView's page loads, bot checks, store finder tasks, and sign-in pages that get nothing injected.
- `tests/replay.test.ts`: learning a request to replay, swapping the query, the relevance check.
- `tests/lanes.test.ts`: kept pages, replays in flight, the pool of lanes, product pages, fees pages, the live feed, store lists from finders, stores asked for by number, the data kept for X-rays, and searches end to end against a simulated WebView.
- `tests/pricing.test.ts`: baskets (matching, usuals, sales), Stretch's pick, split trips, driving costs and whether a store is worth the drive, the pricing engine (a store pausing at its hourly limit included) and saved lists.
- `tests/features.test.ts`: matching, sizes and unit prices, pasted lists, links for Add a store, price history, the scorecard, receipts, savings and Add again.
- `tests/shopping.test.ts`: barcodes, the exact same product, item preferences, same-sizes ranking, recipes, deals, the watchlist, price checks (the same product everywhere included), suggestions as you type, erasing everything, cheaper swaps, member prices and the price truth check.
- `tests/health.test.ts`: the search log and per-store health, the coverage check, store rules files, data sizes, the hourly limit and what the phone asked of each store, and the server cost model.
- `tests/stores.test.ts`: setting stores near a ZIP (the nearest, the distance, retailers with none nearby, a store picked from the list; by API, on the finder or by number), reading store lists, what each store is searched with, and which store it is: numbers in search requests, names on pages and store finders, and what Your stores shows.
- `tests/kroger.test.ts`: Kroger's API shares one sign-in and one store lookup across searches, is warmed up before the first one, lists its stores near a ZIP, and takes certification keys on Kroger's certification environment, saying so.
- `tests/speed.test.ts`: the speed timeline (a page load's parts, bot checks, replays, redirects, where the time went, the biggest costs, the shared text), the page-load fixes (streamed prices posted at once, the bot-check test on big pages, each streamed response read once, a load ending at its own whole answer), leaner requests (finding and rewriting page sizes in URLs, JSON, GraphQL, forms and search-engine parameters; checking the answers, ads on top included; the data saved and thrown away; stores that ignore or refuse a smaller size), the store tuning's rules, memory and pauses (pushback to plain requests included), results recognized past a bigger unrelated list, and one search shared by list items, end to end against simulated WebViews and the pricing engine.
- `tests/ads.test.ts`: weekly ads (deals as ads word them, dates, a flyer's items from the page's data, a deals page through the general product reader, item cards, and data shaped like Kroger's, Target's, Whole Foods' and Publix's), matching ad items to list items and basket lines (something else made of the item isn't it), coupons (their worth and quantities, Kroger's and Albertsons' data, tiles, signed out), matching coupons to basket lines (brands, choices, barcodes), what coupons take off and the totals (only clipped ones, only when counted, and the pick that changes), reading at most once a day and saying when, the saved reads, the list-page and clip scripts in jsdom, the sign-in guard, ads, coupons and clips read end to end on a simulated store lane and counted in its hour, and the store rules.
- `tests/online.test.ts`: what an order costs online (fees and when they're waived, minimums, small-order and service fees, fees by time slot, online prices above in-store ones, plans and what a plan would save), ranking stores by the way you shop, split trips and trip savings with each order's fees, reading a store's fees page (Walmart's, Target's and Costco's wording among others), the saved reads, the words, the store rules and the settings.
- `tests/phoneVsServer.test.ts`: the phone vs. server test: the summary and its words (stores tried both ways, prices and blocks each way, stores left out for their hour), what each outcome means (bot checks and refusals, an empty page against a page without prices, too slow) and its words, a search's result (its first product with a price that isn't an ad, the time of the try itself; a failure's HTTP status and page size), the datacenter column against this README's table, which stores are tested, the plain request's headers, running it (each store's page then its plain request, four stores at once, one run at a time, a store without room in its hour left out), the kept result, the shared text, a failed plain request's words, the product data a plain request's page carries (JSON script blocks and page state), and end to end through the app's own search with a simulated store page: counted in the hour, kept out of Store health's rates, bot checks reported, and the store tuning hearing only of pushback from a way a store isn't searched with.
- `tests/battery.test.ts`: what pricing costs the battery: shares of the battery and ranges in words, the gauge's step, the drop per list and per search with the range the steps leave (a drop too small to see, one run, a 5% gauge, Low Power Mode, searches that didn't run), no estimate when plugged in (at either end or between), unreadable, unsure, after leaving the app, from 100% or rising, the runs that fit in every store's hour and when there's room again, the status bar's whole percents typed at a test's start and end (what's taken, the figure from them beside the phone's own), this session's stretches of pricing, and the battery meter end to end on the pricing engine with a simulated battery: a battery test run again and again, plugged in or leaving the app mid-test, stopping, one test at a time, the status bar typed with it, and a list erased mid-run.

## Verify on a device

Price "Sunday BBQ" at the default four stores three times, then once more with replays off (Diagnostics).

- [ ] Every store fills in, and the basket's products match what the retailer's own app shows for the same store.
- [ ] Diagnostics shows each lane's replay source (an API request or the page's own data), and most searches after the first are replays.
- [ ] Record the time for the whole list with replays on and off, and any bot checks.
- [ ] A bot check covers the app, other stores keep going, and Skip stops only that store.
- [ ] Use my location: iOS asks once, and the ZIP it finds is right. Deny it, and typing a ZIP still works.
- [ ] Set a ZIP: each retailer lists its stores near you (Store health shows each finder's result). Walmart's is set on its finder, the others by number, and prices change to those stores'.
- [ ] Set the distance to 5 miles where a retailer has no store that close: it's no longer compared, and Your stores says so.
- [ ] Change store: pick another store from a retailer's list; the next search's prices are for it (the check line on Your stores).
- [ ] Note which retailers' finders list stores from the phone, and fix the others' `storeFinder` in a rules file.
- [ ] Walmart: compare Plain request and WebView over 20 searches.
- [ ] Kroger: the official API with a ZIP code. The whole list should take a second or two.
- [ ] Open a list and wait: it prices in the background, and the banner shows when it's done. Then Find a store is instant.
- [ ] The next day, older prices show at once, labeled with their age, and update in place.
- [ ] Switch to another app mid-pricing and come back: it carries on, without "timeout" failures.
- [ ] On a failure, the basket and Diagnostics (Recent failures) say what the page showed.
- [ ] Watch it scrape: the store pages show up small and live while a list prices, and the feed keeps up. Check it doesn't slow pricing down.
- [ ] Open a product: photos, description and rating arrive from its own page, and the price check agrees. Try it at each store.
- [ ] Matching: look through each basket for products that aren't the item, and for items marked "didn't name it" that should have matched.
- [ ] Sale badges and unit prices match what each store's own app shows.
- [ ] Add a store from a search link (a grocery site not in the list) and price a list there.
- [ ] Run the speed test cold, then warm, and share both. In each store's waterfall, note the longest part: the page's HTML, waiting for its prices, finishing the load, replays, or waiting for a turn.
- [ ] Speed test with **Ask for only what the app keeps** off, then on: compare the data (Store health shows what was saved) and check each store's basket has the same products. Note which stores' lanes say "asks for 12 results".
- [ ] Speed test with **Adapt to each store** off, then on after a couple of runs: compare the times. Note any store that goes Careful, and why.
- [ ] Run the speed test from cold twice more, and warm, and share them: each store's replays should go in one round once it's Wider, Target's lanes should say "asks for 12 results", and the first price should come sooner in the first run after the app opens (Kroger warmed up). Look at ALDI's lines for "redirects took" and where its page ended up.
- [ ] A list with "Milk", "Whole milk" and "Almond milk": where a store's milk search shows them near the top, their receipts say they came with milk's search, and the products really are whole milk and almond milk.
- [ ] Shop at Stretch's pick, tap Done shopping, and check the savings on the home screen.
- [ ] Store health → Check all 14 stores, from home Wi-Fi and from mobile data. Note which work, and share the result.
- [ ] Data: price a list, then compare Store health's data for the day with Settings → Cellular for Expo Go. Run the speed test with Lighter hidden pages on and off.
- [ ] Lighter hidden pages: every store still reads prices with it on, and a bot check still looks right.
- [ ] Price check a few items, and scan a few barcodes from the pantry (a national brand and a store brand). Compare each store's answer with its own app.
- [ ] Add from a recipe (an Allrecipes or Food Network link), and check the ingredient names.
- [ ] Price check: type "mil", then "milk". Suggestions from two of your stores show up (with "From Walmart" and so on) within a second or so of pausing. Tap a suggested product: each store shows the same product, or its closest equivalent.
- [ ] Set organic, a brand and a size on items, then check each basket's picks.
- [ ] Compare the same products on Find a store: stores without them say so.
- [ ] Watch a product's price; Check watched prices now reads it again.
- [ ] Store rules: share the current rules, put them in a Gist with one store's search link changed, paste the raw link, and check that store searches with the new link.
- [ ] VoiceOver: go through a list, Find a store, a basket and a product page with the screen reader, and with the largest text size.
- [ ] Your stores: after setting a ZIP, each store shows its name, address, number and distance. After pricing a list, each store says whether the last search's prices were from it. Compare the names and numbers with each retailer's own app.
- [ ] Diagnostics → Start over: the welcome shows, and the lists, stores and prices are back to a first launch.
- [ ] Welcome → Watch it work: milk's price lands at each store within seconds, with the time each took, then the cheapest.
- [ ] Presenter mode on Sunday BBQ: the store pages show big and readable on stage, the caption and race keep up, and the ending's price check agrees with the product page. Time the whole run.
- [ ] Find a store: the race, then the podium. Share your savings: the picture looks right in Messages.
- [ ] Count the drive at 70¢ a mile: the pick and the verdict make sense against each store's distance.
- [ ] Cheaper swaps at Walmart and Target: each swap is the same kind and size, and the basket drops by what it says.
- [ ] Price truth check with 5 per store: note the match rate per store, and open the X-ray of any mismatch.
- [ ] X-ray a price from each store: the data and the highlighted line match the price.
- [ ] Kroger card on, and Sign in on kroger.com with your own account: card prices count in the totals, and searches after signing in still work. Try a store in the Albertsons family too.
- [ ] Switch on a regional chain near you (Vons, Ralphs, Jewel-Osco…): its stores are listed and a list prices there.
- [ ] How you shop → Delivery, then Pickup: each compared store's fees page is read (Your stores → Where the fees come from: "read from walmart.com just now"; the live feed shows "fees page"). Note which pages read and which gave figures, and fix `online.feesUrl` or the figures in a rules file.
- [ ] For the same basket, compare each store's delivered and pickup totals with its own app's checkout: the fee, the service fee, the minimum. Note tips, taxes and bag fees apart.
- [ ] Switch on a plan you have (Walmart+, Boost, Instacart+…): the basket's fees change as the store's app shows them.
- [ ] ALDI: compare a few prices in its app's in-store mode with its delivery mode, to check the ~10.7%. Wegmans or Costco: the markup matches what the store's app charges above in-store prices.
- [ ] A split trip, delivered: two orders' fees. Shop here, then Done shopping: the trip's total includes the fees.
- [ ] VoiceOver: How you shop reads as a choice of three, and each line of a basket's breakdown reads with where it came from.
- [ ] Store health → How much this phone asks, after a busy session: busiest hours stay under 120.
- [ ] Battery test, unplugged, below 100%, screen on: Diagnostics → Battery test → 10 runs from cold, typing the status bar's percentage at the start and as soon as it ends (Settings → Battery → Battery Percentage shows it). An hour later, when there's room again, 10 runs warm the same way. Share both, and note the screen brightness, Low Power Mode and any bot check. Note whether "How precise" says whole percents or steps of 5%: that's how this iPhone gives apps its battery (5% on the first iPhone tried).
- [ ] Battery test, plugged in: it won't start. Start one unplugged and plug in mid-way: it ends after that run, with no estimate. Leave the app mid-way: the same.
- [ ] After pricing a few lists unplugged, Store health → How much this phone asks: the battery line's drop and time agree with the phone's own battery percentage over that time.
- [ ] Weekly ads and coupons (the card on deals, or Your stores): after pricing a list, each compared store's ad is read once its prices are in (the live feed shows "weekly ad · N sale items"). Try each store's ad: compare its items, prices and dates with the store's own app for your store, and note which gave no items, and what Weekly ads and coupons says about it.
- [ ] Kroger with its API keys: its ad is for the store set on kroger.com, which the API doesn't set. Check it's your store's; if it asks for a store, sign in on kroger.com and read it again the next day.
- [ ] Walmart's rollbacks and Costco's monthly savings: the items match those pages on their sites.
- [ ] Basket: items in this week's ad say "In this week's ad" with the deal and its end; the ad's product priced lower than the site's says so.
- [ ] Open the deals screen again later the same day: no store's ad is read again (its line says when it was read); a failed one only on Try again.
- [ ] Sign in on kroger.com (and at Safeway, Target, Publix, Meijer, H-E-B, Wegmans or Sprouts, where you have an account): after Done, the coupons are read, and Weekly ads and coupons says how many there are and how many are clipped. Compare with the store's app.
- [ ] Signed out on a store's site (or once its session ends): the next read says signed out, and no sign-in page loads hidden (Watch it scrape shows none).
- [ ] Clip one coupon from a basket line: it says "clipped here", and the store's own app shows it clipped. Try Clip all, and See them on kroger.com.
- [ ] Count clipped coupons in totals: on, the basket, Find a store and the list's pick say "with coupons" and take off what they say; off, totals go back to the stores' prices.
- [ ] Phone vs. server (Store health → Open the test), on home Wi-Fi with no VPN: Run the test for your stores, then All 13 stores. Note each store's two results next to the datacenter's, and share both. Run it again on mobile data, and once over a VPN.
- [ ] Presenter mode on Sunday BBQ, then Could a server do this?: the test starts at once for your stores. Time it.
- [ ] After a test: How much this phone asks has 2 more searches at each store, the last 7 days' rates are unchanged, and a store that showed a bot check is Careful in Diagnostics for 15 minutes. Diagnostics' recent failures show a blocked plain request's HTTP status, size and the words that gave it away.
- [ ] With Proxyman: the test's plain request carries the WebView's user agent and no Cookie header.

## Before production

- Set store cookies in the WebKit cookie store with `@react-native-cookies/cookies` (needs a development build, not Expo Go). Header cookies only ride the first request.
- Serve retailer rules from the Stretch backend over HTTPS with authentication and reviewed changes. A `pageScript` runs inside retailer pages, so treat it as code.
- Call Kroger's API from the backend, never with credentials in the app.
- Replace `autoDetect` with a dedicated parser for each retailer that works, and keep auto-detect only as a fallback.
- Point telemetry at the backend and alert when a retailer's success rate drops. Events now say whether a search was a page load or a replay.
- The store tuning's thresholds (what counts as fast, slow or touchy, and how far each goes) are guesses: set them from the fleet's measurements once there are some, and serve them with the store rules.
- The request headers a page sends (which can include tokens) are kept in memory only to replay that retailer's search, and are never logged or sent. Keep it that way.
- Search only for the user's own lists, and only while the app is open. No crawling on users' phones for anyone else. Product pages are read only when the user opens one.
- Stores added from a link are the user's own and stay on the phone. Before letting them spread, review which sites they point at.
- A rules file from a link can carry page scripts that run inside store pages. That's fine for the team testing fixes; in production, serve signed rules from the backend and drop the free-form link.
- The search log could become the backend's health telemetry (store, outcome, time, data, rules version; no search words or products), once there's an endpoint and consent.
- Signing in to a store happens on its own page in the app's browser, with nothing injected into it. Keep it that way, and have it reviewed for security before shipping. The same goes for the hidden reads of an account's coupons, which stop before any sign-in page loads.
- Clipping presses a button on the user's account at the store: keep it to what the user taps, and check each store's terms on clipping from an app.
- The hourly limit (120 searches at one store, per phone) is a guess at human scale: tune it once retailers' real limits are known.
- Get a legal read on retailer terms before launch.

## Known gaps

- Target and Kroger's websites have only been tried from a non-U.S. connection, and Kroger's also over a VPN, where it loaded but showed no products. The failure details on Diagnostics will say what its page shows next time.
- Whether replays work for a retailer depends on its site. One that signs its requests, or keeps the query outside the URL and body, falls back to page loads (slower, still correct). Diagnostics shows which.
- `autoDetect` can pick the wrong list, such as recommendations instead of results. Check the source it reports.
- Matching is word-based. It can pass over a real match named differently ("Pepsi" for "cola", "Hawaiian rolls" for "dinner rolls"): the line then says so, and choosing one fixes it for good. It can also accept a close cousin ("skim milk" is still milk). Synonyms are a short list in `matching.ts`.
- Sizes come from product names. "5.3 oz, 4 ct" yogurt reads as one cup, so its worked-out unit price is 4× too high; stores that show their own unit price don't have this problem.
- The live view's page tiles, and reading product pages, have only been tried in a browser preview, where WebViews don't run. A product page reads best from sites that publish schema.org data, which most large grocers do.
- There's no map.
- The 19 regional chains are rules only, untried. The Albertsons family's store finders answered with JSON from here (2026-09-25); the Kroger family's website search pages, finders and chain codes in Kroger's API couldn't be checked from here.
- Member prices are read with general rules (fields named for clubs, cards, members, Prime or Circle), besides Kroger's API, where a promo price below the regular one is the price with the card. A site that shows everyone its club price, or keeps member prices in coupons, won't show a difference. Sign-in has only been simulated; whether each site's searches then carry the account's prices is untested.
- The price truth check and presenter mode's check compare with the product page's price, which a site may give for another store than the search's (sites often pick their own store for product pages).
- The share card's picture (react-native-view-shot) and presenter mode's large store pages (WebViews drawn cropped) have only been tried in a browser preview, where neither works: on a phone they're untested.
- The server cost model's defaults are assumptions, not quotes: proxies at $4 a GB, 30% of server searches meeting a bot check, $2 per 1,000 solved, 10¢ a browser-hour. Only the data and time per search are measured, on the phone.
- Store finders have only been read on simulated pages, plus Safeway's JSON from a desktop. Whether each retailer's finder lists stores from a phone, and whether its searches take a store number, is untested. Target's and Kroger's finders couldn't be checked from here, since both block non-U.S. and datacenter connections.
- ALDI and Sprouts run on Instacart, whose store ids aren't the chains' own numbers, so a store asked for by number may not take there. The check line on Your stores says so when it doesn't.
- A finder that gives neither distances nor coordinates can't drop a retailer for distance, and the ZIP code's center comes from the phone's geocoder, so measured distances are approximate.
- The response-capture script wraps the page's `fetch` and `XMLHttpRequest`, and some bot protection may notice that.
- Walmart's field paths follow its page data as publicly documented; confirm them with a capture.
- Data use is an estimate: files from other sites often don't report their size, so they're counted at a typical size for their type.
- Lighter hidden pages have only been tried in a browser preview, not in WebKit on a phone. A site that loads its prices with a script it builds from an image or a font would break; none of the compared stores is known to.
- Barcodes: only some stores' search results include them (Walmart's page data, Kroger's API, and sites whose data has a `gtin` or `upc`), and only some sites find products by barcode. Elsewhere, the scanned product is found by name and size, which can miss a product the store names differently. The camera needs a real phone.
- Stores' suggestions are read with general rules (a search box, then a suggestion list or suggestion data), and so far only on simulated pages. A site whose search box or suggestions look different gives none, and suggestions still come from the phone's own sources. Opening Price check loads two stores' home pages, hidden, which costs about as much data as a search.
- Recipes only work from pages that publish schema.org recipe data. Ingredient names are read with simple rules, so an odd line ("1 (14 oz) can coconut milk, well shaken") may need editing.
- The watchlist only learns about prices while the app is open; there are no notifications.
- Store names are read from pages with general rules ("Your store:", "Shopping at", a store finder's listing), not per retailer, and only tried on simulated pages so far. A site that names its store some other way shows its number only, from its searches. Sites whose searches don't carry a store number (Walmart's page data, for one) can't be checked that way.
- **Start over** can't clear what the stores' own sites remember: iOS doesn't let an Expo Go app delete other sites' cookies. Walmart's store, set on its finder, stays set there until another is set.
- Android is untested.
- Kroger's certification environment is untried: whether its products and prices match the stores' own is unknown, which is why its results say where they came from.
- Fees pages are read with general rules, tried on the wording of Walmart's, Target's, Kroger's and Costco's pages as quoted on 2026-09-25, and on Sprouts' and Wegmans' live pages, but never on a phone. A page worded differently gives no figures (the rules' stand), and one whose wording changes could give a wrong one, which is why each figure read shows its sentence. ALDI's and Meijer's pages are drawn by scripts, so only the phone can read them; H-E-B and Publix have no page to read.
- Checkout can differ from these totals: fees vary by store, time slot, order size and region (California and New York City surcharges, long-distance, heavy-order and bag fees, deposits), and tips and taxes aren't counted. Instacart doesn't publish its service fee: 10% (5% with Instacart+) is an estimate.
- Online-price markups: only Wegmans gives a figure (about 15%). Costco's 13.5% (10% with Instacart+) is a third party's, ALDI's 10.7% is one area's storefront, and Publix's 10% is a guess. The phone reads online prices at ALDI and H-E-B, so their in-store totals are higher than in store: that's said beside them, not corrected.
- Some fees aren't published: Safeway's under $30 (pickup and delivery) and H-E-B's delivery fee; Walmart's and Whole Foods' under $35 are partly unclear. Those totals may be a little low.
- Plans: one per order counts (the cheapest), and a plan's own price isn't in an order's total (the basket says what a plan would save on that order). Boost Essential counts as free delivery, though it only covers next-day slots.
- Costco's searches read costco.com, whose prices for some items differ from the warehouse's; the Same-Day markup is added on top of them.
- The speed timeline's page parts come from the page's own navigation timing, which WebKit reports on the phone's clock; a page that doesn't report it shows its load as one part. "To the screen" is measured on the screen that showed the run: Diagnostics for the speed test, Find a store for a list.
- Leaner requests: the data saved is an estimate (each lean answer against the page's own full answer to its first search). Only replays are lean. A store whose API takes only some sizes goes back to full answers after one try.
- The tuning's first phone runs showed no pushback at 3 at once; whether 6 at once stays that way is untested. Sharing uses word rules, not AI: a product that says the item's words but is something else ("Almond Milk Creamer") could still pass if it's near the top of the other search.
- Weekly ads and coupons have only been read from simulated pages, and from test data shaped like the stores' as others' scrapers describe it: no store's page has been read on a phone. Stores change their pages; one that gives nothing is fixed in its rules (Store health).
- Kroger's weekly ad is for the store set on kroger.com, which the app sets through Kroger's API, not on the site: signed out there, the ad may ask for a store and give no items. Target's, Publix's, H-E-B's and Meijer's ads are also for the store their sites have. Whole Foods' needs its store id; the Safeway family's set-store link sets the store on the site to the one chosen in the app.
- An ad drawn inside a frame from another site can't be read: the phone reads what the page itself fetches, and its own cards. Deals with more words than a price ("Save up to $2", "Mix & match") show no price, and ads' deals never change totals.
- Coupons: a store's page may list only the coupons still to clip (Kroger's asks for "unclipped" and "active" ones), so clipped ones can be missing, and a page that shows more with a "Load more" button gives its first ones only. Clipping presses the page's own button, found by general rules: a button that's an icon without words may not be found, and See them on kroger.com is the fallback.
- A coupon fits by its barcodes where both have them, else by words: a brand's coupon for "Tide PODS or Liquid" also fits other Tide detergents. Household limits, and whether a store takes a coupon on a sale price, aren't known: each coupon counts once, on one line. Counted coupons don't change online fees' thresholds, split trips or trips' savings.
- Walmart's plain requests set the total in most runs (two rounds of 3, each request 2.6 to 10.6 s), and speed tests run one after another make Walmart ask for a bot check (after about 12 plain requests in a minute, on 2026-09-26). It then goes Careful for 15 minutes (one search at a time, 3 s apart), so speed tests in that window show Walmart much slower: leave 15 minutes between them. Plain requests stay at 3 at once because each is a whole search page, which the app counts as a page load, while "one page load at a time" is the politeness rule; they already run 3 at once, which that rule doesn't strictly allow, and one at a time would roughly triple Walmart's time. Which to keep is a policy call. Reading Walmart through its page's own data instead of whole search pages is untried.
- One battery test has run on a phone so far (10 runs from cold, before the status bar could be typed in), and the status bar's typing has only met a simulated battery. The figures are the phone's own gauge, in steps (5% for apps on the iPhone tried, whole percents in its status bar), which is an estimate itself, and they include the screen and everything else running: screen brightness isn't read, and there's no baseline of the phone idle with its screen on to take away. A test can't run long enough to narrow its range much: the hourly limit (120 searches at a store, 6 a run) caps it at 20 runs in an hour, so without the status bar a test on a 5%-step phone is mostly an upper limit. A bot check that waits for you counts its time toward the drop.
- Phone vs. server has only run in a browser preview, with simulated stores. On a phone its results will vary with the connection (home Wi-Fi, mobile data, a VPN, a non-U.S. address, where stores may block both ways), the time and the store: each run is one search each way at each store, for milk only. The datacenter column is one request per store on one day (2026-09-24), not a live test, and may differ today; regional chains weren't tried there. The plain request is a server's best case on its address, and a fair one on what it sends (the phone browser's user agent and Accept headers, no cookies), but a scraper written for one store could read more from a page that came through than the app's general reader, or call the store's own product requests: "No prices in the page" isn't a block, which is why blocks are counted apart. Whether iOS sends Expo Go's plain request with the WebView's user agent, as asked, is to check with Proxyman.
- The battery test needs the screen on: in Expo Go with the dev server, Expo keeps it awake, but a release build would have to keep it awake itself, or iOS locks the phone and the test ends with no estimate. The session line in Store health adds up stretches of pricing, each read in whole steps, so it's rough, as it says. In a browser, expo-battery's news (plugged in, the level) never comes, only readings. Android's level news only comes at its low-battery marks, and Android is untested.

## Code map

- `src/app/`: screens (Expo Router).
  - `welcome` (first run), `index` (lists, savings, price check and watchlist entries).
  - `list/[id]/index` (list and shop mode), `list/[id]/item/[itemId]` (item details), `list/[id]/recipe`, `list/[id]/compare` (Find a store), `list/[id]/store/[retailerId]` (basket), `list/[id]/product` (product page), `list/[id]/split`.
  - `search` (price check), `scan` (barcode camera), `product` (a price check's product page), `watchlist`.
  - `present` (presenter mode), `xray` (a price's X-ray), `cost` (what servers would cost), `phone-vs-server` (the phone vs. server test), `list/[id]/share` (the savings card), `list/[id]/truth` (the price truth check).
  - `stores`, `choose-store/[retailerId]` (a retailer's stores near you), `add-store`, `health` (Store health and rules), `privacy`, `diagnostics`, `ads` (Weekly ads and coupons).
- `src/onDevice/`: the on-device search engine.
  - `retailers.ts`: rules.
  - `retailerSearch.ts`: strategies, replays, fallbacks and product pages.
  - `webviewPool.ts` and `webviewQueue.ts`: WebView lanes, plus the live view's state and feed (`scrapeFeed.ts`).
  - `WebViewFetcher.tsx`: draws the lanes: hidden, as a sheet, or as live view tiles.
  - `webviewScript.ts`: the scripts injected into pages.
  - `replay.ts`: learning and swapping requests.
  - `parsers.ts`, `productPage.ts`, `fetchStrategy.ts`, `krogerApi.ts`: parsing and the other strategies.
  - `feePage.ts`: reading a store's own fees page, from its text, for what pickup and delivery cost there.
  - `adPage.ts` (reading a store's weekly ad: deals, prices of one, days, from the page's data, the general product reader or its cards) and `couponPage.ts` (reading an account's coupons: worth, quantity, expiry, brand, barcodes, clipped).
  - `barcode.ts` (normalizing and comparing barcodes), `attemptLog.ts` (the search log and per-store health), `coverage.ts` (Which stores work from here), `phoneVsServer.ts` (the phone vs. server test: the datacenter's record, what each way got, the summary and its words, and the test itself), `storeIdentity.ts` (which store: from requests, pages and store finders, and asking for one by number), `storeLocator.ts` (stores near a ZIP, from a finder's data), `evidence.ts` (the X-ray's data, in memory), `politeness.ts` (the hourly limit, and what the phone asked of each store).
  - `timing.ts` (when each part of a search happened, for the speed timeline), `pageSize.ts` (leaner requests: page sizes found, rewritten and checked), `tuning.ts` (adapting to each store).
- `src/pricing/`:
  - `pricingEngine.ts` (runs a list across stores), `basket.ts` (picks, totals, sales, split trips), `priceCache.ts`.
  - `matching.ts`, `sizes.ts`, `priceHistory.ts`, `receipt.ts`, `scorecard.ts` (the scorecard, and the speed profile: timelines and where the time went), `trips.ts` (Shop here and savings).
  - `sharing.ts` (one search for list items that share it).
  - `exact.ts` (the same product at another store), `priceCheck.ts` (each store's answer to a price check), `suggest.ts` (suggestions as you type), `deals.ts`.
  - `swaps.ts` (cheaper swaps), `member.ts` (member prices), `truth.ts` (the price truth check), `costModel.ts` (what servers would cost).
  - `batteryCost.ts` (what pricing costs the battery: readings before and after, the drop per list and per search with the range the gauge's steps leave, when there's no estimate, this session's pricing, and the meter that watches the engine and runs the battery test).
  - `onlineCost.ts` (what a basket costs ordered online: fees, online prices, plans, and what each store adds for ranking, in words too), `feeBook.ts` (each store's fees page as last read, saved on the phone).
  - `ads.ts` (ad items for list items and basket lines, when an ad is read, in words), `coupons.ts` (coupons on basket lines, what they take off, totals when counted, when coupons are read, in words), `readBook.ts` (each store's last read of its ad and coupons, saved on the phone).
- `src/state/`: lists, settings, usuals and trips (saved with AsyncStorage), the phone's ZIP code (`deviceLocation.ts`), its battery through expo-battery (`battery.ts`), store setup near a ZIP (`storeSetup.ts`), what each store is searched with (`storeChoices.ts`), which store each retailer is set to, in words (`storeInfo.ts`), links for Add a store (`customStores.ts`), and the provider that wires everything together.
- `src/lists/`: list types (with item preferences and the exact product), reading pasted lists (`parse.ts`) and recipes (`recipe.ts`), and common grocery searches (`groceryTerms.ts`).
- `src/ui/`: theme, icons, shared controls and chips, the product page (`ProductDetail.tsx`) used by lists and price checks, Price check's suggestions (`Suggestions.tsx`, `useStoreSuggestions.ts`), the race and podium (`Race.tsx`), How you shop with a basket's online breakdown (`ShopMode.tsx`), the speed test's waterfalls (`Waterfall.tsx`, with `useScreenTimes.ts` noting when results reach the screen), and a basket line's ad and coupon notes (`AdsCoupons.tsx`).
