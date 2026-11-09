/**
 * DataTable — the compact table every list screen uses (Incidents, Users,
 * Audit Log); roughly half the row height of stacked-card lists.
 *
 * Renders a real <table> (not divs) so it stays navigable to screen readers
 * and keyboard users, with scope="col" headers. Column headers are uppercase
 * 12px grey on a --color-bg header row; body rows divide with --color-divider
 * and highlight on hover.
 *
 * Wraps itself in a horizontally scrollable container so wide content scrolls
 * inside its own box rather than pushing the page into a horizontal scroll.
 *
 * Column sorting is CLIENT-SIDE ONLY, sorting the `rows` array already handed
 * to this component — deliberately not wired to any API `page`/`limit`/`sort`
 * param (some list endpoints paginate, not all are confirmed to). A column
 * opts in with `sortable: true` plus a `sortValue(row)` accessor — required
 * per sortable column rather than defaulting to `row[key]`, because column
 * `key`s (e.g. `'reported'`) frequently don't match the underlying row
 * property name (`createdAt`), as `renderCell`'s own switch shows.
 *
 * Pagination, when the caller passes all four of `page`/`totalItems`/
 * `pageSize`/`onPageChange`, renders a real Prev/Next + "Page X of Y" footer
 * that calls back into the PAGE's own `load()` — this component never
 * invents client-side pagination on top of an already-fetched, already-capped
 * array; `rows` is always exactly what the caller's API call for the CURRENT
 * page returned. Omit all four (the default) and no footer renders at all.
 *
 * Empty state: when `rows.length === 0` AND `emptyMessage` was passed, a
 * single centred row (optional icon + message) renders inside the table
 * itself instead of an empty <tbody> — opt-in, so a page that renders its own
 * empty-state block instead of the table keeps working.
 *
 * @param {{
 *   columns: Array<{key:string, label:string, align?:'left'|'right', width?:string, sortable?:boolean, sortValue?:(row:object)=>(string|number)}>,
 *   rows: Array<object>,
 *   renderCell: (row:object, columnKey:string) => (string|Node),
 *   rowKey: (row:object) => string|number,
 *   rowClass?: (row:object) => string|undefined,
 *   onRowClick?: (row:object) => void,
 *   selectedKey?: string|number|null,
 *   caption?: string,
 *   emptyIcon?: (size:number) => string,
 *   emptyMessage?: string,
 *   page?: number, totalItems?: number, pageSize?: number, onPageChange?: (nextPage:number) => void,
 * }} props
 * @returns {HTMLElement}
 */

// --- String cells are sanitized, not trusted --------------------------------
// `renderCell` may return a string, and callers use that for small static
// markup ('<span class="text-tertiary">—</span>'). Trusting it as raw
// innerHTML meant any caller that returned server text unescaped was a stored
// XSS. A string is now parsed inertly (<template>: nothing loads or runs) and
// only an allowlist of formatting tags/attributes survives; any other element
// is replaced by its own text. Callers that escape still render identically.
const SAFE_CELL_TAGS = new Set([
  'span', 'strong', 'em', 'b', 'i', 'small', 'br', 'code', 'div', 'p', 'abbr', 'time', 'mark', 'sup', 'sub',
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect',
]);
const SAFE_CELL_ATTRS = new Set([
  'class', 'title', 'role', 'datetime', 'style',
  'viewbox', 'width', 'height', 'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'xmlns', 'focusable', 'transform',
  'opacity', 'fill-rule', 'clip-rule',
]);

function sanitizeCellNode(parent) {
  for (const child of [...parent.childNodes]) {
    if (child.nodeType === 3) continue; // text
    if (child.nodeType !== 1) { child.remove(); continue; }
    const tag = child.localName.toLowerCase();
    if (!SAFE_CELL_TAGS.has(tag)) {
      child.replaceWith(document.createTextNode(child.textContent));
      continue;
    }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      const allowed = SAFE_CELL_ATTRS.has(name) || name.startsWith('aria-');
      if (!allowed || (name === 'style' && /url\s*\(|expression\s*\(/i.test(attr.value))) child.removeAttribute(attr.name);
    }
    sanitizeCellNode(child);
  }
}

/** Inert parse + allowlist; returns a fragment safe to append. Exported for tests. */
export function cellContent(html) {
  const template = document.createElement('template');
  template.innerHTML = html == null ? '' : String(html);
  sanitizeCellNode(template.content);
  return template.content;
}

export function DataTable({
  columns, rows, renderCell, rowKey, rowClass, onRowClick, selectedKey = null, caption,
  emptyIcon, emptyMessage,
  page, totalItems, pageSize, onPageChange,
  initialSort = null, onSortChange = null, rowAriaLabel = null,
}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'data-table-wrap';

  // A real row-count line, announced to screen readers via aria-live so a
  // filter/reload/sort that changes which rows are showing is heard, not just
  // seen. Visually hidden (sr-only); it only ever counts what it was given.
  const summary = document.createElement('p');
  summary.className = 'sr-only';
  summary.setAttribute('role', 'status');
  summary.setAttribute('aria-live', 'polite');
  wrapper.appendChild(summary);
  function syncSummary() {
    const n = rows.length;
    summary.textContent = `${n} ${n === 1 ? 'row' : 'rows'}${caption ? ` in ${caption}` : ''}.`;
  }

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
  let sort = initialSort && initialSort.key
    ? { key: initialSort.key, direction: initialSort.direction === 'desc' ? 'desc' : 'asc' }
    : { key: null, direction: 'asc' };
  const headerButtons = {};
  const headerCells = {};

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    if (col.align === 'right') th.classList.add('is-right');
    if (col.width) th.style.width = col.width;

    // Sorting is client-side over `rows`, which is exactly ONE
    // page when the caller paginates server-side. Reordering 25 of 30 rows
    // and presenting it as a sorted table is worse than not offering the
    // control, so sorting is suppressed entirely while paginated — until
    // the endpoints accept a sort param, "sorted" would be a lie.
    const paginated = page !== undefined && totalItems !== undefined && pageSize !== undefined && !!onPageChange;
    if (col.sortable && col.sortValue && !paginated) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'data-table__sort-button';
      const labelSpan = document.createElement('span');
      labelSpan.textContent = col.label; // same as the non-sortable header below
      const sortIcon = document.createElement('span');
      sortIcon.className = 'data-table__sort-icon';
      sortIcon.setAttribute('aria-hidden', 'true');
      button.append(labelSpan, sortIcon);
      button.addEventListener('click', () => {
        sort = sort.key === col.key
          ? { key: col.key, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
          : { key: col.key, direction: 'asc' };
        renderBody();
        syncSortIndicators();
        if (onSortChange) onSortChange({ ...sort });
      });
      headerButtons[col.key] = button;
      headerCells[col.key] = th;
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
      // aria-sort belongs on the column header cell, not on a button inside
      // it: on the button, no screen reader reports the sort state.
      headerCells[key].setAttribute('aria-sort', active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
      // A neutral glyph at rest, so a sortable column is
      // identifiable as sortable BEFORE it has been clicked once.
      icon.textContent = active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕';
      icon.classList.toggle('is-active', active);
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
    if (rows.length === 0 && emptyMessage) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = columns.length;
      td.className = 'data-table__empty';
      if (emptyIcon) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'data-table__empty-icon';
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.innerHTML = emptyIcon(28);
        td.appendChild(iconSpan);
      }
      const msg = document.createElement('span');
      msg.textContent = emptyMessage;
      td.appendChild(msg);
      tr.appendChild(td);
      tbody.appendChild(tr);
      syncSummary();
      return;
    }
    for (const row of sortedRows()) {
      const tr = document.createElement('tr');
      const key = rowKey(row);
      tr.dataset.rowKey = String(key);
      if (selectedKey !== null && key === selectedKey) tr.classList.add('is-selected');
      if (rowClass) {
        const customClass = rowClass(row);
        if (customClass) {
          customClass.split(' ').filter(Boolean).forEach((cls) => tr.classList.add(cls));
        }
      }

      // role="button" + tabindex on the <tr> itself would override the row
      // role, so the cells stop being associated with their column headers.
      // The row stays a row. The FIRST CELL gets a real button carrying
      // the accessible name, which is the keyboard/AT activator; the
      // row-level click handler stays as a mouse convenience only.
      if (onRowClick) {
        tr.classList.add('is-clickable');
        tr.addEventListener('click', () => onRowClick(row));
      }

      let firstCell = true;
      for (const col of columns) {
        const td = document.createElement('td');
        if (col.align === 'right') td.classList.add('is-right');
        const cell = renderCell(row, col.key);
        if (onRowClick && firstCell && col.activator !== false) {
          const activator = document.createElement('button');
          activator.type = 'button';
          activator.className = 'data-table__row-activator';
          if (rowAriaLabel) activator.setAttribute('aria-label', rowAriaLabel(row));
          if (cell instanceof Node) activator.appendChild(cell);
          else activator.appendChild(cellContent(cell));
          activator.addEventListener('click', (event) => {
            // The row handler above would otherwise fire a second time.
            event.stopPropagation();
            onRowClick(row);
          });
          td.appendChild(activator);
        } else if (cell instanceof Node) {
          td.appendChild(cell);
        } else {
          td.appendChild(cellContent(cell));
        }
        // A column that opts out (`activator: false`, e.g. a checkbox column)
        // does not consume the activator; the next column gets it instead.
        if (col.activator !== false) firstCell = false;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    syncSummary();
  }
  renderBody();

  // Pagination footer — only when the caller supplied every one of the
  // four props together (see this file's own doc comment for why a
  // partial set renders nothing rather than guessing).
  if (page !== undefined && totalItems !== undefined && pageSize !== undefined && onPageChange) {
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const footer = document.createElement('div');
    footer.className = 'data-table__pagination';

    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.className = 'ghost';
    prevButton.textContent = 'Previous';
    prevButton.disabled = page <= 1;
    prevButton.addEventListener('click', () => onPageChange(page - 1));

    const indicator = document.createElement('span');
    indicator.className = 'data-table__pagination-indicator';
    // Announced, so pressing Next tells a screen-reader user where they
    // landed rather than silently swapping the rows underneath them.
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-live', 'polite');
    const startRow = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
    const endRow = Math.min(page * pageSize, totalItems);
    indicator.textContent = totalItems === 0
      ? 'No results'
      : `Showing ${startRow}-${endRow} of ${totalItems} · Page ${page} of ${totalPages}`;

    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'ghost';
    nextButton.textContent = 'Next';
    nextButton.disabled = page >= totalPages;
    nextButton.addEventListener('click', () => onPageChange(page + 1));

    footer.append(prevButton, indicator, nextButton);
    wrapper.appendChild(footer);
  }

  return wrapper;
}

/**
 * One shared CSV export used by every page that
 * wants a Download button, rather than each page hand-rolling its own
 * serialization. Exports exactly the ROWS the caller currently has loaded
 * (whatever a filter/pagination/sort left them with) — never a second
 * server round-trip to fetch "everything," which could silently include
 * rows outside the caller's own tenant/role-scoped view if the endpoint
 * ever changed shape.
 *
 * `columns` reuses the SAME shape `DataTable` itself takes, so a page
 * defines its column list once and passes it to both. A column needs a
 * `csvValue(row)` accessor to appear in the export — same "explicit per
 * column, no ambient row[key] guessing" rule `sortValue` already
 * established, and for the same reason (this codebase's column `key`s
 * frequently don't match the underlying row property name).
 *
 * @param {Array<{label:string, csvValue?:(row:object)=>(string|number)}>} columns
 * @param {Array<object>} rows
 * @param {string} filename without extension — `.csv` is appended here.
 */
export function exportRowsToCsv(columns, rows, filename) {
  if (rows.length === 0) return 0;
  const exportable = columns.filter((c) => typeof c.csvValue === 'function');
  const escapeCell = (value) => {
    let text = value === null || value === undefined ? '' : String(value);
    // CSV injection: a citizen-typed "=HYPERLINK(...)" would run as a live
    // formula in Excel. Only strings are neutralised — a real negative
    // number stays a number.
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    // RFC 4180: quote any field containing a comma, quote, or newline;
    // double up embedded quotes.
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    exportable.map((c) => escapeCell(c.label)).join(','),
    ...rows.map((row) => exportable.map((c) => escapeCell(c.csvValue(row))).join(',')),
  ];
  // \r\n line endings — the CSV spec's own recommendation, and what keeps
  // Excel (still the most likely consumer for a barangay office) from
  // occasionally mis-detecting the line ending on a bare \n file.
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return rows.length;
}

/**
 * An "Export CSV" button next to a server-paginated table would write only
 * the loaded page (e.g. 25 of 30 rows) with nothing saying the file is
 * partial.
 *
 * The button states what it will actually write. Callers pass the
 * rows they hold; if that is fewer than the server's total, the label
 * says so rather than the file quietly disagreeing with the screen.
 *
 * @param {{rows:Array<object>, totalItems?:number, label?:string, onExport:()=>void}} props
 */
export function ExportCsvButton({ rows, totalItems, label = 'Export CSV', onExport }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost';
  const n = rows.length;
  const partial = totalItems !== undefined && totalItems > n;
  button.textContent = n === 0
    ? label
    : partial ? `${label} (${n} of ${totalItems})` : `${label} (${n})`;
  if (partial) button.title = `Exports the ${n} rows currently loaded, not all ${totalItems}.`;
  button.disabled = n === 0;
  button.addEventListener('click', onExport);
  return button;
}
