-- Baranguard — Sprint 0 seed data
-- Seeds ONLY the four deterministic barangay rows (Master Reference §5,
-- Rule 10 in §2: "The four barangay IDs are fixed in the baseline
-- migration"). Do NOT seed incident/PII data here or in any dev/test
-- fixture derived from this file — §11's retention table has nothing to
-- do with seeding.
--
-- IDs are fixed/deterministic and must never be regenerated once assigned.
-- Safe to re-run: uses INSERT ... ON DUPLICATE KEY UPDATE keyed on the
-- fixed barangay_id, so re-seeding never creates duplicate rows or drifts
-- the deterministic IDs.

INSERT INTO barangay (barangay_id, name, municipality, province, population, boundary_geojson, created_at)
VALUES
  (1, 'Dao',         'Pilar', 'Sorsogon', NULL, NULL, UTC_TIMESTAMP()),
  (2, 'Binanuahan',   'Pilar', 'Sorsogon', NULL, NULL, UTC_TIMESTAMP()),
  (3, 'Marifosque',   'Pilar', 'Sorsogon', NULL, NULL, UTC_TIMESTAMP()),
  (4, 'Banuyo',        'Pilar', 'Sorsogon', NULL, NULL, UTC_TIMESTAMP())
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  municipality = VALUES(municipality),
  province = VALUES(province);
