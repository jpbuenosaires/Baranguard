/**
 * DataTable — the compact table every list screen in the Figma reference
 * uses (Blotter, Incidents, Users). Replaces this app's stacked-card
 * lists, which rendered ~90px per row against the reference's ~44px —
 * roughly half the information density, and the main reason the UI read
 * as oversized regardless of font size.
 *
 * Renders a real <table> (not divs) so it stays navigable to screen
 * readers and keyboard users, with scope="col" headers per §8's
 * accessibility rules. Column headers are uppercase 12px grey on a
 * --color-bg header row; body rows divide with --color-divider and
 * highlight on hover.
 *
 * Wraps itself in a horizontally scrollable container — §8 requires wide
 * content to scroll inside its own box rather than push the page into a
 * horizontal scroll.
 *
 * @param {{
 *   columns: Array<{key:string, label:string, align?:'left'|'right', width?:string}>,
 *   rows: Array<object>,
 *   renderCell: (row:object, columnKey:string) => (string|Node),
 *   rowKey: (row:object) => string|number,
 *   onRowClick?: (row:object) => void,
 *   selectedKey?: string|number|null,
 *   caption?: string,
 * }} props
 * @returns {HTMLElement}
 */
export function DataTable({ columns, rows, renderCell, rowKey, onRowClick, selectedKey = null, caption }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'data-table-wrap';

  const table = document.createElement('table');
  table.className = 'data-table';

  if (caption) {
    const cap = document.createElement('caption');
    cap.className = 'sr-only';
    cap.textContent = caption;
    table.appendChild(cap);
  }

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = col.label;
    if (col.align === 'right') th.classList.add('is-right');
    if (col.width) th.style.width = col.width;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    const key = rowKey(row);
    if (selectedKey !== null && key === selectedKey) tr.classList.add('is-selected');

    if (onRowClick) {
      tr.classList.add('is-clickable');
      // Keyboard-operable: a clickable row needs a real focus stop and
      // Enter/Space activation, not just a mouse handler (§8 a11y).
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.addEventListener('click', () => onRowClick(row));
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onRowClick(row);
        }
      });
    }

    for (const col of columns) {
      const td = document.createElement('td');
      if (col.align === 'right') td.classList.add('is-right');
      const cell = renderCell(row, col.key);
      if (cell instanceof Node) td.appendChild(cell);
      else td.innerHTML = cell ?? '';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);
  wrapper.appendChild(table);
  return wrapper;
}
