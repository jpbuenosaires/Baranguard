<?php
declare(strict_types=1);

namespace Baranguard\Services\Notifications;

/**
 * Split into its own file rather than declared alongside FcmClient, on
 * purpose — this codebase already lost real time once (Sprint 1's own
 * DEVLOG entry) to an autoloader that maps class name -> exact filename,
 * where two classes sharing a file only "worked" by accident depending on
 * load order. One class per file, no exceptions.
 */
final class FcmException extends \RuntimeException
{
}
