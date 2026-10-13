-- Reverts 0043. Fails if two barangays already hold the same code (that is the case 0043 exists to allow).
ALTER TABLE incident
  DROP INDEX IF EXISTS uq_incident_barangay_display,
  ADD UNIQUE KEY IF NOT EXISTS uq_incident_display_id (display_id);
