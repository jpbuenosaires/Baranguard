import { createContext } from 'react';

/** True inside the Tanod tabs: MobileHeader then carries the SOS hold control (Admin console headers do not). */
export const SosInHeaderContext = createContext(false);
