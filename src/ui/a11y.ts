import { useCallback, useEffect, useState, type RefObject } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, type LayoutChangeEvent } from 'react-native';

// VoiceOver doesn't read changes the app makes on its own (accessibilityLiveRegion is Android only), so results that
// arrive in the background are announced. Guarded, since the web build lacks some of these.

/** Says `message` with VoiceOver or TalkBack, after what it's saying now. Nothing happens without a screen reader. */
export function announce(message: string): void {
  if (!message) return;
  const info = AccessibilityInfo as Partial<typeof AccessibilityInfo>;
  if (typeof info.announceForAccessibilityWithOptions === 'function') info.announceForAccessibilityWithOptions(message, { queue: true });
  else info.announceForAccessibility?.(message);
}

/** Moves the screen reader to `ref`, once what just appeared has been laid out. */
export function focusOn(ref: RefObject<unknown>, delayMs = 300): () => void {
  const timer = setTimeout(() => {
    const node = ref.current;
    // Screen readers on the web follow the browser's own focus; findNodeHandle doesn't exist there.
    if (!node || Platform.OS === 'web') return;
    const info = AccessibilityInfo as Partial<typeof AccessibilityInfo>;
    try {
      if (typeof info.sendAccessibilityEvent === 'function') {
        info.sendAccessibilityEvent(node as Parameters<typeof AccessibilityInfo.sendAccessibilityEvent>[0], 'focus');
        return;
      }
      const tag = findNodeHandle(node as Parameters<typeof findNodeHandle>[0]);
      if (tag) info.setAccessibilityFocus?.(tag);
    } catch {
      // Moving the focus is a courtesy: never worth an error.
    }
  }, delayMs);
  return () => clearTimeout(timer);
}

/** Whether VoiceOver or TalkBack is on, kept up to date. */
export function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isScreenReaderEnabled?.().then(
      (v) => alive && setOn(v),
      () => {},
    );
    const sub = AccessibilityInfo.addEventListener?.('screenReaderChanged', (v: boolean) => setOn(v));
    return () => {
      alive = false;
      sub?.remove();
    };
  }, []);
  return on;
}

/** Props that keep a decorative View, and everything in it, away from screen readers. */
export const hiddenFromScreenReaders = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

/**
 * A floating footer's height, measured, so the content under it can scroll clear of it at any text size. Starts at
 * `initial` until the footer has been laid out.
 */
export function useFooterHeight(initial: number): [number, (e: LayoutChangeEvent) => void] {
  const [height, setHeight] = useState(initial);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const next = Math.ceil(e.nativeEvent.layout.height);
    setHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
  }, []);
  return [height, onLayout];
}
