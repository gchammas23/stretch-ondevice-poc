// Per-weight entry points, so only these six font files ship (the package index pulls in every weight).
import { Caveat_700Bold } from '@expo-google-fonts/caveat/700Bold';
import { Fraunces_600SemiBold } from '@expo-google-fonts/fraunces/600SemiBold';
import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular';
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium';
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold';
import { Geist_700Bold } from '@expo-google-fonts/geist/700Bold';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WebViewFetcherProvider } from '../onDevice/WebViewFetcher';
import { AppProvider, useAppState } from '../state/AppProvider';
import { CloudProvider } from '../state/CloudProvider';
import { PricingBanner } from '../ui/PricingBanner';
import { colors } from '../ui/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Fraunces_600SemiBold,
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
    Caveat_700Bold,
  });
  const [dataReady, setDataReady] = useState(false);
  const fontsReady = fontsLoaded || !!fontError;
  const onReady = useCallback(() => setDataReady(true), []);

  useEffect(() => {
    if (fontsReady && dataReady) SplashScreen.hideAsync().catch(() => {});
  }, [fontsReady, dataReady]);

  return (
    <SafeAreaProvider>
      {/* The WebView lanes sit above the navigation stack, so a bot check or store visit can cover any screen. */}
      <WebViewFetcherProvider>
        <AppProvider onReady={onReady}>
          {/* Cloud jobs run whatever screen is open (see src/cloud). */}
          <CloudProvider>{fontsReady ? <AppStack /> : null}</CloudProvider>
        </AppProvider>
      </WebViewFetcherProvider>
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}

/** The welcome shows until it's done; then it can't be reached and the lists open instead. */
function AppStack() {
  const onboarded = useAppState((s) => s.settings.onboarded);
  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.paper } }}>
        <Stack.Protected guard={!onboarded}>
          <Stack.Screen name="welcome" />
        </Stack.Protected>
        <Stack.Protected guard={onboarded}>
          <Stack.Screen name="index" />
        </Stack.Protected>
      </Stack>
      <PricingBanner />
    </>
  );
}
