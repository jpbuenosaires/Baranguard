import { AiToolPanel } from '../components/AiToolPanel.js';
import { queueThreatAnalysis } from '../api/apiClient.js';

/**
 * threat-analysis.js — the Threat Analyzer tab of Analytics.
 *
 * Lives here rather than on a standalone AI screen because this is
 * aggregate historical analysis, which is what Analytics already is, and
 * because Analytics' Admin + Punong Barangay pair is exactly this tool's
 * own role gate — no per-tab gating needed (unlike Personnel).
 *
 * THE NON-PREDICTIVE FRAMING IS NOT DECORATION. W5 Historical Heatmap
 * carries an explicit "not predictive, not real-time" label for a reason,
 * and a tool that reads the same incident history and outputs the words
 * "suggested patrols" is far more likely to be mistaken for a forecast.
 * It describes counts that already happened. The server-side prompt
 * forbids naming individuals, describing households, or predicting who
 * will offend (see AiPrompts::threatAnalysis()); this label is the same
 * commitment stated to the reader.
 *
 * @param {HTMLElement} body
 * @param {{el: HTMLElement, actions: HTMLElement}} pageHeader
 * @param {{fullName:string, role:string}} user
 * @returns {{stop: () => void}}
 */
export function renderThreatAnalysisTab(body, pageHeader, user) {
  const intro = document.createElement('p');
  intro.className = 'note';
  intro.textContent =
    'Summarises the last 90 days of recorded incidents for your barangay by type, '
    + 'time of day and day of week, then suggests when patrols would help. It reads '
    + 'counts only — no names, no addresses, no households. It describes what has '
    + 'already been recorded and is not a forecast of future incidents.';
  body.appendChild(intro);

  const panel = AiToolPanel({
    collapsible: false,
    tool: {
      label: 'Threat Analyzer',
      input: 'none',
      emptyText: 'Run the analyzer to summarise the last 90 days and get patrol suggestions.',
      run: () => queueThreatAnalysis(),
    },
  });
  body.appendChild(panel.el);

  return { stop: panel.stop };
}
