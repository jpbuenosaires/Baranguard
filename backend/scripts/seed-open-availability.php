<?php
declare(strict_types=1);

/**
 * Test helper (verify-*.sh suites only, never production): prints ONE SQL
 * statement that gives every active `tanod` account (or only --user-ids)
 * a whole-day availability submission for every Asia/Manila date from
 * today-<days-back> to today+<days-ahead>.
 *
 * Why: since 2026-10-12 POST/PATCH /shifts refuses to schedule a tanod
 * outside their submitted availability (422 OUTSIDE_AVAILABILITY,
 * ShiftsController::assertWithinAvailability). Suites that test OTHER roster
 * rules (overlap, 12 h/day cap, publish, swaps, dispatch) seed open
 * availability first instead of weakening that rule.
 *
 * Windows are 00:00-23:59, which assertWithinAvailability() treats as
 * running to midnight, so any shift (including one crossing midnight) is
 * inside. INSERT IGNORE: re-running it, or running it after more tanods
 * were created, is safe (the (user, period) unique key skips existing rows).
 *
 * Usage: php seed-open-availability.php [--days-back=400] [--days-ahead=500] [--user-ids=4,5]
 *        | mysql <db>
 */

$opts = getopt('', ['days-back::', 'days-ahead::', 'user-ids::']);
$back = isset($opts['days-back']) ? max(0, (int) $opts['days-back']) : 400;
$ahead = isset($opts['days-ahead']) ? max(0, (int) $opts['days-ahead']) : 500;
$userIds = [];
if (isset($opts['user-ids']) && $opts['user-ids'] !== '') {
    foreach (explode(',', (string) $opts['user-ids']) as $id) {
        if (!ctype_digit(trim($id))) {
            fwrite(STDERR, "user-ids must be a comma-separated list of integers\n");
            exit(1);
        }
        $userIds[] = (int) trim($id);
    }
}

$today = new DateTimeImmutable('now', new DateTimeZone('+08:00'));
$start = $today->modify("-{$back} days")->format('Y-m-d');
$end = $today->modify("+{$ahead} days")->format('Y-m-d');
$windows = [];
for ($d = new DateTimeImmutable($start); $d->format('Y-m-d') <= $end; $d = $d->modify('+1 day')) {
    $windows[] = ['date' => $d->format('Y-m-d'), 'start' => '00:00', 'end' => '23:59'];
}
$json = json_encode($windows, JSON_UNESCAPED_SLASHES);

$where = "role = 'tanod' AND is_active = 1";
if ($userIds !== []) {
    $where .= ' AND user_id IN (' . implode(',', $userIds) . ')';
}

echo "INSERT IGNORE INTO tanod_availability
  (barangay_id, user_id, period_start, period_end, windows_json, status, version, client_event_id, created_at, updated_at)
SELECT barangay_id, user_id, '{$start}', '{$end}', '{$json}', 'submitted', 1, UUID(), UTC_TIMESTAMP(), UTC_TIMESTAMP()
  FROM user WHERE {$where};\n";
