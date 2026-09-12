<?php
declare(strict_types=1);

namespace Baranguard\Services\Sms;

use PDO;

/**
 * CitizenUpdateNotifier — closes the loop with the person who filed a
 * citizen report.
 *
 * THE GAP THIS FILLS: `citizen_report.contact_number` has been collected
 * since Sprint 1 and, until now, never used for anything. A resident
 * texted or submitted a report and then heard nothing — not when it was
 * accepted as an incident, not when it was resolved. The number was
 * gathered for exactly this purpose, so leaving it unused was both a
 * missed courtesy and, arguably, collecting data for a stated reason and
 * then not honouring it.
 *
 * §2 RULE 1 IS THE BINDING CONSTRAINT, and it shapes every message here:
 * an SMS leaves the system entirely, through a third-party gateway, so
 * **no narrative text of any kind may appear in one**. These messages
 * are fixed templates plus two identifiers — the barangay name and the
 * incident's `display_id`. No complainant name, no respondent name, no
 * address, no location description, no narrative, not even the incident
 * type (a "Physical Injury" notice arriving on a shared household phone
 * discloses something about the household). `display_id` is included
 * deliberately: it is the one thing that makes a follow-up call
 * possible, and it identifies a case, not a person.
 *
 * BEST-EFFORT, ALWAYS. Neither notification may ever fail the operation
 * that triggered it. A conversion is a records action and a resolution
 * is an operational one; a courtesy text failing — because Semaphore is
 * unconfigured, the number is wrong, or the gateway is down — must not
 * roll either back. Every entry point here swallows its own errors and
 * the caller is not told, because there is nothing the caller could
 * usefully do differently.
 *
 * IDEMPOTENT BY DETERMINISTIC CORRELATION. Each event derives a stable
 * `correlation_id` from its own identity, and a matching row already in
 * `sms_log` means the text was already sent. So a retried conversion, or
 * an incident that somehow passes through `resolved` twice, cannot text
 * the same resident twice about the same thing.
 *
 * WITHOUT SEMAPHORE CREDENTIALS (this workstation's normal state,
 * `docs/REMAINING.md` A4) `sendOutbound()` still writes the `sms_log`
 * row and marks it `failed` / `SEMAPHORE_NOT_CONFIGURED`. That is the
 * honest outcome and it is what makes this testable here: the intent,
 * recipient and body are all recorded truthfully, and nothing claims a
 * message was delivered when no gateway exists to deliver it.
 */
final class CitizenUpdateNotifier
{
    /** Sent when a citizen report is accepted and becomes a real incident. */
    public static function notifyReceived(PDO $pdo, int $reportId): void
    {
        self::notify($pdo, $reportId, 'received');
    }

    /** Sent when the incident a citizen report became is resolved. */
    public static function notifyResolved(PDO $pdo, int $reportId): void
    {
        self::notify($pdo, $reportId, 'resolved');
    }

    /**
     * Looks up the report, decides whether there is anyone to tell, and
     * sends at most once per (report, event).
     */
    private static function notify(PDO $pdo, int $reportId, string $event): void
    {
        try {
            $stmt = $pdo->prepare(
                'SELECT cr.report_id, cr.barangay_id, cr.contact_number, cr.incident_id,
                        b.name AS barangay_name, i.display_id
                   FROM citizen_report cr
                   JOIN barangay b ON b.barangay_id = cr.barangay_id
              LEFT JOIN incident i ON i.incident_id = cr.incident_id
                  WHERE cr.report_id = :report_id
                  LIMIT 1'
            );
            $stmt->execute(['report_id' => $reportId]);
            $report = $stmt->fetch(PDO::FETCH_ASSOC);

            // No report, or no number given — reporting anonymously is
            // allowed (`contact_number` is optional on submit), and there
            // is simply nobody to tell.
            if ($report === false || trim((string) ($report['contact_number'] ?? '')) === '') {
                return;
            }

            $correlationId = self::correlationId($reportId, $event);
            $seen = $pdo->prepare('SELECT 1 FROM sms_log WHERE correlation_id = :correlation_id LIMIT 1');
            $seen->execute(['correlation_id' => $correlationId]);
            if ($seen->fetchColumn() !== false) {
                return; // Already told them about this exact event.
            }

            $reference = trim((string) ($report['display_id'] ?? ''));
            $message = self::composeMessage($event, (string) $report['barangay_name'], $reference);

            (new SmsGatewayService())->sendOutbound(
                $pdo,
                'confirmation',
                false,
                $report['incident_id'] !== null ? (int) $report['incident_id'] : null,
                null,
                trim((string) $report['contact_number']),
                $message,
                (int) $report['barangay_id'],
                $correlationId,
                (int) $report['report_id']
            );
        } catch (\Throwable) {
            // See the class doc: a courtesy text must never fail the
            // records or dispatch action that triggered it.
        }
    }

    /**
     * Fixed templates. Taglish, matching how this barangay's outbound SMS
     * already reads elsewhere in the system rather than switching
     * register for these two messages only.
     *
     * The "huwag po ninyong sagutin" line is deliberate: replies to this
     * number land in the SMS Monitor inbox as untriaged inbound traffic,
     * and telling a resident their reply was read when nobody is
     * guaranteed to be watching would be a worse courtesy than saying so.
     */
    private static function composeMessage(string $event, string $barangayName, string $reference): string
    {
        $ref = $reference !== '' ? " Ref: {$reference}." : '';

        if ($event === 'received') {
            return "Barangay {$barangayName}: Naitala na po ang inyong ulat at ito ay aaksyunan.{$ref}"
                . ' Salamat po sa pag-uulat. Hindi po kailangang sagutin ang mensaheng ito.';
        }

        return "Barangay {$barangayName}: Ang inyong naiulat ay naisara na po bilang resolbado.{$ref}"
            . ' Salamat po sa inyong tulong. Hindi po kailangang sagutin ang mensaheng ito.';
    }

    /**
     * A stable, UUID-shaped id for one (report, event) pair.
     *
     * `sms_log.correlation_id` is CHAR(36) and every other writer puts a
     * UUID there, so this keeps the same shape rather than widening the
     * column or storing something that reads like corruption to anyone
     * inspecting the table. It is derived, not random, which is the
     * entire point — the same event recomputes the same id and the
     * duplicate check above finds it.
     */
    private static function correlationId(int $reportId, string $event): string
    {
        $h = md5("citizen-update:{$event}:{$reportId}");
        return sprintf(
            '%s-%s-4%s-8%s-%s',
            substr($h, 0, 8),
            substr($h, 8, 4),
            substr($h, 13, 3),
            substr($h, 17, 3),
            substr($h, 20, 12)
        );
    }
}
