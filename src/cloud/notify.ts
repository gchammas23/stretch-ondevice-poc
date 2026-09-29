import { Platform } from 'react-native';
import { comparisonNotice, type Comparison } from './compare';
import type { CloudJob } from './jobs';
import { jobNotice } from './words';

// Local notifications for cloud jobs (expo-notifications, no server and no push). The module is loaded the first time
// cloud fetch needs it: with the switch off and no jobs, the app never loads it.

type NotificationsModule = typeof import('expo-notifications');
let loading: Promise<NotificationsModule> | null = null;
const CHANNEL = 'cloud-searches';

function notifications(): Promise<NotificationsModule> {
  return (loading ??= import('expo-notifications').then(async (N) => {
    // Shown in the foreground too, beside the app's own banner (PricingBanner).
    N.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
    });
    if (Platform.OS === 'android') await N.setNotificationChannelAsync(CHANNEL, { name: 'Cloud searches', importance: N.AndroidImportance.DEFAULT }).catch(() => null);
    return N;
  }));
}

/** Asks to show notifications, once, as cloud fetch is first turned on. True when they're allowed. */
export async function askForNotifications(): Promise<boolean> {
  try {
    const N = await notifications();
    const had = await N.getPermissionsAsync();
    if (had.granted || had.ios?.status === N.IosAuthorizationStatus.PROVISIONAL) return true;
    if (!had.canAskAgain) return false;
    return (await N.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/** A job is over: a local notification now, which opens the job when tapped. */
export async function notifyJobDone(job: CloudJob): Promise<void> {
  try {
    const N = await notifications();
    const { title, body } = jobNotice(job);
    await N.scheduleNotificationAsync({
      content: { title, body, data: { url: `/cloud/${job.id}` } },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
    });
  } catch {
    // No permission, or no notifications here: the app's own banner still says it.
  }
}

/** A Phone vs. cloud comparison is over: a local notification now, which opens the comparison when tapped. */
export async function notifyComparisonDone(comparison: Comparison): Promise<void> {
  try {
    const N = await notifications();
    const { title, body } = comparisonNotice(comparison);
    await N.scheduleNotificationAsync({
      content: { title, body, data: { url: `/phone-vs-cloud/${comparison.id}` } },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
    });
  } catch {
    // No permission, or no notifications here: the app's own banner still says it.
  }
}

/**
 * Opens a job's (or a comparison's) screen when its notification is tapped: now, and once for the tap that opened the app. Returns a
 * function that stops listening.
 */
export function openJobsFromNotifications(open: (url: string) => void): () => void {
  let stop = false;
  let remove: (() => void) | null = null;
  const route = (data: unknown) => {
    const url = typeof data === 'object' && data !== null ? (data as { url?: unknown }).url : undefined;
    if (typeof url === 'string' && (url.startsWith('/cloud/') || url.startsWith('/phone-vs-cloud/'))) open(url);
  };
  void notifications()
    .then((N) => {
      if (stop) return;
      const last = N.getLastNotificationResponse();
      if (last) {
        route(last.notification.request.content.data);
        // Handled: the next launch doesn't open it again.
        N.clearLastNotificationResponse();
      }
      const sub = N.addNotificationResponseReceivedListener((response) => route(response.notification.request.content.data));
      remove = () => sub.remove();
    })
    .catch(() => {});
  return () => {
    stop = true;
    remove?.();
  };
}
