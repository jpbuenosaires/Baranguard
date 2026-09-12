-- Rollback for 0018_sms_subscriber.sql.
--
-- WHAT ROLLING BACK DESTROYS, and why it deserves a moment's thought
-- before running: this table is the CONSENT RECORD. Dropping it does not
-- just remove a mailing list — it removes the evidence that each
-- resident on that list agreed to be on it, and the evidence that anyone
-- who withdrew was honoured. Under RA 10173 that record is the thing
-- that makes the broadcasts lawful.
--
-- If the subscriber feature is being withdrawn, export this table first.
-- If it is being rebuilt, the consents do not carry over and every
-- resident has to be asked again — which is the correct outcome, not an
-- inconvenience to engineer around.

DROP TABLE IF EXISTS sms_subscriber;
