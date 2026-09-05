/**
 * icons.js — small inline-SVG icon set matching the Figma design's visual
 * language (24x24 grid, 2px stroke, round caps/joins — the same style
 * lucide-react uses throughout the Figma Make export's source, e.g.
 * DashboardLayout.tsx/LoginPage.tsx/AdminDashboard.tsx). This is a
 * from-scratch, geometrically-equivalent icon set, not a port of
 * lucide-react's actual path data — this app has no npm install step
 * (§1: no bundler), so a library import isn't an option the way it was
 * vendored for MapLibre GL JS.
 *
 * Each icon is a function `(size = 20) => svgString` so callers can inline
 * it directly via `.innerHTML` at whatever size the badge/context needs.
 */

/**
 * `size` is expressed in reference-design pixels (the same numbers the
 * Figma source uses: 16/20/24) but emitted as `rem` so icons scale with
 * base.css's root UI-scale knob along with everything else. Dividing by
 * 16 keeps every existing call site's number meaningful — `icons.map(22)`
 * still means "22px in the reference design", it just renders smaller at
 * a sub-100% root scale. Changing this one line rescales every icon in
 * the app; never hand-adjust call sites to change overall icon size.
 */
const svg = (paths, size) =>
  `<svg width="${size / 16}rem" height="${size / 16}rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const icons = {
  shield: (size = 20) => svg('<path d="M12 3l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6z"/>', size),
  lock: (size = 20) => svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', size),
  alertCircle: (size = 20) => svg('<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>', size),
  alertTriangle: (size = 20) => svg('<path d="M12 3 2 20h20L12 3z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', size),
  layoutDashboard: (size = 20) => svg('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>', size),
  radio: (size = 20) => svg('<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/>', size),
  map: (size = 20) => svg('<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><line x1="9" y1="4" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="20"/>', size),
  bell: (size = 20) => svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>', size),
  checkCircle: (size = 20) => svg('<circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/>', size),
  clock: (size = 20) => svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', size),
  users: (size = 20) => svg('<circle cx="9" cy="7" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><circle cx="17" cy="8" r="3"/><path d="M23 21c0-3-1.8-5-4-5.5"/>', size),
  logOut: (size = 20) => svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>', size),
  flame: (size = 20) => svg('<path d="M12 2c1 3-3 4-3 8a3 3 0 0 0 6 0c0-1-1-2-1-3 2 1 3 4 3 6a5 5 0 0 1-10 0c0-5 3-6 5-11z"/>', size),
  fileText: (size = 20) => svg('<path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M15 2v5h5"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>', size),
  barChart: (size = 20) => svg('<line x1="4" y1="20" x2="20" y2="20"/><rect x="6" y="12" width="3" height="8"/><rect x="13" y="7" width="3" height="13"/><rect x="17" y="4" width="3" height="16"/>', size),
  settings: (size = 20) => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V19a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H5a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H11a1.7 1.7 0 0 0 1-1.5V5a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V11a1.7 1.7 0 0 0 1.5 1H19a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', size),
  inbox: (size = 20) => svg('<path d="M4 4h16l3 8v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-7z"/><path d="M1 12h6l2 3h6l2-3h6"/>', size),
  megaphone: (size = 20) => svg('<path d="M3 11v3a1 1 0 0 0 1 1h2l4 5v-15l-4 5H4a1 1 0 0 0-1 1z"/><path d="M14 8a5 5 0 0 1 0 8"/><path d="M18 4a10 10 0 0 1 0 16"/>', size),
  calendar: (size = 20) => svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>', size),
  repeat: (size = 20) => svg('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>', size),
  batteryWarning: (size = 20) => svg('<rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="9" y1="9" x2="9" y2="13"/><line x1="9" y1="16" x2="9.01" y2="16"/>', size),
  // Corner marks for the dashboard's two chart cards.
  trendingUp: (size = 20) => svg('<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>', size),
  activity: (size = 20) => svg('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>', size),
  x: (size = 20) => svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', size),
  menu: (size = 20) => svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>', size),
  search: (size = 20) => svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', size),
  chevronDown: (size = 20) => svg('<polyline points="6 9 12 15 18 9"/>', size),
  chevronLeft: (size = 20) => svg('<polyline points="15 18 9 12 15 6"/>', size),
  eye: (size = 20) => svg('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>', size),
  eyeOff: (size = 20) => svg('<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.7 19.7 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.6 19.6 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>', size),
  plus: (size = 20) => svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', size),
  download: (size = 20) => svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', size),
  mapPin: (size = 20) => svg('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>', size),
  messageSquare: (size = 20) => svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', size),
  arrowDownLeft: (size = 20) => svg('<line x1="17" y1="7" x2="7" y2="17"/><polyline points="17 17 7 17 7 7"/>', size),
  arrowUpRight: (size = 20) => svg('<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>', size),
  sun: (size = 20) => svg('<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>', size),
  moon: (size = 20) => svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>', size),
  phone: (size = 20) => svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.902.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.908.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>', size),
  edit: (size = 20) => svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/>', size),
  send: (size = 20) => svg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>', size),
};
