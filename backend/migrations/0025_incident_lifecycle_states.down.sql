-- Rollback for 0025_incident_lifecycle_states.sql.
ALTER TABLE ai_processing_log DROP COLUMN prompt_template_version;

ALTER TABLE incident DROP FOREIGN KEY fk_incident_lifecycle_changed_by;
ALTER TABLE incident DROP FOREIGN KEY fk_incident_duplicate_of;
ALTER TABLE incident DROP INDEX idx_incident_duplicate_of;
ALTER TABLE incident DROP COLUMN lifecycle_changed_at;
ALTER TABLE incident DROP COLUMN lifecycle_changed_by;
ALTER TABLE incident DROP COLUMN duplicate_of_incident_id;

ALTER TABLE incident
  MODIFY COLUMN status ENUM('pending','dispatched','resolved') NOT NULL DEFAULT 'pending';
