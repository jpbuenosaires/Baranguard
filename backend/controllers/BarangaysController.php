<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\Http;
use PDO;

/**
 * GET /barangays — Master Reference §6 "Reference / lookup" section, added
 * this session (2026-09-02 architecture review) so W19's public barangay
 * picker stops hardcoding `{id,name}` pairs in `citizen-report.js` — §8's
 * production-realism rule: "every barangay a screen offers must come from
 * this table, not a literal array in a component file."
 *
 * Public, no auth — W19 is reached with zero session (same reasoning as
 * `POST /citizen-reports`). Always returns exactly the four deterministic
 * seeded rows; nothing here is barangay-scoped since there's no caller
 * identity to scope by.
 */
final class BarangaysController
{
    public static function index(PDO $pdo): void
    {
        $stmt = $pdo->query('SELECT barangay_id, name, municipality, province FROM barangay ORDER BY barangay_id');
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $items = array_map(static function (array $row): array {
            return [
                'barangay_id' => (int) $row['barangay_id'],
                'name' => $row['name'],
                'municipality' => $row['municipality'],
                'province' => $row['province'],
            ];
        }, $rows);

        Http::send(200, ['items' => $items]);
    }
}
