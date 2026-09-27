import { useEffect } from 'react';
import { router } from 'expo-router';

/**
 * Never actually shown — `(tabs)/_layout.tsx` intercepts the tab press and
 * pushes the `/incidents/new` modal instead. This redirect only covers a
 * direct/deep-link navigation to this route.
 */
export default function LogIncidentRedirect() {
  useEffect(() => {
    router.replace('/incidents/new');
  }, []);
  return null;
}
