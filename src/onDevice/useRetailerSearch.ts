import { useMemo } from 'react';
import { parserProfiles } from './profiles';
import { createRetailerSearch, type RetailerSearch, type SearchHooks } from './retailerSearch';
import { storeTuner } from './tuning';
import { useWebViewPool } from './WebViewFetcher';

export { SearchFailed, type RetailerSearch } from './retailerSearch';

/**
 * The app's retailer search, bound to the WebView lanes, the app's store tuning and cool-downs, and its stores' parser
 * profiles, which outlive a change of rules. `hooks` should keep its identity: a new one makes a new search.
 */
export function useRetailerSearch(configVersion: string, hooks?: SearchHooks): RetailerSearch {
  const pool = useWebViewPool();
  return useMemo(() => createRetailerSearch(pool, configVersion, storeTuner, parserProfiles, hooks), [pool, configVersion, hooks]);
}
