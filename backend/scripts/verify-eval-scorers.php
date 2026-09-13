<?php
declare(strict_types=1);

/**
 * verify-eval-scorers.php — hand-checked assertions against every new
 * scorer class in backend/services/eval/ (docs/REMAINING.md A6).
 *
 * These are pure functions with no DB/HTTP/Ollama dependency, so this is
 * a plain PHP assertion script (same convention generate-eval-dataset.php
 * already uses for its own self-validation) rather than a PHPUnit suite —
 * this repo has no Composer/PHPUnit dependency anywhere (deliberate, see
 * config/autoload.php's own docblock).
 *
 * Each check constructs an input with a KNOWN correct score by hand, so a
 * failure here means the scorer itself is wrong — not that the model
 * produced a bad output. This is what the plan this session wrote called
 * for instead of trusting scorer code the same way RegexRedactor's own
 * --engine=baseline path already gets exercised before ever touching a
 * real model.
 *
 * Usage: php scripts/verify-eval-scorers.php
 */

require dirname(__DIR__) . '/config/autoload.php';

use Baranguard\Services\Eval\ChecklistScorer;
use Baranguard\Services\Eval\ClassificationScorer;
use Baranguard\Services\Eval\ExtractionScorer;
use Baranguard\Services\Eval\RedactionScorer;

$pass = 0;
$fail = 0;

function check(string $label, bool $condition): void
{
    global $pass, $fail;
    if ($condition) {
        $pass++;
        echo "[PASS] {$label}\n";
    } else {
        $fail++;
        echo "[FAIL] {$label}\n";
    }
}

// --- RedactionScorer::score ------------------------------------------------

$entities = [['type' => 'NAME', 'text' => 'Juan Cruz'], ['type' => 'ADDRESS', 'text' => '12 Purok Maligaya']];
$r = RedactionScorer::score('Juan Cruz reported theft at 12 Purok Maligaya.', '[NAME] reported theft at [ADDRESS].', $entities, ['theft']);
check('RedactionScorer: both entities redacted -> tp=2 fn=0', $r['tp'] === 2 && $r['fn'] === 0);

$r = RedactionScorer::score('Juan Cruz reported theft at 12 Purok Maligaya.', 'Juan Cruz reported theft at [ADDRESS].', $entities, ['theft']);
check('RedactionScorer: NAME leaked -> fn=1, leaked contains it', $r['fn'] === 1 && in_array('Juan Cruz', $r['leaked'], true));

// Isolated: an extra placeholder beyond the entity count, with the
// must_keep word ("theft") left intact — must_keep must NOT also fire.
$r = RedactionScorer::score('Juan Cruz reported theft at 12 Purok Maligaya.', '[NAME] reported theft at [ADDRESS] and [ADDRESS].', $entities, ['theft']);
check('RedactionScorer: one extra placeholder beyond entity count -> fp=1', $r['fp'] === 1);

// Isolated: placeholder count matches entity count exactly (no over-
// redaction there), but the must_keep word ("theft") is gone from the
// output — must_keep's own check must fire alone.
$r = RedactionScorer::score('Juan Cruz reported theft at 12 Purok Maligaya.', '[NAME] reported burglary at [ADDRESS].', $entities, ['theft']);
check('RedactionScorer: must_keep word dropped -> fp counts it', $r['fp'] === 1);

// --- RedactionScorer::countLeaks ------------------------------------------

$leaks = RedactionScorer::countLeaks('Call 0917-555-2841 for help.', ['0917-555-2841']);
check('RedactionScorer::countLeaks: decoy present -> leakCount=1', $leaks['leakCount'] === 1);

$leaks = RedactionScorer::countLeaks('Call the barangay hall for help.', ['0917-555-2841']);
check('RedactionScorer::countLeaks: decoy absent -> leakCount=0', $leaks['leakCount'] === 0);

// --- RedactionScorer::deriveGoldRedacted ----------------------------------

$gold = RedactionScorer::deriveGoldRedacted('Juan Cruz lives at 12 Purok Maligaya.', $entities);
check('deriveGoldRedacted: both entities replaced with placeholders', $gold === '[NAME] lives at [ADDRESS].');

// Longest-match-first: a NAME that is a substring of a longer string must not corrupt it.
$overlap = [['type' => 'NAME', 'text' => 'Ana'], ['type' => 'NAME', 'text' => 'Ana Reyes']];
$gold = RedactionScorer::deriveGoldRedacted('Ana Reyes and Ana were both present.', $overlap);
check('deriveGoldRedacted: longest entity replaced before its substring', substr_count($gold, '[NAME]') === 2 && !str_contains($gold, 'Ana'));

// --- ExtractionScorer -------------------------------------------------------

$out = "Complainant: Juan Cruz\nRespondent: Pedro Reyes\nContact: 0917-555-2841";
$s = ExtractionScorer::score('Juan Cruz', 'Pedro Reyes', '0917-555-2841', $out);
check('ExtractionScorer: exact 3-field match', $s['complainant'] && $s['respondent'] && $s['contact']);

$out = "Complainant: Juan Cruz\nRespondent: \nContact: ";
$s = ExtractionScorer::score('Juan Cruz', '', '', $out);
check('ExtractionScorer: blank gold matches blank output', $s['complainant'] && $s['respondent'] && $s['contact']);

$out = "Complainant: Juan Cruz\nRespondent: Mario Reyes\nContact: 0917-555-2841";
$s = ExtractionScorer::score('Juan Cruz', 'Pedro Reyes', '0917-555-2841', $out);
check('ExtractionScorer: wrong respondent name -> respondent=false', $s['respondent'] === false);

$out = "Complainant: Juan Cruz\nRespondent: Someone Invented\nContact: ";
$s = ExtractionScorer::score('Juan Cruz', '', '', $out);
check('ExtractionScorer: hallucinated respondent when gold is blank -> false', $s['respondent'] === false);

// --- ClassificationScorer --------------------------------------------------

$out = "Type: fire\nPriority: critical\nReason: A fire was reported.";
$s = ClassificationScorer::score('fire', 'critical', $out);
check('ClassificationScorer: exact type+priority match', $s['typeMatch'] && $s['priorityMatch']);

$out = "Type: theft\nPriority: high\nReason: Something.";
$s = ClassificationScorer::score('fire', 'critical', $out);
check('ClassificationScorer: wrong type+priority -> both false', !$s['typeMatch'] && !$s['priorityMatch']);

// Case-insensitivity, since the prompt doesn't force the model's letter-casing.
$out = "Type: FIRE\nPriority: Critical\nReason: x";
$s = ClassificationScorer::score('fire', 'critical', $out);
check('ClassificationScorer: case-insensitive match', $s['typeMatch'] && $s['priorityMatch']);

// --- ChecklistScorer ---------------------------------------------------------

check('ChecklistScorer::placeholderCountsMatch: equal counts -> true',
    ChecklistScorer::placeholderCountsMatch('[NAME] and [NAME] met at [ADDRESS].', '[NAME] talked to [NAME] near [ADDRESS].'));
check('ChecklistScorer::placeholderCountsMatch: dropped placeholder -> false',
    !ChecklistScorer::placeholderCountsMatch('[NAME] and [NAME] met at [ADDRESS].', '[NAME] met at [ADDRESS].'));
check('ChecklistScorer::placeholderCountsMatch: invented placeholder -> false',
    !ChecklistScorer::placeholderCountsMatch('[NAME] met at [ADDRESS].', '[NAME] met [NAME] at [ADDRESS].'));

check('ChecklistScorer::sentenceCountInRange: 3 sentences in [2,4] -> true',
    ChecklistScorer::sentenceCountInRange('One. Two. Three.', 2, 4));
check('ChecklistScorer::sentenceCountInRange: 1 sentence outside [2,4] -> false',
    !ChecklistScorer::sentenceCountInRange('Just one sentence.', 2, 4));

check('ChecklistScorer::charCountAtMost: within limit -> true', ChecklistScorer::charCountAtMost('short text', 300));
check('ChecklistScorer::charCountAtMost: over limit -> false', !ChecklistScorer::charCountAtMost(str_repeat('x', 301), 300));

check('ChecklistScorer::noDenylistTerms: clean text -> true',
    ChecklistScorer::noDenylistTerms('Please stay safe.', ['guilty', 'penalty']));
check('ChecklistScorer::noDenylistTerms: denylisted word present -> false',
    !ChecklistScorer::noDenylistTerms('The respondent is guilty.', ['guilty', 'penalty']));

check('ChecklistScorer::mentionsAllFacts: all facts present -> true',
    ChecklistScorer::mentionsAllFacts('Water will be off tomorrow at the plaza.', ['tomorrow', 'plaza']));
check('ChecklistScorer::mentionsAllFacts: a fact missing -> false',
    !ChecklistScorer::mentionsAllFacts('Water will be off tomorrow.', ['tomorrow', 'plaza']));

$counts = [['label' => 'theft', 'count' => 5], ['label' => 'fire', 'count' => 2]];
$g = ChecklistScorer::numbersAreGrounded('Theft cases numbered 5 this period, fire cases 2.', $counts);
check('ChecklistScorer::numbersAreGrounded: only known numbers cited -> ok', $g['ok']);
$g = ChecklistScorer::numbersAreGrounded('Theft cases numbered 5, but a spike of 47 was also seen.', $counts);
check('ChecklistScorer::numbersAreGrounded: fabricated number 47 flagged', !$g['ok'] && in_array(47, $g['fabricated'], true));
$g = ChecklistScorer::numbersAreGrounded('At most 3 patrol suggestions follow, based on 5 theft cases.', $counts);
check('ChecklistScorer::numbersAreGrounded: small ignored number (3) does not false-positive', $g['ok']);

check('ChecklistScorer::containsAllHeaders: both present -> true',
    ChecklistScorer::containsAllHeaders("Patterns:\n- x\nSuggested patrols:\n- y", ['Patterns:', 'Suggested patrols:']));
check('ChecklistScorer::containsAllHeaders: one missing -> false',
    !ChecklistScorer::containsAllHeaders("Patterns:\n- x", ['Patterns:', 'Suggested patrols:']));

check('ChecklistScorer::bulletCount: counts dash-bullets only', ChecklistScorer::bulletCount("- one\n- two\nnot a bullet\n- three") === 3);

$summary = ChecklistScorer::summarize(['a' => true, 'b' => false, 'c' => true]);
check('ChecklistScorer::summarize: 2/3 passed, rate=0.667, failed=[b]', $summary['passed'] === 2 && $summary['total'] === 3 && $summary['failed'] === ['b']);

echo "\n{$pass} passed, {$fail} failed.\n";
exit($fail > 0 ? 1 : 0);
