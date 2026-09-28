// Pieces of in-page script that several of the injected scripts include: the store the page says it's set to, and
// how much data it moved.

/**
 * Script text defining storeLabel(): the store the site says it's set to, as its header (or a store card) writes it:
 * "Your store: Brooklyn Atlantic Terminal", "My Warehouse Brooklyn", "Shopping at Sprouts Farmers Market". Null when
 * the page names none. The app splits it into a name, an address and a number (parseStoreLabel in storeIdentity.ts).
 */
export const STORE_LABEL = `function storeLabel() {
    try {
      var PHRASE = /\\b(?:(?:my|your|selected|preferred|current|home)\\s+(?:store|warehouse|club)|shopping\\s+(?:at|in)|pick\\s?up\\s+(?:at|from)|picking\\s+up\\s+at)\\b|\\b(?:store|warehouse)\\s*:/i;
      var BEFORE = /\\b(?:find|choose|select|change|set|pick|update|search|locate)\\b/i;
      var NOT_NAME = /^(?:find|choose|select|change|set|hours|details|info|deals|weekly|ad|locator|finder|near)\\b/i;
      var nodes = document.querySelectorAll('[aria-label], button, a, [role="button"], [data-test], [data-testid], [data-automation-id], header span, header div, header p');
      for (var i = 0; i < nodes.length && i < 2000; i++) {
        var el = nodes[i];
        var own = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
        var texts = [String(el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(), own.length <= 160 ? own : ''];
        for (var j = 0; j < texts.length; j++) {
          var t = texts[j];
          var m = t && t.length <= 200 ? PHRASE.exec(t) : null;
          if (!m || BEFORE.test(t.slice(0, m.index))) continue;
          var rest = t.slice(m.index + m[0].length).replace(/^[\\s:|\\u00b7\\u2022-]+/, '');
          // "Your store" on its own: the name is next to it.
          if (!rest && el.nextElementSibling) rest = String(el.nextElementSibling.textContent || '').replace(/\\s+/g, ' ').trim();
          if (rest.length >= 2 && rest.length <= 200 && /^[A-Za-z0-9]/.test(rest) && !NOT_NAME.test(rest)) return (m[0] + ' ' + rest).slice(0, 240);
        }
      }
    } catch (e) {}
    return null;
  }`;

/**
 * Script text defining pageBytes(): about how much data the page has moved so far, from the browser's own resource
 * timing. Files from other sites that don't allow timing (images on a CDN, usually) report no size; each of those
 * is counted at a typical size for its kind, so the figure is an estimate.
 */
export const PAGE_BYTES = `function pageBytes() {
    try {
      var TYPICAL = { img: 25000, image: 25000, css: 30000, link: 30000, script: 60000, font: 40000, fetch: 4000, xmlhttprequest: 4000, beacon: 500, video: 300000, audio: 100000, other: 10000 };
      var nav = performance.getEntriesByType('navigation')[0];
      var total = nav ? nav.transferSize || nav.encodedBodySize || 0 : 0;
      var list = performance.getEntriesByType('resource'), estimated = 0;
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (r.transferSize > 0) total += r.transferSize;
        else if (r.encodedBodySize > 0) continue; // From the cache: nothing moved.
        else if (!r.responseStart) { total += TYPICAL[r.initiatorType] || TYPICAL.other; estimated++; }
      }
      return { bytes: Math.round(total), files: list.length + 1, estimated: estimated };
    } catch (e) {
      return null;
    }
  }`;
