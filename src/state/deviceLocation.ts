import * as Location from 'expo-location';
import type { LatLng } from '../onDevice/storeLocator';

/** The phone's ZIP code, or why there isn't one: no permission, outside the U.S., or no fix. */
export type Located = { ok: true; zip: string } | { ok: false; reason: 'denied' | 'not_us' | 'unavailable' };

/** What to tell the user when the phone's ZIP code couldn't be had. */
export const LOCATE_PROBLEMS: Record<Extract<Located, { ok: false }>['reason'], string> = {
  denied: 'Location is off for Stretch. Type your ZIP code instead.',
  not_us: 'This phone doesn’t seem to be in the U.S. Type a U.S. ZIP code.',
  unavailable: 'Couldn’t tell where this phone is. Type your ZIP code.',
};

/**
 * The phone's ZIP code, from where it is, read once when the user asks, with their permission. Only the ZIP comes
 * back: the phone's own position isn't kept anywhere.
 */
export async function zipFromDevice(): Promise<Located> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return { ok: false, reason: 'denied' };
    const position =
      (await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000, requiredAccuracy: 1000 })) ??
      (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
    const [place] = await Location.reverseGeocodeAsync({ latitude: position.coords.latitude, longitude: position.coords.longitude });
    const zip = place?.postalCode?.slice(0, 5) ?? '';
    if (place?.isoCountryCode !== 'US' || !/^\d{5}$/.test(zip)) return { ok: false, reason: 'not_us' };
    return { ok: true, zip };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Where a ZIP code is on the map (its center, as the phone's geocoder has it), or null if it can't be told. */
export async function locateZip(zip: string): Promise<LatLng | null> {
  try {
    const [hit] = await Location.geocodeAsync(`${zip}, USA`);
    return hit ? { lat: hit.latitude, lng: hit.longitude } : null;
  } catch {
    return null;
  }
}
