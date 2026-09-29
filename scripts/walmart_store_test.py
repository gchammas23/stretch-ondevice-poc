"""
Walmart store-switch stress test.

For each store: open the store page, click "Make this my store" (Walmart's real flow),
then pull a small basket of product pages with in-page fetch() and read the store-level
price from __NEXT_DATA__. Records blocks (PerimeterX "Robot or human?"), timing and bytes.

Modes:
  --mode local        Scrapling's local stealth browser (patchright), from this machine's IP
  --mode browser-use  Browser Use cloud browser over CDP (needs BROWSER_USE_API_KEY)

Stops on: --max-stores, --max-minutes, --max-mb, or --stop-after-blocks consecutive blocks.
"""
import argparse, json, os, re, sys, time, urllib.request
from collections import deque

BASKET = {"10450114": "GV whole milk 1 gal", "44390948": "Banana, each"}
SEED_STORES = ["5260", "100", "1000", "3150"]  # Rogers AR, Bentonville AR, Brownsville TX, Council Bluffs IA
API = "https://api.browser-use.com/api/v4/browsers"
NEXT_RE = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)


def is_blocked(url: str, title: str) -> bool:
    return "/blocked" in (url or "") or "robot or human" in (title or "").lower()


def px_challenge(page) -> bool:
    """PerimeterX shows up either as a /blocked redirect or as a 'Press & Hold' modal over the real page."""
    if is_blocked(page.url, page.title()):
        return True
    try:
        return page.locator("[role=dialog]", has_text=re.compile(r"robot or human", re.I)).count() > 0
    except Exception:
        return False


def wait_out_challenge(page, seconds: int) -> bool:
    """Give the browser a chance to clear a challenge on its own (managed browsers claim to)."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        page.wait_for_timeout(2000)
        if not px_challenge(page):
            return True
    return False


def fetch_product(page, item_id: str) -> dict:
    res = page.evaluate(
        """async (u) => { const r = await fetch(u, {credentials: 'include'});
                          return {status: r.status, url: r.url, text: await r.text()}; }""",
        f"https://www.walmart.com/ip/{item_id}",
    )
    text = res["text"]
    if "/blocked" in res["url"] or "Robot or human" in text[:3000]:
        return {"item": item_id, "blocked": True}
    m = NEXT_RE.search(text)
    if not m:
        return {"item": item_id, "blocked": False, "error": "no __NEXT_DATA__"}
    raw = m.group(1)
    data = json.loads(raw)
    prod = data["props"]["pageProps"]["initialData"]["data"].get("product") or {}
    price = ((prod.get("priceInfo") or {}).get("currentPrice") or {}).get("price")
    stores = list(dict.fromkeys(re.findall(r'"storeId":"(\d+)"', raw)))
    return {"item": item_id, "blocked": False, "price": price, "store_ids_in_page": stores[:3]}


def fetch_product_nav(page, item_id: str, challenge_wait: int) -> dict:
    page.goto(f"https://www.walmart.com/ip/{item_id}", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2500)
    if px_challenge(page) and not wait_out_challenge(page, challenge_wait):
        return {"item": item_id, "blocked": True}
    data, raw = None, ""
    for _ in range(3):  # __NEXT_DATA__ can still be streaming at domcontentloaded; retry briefly
        raw = page.evaluate("document.getElementById('__NEXT_DATA__')?.textContent || ''")
        try:
            data = json.loads(raw) if raw else None
            break
        except json.JSONDecodeError:
            page.wait_for_timeout(1500)
    if not data:
        return {"item": item_id, "blocked": False, "error": "no or partial __NEXT_DATA__"}
    prod = data["props"]["pageProps"]["initialData"]["data"].get("product") or {}
    price = ((prod.get("priceInfo") or {}).get("currentPrice") or {}).get("price")
    stores = list(dict.fromkeys(re.findall(r'"storeId":"(\d+)"', raw)))
    return {"item": item_id, "blocked": False, "price": price, "store_ids_in_page": stores[:3]}


def set_store(page, sid: str, challenge_wait: int) -> dict:
    page.goto(f"https://www.walmart.com/store/{sid}", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(3000)
    challenged = px_challenge(page)
    if challenged and not wait_out_challenge(page, challenge_wait):
        return {"ok": False, "why": "blocked_on_store_page", "challenge_seen": True}
    title = page.title()
    btn = page.locator("button", has_text=re.compile(r"make this my store", re.I))
    try:
        btn.first.wait_for(state="visible", timeout=15000)
    except Exception:
        pass
    if btn.count() == 0:
        current = {c["name"]: c["value"] for c in page.context.cookies("https://www.walmart.com")}.get("assortmentStoreId")
        if current == sid:  # already this session's store (e.g. the one Walmart picked from the IP)
            return {"ok": True, "why": None, "title": title[:80], "assortment_cookie": current, "challenge_seen": challenged, "note": "already_selected"}
        return {"ok": False, "why": "no_button", "title": title[:80]}
    btn.first.click(timeout=15000)
    page.wait_for_timeout(2500)
    if px_challenge(page) and not wait_out_challenge(page, challenge_wait):
        return {"ok": False, "why": "blocked_after_click", "challenge_seen": True}
    cookie = {c["name"]: c["value"] for c in page.context.cookies("https://www.walmart.com")}
    return {"ok": cookie.get("assortmentStoreId") == sid, "why": None if cookie.get("assortmentStoreId") == sid else "cookie_not_set",
            "title": title[:80], "assortment_cookie": cookie.get("assortmentStoreId"), "challenge_seen": challenged}


def fetch_search(page, term, challenge_wait):
    """One search page returns a whole grid of items with store-level prices; this is the cost unit for full catalogs."""
    page.goto(f"https://www.walmart.com/search?q={term}", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2500)
    if px_challenge(page) and not wait_out_challenge(page, challenge_wait):
        return {"search": term, "blocked": True}
    raw = page.evaluate("document.getElementById('__NEXT_DATA__')?.textContent || ''")
    if not raw:
        return {"search": term, "blocked": False, "error": "no __NEXT_DATA__"}
    stacks = (json.loads(raw)["props"]["pageProps"]["initialData"].get("searchResult") or {}).get("itemStacks") or []
    items = [i for s in stacks for i in (s.get("items") or []) if i.get("__typename") == "Product" or i.get("usItemId")]
    priced = [i for i in items if i.get("price") or (i.get("priceInfo") or {}).get("linePrice") or (i.get("priceInfo") or {}).get("itemPrice")]
    return {"search": term, "blocked": False, "items": len(items), "priced": len(priced)}


def visit_store(page, sid, args, queue=None, seen=None, meter=None):
    s0 = time.time()
    mb = lambda: meter["bytes"] / 1e6 if meter else 0
    m0 = mb()
    rec = {"store": sid, **set_store(page, sid, args.challenge_wait)}
    rec["mb_store_page"] = round(mb() - m0, 2)
    if queue is not None and not (rec.get("why") or "").startswith("blocked"):
        for s in discover_stores(page):
            if s not in seen:
                queue.append(s)
    if rec["ok"]:
        getter = (lambda i: fetch_product_nav(page, i, args.challenge_wait)) if args.product_mode == "nav" else (lambda i: fetch_product(page, i))
        rec["products"] = []
        m1 = mb()
        for i in BASKET:
            rec["products"].append(getter(i))
            time.sleep(args.delay / 2)
        rec["mb_per_product_page"] = round((mb() - m1) / len(BASKET), 2)
        if args.search_term:
            m2 = mb()
            rec["search_result"] = fetch_search(page, args.search_term, args.challenge_wait)
            rec["mb_search_page"] = round(mb() - m2, 2)
        got = [p for p in rec["products"] if not p.get("blocked") and p.get("price") is not None]
        rec["store_confirmed"] = bool(got) and all(sid in p.get("store_ids_in_page", []) for p in got)
        rec["blocked"] = any(p.get("blocked") for p in rec["products"])
    else:
        rec["blocked"] = (rec.get("why") or "").startswith("blocked")
    rec["secs"] = round(time.time() - s0, 1)
    return rec


def discover_stores(page) -> list:
    hrefs = page.eval_on_selector_all("a[href*='/store/']", "els => els.map(e => e.getAttribute('href'))")
    return list(dict.fromkeys(m.group(1) for h in hrefs if (m := re.search(r"/store/(\d{2,5})", h or ""))))


HEAVY = ["*.png*", "*.jpg*", "*.jpeg*", "*.gif*", "*.webp*", "*.avif*", "*.svg*", "*.woff*", "*.ttf*", "*.mp4*"]  # not the i5 CDN host: it also serves the JS bundles


def attach_meter(page, block=False):
    """Meter bytes via CDP. Blocking is done with Network.setBlockedURLs rather than page.route(),
    because Playwright routing disables the HTTP cache and made every page re-download ~5 MB of JS."""
    total = {"bytes": 0}
    cdp = page.context.new_cdp_session(page)
    cdp.send("Network.enable")
    if block:
        cdp.send("Network.setBlockedURLs", {"urls": HEAVY})
    cdp.on("Network.loadingFinished", lambda e: total.__setitem__("bytes", total["bytes"] + e.get("encodedDataLength", 0)))
    return total


def block_heavy_resources(page):
    page.route("**/*", lambda r: r.abort() if r.request.resource_type in ("image", "media", "font") else r.continue_())


def run(page, args, log):
    meter = attach_meter(page, args.block_resources)
    queue, seen = deque(([] if args.no_default_seeds else SEED_STORES) + args.extra_stores), set()
    if args.seed_from_ip:  # start from the store Walmart assigned to this session's IP, then walk nearby stores
        ip_store = {c["name"]: c["value"] for c in page.context.cookies("https://www.walmart.com")}.get("assortmentStoreId")
        log({"ip_assigned_store": ip_store})
        if ip_store:
            queue.appendleft(ip_store)
    t0, consecutive_blocks, results = time.time(), 0, []
    while queue:
        mins, mb = (time.time() - t0) / 60, meter["bytes"] / 1e6
        if len(seen) >= args.max_stores or mins >= args.max_minutes or mb >= args.max_mb:
            break
        sid = queue.popleft()
        if sid in seen:
            continue
        seen.add(sid)
        rec = visit_store(page, sid, args, queue, seen, meter)
        blocked = rec["blocked"]
        rec["mb_total"] = round(meter["bytes"] / 1e6, 2)
        results.append(rec)
        log(rec)
        consecutive_blocks = consecutive_blocks + 1 if blocked else 0
        if consecutive_blocks >= args.stop_after_blocks:
            log({"stop": f"{consecutive_blocks} consecutive blocks"})
            break
        time.sleep(args.delay)
    elapsed = time.time() - t0
    summary = summarize(results, elapsed, meter["bytes"] / 1e6, args.mode)
    summary["first_block_at_store_n"] = next((i + 1 for i, r in enumerate(results) if r["blocked"]), None)
    return results, summary


def bu_request(method, url, body=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"X-Browser-Use-API-Key": os.environ["BROWSER_USE_API_KEY"],
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def summarize(results, elapsed, mb, mode):
    good = [r for r in results if r.get("ok") and not r["blocked"] and r.get("store_confirmed")]
    return {
        "mode": mode, "stores_attempted": len(results), "stores_with_confirmed_prices": len(good),
        "store_switch_ok": sum(bool(r.get("ok")) for r in results),
        "blocked": sum(r["blocked"] for r in results), "minutes": round(elapsed / 60, 1),
        "confirmed_stores_per_hour_per_worker": round(len(good) / elapsed * 3600, 1) if elapsed else 0,
        "mb_total_measured": round(mb, 2),
        "mb_per_attempt": round(mb / len(results), 2) if results else None,
    }


def run_session_per_store(args, log):
    """Fresh cloud browser (and usually a fresh residential IP) for every store."""
    from playwright.sync_api import sync_playwright
    queue, seen, results, total_mb, t0 = deque(SEED_STORES + args.extra_stores), set(), [], 0.0, time.time()
    with sync_playwright() as p:
        while queue and len(seen) < args.max_stores and (time.time() - t0) / 60 < args.max_minutes and total_mb < args.max_mb:
            sid = queue.popleft()
            if sid in seen:
                continue
            seen.add(sid)
            session = bu_request("POST", API, {"proxyCountryCode": "us"})
            try:
                browser = p.chromium.connect_over_cdp(session["cdpUrl"])
                ctx = browser.contexts[0]
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                meter = attach_meter(page, args.block_resources)
                page.goto("https://ipinfo.io/json", timeout=30000)
                ip = json.loads(page.locator("body").inner_text())
                page.goto("https://www.walmart.com/", wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(3000)
                rec = visit_store(page, sid, args, queue, seen)
                rec["egress"] = f"{ip.get('city')}, {ip.get('region')} ({ip.get('org', '')[:30]})"
                rec["mb_session"] = round(meter["bytes"] / 1e6, 2)
                total_mb += meter["bytes"] / 1e6
                browser.close()
            except Exception as e:
                rec = {"store": sid, "ok": False, "why": f"error: {type(e).__name__}: {str(e)[:120]}", "blocked": False}
            finally:
                bu_request("PATCH", f"{API}/{session['id']}", {"action": "stop"})
            results.append(rec)
            log(rec)
            time.sleep(args.delay)
    return results, summarize(results, time.time() - t0, total_mb, "browser-use/session-per-store")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["local", "browser-use"], default="local")
    ap.add_argument("--max-stores", type=int, default=40)
    ap.add_argument("--max-minutes", type=float, default=30)
    ap.add_argument("--max-mb", type=float, default=400)
    ap.add_argument("--stop-after-blocks", type=int, default=3)
    ap.add_argument("--challenge-wait", type=int, default=20)
    ap.add_argument("--delay", type=float, default=2.0)
    ap.add_argument("--block-resources", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--out", default="results")
    ap.add_argument("--product-mode", choices=["nav", "fetch"], default="nav")
    ap.add_argument("--session-per-store", action="store_true")
    ap.add_argument("--extra-stores", nargs="*", default=[])
    ap.add_argument("--seed-from-ip", action="store_true")
    ap.add_argument("--no-default-seeds", action="store_true")
    ap.add_argument("--tag", default="")
    ap.add_argument("--search-term", default="")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    log_path = os.path.join(args.out, f"{args.mode}{args.tag}_log.jsonl")
    fh = open(log_path, "w")
    def log(obj):
        line = json.dumps(obj); print(line, flush=True); fh.write(line + "\n"); fh.flush()

    if args.mode == "local":
        from scrapling.fetchers import StealthySession
        box = {}
        def action(page):
            box["out"] = run(page, args, log)
        with StealthySession(headless=True) as s:
            s.fetch("https://www.walmart.com/", page_action=action, timeout=60000)
        results, summary = box["out"]
    elif args.session_per_store:
        results, summary = run_session_per_store(args, log)
    else:
        from playwright.sync_api import sync_playwright
        session = bu_request("POST", API, {"proxyCountryCode": "us"})
        log({"browser_use_session": session.get("id")})
        try:
            with sync_playwright() as p:
                browser = p.chromium.connect_over_cdp(session["cdpUrl"])
                ctx = browser.contexts[0]  # keep Browser Use's managed context/fingerprint
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                page.goto("https://www.walmart.com/", wait_until="domcontentloaded", timeout=60000)
                results, summary = run(page, args, log)
        finally:
            bu_request("PATCH", f"{API}/{session['id']}", {"action": "stop"})
            time.sleep(5)
            billed = bu_request("GET", f"{API}/{session['id']}")
            log({"browser_use_billing": {k: billed.get(k) for k in ("proxyUsedMb", "proxyCost", "browserCost", "startedAt", "finishedAt")}})

    log({"summary": summary})
    json.dump({"summary": summary, "results": results}, open(os.path.join(args.out, f"{args.mode}{args.tag}_results.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
