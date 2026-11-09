<?php
declare(strict_types=1);

/**
 * Route table for /search. Authenticated
 * — the topbar's real global search box.
 */

use Baranguard\Controllers\SearchController;

return [
    ['GET', '#^/search$#', [SearchController::class, 'index'], true],
];
