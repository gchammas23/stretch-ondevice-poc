import { useMemo } from 'react';
import { createRetailerSearch, type RetailerSearch } from './retailerSearch';
import { useWebViewPool } from './WebViewFetcher';

export { SearchFailed, type RetailerSearch } from './retailerSearch';

/** The app's retailer search, bound to the WebView lanes. */
export function useRetailerSearch(configVersion: string): RetailerSearch {
  const pool = useWebViewPool();
  return useMemo(() => createRetailerSearch(pool, configVersion), [pool, configVersion]);
}
