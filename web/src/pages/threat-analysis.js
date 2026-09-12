import { AiToolPanel } from '../components/AiToolPanel.js';
import { queueThreatAnalysis } from '../api/apiClient.js';
import { DateRangePicker } from '../components/DateRangePicker.js';

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
  let currentRange = { mode: '90', from: null, to: null };

  const rangePicker = DateRangePicker({
    value: '90',
    ariaLabel: 'Threat analysis timeframe',
    onChange: (state) => {
      currentRange = state;
      updateContextLabel();
    },
  });
  currentRange = rangePicker.getState();
  pageHeader.actions.appendChild(rangePicker.el);

  const intro = document.createElement('p');
  intro.className = 'note';
  body.appendChild(intro);

  function updateContextLabel() {
    let windowLabel = 'the last 90 days';
    if (currentRange.mode === '7') windowLabel = 'the last 7 days';
    else if (currentRange.mode === '30') windowLabel = 'the last 30 days';
    else if (currentRange.mode === '90') windowLabel = 'the last 90 days';
    else if (currentRange.from && currentRange.to) {
      windowLabel = `the period ${currentRange.from} to ${currentRange.to}`;
    }

    intro.textContent =
      `Summarises recorded incidents for your barangay over ${windowLabel} by type, `
      + 'time of day, and day of week, then suggests targeted patrol roster adjustments. It reads '
      + 'aggregate counts only — no citizen names, no addresses, no personal identities. It describes historical '
      + 'incident patterns and is not a predictive forecast.';
  }
  updateContextLabel();

  const panel = AiToolPanel({
    collapsible: false,
    tool: {
      label: 'Threat Analyzer',
      input: 'none',
      emptyText: 'Run the analyzer to examine incident patterns and get non-predictive patrol suggestions.',
      run: () => {
        const payload = {};
        if (currentRange.mode === 'custom' && currentRange.from && currentRange.to) {
          payload.from = currentRange.from;
          payload.to = currentRange.to;
        } else if (['7', '30', '90'].includes(currentRange.mode)) {
          payload.days = Number(currentRange.mode);
        } else {
          payload.days = 90;
        }
        return queueThreatAnalysis(payload);
      },
    },
  });
  body.appendChild(panel.el);

  return {
    stop() {
      panel.stop();
      rangePicker.el.remove();
    },
  };
}
