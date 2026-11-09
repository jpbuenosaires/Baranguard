/**
 * PageHeader — the white full-bleed page title bar every screen in the
 * Figma reference carries: title (24px bold) + subtitle (14px grey) on
 * the left, an actions slot on the right (buttons, period toggles, or a
 * StatStrip). Sits above the scrolling content area, not inside it, so
 * it stays put while content scrolls — see AppShell's `header` slot.
 *
 * One shared header, so every screen has the same header treatment instead
 * of a per-page <h2> with inline styles written into the content area.
 *
 * @param {{title:string, subtitle?:string, icon?:(size:number)=>string}} props
 * @returns {{el:HTMLElement, actions:HTMLElement}} `actions` is an empty
 *   right-aligned slot — append buttons/controls to it, or leave empty.
 */
export function PageHeader({ title, subtitle, icon }) {
  const el = document.createElement('div');
  el.className = 'page-header';

  const titleBlock = document.createElement('div');
  titleBlock.className = 'page-header__titles';

  // h1: the page title is the top-level heading of
  // every screen; the class carries the look, so the level is semantic only.
  const heading = document.createElement('h1');
  heading.className = 'page-header__title';
  if (icon) {
    const iconSpan = document.createElement('span');
    iconSpan.className = 'page-header__icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.innerHTML = icon(22);
    heading.appendChild(iconSpan);
  }
  heading.appendChild(document.createTextNode(title));
  titleBlock.appendChild(heading);

  if (subtitle) {
    const sub = document.createElement('p');
    sub.className = 'page-header__subtitle';
    sub.textContent = subtitle;
    titleBlock.appendChild(sub);
  }

  const actions = document.createElement('div');
  actions.className = 'page-header__actions';

  el.append(titleBlock, actions);
  return { el, actions };
}
