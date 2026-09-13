/**
 * Every screen in this app passes CSS custom properties (`--background`,
 * `--color`, etc. — Ionic components' own documented styling API) inside
 * a React `style={{ ... }}` object, and TypeScript's `CSSProperties` has
 * no way to know an arbitrary `--foo` key is valid, since it isn't part
 * of the standard CSS property list. This is the standard fix (a
 * template-literal-typed index signature, TS 4.4+): widen
 * `React.CSSProperties` to accept any `--`-prefixed key, everywhere, once
 * — rather than an `as React.CSSProperties` cast (or worse, `as any`) at
 * each of the dozen+ call sites this repo already has, with more added
 * every time a screen needs one.
 */
import 'react';

declare module 'react' {
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}
