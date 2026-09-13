<?php
declare(strict_types=1);

/**
 * generate-eval-dataset.php — builds the incident-narrative evaluation
 * corpus that backs redaction, extraction, classification, summary,
 * translation, and blotter-assist evaluation (docs/REMAINING.md A6).
 *
 * v2 (2026-09-14) extends the original 200-record redaction-only set:
 *  - 350 records (was 200) — sized so each of the 7 language buckets below
 *    gets ~50 records, which keeps the per-bucket margin of error
 *    reasonable at ~95% confidence / ~5-7% margin (see the plan this
 *    session wrote for the sample-size math; a flat 200/7≈29 per bucket
 *    would be noticeably noisier).
 *  - CODE-MIXED language buckets, not just monolingual en/tl/bcl. Real
 *    Bicol-region residents are typically multilingual and frequently
 *    switch between Bikol, Tagalog, and English within one account —
 *    a monolingual-only corpus tests an input shape real barangay
 *    narratives may rarely take in pure form. No prompt changed for
 *    this — AiPrompts::redaction()'s own rule already says to keep "the
 *    language the narrative is written in," which already covers mixed
 *    input; this is purely a dataset gap being closed, not a new
 *    requirement invented for testing.
 *  - `complainant`/`respondent`/`contact` ground truth, for the
 *    extraction task (AiPrompts::extraction()) — previously nothing in
 *    this repo distinguished "the reporting party" from "a witness" from
 *    "who the complaint is against."
 *  - `priority` ground truth, for the classification task
 *    (AiPrompts::classification()) — derived deterministically from
 *    `incident_type` using that prompt's OWN stated definition (critical
 *    = immediate threat to life or fire in progress; high = injury,
 *    ongoing confrontation, or likely to escalate; normal = everything
 *    else) — not an invented rule.
 *
 * WHY THIS EXISTS INSTEAD OF HAND-WRITTEN RECORDS: docs/AI_Evaluation_Dataset_Guide.md
 * originally assumed three people would hand-author this set. That didn't
 * happen — by explicit user decision (2026-09-07 session), this script
 * generates it instead, via template + pool synthesis rather than one-off
 * prose, so every entity/ground-truth string is guaranteed to appear
 * verbatim in its narrative (built by concatenating the exact same
 * variable into both places, never "typed twice") rather than relying on
 * a human to copy-paste correctly hundreds of times.
 *
 * HONESTY REQUIREMENT (matches this project's own no-fabrication rule):
 * the output file's top-level `generation_method` field says exactly how
 * this was produced, including that the Bikol (and code-mixed Bikol)
 * text is hand-template-authored by this script's author, not verified
 * by a native Bikol speaker or machine-translated. Do not remove or
 * soften that field.
 *
 * Every record is INVENTED — no real incident narrative was used or
 * consulted, satisfying the guide's one absolute rule (§1 of the guide).
 *
 * Usage:
 *   php scripts/generate-eval-dataset.php
 *   php scripts/generate-eval-dataset.php --out=fixtures/eval-incidents-v1.json --seed=42 --count=350
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

$options = ['out' => 'fixtures/eval-incidents-v1.json', 'seed' => 42, 'count' => 350];
foreach (array_slice($argv, 1) as $arg) {
    if (str_starts_with($arg, '--out=')) {
        $options['out'] = substr($arg, strlen('--out='));
    } elseif (str_starts_with($arg, '--seed=')) {
        $options['seed'] = (int) substr($arg, strlen('--seed='));
    } elseif (str_starts_with($arg, '--count=')) {
        $options['count'] = max(7, (int) substr($arg, strlen('--count=')));
    }
}
$outPath = $options['out'];
if (!str_starts_with($outPath, '/') && !preg_match('/^[A-Za-z]:/', $outPath)) {
    $outPath = dirname(__DIR__) . '/' . ltrim($outPath, '/');
}
$RECORD_COUNT = $options['count'];

mt_srand($options['seed']);

// --- Fixed vocabulary -------------------------------------------------

const INCIDENT_TYPES = [
    'theft', 'physical_injury', 'disturbance', 'domestic_dispute',
    'vandalism', 'traffic_incident', 'fire', 'medical_emergency',
    'missing_person', 'animal_complaint', 'other',
];
// The 7 language buckets: 3 pure (as the original v1 corpus had) + 4
// code-mixed combinations. Order within each bucket array is
// [primary language for the main sentence's grammar, ...other languages
// individual clauses may switch into].
const LANGUAGE_BUCKETS = [
    'en' => ['en'],
    'tl' => ['tl'],
    'bcl' => ['bcl'],
    'bcl-tl' => ['bcl', 'tl'],
    'bcl-en' => ['bcl', 'en'],
    'tl-en' => ['tl', 'en'],
    'bcl-tl-en' => ['bcl', 'tl', 'en'],
];
const BARANGAYS = ['Dao', 'Binanuahan', 'Marifosque', 'Banuyo']; // never an ADDRESS entity — §3 of the guide

// Incident types where a narrative can plausibly name a respondent (the
// person the complaint is against) as well as a complainant. Fire,
// medical_emergency, missing_person, animal_complaint, and other
// deliberately never get one — that mirrors AiPrompts::extraction()'s own
// note that "a narrative may have no identifiable respondent at all (for
// example a fire or an animal complaint) — that is expected."
const RESPONDENT_ELIGIBLE_TYPES = ['domestic_dispute', 'physical_injury', 'vandalism', 'disturbance', 'theft'];

/**
 * Gold priority, derived from AiPrompts::classification()'s OWN written
 * definitions — not an independently invented mapping. "critical" there
 * is defined as "immediate threat to life or a fire in progress"; "high"
 * as "injury, an ongoing confrontation, or a situation likely to
 * escalate"; "normal" is everything else.
 */
function priorityForType(string $type): string
{
    return match ($type) {
        'fire' => 'critical',
        'physical_injury', 'domestic_dispute', 'traffic_incident', 'medical_emergency' => 'high',
        default => 'normal',
    };
}

$FIRST_MALE = ['Jose', 'Juan', 'Pedro', 'Ramon', 'Antonio', 'Ricardo', 'Danilo', 'Rogelio', 'Ernesto', 'Roberto',
    'Eduardo', 'Manuel', 'Alfredo', 'Nestor', 'Romeo', 'Bienvenido', 'Cesar', 'Rolando', 'Arturo', 'Benjamin',
    'Carlos', 'Domingo', 'Elmer', 'Federico', 'Gregorio', 'Hernan', 'Isagani', 'Leonardo', 'Marcelo', 'Vicente'];
$FIRST_FEMALE = ['Rosalinda', 'Maria', 'Teresita', 'Gloria', 'Corazon', 'Josefina', 'Remedios', 'Consuelo', 'Aurora',
    'Leticia', 'Erlinda', 'Perlita', 'Norma', 'Estela', 'Milagros', 'Angelina', 'Bernadette', 'Carmelita', 'Divina',
    'Editha', 'Fe', 'Gemma', 'Herminia', 'Imelda', 'Julieta', 'Lourdes', 'Marilou', 'Nenita', 'Ofelia', 'Precy'];
// Mercado/Cruz/Reyes are the guide's own named homonym examples (market/cross/kings) — kept separate so the
// homonym hard-case generator can specifically choose from these three, never accidentally from the rest.
$HOMONYM_SURNAMES = ['Mercado', 'Cruz', 'Reyes'];
$SURNAMES = array_merge($HOMONYM_SURNAMES, ['Santos', 'Bautista', 'Ocampo', 'Garcia', 'Fernandez', 'Ramos', 'Torres',
    'Flores', 'Villanueva', 'Aquino', 'Mendoza', 'Gonzales', 'Pascual', 'Salazar', 'Rivera', 'Castillo', 'Navarro',
    'Manalo', 'Lazaro', 'Bermudez', 'Escobar', 'Padilla', 'Marasigan', 'Delacruz', 'Abad']);
// Ordinary puroks/sitios, plus a few that deliberately sound like landmarks (purok_landmark hard case).
$PUROKS = ['Purok Maligaya', 'Purok Bagong Silang', 'Purok Masagana', 'Purok Malinis', 'Purok Kalayaan',
    'Sitio Mabuhay', 'Sitio Kalinaw', 'Purok Sampaguita', 'Purok Ilang-Ilang', 'Sitio Bagong Buhay',
    'Purok Riverside', 'Purok Bayanihan', 'Sitio Look'];
$LANDMARK_PUROKS = ['Purok Simbahan', 'Purok Palengke', 'Purok Plaza']; // named like a landmark, but IS still an address
$DOMAINS = ['gmail.com', 'yahoo.com'];

// Non-entity "safe" fillers, always outside the entities list — used for must_keep and general color.
$TIME_PHRASES = [
    'en' => ['yesterday afternoon', 'last Monday morning', 'around three in the afternoon today', 'last night', 'this morning'],
    'tl' => ['kahapon ng hapon', 'noong Lunes ng umaga', 'kaninang alas-tres ng hapon', 'kagabi', 'ngayong umaga'],
    'bcl' => ['kasu-arado na hapon', 'kaidto Lunes na aga', 'kasu-ina na alas-tres kan hapon', 'kagab-i', 'ngonyan na aga'],
];
$LANDMARK_PHRASES = [
    'en' => ['near the market', 'at the plaza', 'near the church', 'along the road', 'at the tricycle terminal'],
    'tl' => ['malapit sa palengke', 'sa plaza', 'malapit sa simbahan', 'sa kalsada', 'sa terminal ng traysikel'],
    'bcl' => ['harani sa palengke', 'sa plasa', 'harani sa simbahan', 'sa dalan', 'sa terminal kan traysikel'],
];

// --- Per-incident-type scenario + witness content ----------------------
// Each entry: 'scenario' template with {ITEM}, list of item words (become
// must_keep candidates), and an optional 'witness' template family.
// {NAME1}/{NAME2}/{PLATE}/{TIME}/{PLACE} are substituted by the caller,
// which is also where the exact entity/must_keep strings get recorded —
// never re-derived by searching the rendered text afterward.

// NOTE: every template below contains a literal {ITEM} token that the
// chosen item word is substituted into — must_keep only ever records the
// ONE item word actually picked, so it must always be the same string
// that lands in the rendered narrative. A template that hard-codes a word
// instead of using {ITEM} silently breaks that guarantee (caught the hard
// way while validating this file — see DEVLOG).
$SCENARIOS = [
    'theft' => [
        'en' => ['reported that {POSS} {ITEM} was stolen {TIME}', ['cellphone', 'wallet', 'bicycle', 'grocery bag', 'motorcycle']],
        'tl' => ['na nawala ang kanyang {ITEM} {TIME}', ['selpon', 'pitaka', 'bisikleta', 'motorsiklo']],
        'bcl' => ['na nawara an saiyang {ITEM} {TIME}', ['selpon', 'pitaka', 'bisikleta']],
    ],
    'physical_injury' => [
        'en' => ['was hurt in a {ITEM} {TIME}', ['fistfight', 'altercation']],
        'tl' => ['nasaktan sa isang {ITEM} {TIME}', ['suntukan', 'gulo']],
        'bcl' => ['nasakitan sa sarong {ITEM} {TIME}', ['ribok']],
    ],
    'disturbance' => [
        'en' => ['complained about a {ITEM} {TIME}', ['loud videoke session', 'noisy street party']],
        'tl' => ['nagreklamo tungkol sa {ITEM} {TIME}', ['maingay na videoke', 'malakas na ingay sa kalye']],
        'bcl' => ['nagreklamo manongod sa {ITEM} {TIME}', ['maribok na videoke', 'makusog na ribok sa dalan']],
    ],
    'domestic_dispute' => [
        'en' => ['reported a loud {ITEM} at home {TIME}', ['quarrel', 'shouting match']],
        'tl' => ['may malakas na {ITEM} sa bahay {TIME}', ['away', 'sigawan']],
        'bcl' => ['igwang makusog na {ITEM} sa harong {TIME}', ['iriwal']],
    ],
    'vandalism' => [
        'en' => ['reported that the {ITEM} was vandalized {TIME}', ['fence', 'wall']],
        'tl' => ['na-graffiti ang {ITEM} {TIME}', ['bakod', 'pader']],
        'bcl' => ['na-graffiti an {ITEM} {TIME}', ['bakod']],
    ],
    'traffic_incident' => [
        'en' => ['reported a road accident involving a {ITEM} {TIME}', ['tricycle', 'motorcycle']],
        'tl' => ['may aksidente sa kalsada na may kinalaman sa {ITEM} {TIME}', ['traysikel', 'motorsiklo']],
        'bcl' => ['igwang aksidente sa dalan na kaiba an {ITEM} {TIME}', ['traysikel', 'motorsiklo']],
    ],
    'fire' => [
        'en' => ['reported a fire that started near the {ITEM} {TIME}', ['kitchen', 'cooking gas tank']],
        'tl' => ['may sunog na nagsimula malapit sa {ITEM} {TIME}', ['kusina', 'gasul']],
        'bcl' => ['igwang sunog na nagpoon harani sa {ITEM} {TIME}', ['kusina']],
    ],
    'medical_emergency' => [
        'en' => ['reported that a family member had a {ITEM} {TIME}', ['fainting spell', 'high fever']],
        'tl' => ['nagkaroon ng {ITEM} ang isang kapamilya {TIME}', ['pagkahimatay', 'lagnat']],
        'bcl' => ['nagkaigwa nin {ITEM} an sarong kapamilya {TIME}', ['pagkasuba']],
    ],
    'missing_person' => [
        'en' => ['reported that a family member has been {ITEM} since {TIME}', ['missing', 'unreachable']],
        'tl' => ['{ITEM} ang isang kapamilya mula pa {TIME}', ['nawawala', 'hindi na nakontak']],
        'bcl' => ['{ITEM} an sarong kapamilya poon pa {TIME}', ['nawawara']],
    ],
    'animal_complaint' => [
        'en' => ['complained about a {ITEM} {TIME}', ['stray dog roaming the area', 'loose carabao blocking the road']],
        'tl' => ['nagreklamo tungkol sa {ITEM} {TIME}', ['gala-galang aso', 'nakawalang kalabaw']],
        'bcl' => ['nagreklamo manongod sa {ITEM} {TIME}', ['nagraralakaw-lakaw na ayam']],
    ],
    'other' => [
        'en' => ['filed a {ITEM} {TIME}', ['general complaint', 'formal complaint']],
        'tl' => ['naghain ng {ITEM} {TIME}', ['reklamo']],
        'bcl' => ['naghain nin {ITEM} {TIME}', ['reklamo']],
    ],
];

$WITNESS_SUSPECT = [
    'en' => ' {NAME2} witnessed the suspect flee on a motorcycle with plate number {PLATE}.',
    'tl' => ' Nakita ni {NAME2} ang suspek na tumakas sakay ng motorsiklo na may plate number na {PLATE}.',
    'bcl' => ' Naheling ni {NAME2} an suspetsado na naglayas sakay nin motorsiklo na may plaka na {PLATE}.',
];
$WITNESS_PLAIN = [
    'en' => ' {NAME2}, a neighbor, confirmed what happened {PLACE}.',
    'tl' => ' Kinumpirma ni {NAME2}, na kapitbahay, ang pangyayari {PLACE}.',
    'bcl' => ' Kinumpirma ni {NAME2}, na kataed, an nangyari {PLACE}.',
];
// Respondent clause — "the complaint is against {NAME3}." Kept structurally
// parallel across the three languages, same pattern as the witness
// templates above (direct, simple sentences, not idiomatic prose) — this
// is hand-authored, not independently verified Bikol, disclosed in
// generation_method below, same caveat the file already carried for
// every other Bikol string here.
$RESPONDENT_CLAUSE = [
    'en' => ' {NAME1} identified {NAME3} as the person responsible.',
    'tl' => ' Itinuro ni {NAME1} si {NAME3} bilang responsable.',
    'bcl' => ' Itinukdo ni {NAME1} si {NAME3} bilang responsable.',
];

// --- Helpers -------------------------------------------------------------

function pick(array $pool)
{
    return $pool[array_rand($pool)];
}

function chance(int $percent): bool
{
    return mt_rand(1, 100) <= $percent;
}

function fullName(string $first, string $last): string
{
    return $first . ' ' . $last;
}

function randPhone(): string
{
    return sprintf('09%02d-%03d-%04d', mt_rand(10, 99), mt_rand(0, 999), mt_rand(0, 9999));
}

function randPlate(): string
{
    $letters = '';
    for ($i = 0; $i < 3; $i++) {
        $letters .= chr(mt_rand(65, 90));
    }
    return $letters . ' ' . mt_rand(1000, 9999);
}

function randIdNumber(): string
{
    return sprintf('%04d-%04d-%04d', mt_rand(1000, 9999), mt_rand(1000, 9999), mt_rand(1000, 9999));
}

function randDob(): string
{
    $months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return pick($months) . ' ' . mt_rand(1, 28) . ', ' . mt_rand(1958, 2002);
}

function randEmail(string $first, string $last, array $domains): string
{
    return strtolower($first) . '.' . strtolower($last) . mt_rand(1, 99) . '@' . pick($domains);
}

function randAccountHandle(string $first): string
{
    return '@' . strtolower($first) . '_' . mt_rand(10, 999);
}

function addressString(string $purok): string
{
    return mt_rand(1, 99) . ' ' . $purok;
}

/**
 * Substitutes {TOKEN} placeholders and returns the rendered string. Every
 * value substituted here is the SAME variable recorded as an entity by the
 * caller — this function never invents a new copy of the text.
 */
function render(string $template, array $values): string
{
    return strtr($template, $values);
}

// --- Record builder --------------------------------------------------

/**
 * @param string[] $langMix One (pure) to three (code-mixed) language codes.
 *                          $langMix[0] is the primary language, used for
 *                          the main reporting sentence's grammar; every
 *                          OTHER appended clause (witness, respondent,
 *                          extra sentences, homonym aside) independently
 *                          picks a language from the full set — this is
 *                          what makes a multi-language record realistic
 *                          inter-sentential code-switching rather than
 *                          one clause bolted onto an otherwise-monolingual
 *                          narrative.
 * @return array{narrative:string,entities:array<int,array{type:string,text:string}>,must_keep:string[],complainant:string,respondent:string,contact:string}
 */
function buildRecord(string $type, array $langMix, ?string $hardCase, array $vocab): array
{
    ['FIRST_MALE' => $firstMale, 'FIRST_FEMALE' => $firstFemale, 'SURNAMES' => $surnames,
        'HOMONYM_SURNAMES' => $homonyms, 'PUROKS' => $puroks, 'LANDMARK_PUROKS' => $landmarkPuroks,
        'DOMAINS' => $domains, 'TIME_PHRASES' => $timePhrases, 'LANDMARK_PHRASES' => $landmarkPhrases,
        'SCENARIOS' => $scenarios, 'WITNESS_SUSPECT' => $witnessSuspect, 'WITNESS_PLAIN' => $witnessPlain,
        'RESPONDENT_CLAUSE' => $respondentClause,
    ] = $vocab;

    $lang = $langMix[0]; // primary language, drives the main sentence's grammar
    $entities = [];
    $mustKeep = [];
    $complainant = '';
    $respondent = '';
    $contact = '';

    // --- No-PII branch: a fully anonymized event report. No name, no
    // specific purok (a purok IS an address per the guide's own rule, so
    // naming one here would silently reintroduce PII into a record meant
    // to have none), no phone, no plate.
    if ($hardCase === 'no_pii') {
        [$scenarioTpl, $itemWords] = $scenarios[$type][$lang];
        $time = pick($timePhrases[$lang]);
        $place = pick($landmarkPhrases[$lang]);
        $item = pick($itemWords);
        $scenario = render($scenarioTpl, ['{ITEM}' => $item, '{TIME}' => $time, '{POSS}' => 'their']);
        $barangay = pick(BARANGAYS);

        $narrative = match ($lang) {
            'en' => "An unnamed resident of Barangay {$barangay} {$scenario} {$place}. Barangay tanods were requested to check the area.",
            'tl' => "May isang residente ng Barangay {$barangay} {$scenario} {$place}. Hiniling na tingnan ito ng mga tanod.",
            'bcl' => "May sarong residente kan Barangay {$barangay} {$scenario} {$place}. Hinagad na checkon iyan kan mga tanod.",
        };
        $mustKeep = array_slice(array_unique([$item, wordFromPhrase($place)]), 0, 3);
        return [
            'narrative' => $narrative, 'entities' => [], 'must_keep' => $mustKeep,
            'complainant' => '', 'respondent' => '', 'contact' => '',
        ];
    }

    // --- Name selection, including the two "hard" surname patterns.
    $gender1 = chance(50) ? 'm' : 'f';
    $first1 = $gender1 === 'm' ? pick($firstMale) : pick($firstFemale);
    $last1 = $hardCase === 'homonym_surname' ? pick($homonyms) : pick($surnames);
    $name1 = fullName($first1, $last1);
    $entities[] = ['type' => 'NAME', 'text' => $name1];
    $complainant = $name1;

    $useWitness = $hardCase === 'duplicate_surname' || chance(55);
    $name2 = null;
    if ($useWitness) {
        $gender2 = chance(50) ? 'm' : 'f';
        $first2 = $gender2 === 'm' ? pick($firstMale) : pick($firstFemale);
        $last2 = $hardCase === 'duplicate_surname' ? $last1 : pick($surnames);
        // Avoid an accidental identical full name (would collapse to one entity).
        if ($first2 === $first1 && $last2 === $last1) {
            $first2 = pick(array_diff($gender2 === 'm' ? $firstMale : $firstFemale, [$first1]));
        }
        $name2 = fullName($first2, $last2);
        $entities[] = ['type' => 'NAME', 'text' => $name2];
    }

    // --- Address.
    $purok = $hardCase === 'purok_landmark' ? pick($landmarkPuroks) : pick($puroks);
    $address = addressString($purok);
    $entities[] = ['type' => 'ADDRESS', 'text' => $address];

    // --- Scenario clause.
    [$scenarioTpl, $itemWords] = $scenarios[$type][$lang];
    $time = pick($timePhrases[$lang]);
    $place = pick($landmarkPhrases[$lang]);
    $item = pick($itemWords);
    $possessive = $gender1 === 'm' ? 'his' : 'her';
    $scenario = render($scenarioTpl, ['{ITEM}' => $item, '{TIME}' => $time, '{POSS}' => $possessive]);

    // --- Phone (most records).
    $phone = null;
    if (chance(85)) {
        $phone = randPhone();
        $entities[] = ['type' => 'PHONE', 'text' => $phone];
        $contact = $phone;
    }

    // --- Optional rarer categories, each its own sentence appended at the
    // end, each independently choosing a clause language from the full
    // mix (this is where code-mixed records actually switch languages).
    $extraSentences = [];

    $idNumber = null;
    if (chance(12) || $hardCase === 'fake_id_decoy') {
        $clauseLang = pick($langMix);
        $idNumber = randIdNumber();
        $entities[] = ['type' => 'ID_NUMBER', 'text' => $idNumber];
        $extraSentences[] = match ($clauseLang) {
            'en' => "{$first1} presented an ID number {$idNumber} for verification.",
            'tl' => "Nagpakita si {$first1} ng ID number na {$idNumber} para sa beripikasyon.",
            'bcl' => "Nagpaheling si {$first1} nin ID number na {$idNumber} para sa beripikasyon.",
        };
    }

    if (chance(10)) {
        $clauseLang = pick($langMix);
        $email = randEmail($first1, $last1, $domains);
        $entities[] = ['type' => 'EMAIL', 'text' => $email];
        $extraSentences[] = match ($clauseLang) {
            'en' => "{$first1} may also be reached at {$email}.",
            'tl' => "Maaari ring makontak si {$first1} sa {$email}.",
            'bcl' => "Puwede man ma-contact si {$first1} sa {$email}.",
        };
    }

    if (chance(10)) {
        $clauseLang = pick($langMix);
        $dob = randDob();
        $entities[] = ['type' => 'DATE_OF_BIRTH', 'text' => $dob];
        $extraSentences[] = match ($clauseLang) {
            'en' => "{$first1} was born on {$dob}.",
            'tl' => "Ipinanganak si {$first1} noong {$dob}.",
            'bcl' => "Namundag si {$first1} kan {$dob}.",
        };
    }

    if (chance(8)) {
        $clauseLang = pick($langMix);
        $account = randAccountHandle($first1);
        $entities[] = ['type' => 'ACCOUNT', 'text' => $account];
        $extraSentences[] = match ($clauseLang) {
            'en' => "{$first1} can also be reached through the social media account {$account}.",
            'tl' => "Maaari ring i-contact si {$first1} sa social media account na {$account}.",
            'bcl' => "Puwede man ma-contact si {$first1} sa social media account na {$account}.",
        };
    }

    // --- Respondent (who the complaint is against) — only for eligible
    // types, and only sometimes, so plenty of records legitimately have
    // no respondent at all (extraction's own "leave it blank" case).
    if (in_array($type, RESPONDENT_ELIGIBLE_TYPES, true) && chance(45)) {
        $clauseLang = pick($langMix);
        $gender3 = chance(50) ? 'm' : 'f';
        $pool3 = $gender3 === 'm' ? $firstMale : $firstFemale;
        $first3 = pick($pool3);
        // Avoid colliding with name1/name2 so the three stay distinguishable.
        $taken = array_filter([$first1, $name2 !== null ? explode(' ', $name2)[0] : null]);
        if (in_array($first3, $taken, true)) {
            $alt = array_diff($pool3, $taken);
            $first3 = $alt !== [] ? pick($alt) : $first3;
        }
        $last3 = pick($surnames);
        $name3 = fullName($first3, $last3);
        $entities[] = ['type' => 'NAME', 'text' => $name3];
        $respondent = $name3;
        $respondentSentence = render($respondentClause[$clauseLang], ['{NAME1}' => $name1, '{NAME3}' => $name3]);
    } else {
        $respondentSentence = '';
    }

    // --- Fake-ID decoy hard case: a plausible-looking case/reference number
    // that is deliberately NOT a planted entity — tests over-redaction.
    $decoySentence = '';
    if ($hardCase === 'fake_id_decoy') {
        $clauseLang = pick($langMix);
        $caseNo = 'Case No. 2026-' . mt_rand(1000, 9999);
        $decoySentence = match ($clauseLang) {
            'en' => " This was logged under {$caseNo}.",
            'tl' => " Naitala ito sa ilalim ng {$caseNo}.",
            'bcl' => " Naireport ini sa irarom kan {$caseNo}.",
        };
        // Deliberately NOT added to $entities.
    }

    // --- Witness clause.
    $witnessSentence = '';
    if ($name2 !== null) {
        $clauseLang = pick($langMix);
        $wantsPlate = $useWitness && in_array($type, ['theft', 'vandalism', 'traffic_incident'], true) && chance(70);
        if ($wantsPlate) {
            $plate = randPlate();
            $entities[] = ['type' => 'PLATE_NUMBER', 'text' => $plate];
            $witnessSentence = render($witnessSuspect[$clauseLang], ['{NAME2}' => $name2, '{PLATE}' => $plate]);
            $mustKeep[] = wordFromPhrase(match ($clauseLang) { 'en' => 'motorcycle', 'tl' => 'motorsiklo', 'bcl' => 'motorsiklo' });
        } else {
            $witnessSentence = render($witnessPlain[$clauseLang], ['{NAME2}' => $name2, '{PLACE}' => $place]);
        }
    }

    // --- Untitled-mid-sentence hard case: rebuild the opening clause so the
    // reporter's name has no preceding cue word ("si"/"ni"/no comma-led intro).
    if ($hardCase === 'untitled_midsentence') {
        $narrative = match ($lang) {
            'en' => "A barangay tanod on patrol encountered {$name1}, who {$scenario} {$time} {$place}, living at {$address}, with contact number " . ($phone ?? 'not on file') . ".",
            'tl' => "Habang naka-patrol, nakasalubong ng tanod si {$name1} na {$scenario} {$time} {$place}, naninirahan sa {$address}, may contact number na " . ($phone ?? 'wala sa file') . ".",
            'bcl' => "Mantang nagpapatrol, nakaentra kan tanod si {$name1} na {$scenario} {$time} {$place}, nag-iistar sa {$address}, may contact number na " . ($phone ?? 'mayong file') . ".",
        };
    } else {
        $narrative = match ($lang) {
            'en' => "{$name1}, residing at {$address}, reported that {$possessive} {$scenario} {$place}. {$name1}'s contact number is " . ($phone ?? 'not on file') . ".",
            'tl' => "Nagreklamo si {$name1}, na naninirahan sa {$address}, na {$scenario} {$place}. Ang contact number ni {$name1} ay " . ($phone ?? 'wala sa file') . ".",
            'bcl' => "Nagreklamo si {$name1}, na nag-iistar sa {$address}, na {$scenario} {$place}. An contact number ni {$name1} iyo an " . ($phone ?? 'mayong file') . ".",
        };
    }

    // --- Homonym hard case: plant the SAME surface word as an ordinary
    // common noun elsewhere in the narrative (Mercado=market, Cruz=cross),
    // never tagged as an entity there.
    if ($hardCase === 'homonym_surname') {
        $clauseLang = pick($langMix);
        $commonNounSentence = match ($last1) {
            'Mercado' => match ($clauseLang) {
                'en' => ' The incident happened near the mercado where vendors were setting up.',
                'tl' => ' Ang pangyayari ay malapit sa mercado kung saan naghahanda ang mga tindero.',
                'bcl' => ' An pangyayari harani sa mercado na inaandam kan mga paratinda.',
            },
            'Cruz' => match ($clauseLang) {
                'en' => ' Bystanders were gathered near the small cruz marker by the roadside.',
                'tl' => ' Nagtipon ang mga saksi malapit sa cruz sa gilid ng kalsada.',
                'bcl' => ' Nagtiripon an mga saksi harani sa cruz sa gilid kan dalan.',
            },
            default => '', // Reyes has no everyday common-noun use — no forced sentence.
        };
        $narrative .= $commonNounSentence;
    }

    $narrative .= $witnessSentence . $respondentSentence . implode('', $extraSentences) . $decoySentence;

    $mustKeep = array_values(array_unique(array_merge($mustKeep, [$item, wordFromPhrase($place)])));
    $mustKeep = array_slice($mustKeep, 0, 4);
    if (count($mustKeep) < 2) {
        $mustKeep[] = wordFromPhrase($time);
    }

    return [
        'narrative' => trim($narrative), 'entities' => $entities, 'must_keep' => $mustKeep,
        'complainant' => $complainant, 'respondent' => $respondent, 'contact' => $contact,
    ];
}

/** Pulls one safe, short content word out of a filler phrase for must_keep. */
function wordFromPhrase(string $phrase): string
{
    $stop = ['sa', 'ng', 'ang', 'the', 'a', 'an', 'at', 'near', 'malapit', 'harani', 'kan', 'na', 'noong', 'kaidto', 'today', 'kaninang', 'kasu-ina', 'ngayong', 'ngonyan'];
    $words = preg_split('/\s+/', trim($phrase));
    foreach (array_reverse($words) as $w) {
        $clean = trim($w, '.,');
        if (!in_array(strtolower($clean), $stop, true) && mb_strlen($clean) > 2) {
            return $clean;
        }
    }
    return trim(end($words), '.,');
}

// --- Build the record plan -------------------------------------------

// Language-bucket assignment: as close to an even split across the 7
// buckets as $RECORD_COUNT allows, remainder distributed to the first
// few buckets rather than silently dropped.
$bucketKeys = array_keys(LANGUAGE_BUCKETS);
$bucketCount = count($bucketKeys);
$perBucket = intdiv($RECORD_COUNT, $bucketCount);
$remainder = $RECORD_COUNT % $bucketCount;
$langPlan = [];
foreach ($bucketKeys as $i => $key) {
    $n = $perBucket + ($i < $remainder ? 1 : 0);
    for ($j = 0; $j < $n; $j++) {
        $langPlan[] = $key;
    }
}
shuffle($langPlan);

// Type assignment: round-robin over the 11 types so counts are within 1 of each other.
$typePlan = [];
for ($i = 0; $i < $RECORD_COUNT; $i++) {
    $typePlan[] = INCIDENT_TYPES[$i % count(INCIDENT_TYPES)];
}
shuffle($typePlan);

// Hard-case tags: proportional to the original 40/200 (20%) ratio, spread
// across random distinct slots.
$hardCasePlan = array_fill(0, $RECORD_COUNT, null);
$tagRatios = ['homonym_surname' => 8, 'duplicate_surname' => 6, 'untitled_midsentence' => 6,
    'purok_landmark' => 4, 'fake_id_decoy' => 4, 'no_pii' => 10, 'formatting_oddity' => 2]; // out of /200
$tagCounts = [];
foreach ($tagRatios as $tag => $per200) {
    $tagCounts[$tag] = (int) round($per200 * $RECORD_COUNT / 200);
}
$slots = range(0, $RECORD_COUNT - 1);
shuffle($slots);
$cursor = 0;
foreach ($tagCounts as $tag => $count) {
    for ($i = 0; $i < $count && $cursor < count($slots); $i++) {
        $hardCasePlan[$slots[$cursor]] = $tag;
        $cursor++;
    }
}

$vocab = [
    'FIRST_MALE' => $FIRST_MALE, 'FIRST_FEMALE' => $FIRST_FEMALE, 'SURNAMES' => $SURNAMES,
    'HOMONYM_SURNAMES' => $HOMONYM_SURNAMES, 'PUROKS' => $PUROKS, 'LANDMARK_PUROKS' => $LANDMARK_PUROKS,
    'DOMAINS' => $DOMAINS, 'TIME_PHRASES' => $TIME_PHRASES, 'LANDMARK_PHRASES' => $LANDMARK_PHRASES,
    'SCENARIOS' => $SCENARIOS, 'WITNESS_SUSPECT' => $WITNESS_SUSPECT, 'WITNESS_PLAIN' => $WITNESS_PLAIN,
    'RESPONDENT_CLAUSE' => $RESPONDENT_CLAUSE,
];

$records = [];
for ($i = 0; $i < $RECORD_COUNT; $i++) {
    $type = $typePlan[$i];
    $langLabel = $langPlan[$i];
    $langMix = LANGUAGE_BUCKETS[$langLabel];
    $hardCase = $hardCasePlan[$i];

    $built = buildRecord($type, $langMix, $hardCase === 'formatting_oddity' ? null : $hardCase, $vocab);
    $narrative = $built['narrative'];

    if ($hardCase === 'formatting_oddity') {
        if (chance(50)) {
            $narrative = strtoupper($narrative);
        } else {
            $stripped = preg_replace('/[.,]/', '', $narrative);
            // Stripping punctuation corrupts any entity whose OWN text contains
            // a period or comma (an EMAIL address, or a DATE_OF_BIRTH like
            // "January 5, 1990") — fall back to uppercasing instead of
            // producing a record whose planted entities no longer appear.
            $corrupts = false;
            foreach ($built['entities'] as $e) {
                if (mb_stripos($stripped, $e['text']) === false) {
                    $corrupts = true;
                    break;
                }
            }
            $narrative = $corrupts ? strtoupper($narrative) : $stripped;
        }
    }

    $id = sprintf('eval-%03d', $i + 1);
    $records[] = [
        'id' => $id,
        'author' => 'AI',
        'incident_type' => $type,
        'priority' => priorityForType($type),
        'language' => $langLabel,
        'language_mix' => $langMix,
        'hard_case' => $hardCase,
        'narrative' => $narrative,
        'entities' => $built['entities'],
        'must_keep' => $built['must_keep'],
        'complainant' => $built['complainant'],
        'respondent' => $built['respondent'],
        'contact' => $built['contact'],
    ];
}

// --- Self-validation ----------------------------------------------------

$errors = [];
$idsSeen = [];
foreach ($records as $r) {
    if (isset($idsSeen[$r['id']])) {
        $errors[] = "duplicate id {$r['id']}";
    }
    $idsSeen[$r['id']] = true;

    $isAllCaps = preg_match('/[A-Z]{2,}/', $r['narrative']) && $r['hard_case'] === 'formatting_oddity';

    foreach ($r['entities'] as $e) {
        if (!$isAllCaps && mb_strpos($r['narrative'], $e['text']) === false) {
            $errors[] = "{$r['id']}: entity '{$e['text']}' ({$e['type']}) not found verbatim in narrative";
        }
    }
    foreach ($r['must_keep'] as $mk) {
        if (mb_stripos($r['narrative'], $mk) === false) {
            $errors[] = "{$r['id']}: must_keep '{$mk}' not found in narrative";
        }
    }
    // The three ground-truth extraction fields must each be either empty
    // or a string that genuinely appears in the narrative — same
    // verbatim-or-nothing discipline as entities/must_keep, since these
    // are exactly the entity strings above, just labeled by role.
    foreach (['complainant', 'respondent', 'contact'] as $field) {
        $value = (string) $r[$field];
        if ($value !== '' && !$isAllCaps && mb_strpos($r['narrative'], $value) === false) {
            $errors[] = "{$r['id']}: {$field} '{$value}' not found verbatim in narrative";
        }
    }
    if (!in_array($r['priority'], ['normal', 'high', 'critical'], true)) {
        $errors[] = "{$r['id']}: invalid priority '{$r['priority']}'";
    }
}
// formatting_oddity records are uppercased/stripped after the fact, so an exact-case
// substring check would false-positive on them — they're excluded above via the
// ALL-CAPS heuristic and validated separately here with a case-insensitive check.
foreach ($records as $r) {
    if ($r['hard_case'] !== 'formatting_oddity') {
        continue;
    }
    foreach ($r['entities'] as $e) {
        if (mb_stripos($r['narrative'], $e['text']) === false) {
            $errors[] = "{$r['id']}: entity '{$e['text']}' not found (case-insensitive) in formatting-oddity narrative";
        }
    }
    foreach (['complainant', 'respondent', 'contact'] as $field) {
        $value = (string) $r[$field];
        if ($value !== '' && mb_stripos($r['narrative'], $value) === false) {
            $errors[] = "{$r['id']}: {$field} '{$value}' not found (case-insensitive) in formatting-oddity narrative";
        }
    }
}

if (count($idsSeen) !== $RECORD_COUNT) {
    $errors[] = "expected {$RECORD_COUNT} unique ids, got " . count($idsSeen);
}

if ($errors !== []) {
    fwrite(STDERR, "VALIDATION FAILED (" . count($errors) . " problems):\n");
    foreach (array_slice($errors, 0, 30) as $e) {
        fwrite(STDERR, "  - {$e}\n");
    }
    exit(1);
}

// --- Coverage report -----------------------------------------------------

$byType = array_count_values(array_column($records, 'incident_type'));
$byPriority = array_count_values(array_column($records, 'priority'));
$byLang = array_count_values(array_column($records, 'language'));
$byHardCase = array_count_values(array_filter(array_column($records, 'hard_case')));
$noPii = count(array_filter($records, fn ($r) => $r['entities'] === []));
$withRespondent = count(array_filter($records, fn ($r) => $r['respondent'] !== ''));
$entityTypeCounts = [];
foreach ($records as $r) {
    foreach ($r['entities'] as $e) {
        $entityTypeCounts[$e['type']] = ($entityTypeCounts[$e['type']] ?? 0) + 1;
    }
}

fwrite(STDOUT, "Validation passed: {$RECORD_COUNT} unique records, every entity/must_keep/extraction-field string found verbatim.\n\n");
fwrite(STDOUT, "By incident_type: " . json_encode($byType) . "\n");
fwrite(STDOUT, "By priority:      " . json_encode($byPriority) . "\n");
fwrite(STDOUT, "By language:      " . json_encode($byLang) . "\n");
fwrite(STDOUT, "By hard_case:     " . json_encode($byHardCase) . " (+ {$noPii} no-PII records)\n");
fwrite(STDOUT, "By entity type:   " . json_encode($entityTypeCounts) . "\n");
fwrite(STDOUT, "With a respondent named: {$withRespondent}\n");

// --- Write output --------------------------------------------------------

$output = [
    'dataset_name' => 'eval-incidents-v1',
    'dataset_version' => 'v1',
    'generation_method' => 'AI-generated via template+pool synthesis (backend/scripts/generate-eval-dataset.php) per docs/AI_Evaluation_Dataset_Guide.md. NOT independently authored by three human labelers as the guide originally assumed. Every record is invented; no real incident narrative was used. Bikol (bcl) text, including in every bcl-tl/bcl-en/bcl-tl-en code-mixed record, is hand-template-authored by this script\'s (non-native-speaker) author -- NOT machine-translated and NOT yet verified by a native Bikol speaker. The `priority` field is derived deterministically from `incident_type` using AiPrompts::classification()\'s own written definition, not independently labeled. Recommend a human spot-check pass before treating results as final capstone evidence, especially the Bikol and code-mixed subsets, where generation quality is least certain.',
    'generated_at' => gmdate('c'),
    'record_count' => count($records),
    'language_buckets' => array_keys(LANGUAGE_BUCKETS),
    'records' => $records,
];

if (!is_dir(dirname($outPath))) {
    mkdir(dirname($outPath), 0777, true);
}
file_put_contents($outPath, json_encode($output, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
fwrite(STDOUT, "\nWrote " . count($records) . " records to {$outPath}\n");
