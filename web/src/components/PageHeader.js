/**
 * PageHeader — the white full-bleed page title bar every screen in the
 * Figma reference carries: title (24px bold) + subtitle (14px grey) on
 * the left, an actions slot on the right (buttons, period toggles, or a
 * StatStrip). Sits above the scrolling content area, not inside it, so
 * it stays put while content scrolls — see AppShell's `header` slot.
 *
 * Replaces the old per-page pattern of writing an <h2> with an inline
 * margin/flex style straight into the content area, which produced a
 * different header treatment on every screen and consumed ~140px of
 * vertical space before any data appeared.
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

  const heading = document.createElement('h2');
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
