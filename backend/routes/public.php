<?php
declare(strict_types=1);

/**
 * Route table for the PUBLIC, unauthenticated read surface.
 *
 * Kept in its own file rather than folded into reports.php on purpose:
 * every other route table in this directory is authenticated, and a
 * public route sitting among them is exactly the kind of thing that gets
 * added by pattern-matching a neighbour later. The `false` on the end of
 * each row here is load-bearing and should be visible in a file whose
 * name says so.
 *
 * Anything added here is readable by anyone who can reach the API, with
 * no session, role or tenant check whatsoever — so it must be aggregate,
 * suppressed, and free of anything joinable back to a person. See
 * PublicReportsController's class doc for the full set of rules.
 */

use Baranguard\Controllers\PublicReportsController;

return [
    ['GET', '#^/public/transparency$#', [PublicReportsController::class, 'transparency'], false],
];
