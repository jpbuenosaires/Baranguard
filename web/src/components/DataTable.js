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
 * Column sorting (§3.3 of the UI/UX review) is CLIENT-SIDE ONLY, sorting
 * the `rows` array already handed to this component — deliberately not
 * wired to any API `page`/`limit`/`sort` param, since that would need
 * per-endpoint verification this pass didn't do (some list endpoints
 * paginate, not all are confirmed to). A column opts in with `sortable:
 * true` plus a `sortValue(row)` accessor — required per sortable column
 * rather than defaulting to `row[key]`, because this codebase's column
 * `key`s (e.g. `'reported'`) frequently don't match the underlying row
 * property name (`createdAt`) the way `renderCell`'s own switch already
 * demonstrates.
 *
 * @param {{
 *   columns: Array<{key:string, label:string, align?:'left'|'right', width?:string, sortable?:boolean, sortValue?:(row:object)=>(string|number)}>,
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

  // { key: string|null, direction: 'asc'|'desc' } — null key means
  // "whatever order `rows` was given in," the default/unsorted state.
  let sort = { key: null, direction: 'asc' };
  const headerButtons = {};

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    if (col.align === 'right') th.classList.add('is-right');
    if (col.width) th.style.width = col.width;

    if (col.sortable && col.sortValue) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'data-table__sort-button';
      button.innerHTML = `<span>${col.label}</span><span class="data-table__sort-icon" aria-hidden="true"></span>`;
      button.addEventListener('click', () => {
        sort = sort.key === col.key
          ? { key: col.key, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
          : { key: col.key, direction: 'asc' };
        renderBody();
        syncSortIndicators();
      });
      headerButtons[col.key] = button;
      th.appendChild(button);
    } else {
      th.textContent = col.label;
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  function syncSortIndicators() {
    for (const [key, button] of Object.entries(headerButtons)) {
      const icon = button.querySelector('.data-table__sort-icon');
      const active = sort.key === key;
      button.setAttribute('aria-sort', active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
      icon.textContent = active ? (sort.direction === 'asc' ? '▲' : '▼') : '';
    }
  }
  syncSortIndicators();

  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  wrapper.appendChild(table);

  function sortedRows() {
    if (!sort.key) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return rows;
    const dir = sort.direction === 'asc' ? 1 : -1;
    // Slice, not sort-in-place — `rows` is the caller's own array, and
    // mutating it out from under them (especially between reloads) would
    // be a surprising side effect of just clicking a header.
    return [...rows].sort((a, b) => {
      const av = column.sortValue(a);
      const bv = column.sortValue(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  function renderBody() {
    tbody.innerHTML = '';
    for (const row of sortedRows()) {
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
  }
  renderBody();

  return wrapper;
}
