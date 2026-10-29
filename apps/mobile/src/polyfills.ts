import * as Crypto from 'expo-crypto';
import { I18nManager } from 'react-native';

// UUID v7 generation needs crypto.getRandomValues, which React Native lacks.
const g = globalThis as any;
if (!g.crypto?.getRandomValues) {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues: Crypto.getRandomValues };
}

// Arabic-first: right-to-left layout (takes effect from the next app start).
I18nManager.allowRTL(true);
I18nManager.forceRTL(true);
