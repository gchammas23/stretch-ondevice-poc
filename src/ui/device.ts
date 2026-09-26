import { Platform } from 'react-native';

/** "iPhone", "iPad" or "phone", for "read on this iPhone". */
export const deviceWord: string = Platform.OS === 'ios' ? (Platform.isPad ? 'iPad' : 'iPhone') : 'phone';
