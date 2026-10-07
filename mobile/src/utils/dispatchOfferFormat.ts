/**
 * dispatchOfferFormat.ts — display helpers for the night-dispatch offer cards.
 */

const INCIDENT_TYPE_LABELS: Record<string, string> = {
  theft: 'Theft',
  physical_injury: 'Physical Injury',
  disturbance: 'Disturbance',
  domestic_dispute: 'Domestic Dispute',
  vandalism: 'Vandalism',
  traffic_incident: 'Traffic Incident',
  fire: 'Fire',
  medical_emergency: 'Medical Emergency',
  missing_person: 'Missing Person',
  animal_complaint: 'Animal Complaint',
  other: 'Other Incident',
};

export function incidentTypeLabel(type: string): string {
  return INCIDENT_TYPE_LABELS[type] ?? (type ? type.replace(/_/g, ' ') : 'Incident');
}

/** "2:45" style countdown; never negative. */
export function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
