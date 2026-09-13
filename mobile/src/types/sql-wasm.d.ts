/**
 * `sql.js`'s own package.json has no typed entry for its `dist/*` subpath
 * exports (only the package root `sql.js` is covered by @types/sql.js).
 * `mbtilesReader.ts` imports the concrete `dist/sql-wasm.js` build
 * directly (rather than the bare `sql.js` specifier) so bundling doesn't
 * depend on which of the package's several dist variants a "browser"
 * field resolution picks — this shim just points that exact import at
 * the same types @types/sql.js already declares for the package root.
 */
declare module 'sql.js/dist/sql-wasm.js' {
  import initSqlJs from 'sql.js';
  export default initSqlJs;
}
