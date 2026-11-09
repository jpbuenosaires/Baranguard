<?php
declare(strict_types=1);

namespace Baranguard\Controllers;

use Baranguard\Lib\Http;
use PDO;

/**
 * GET /barangays — public, no auth: the web public barangay picker and
 * the login screens read the barangay list from this table instead of a
 * hardcoded array. Always returns exactly the four deterministic seeded
 * rows; nothing here is barangay-scoped since there is no caller identity.
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
