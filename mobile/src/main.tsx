import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { configureLocalDatabase } from './services/db/localDatabase';
import { getOrCreatePassphrase } from './services/db/passphrase';

/**
 * Wire the encrypted local store's key provider before anything can open
 * it. localDatabase.ts deliberately throws rather than defaulting to a
 * hardcoded passphrase, so this registration is required exactly once, at
 * startup — see services/db/passphrase.ts for the key-provisioning
 * decision and its storage caveat.
 *
 * Note this only REGISTERS the provider; it does not open or create the
 * database. The first actual open happens on the first local write (M3),
 * which keeps app start-up independent of database availability.
 */
configureLocalDatabase(getOrCreatePassphrase);

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
