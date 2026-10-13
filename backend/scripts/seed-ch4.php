<?php
declare(strict_types=1);

/**
 * seed-ch4.php - Chapter 4 data seed for Baranguard: ONE barangay (Dao,
 * barangay_id 1), a fresh database named `baranguard_ch4`.
 *
 * *** EVERYTHING THIS SCRIPT WRITES IS SIMULATED TEST DATA. ***
 * It exists so every screen has realistic content for screenshots and so the
 * ISO/IEC 25010 test runs have a known, repeatable dataset. It is NOT field
 * data. Do not report any figure in it as a measured result of real tanod
 * use; report it as "simulated test data". The script writes the ground
 * truth it generated to backend/storage/ch4-seed-manifest.json so test
 * outputs can be checked against known counts.
 *
 * Repeatable: the same --seed gives the same shape of data (same accounts, same
 * volumes, same mix). Dates are relative to the moment you run it so the dashboard
 * always looks "recent", which means individual rows can differ slightly between
 * runs on different days; the manifest records the exact figures of each run.
 *
 * SAFETY: refuses to run unless --db is literally "baranguard_ch4" (or, with
 * --profile=uat, "baranguard_uat"). It never touches `baranguard` or
 * `baranguard_uiseed`. Normally run through
 * backend/scripts/reset-ch4.ps1, which drops + recreates the database,
 * applies every migration, then calls this.
 *
 * Usage: php scripts/seed-ch4.php [--db=baranguard_ch4] [--seed=2026] [--days=30]
 * DB connection: host/port from backend/.env (DB_HOST/DB_PORT); user from the
 * CH4_DB_USER env var (default root), password from CH4_DB_PASSWORD.
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "CLI only.\n");
    exit(1);
}

$opts = getopt('', ['db::', 'seed::', 'days::', 'profile::']);
$dbName = (string) ($opts['db'] ?? 'baranguard_ch4');
$seedNo = (int) ($opts['seed'] ?? 2026);
$DAYS = max(7, min(90, (int) ($opts['days'] ?? 30)));
// Profile "uat" (database baranguard_uat) is the final-testing dataset: the same
// simulated Dao history, plus fixtures arranged so every scenario in the UAT
// sign-off form (docs/chapter4-instruments/04-uat-signoff.html) has the data it
// needs. See docs/UAT_DATA_REQUIREMENTS.md. Any other combination is refused.
$PROFILE = (string) ($opts['profile'] ?? ($dbName === 'baranguard_uat' ? 'uat' : 'ch4'));
$UAT = $PROFILE === 'uat';
if (!in_array($dbName, ['baranguard_ch4', 'baranguard_uat'], true) || $UAT !== ($dbName === 'baranguard_uat')) {
    fwrite(STDERR, "Refusing to run: --db '{$dbName}' with --profile '{$PROFILE}'. Allowed: baranguard_ch4 (profile ch4) or baranguard_uat (profile uat).\n");
    exit(1);
}

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();
$host = baranguard_env('DB_HOST') ?: '127.0.0.1';
$port = baranguard_env('DB_PORT') ?: '3306';
$dbUser = getenv('CH4_DB_USER') !== false && getenv('CH4_DB_USER') !== '' ? getenv('CH4_DB_USER') : 'root';
$dbPass = getenv('CH4_DB_PASSWORD') !== false ? getenv('CH4_DB_PASSWORD') : '';
$pdo = new PDO("mysql:host={$host};port={$port};dbname={$dbName};charset=utf8mb4", $dbUser, $dbPass, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES => false,
]);
$pdo->exec("SET time_zone = '+00:00'");

mt_srand($seedNo);

const BARANGAY_ID = 1;
// Password for every seeded account: Demo@2026 (same hash as the other seeds).
const DEMO_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=4,p=1$ZmYwUTFDWGpDdVhIbWhvQg$JNTncGjMGRrxGskIsG4HC9zTPdDofF/yt9sfVDAR2G8';
const PHT_OFFSET_H = 8; // Philippines is UTC+8; the database stores UTC.

function uuidv4(): string
{
    $d = '';
    for ($i = 0; $i < 16; $i++) $d .= chr(mt_rand(0, 255)); // seeded -> repeatable
    $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
    $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
}
function pick(array $a) { return $a[mt_rand(0, count($a) - 1)]; }
function chance(int $pct): bool { return mt_rand(1, 100) <= $pct; }
function fmt(DateTimeImmutable $d): string { return $d->format('Y-m-d H:i:s'); }
function frand(float $a, float $b): float { return $a + (mt_rand() / mt_getrandmax()) * ($b - $a); }
/** weighted pick: ['key' => weight, ...] */
function wpick(array $w): string
{
    $t = array_sum($w); $r = mt_rand(1, (int) round($t * 1000)) / 1000.0; $acc = 0.0;
    foreach ($w as $k => $v) { $acc += $v; if ($r <= $acc) return (string) $k; }
    return (string) array_key_last($w);
}
/** bulk insert in chunks; $rows = list of assoc arrays with identical keys */
function bulk(PDO $pdo, string $table, array $rows, int $chunk = 400): void
{
    if (!$rows) return;
    $cols = array_keys($rows[0]);
    $colSql = '`' . implode('`,`', $cols) . '`';
    $one = '(' . implode(',', array_fill(0, count($cols), '?')) . ')';
    foreach (array_chunk($rows, $chunk) as $part) {
        $stmt = $pdo->prepare("INSERT INTO `{$table}` ({$colSql}) VALUES " . implode(',', array_fill(0, count($part), $one)));
        $vals = [];
        foreach ($part as $r) foreach ($cols as $c) $vals[] = $r[$c];
        $stmt->execute($vals);
    }
}

$now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
// $today is the Philippine calendar date (as a UTC-midnight object); add (hour - 8) hours to get a real UTC instant for a PHT clock time.
$today = $now->modify('+' . PHT_OFFSET_H . ' hours')->setTime(0, 0, 0);
/** a UTC moment for "N days ago at HH:MM Philippine time" */
function phtMoment(DateTimeImmutable $base, int $daysAgo, int $h, int $m, int $s = 0): DateTimeImmutable
{
    return $base->modify("-{$daysAgo} days")->setTime($h, $m, $s)->modify('-' . PHT_OFFSET_H . ' hours');
}

// ---- Real-geography data, lifted from the earlier Dao seed ------------------
$LOCATIONS = [
    ['Purok 1, near the water station', 12.9235, 123.6710],
    ['Purok 1, sari-sari store along the seawall road', 12.9201, 123.6708],
    ['Purok 2, backyard pens behind the chapel', 12.9231, 123.6718],
    ['Purok 2, corner house near the sari-sari store', 12.9228, 123.6715],
    ['Chapel courtyard, Purok 2', 12.9230, 123.6720],
    ['Purok 3, along the barangay road', 12.9219, 123.6701],
    ['Purok 3, beside the covered basketball court', 12.9215, 123.6733],
    ['Purok 4, near the barangay road interior', 12.9217, 123.6740],
    ['Purok 4, riverside', 12.9212, 123.6750],
    ['Purok 5, riverside path near the small bridge', 12.9226, 123.6742],
    ['Purok 5, second house from the corner', 12.9235, 123.6745],
    ['Purok 6, near the creek crossing', 12.9202, 123.6728],
    ['Purok 6, near the chapel', 12.9210, 123.6722],
    ['National road, Dao junction', 12.9240, 123.6729],
    ['National road, near the waiting shed', 12.9247, 123.6719],
    ['National road, near the barangay boundary (Marifosque side)', 12.9238, 123.6712],
    ['National road, near the rice fields', 12.9243, 123.6733],
    ['Barangay hall, Dao proper', 12.9223, 123.6725],
    ['Barangay hall perimeter wall', 12.9224, 123.6726],
    ['Near the elementary school gate', 12.9208, 123.6716],
    ['Road in front of the elementary school', 12.9206, 123.6714],
    ['Waiting shed, national road', 12.9244, 123.6708],
    ['Seawall near the Fishery Brokers\' Center', 12.9198, 123.6702],
    ['Fish landing area beside the seawall', 12.9195, 123.6705],
    ['Backyard near the rice paddies, boundary with Santa Fe', 12.9250, 123.6738],
];

$NAMES = [
    'Marites Obligar', 'Ronaldo Fajardo', 'Cristina Belga', 'Danilo Escobal', 'Perla Guinto',
    'Warlito Nacpil', 'Josefina Rebutazo', 'Alvin Torreliza', 'Emelita Sabater', 'Restituto Balane',
    'Leonora Escoto', 'Gerardo Villagracia', 'Fe Domagsang', 'Rodrigo Parcon', 'Teresita Abrera',
    'Bonifacio Guray', 'Analiza Fetalvero', 'Melchor Grepo', 'Concepcion Ranises', 'Edgardo Sabornido',
];

// --- Narrative templates: [type][lang] => array of template strings.
// {A}/{B} are alternation slots, {N} is a purok number 1-6. Written with
// real vocabulary in each language, not machine-translated filler.
$TEMPLATES = [
    'theft' => [
        'en' => [
            'A {A} was taken from {B} while the owner was away. No witnesses have come forward yet.',
            'Resident reported {A} missing after leaving {B} unattended for a short time.',
        ],
        'tl' => [
            'May nawalang {A} sa labas habang wala ang may-ari. Wala pang saksi na lumabas.',
            'Nag-report ang residente na nawala ang {A} matapos iwanang bantay ang {B} ng ilang minuto lamang.',
        ],
        'bik' => [
            'May nawara na {A} mientras wara an kagsadiri. Mayo pang testigo na nagpahayag.',
            'Nagreport an residente na nawara an {A} pagkatapos bayaan an {B} nin pira ka minuto sana.',
        ],
    ],
    'disturbance' => [
        'en' => [
            'Group of {A} drinking and shouting late at night, disturbing nearby residents.',
            'Loud argument and shouting reported along the road; no weapons involved.',
        ],
        'tl' => [
            'Grupo ng mga {A} na umiinom at sumisigaw nang gabing-gabi, nakakagambala sa mga kapitbahay.',
            'May naiulat na malakas na away at sigawan sa daan; walang gamit na sandata.',
        ],
        'bik' => [
            'Grupo nin mga {A} na nag-iinom asin nagkukurahaw sa gab-i, nakaki-istorbo sa mga kataraed.',
            'May report nin makusog na iriwal asin kurahaw sa tinampo; mayo nin ginamit na armas.',
        ],
    ],
    'animal_complaint' => [
        'en' => [
            'Stray dogs gathering near the school during dismissal time. No bites reported.',
            'Resident reports a neighbor\'s {A} repeatedly entering their yard and damaging plants.',
        ],
        'tl' => [
            'Maraming askal na nagtitipon malapit sa paaralan tuwing oras ng uwian. Walang naiulat na kagat.',
            'Nagreklamo ang residente tungkol sa {A} ng kapitbahay na paulit-ulit na pumapasok sa bakuran.',
        ],
        'bik' => [
            'Dakol na ayam na nagtitiripon harani sa eskwelahan pag-oras nin pag-uli. Mayo nin naireport na pangkagat.',
            'Nagreklamo an residente sa {A} kan kataraed na parateng nagsusulod sa harong-baybay.',
        ],
    ],
    'vandalism' => [
        'en' => [
            'Spray paint discovered on the barangay hall wall this morning. Person(s) responsible unknown.',
            'Property damage reported — a fence was deliberately broken overnight.',
        ],
        'tl' => [
            'May nakitang graffiti sa pader ng barangay hall ngayong umaga. Hindi pa kilala ang gumawa.',
            'May naiulat na sinasadyang pagkasira ng bakod kagabi.',
        ],
        'bik' => [
            'May nahiling na graffiti sa pader kan barangay hall ngunyan na aga. Dai pa aram kun siisay an naggibo.',
            'May report nin tuyong pagkarawa kan bakod kagab-i.',
        ],
    ],
    'traffic_incident' => [
        'en' => [
            'Motorcycle skidded on the wet road; rider sustained minor abrasions and is conscious.',
            'Two-vehicle collision along the national road; no serious injuries reported.',
        ],
        'tl' => [
            'Naduling ang motorsiklo sa basang kalsada; may malay ang driver, may bahagyang sugat.',
            'Banggaan ng dalawang sasakyan sa national road; walang seryosong sugat na naiulat.',
        ],
        'bik' => [
            'Naduhagi an motorsiklo sa basang tinampo; may malay an nagmamaneho, may gamay na sugat.',
            'Nagbanggaan an duwang sakyan sa national road; mayo nin grabeng sugat na naireport.',
        ],
    ],
    'fire' => [
        'en' => [
            'Cooking fire spread to a kitchen wall; neighbors helped put it out. No injuries.',
            'Small grass fire reported near the rice fields, possibly from unattended burning.',
        ],
        'tl' => [
            'Kumalat ang sunog mula sa lutuan patungo sa pader ng kusina; tinulungan ito ng mga kapitbahay na patayin. Walang nasugatan.',
            'May naiulat na maliit na sunog sa damo malapit sa palayan, posibleng mula sa hindi binantayang pagsunog.',
        ],
        'bik' => [
            'Naglakop an kalayo hale sa lutuan pasiring sa pader kan kusina; nagbulig an mga kataraed na paluon iyan. Mayo nin nasugatan.',
            'May report nin sadit na sunog sa doot harani sa oma, tibaad hale sa daing bantay na pagsulo.',
        ],
    ],
    'medical_emergency' => [
        'en' => [
            'Elderly resident collapsed at home, breathing but unresponsive. Family requesting immediate transport.',
            'Pregnant resident reporting early labor signs; family requesting assistance to reach the health center.',
        ],
        'tl' => [
            'Matandang residente ang nabuwal sa bahay, may hininga pero hindi tumutugon. Humihingi ng agarang saklolo ang pamilya.',
            'May buntis na residente na nagpapakita ng senyales ng maagang panganganak; humihingi ng tulong ang pamilya.',
        ],
        'bik' => [
            'An gurang na residente nabuka sa harong, nakakahangos alagad dai nagrerespondi. Naghahagad nin tulong an pamilya.',
            'May bados na residente na may senyas nin maaga na pangaanak; naghahagad nin tabang an pamilya.',
        ],
    ],
    'missing_person' => [
        'en' => [
            'Child did not return home from school. Last seen wearing a white school uniform.',
            'Elderly resident wandered off earlier today; family searching nearby areas.',
        ],
        'tl' => [
            'Hindi umuwi mula sa paaralan ang bata. Huling nakita na nakasuot ng puting uniporme.',
            'May matandang residente na naglakad palayo kaninang araw; naghahanap ang pamilya sa mga karatig na lugar.',
        ],
        'bik' => [
            'Dai nag-uli hale sa eskwelahan an aki. Huring nahiling na nakasulot nin puting uniporme.',
            'May gurang na residente na naglakaw palayo kasu-kasu na aldaw; naghahanap an pamilya sa mga kataraed na lugar.',
        ],
    ],
    'physical_injury' => [
        'en' => [
            'Fistfight between two men after a drinking session; one sustained a cut above the eye.',
            'Resident injured after falling from a ladder while doing yard work.',
        ],
        'tl' => [
            'Nagsuntukan ang dalawang lalaki matapos ang inuman; may sugat sa ibabaw ng mata ang isa.',
            'Nasugatan ang residente matapos mahulog sa hagdan habang naglilinis ng bakuran.',
        ],
        'bik' => [
            'Nagsusumbagan an duwang lalaki pagkatapos nin pag-inom; may sugat sa ibabaw kan mata an saro.',
            'Nasugatan an residente pagkatapos na mahulog sa hagdan mientras naglilinig kan harong-baybay.',
        ],
    ],
    'domestic_dispute' => [
        'en' => [
            'Loud argument between spouses reported by a neighbor. No weapons, no injuries reported.',
            'Family dispute over a debt escalated into shouting; barangay tanod requested to mediate.',
        ],
        'tl' => [
            'May naiulat na malakas na away ng mag-asawa mula sa kapitbahay. Walang sandata, walang sugat.',
            'Umigting ang alitan ng pamilya tungkol sa utang hanggang sa sigawan; hiniling ang tanod para mamagitan.',
        ],
        'bik' => [
            'May report nin makusog na iriwal kan mag-agom hale sa kataraed. Mayo nin armas, mayo nin sugat.',
            'Naglala an ka-iriwalan kan pamilya manongod sa utang sagkod sa kurahaw; hinagad an tanod na mamagitan.',
        ],
    ],
    'other' => [
        'en' => [
            'Street light has been out for several nights; residents requesting repair.',
            'Resident reporting a foul odor coming from a clogged drainage near their home.',
        ],
        'tl' => [
            'Ilang gabi nang sira ang ilaw ng poste; humihiling ang mga residente ng ayos.',
            'May residenteng nag-uulat ng masangsang na amoy mula sa nakasarang kanal malapit sa bahay nila.',
        ],
        'bik' => [
            'Pira ng banggi na luyop an ilaw kan poste; naghahagad an mga residente nin ayos.',
            'May residente na nagrereport nin maalot na baho hale sa nakasarang kanal harani sa harong ninda.',
        ],
    ],
];

// Per-language slot fillers — a template's {A}/{B} must only ever be
// filled with a word IN THAT TEMPLATE'S OWN LANGUAGE (an earlier version
// of this script shared one Tagalog-only pool across all three languages
// and produced sentences like "A damit sa sampayan was taken..." —
// fixed by keying every slot pool by language too).
$SLOT_A = [
    'theft' => [
        'en' => ['bicycle', 'cellphone', 'cash', 'chickens', 'laundry from the clothesline'],
        'tl' => ['bisikleta', 'cellphone', 'pera', 'manok', 'damit sa sampayan'],
        'bik' => ['bisikleta', 'cellphone', 'kwarta', 'manok', 'bado sa sampayan'],
    ],
    'disturbance' => [
        'en' => ['men', 'youths'],
        'tl' => ['lalaki', 'kabataan'],
        'bik' => ['lalaki', 'hoben'],
    ],
    'animal_complaint' => [
        'en' => ['carabao', 'goat', 'pig'],
        'tl' => ['kalabaw', 'kambing', 'baboy'],
        'bik' => ['kalabaw', 'kanding', 'baboy'],
    ],
];
$SLOT_B = [
    'theft' => [
        'en' => ['the house', 'the store', 'the yard'],
        'tl' => ['bahay', 'tindahan', 'bakuran'],
        'bik' => ['harong', 'tindahan', 'harong-baybay'],
    ],
];

// --- Type distribution (sums to 123) ---


$TYPE_W = [
    'theft' => 17.9, 'disturbance' => 16.3, 'animal_complaint' => 11.4, 'vandalism' => 6.5,
    'traffic_incident' => 9.8, 'domestic_dispute' => 11.4, 'physical_injury' => 8.1,
    'medical_emergency' => 6.5, 'fire' => 2.4, 'missing_person' => 2.4, 'other' => 7.3,
];
$PRIORITY_BY_TYPE = [
    'fire' => 'critical', 'medical_emergency' => 'critical', 'missing_person' => 'critical',
    'physical_injury' => 'high', 'domestic_dispute' => 'high', 'traffic_incident' => 'high',
    'theft' => 'normal', 'disturbance' => 'normal', 'animal_complaint' => 'normal',
    'vandalism' => 'normal', 'other' => 'normal',
];
$RESPONDENT_ELIGIBLE_TYPES = ['domestic_dispute', 'physical_injury', 'vandalism'];
// Annex C-1 text for a school-zone incident: short, factual, no names, and always about what the tanod met OUTSIDE the school.
$C1_SUMMARY = [
    'theft' => 'Report of a lost or stolen item on the road outside the school gate.',
    'disturbance' => 'Disturbance on the road outside the school gate during the school day.',
    'animal_complaint' => 'Stray dogs gathered outside the school gate around dismissal time.',
    'vandalism' => 'Damage to a wall or fence along the school perimeter, seen from the road.',
    'traffic_incident' => 'Traffic incident on the road in front of the school.',
    'fire' => 'Small grass fire near the school perimeter, outside the grounds.',
    'medical_emergency' => 'Person needing medical help on the road outside the school.',
    'missing_person' => 'Report of a child who did not reach home after school; searched outside the grounds.',
    'physical_injury' => 'Person injured on the road near the school gate.',
    'domestic_dispute' => 'Dispute between adults on the road near the school gate.',
    'other' => 'Street or drainage concern on the road beside the school.',
];
$C1_ACTION = [
    'Tanod responded at the gate and the road outside; the school head was informed.',
    'Tanod kept the road clear outside the school and referred the matter to the proper office.',
    'Tanod responded outside the school grounds and stayed until the area was safe.',
];
// Hour-of-day (Philippine time) weights: evenings and late nights are busier.
$HOUR_W = [0 => 3, 1 => 2, 2 => 2, 3 => 1, 4 => 1, 5 => 2, 6 => 3, 7 => 4, 8 => 4, 9 => 4, 10 => 4, 11 => 4,
    12 => 4, 13 => 4, 14 => 4, 15 => 5, 16 => 6, 17 => 7, 18 => 9, 19 => 10, 20 => 10, 21 => 9, 22 => 7, 23 => 5];

$M = ['label' => 'SIMULATED TEST DATA - Chapter 4 seed (not field data)', 'seed' => $seedNo, 'days' => $DAYS,
    'generated_at_utc' => fmt($now), 'barangay' => 'Dao (barangay_id 1)', 'password_for_all_accounts' => 'Demo@2026'];

$pdo->exec('SET FOREIGN_KEY_CHECKS=0');
foreach ($pdo->query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type='BASE TABLE' AND table_name <> 'barangay'")->fetchAll() as $r) {
    $pdo->exec('TRUNCATE TABLE `' . $r['t'] . '`');
}
$pdo->beginTransaction();
try {
    // ---------------------------------------------------------------- users
    $roster = [
        ['admin.dao', 'Ernesto Lagrimas', 'admin', 'Chief Tanod', '', 0],
        ['secretary.dao', 'Rosario Dimaano', 'secretary', 'Barangay Secretary', 'note_report,prepare_annex_d', 0],
        ['punong.dao', 'Hernando Beltran', 'punong_barangay', 'Punong Barangay', 'approve_report,approve_roster,approve_annex_d', 0],
        ['tanod.reyes', 'Elmer Reyes', 'tanod', null, '', 0],
        ['tanod.delacruz', 'Joselito Dela Cruz', 'tanod', null, '', 0],
        ['tanod.gubaton', 'Ramil Gubaton', 'tanod', null, '', 0],
        ['tanod.dichoso', 'Arnel Dichoso', 'tanod', null, '', 0],
        ['tanod.espinosa', 'Nestor Espinosa', 'tanod', null, '', 0],
        ['tanod.banares', 'Rolando Banares', 'tanod', null, '', 0],
        ['tanod.candelaria', 'Edwin Candelaria', 'tanod', null, '', 0],
        ['tanod.olayvar', 'Mario Olayvar', 'tanod', null, '', 1], // suspended, to show the state
    ];
    $insUser = $pdo->prepare('INSERT INTO user (barangay_id, username, password_hash, full_name, role, contact_number, is_active, created_at, official_title, approval_authority, is_suspended, suspended_reason, suspended_at)
        VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?)');
    $uid = [];
    foreach ($roster as $i => [$un, $fn, $role, $title, $auth, $susp]) {
        $insUser->execute([BARANGAY_ID, $un, DEMO_PASSWORD_HASH, $fn, $role, '0917' . (9100000 + $i * 111), fmt($now->modify('-' . ($DAYS + 60) . ' days')),
            $title, $auth, $susp, $susp ? 'Simulated suspension (demo of the suspended state)' : null, $susp ? fmt($now->modify('-9 days')) : null]);
        $uid[$un] = (int) $pdo->lastInsertId();
    }
    $ADMIN = $uid['admin.dao']; $SEC = $uid['secretary.dao']; $PB = $uid['punong.dao'];
    $tanodNames = ['tanod.reyes', 'tanod.delacruz', 'tanod.gubaton', 'tanod.dichoso', 'tanod.espinosa', 'tanod.banares', 'tanod.candelaria'];
    $TANODS = array_map(fn($n) => $uid[$n], $tanodNames);          // active tanods
    $contactOf = [];
    foreach ($pdo->query('SELECT user_id, contact_number FROM user')->fetchAll() as $r) $contactOf[(int) $r['user_id']] = $r['contact_number'];

    // -------------------------------------------------------- mobile devices
    $deviceOf = [];
    $devRows = [];
    foreach ($TANODS as $i => $t) {
        $deviceOf[$t] = 'ch4-sim-device-' . ($i + 1);
        $devRows[] = ['device_id' => $deviceOf[$t], 'user_id' => $t, 'platform' => 'android', 'fcm_token' => 'ch4-simulated-fcm-token-' . ($i + 1),
            'device_secret_ref' => null, 'device_public_key_pem' => null, 'app_version' => '1.0.0-sim',
            'last_seen_at' => fmt($now->modify('-' . mt_rand(1, 20) . ' minutes')), 'is_active' => 1,
            'created_at' => fmt($now->modify('-' . ($DAYS + 30) . ' days')), 'deactivated_at' => null, 'secrets_scrubbed_at' => null];
    }
    bulk($pdo, 'mobile_device', $devRows);

    // --------------------------------------------------------------- schools
    $schoolDefs = [
        ['Dao Elementary School', 'public', 'primary_elementary', 'Dao, Pilar, Sorsogon', 'Simulated focal person A', 12.9208, 123.6716],
        ['Dao Day Care Center', 'public', 'preschool_daycare_eccd', 'Purok 2, Dao, Pilar, Sorsogon', 'Simulated focal person B', 12.9229, 123.6719],
        ['Dao Learning Center (sample private school)', 'private', 'secondary_high_school', 'Purok 4, Dao, Pilar, Sorsogon', 'Simulated focal person C', 12.9217, 123.6741],
    ];
    $insSchool = $pdo->prepare('INSERT INTO school (barangay_id,name,school_type,level,address,focal_person,focal_contact,remarks,latitude,longitude,is_active,created_by,client_request_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)');
    $schoolId = [];
    foreach ($schoolDefs as $i => $s) {
        $created = fmt($now->modify('-' . ($DAYS + 20) . ' days'));
        $insSchool->execute([BARANGAY_ID, $s[0], $s[1], $s[2], $s[3], $s[4], '09175550' . (100 + $i), 'Simulated record for Chapter 4 test data.', $s[5], $s[6], $SEC, uuidv4(), $created, $created]);
        $schoolId[$i] = (int) $pdo->lastInsertId();
    }

    // ------------------------------------------------------------- incidents
    $N = (int) round($DAYS * 5.3);
    // UAT: a deeper pending queue (every scenario that dispatches, broadcasts or reopens consumes one) and
    // five dispatched incidents (2 live + 3 whose dispatches are all completed, awaiting the Admin's resolve).
    $statusPlan = array_merge(array_fill(0, $UAT ? 12 : 4, 'pending'), array_fill(0, 5, 'dispatched'), array_fill(0, 3, 'cancelled'),
        array_fill(0, 4, 'duplicate'), array_fill(0, 3, 'invalid'), array_fill(0, 2, 'reopened'));
    $statusPlan = array_pad($statusPlan, $N, 'resolved');
    // shuffle (seeded) except we want pending/dispatched to be the newest
    $recentStatuses = ['pending', 'dispatched'];
    $specs = [];
    foreach ($statusPlan as $st) {
        $type = wpick($TYPE_W);
        if (in_array($st, $recentStatuses, true)) {
            $created = $UAT ? $now->modify('-' . mt_rand(90, 600) . ' minutes') : $now->modify('-' . mt_rand(12, 1700) . ' minutes');
        } else {
            $try = 0;
            do {
                $daysAgo = mt_rand(0, $DAYS - 1);
                $hour = (int) wpick($HOUR_W);
                $created = phtMoment($today, $daysAgo, $hour, mt_rand(0, 59), mt_rand(0, 59));
                $try++;
            } while ($created > $now->modify('-100 minutes') && $try < 20);
            if ($created > $now->modify('-100 minutes')) $created = $now->modify('-' . mt_rand(2, 20) . ' days');
        }
        [$locDesc, $lat0, $lng0] = pick($LOCATIONS);
        $specs[] = ['status' => $st, 'type' => $type, 'created' => $created, 'loc' => $locDesc,
            'lat' => round($lat0 + mt_rand(-15, 15) / 100000, 7), 'lng' => round($lng0 + mt_rand(-15, 15) / 100000, 7)];
    }
    usort($specs, fn($a, $b) => $a['created'] <=> $b['created']);

    $insInc = $pdo->prepare('INSERT INTO incident (barangay_id, reported_by, device_id, incident_type, priority, raw_narrative, redacted_narrative, redaction_approved_by, redaction_approved_at,
        status, lifecycle_changed_by, lifecycle_changed_at, source, report_channel, latitude, longitude, created_at, device_offline_created_at, client_event_id, synced_at, updated_at,
        complainant_name, respondent_name, complainant_contact_number, location_description, display_id, school_id, c1_summary, c1_action_taken, resolve_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    $incs = []; // index => info
    $cnt = [];
    $offlineDelays = [];
    foreach ($specs as $idx => $sp) {
        $type = $sp['type']; $st = $sp['status']; $created = $sp['created'];
        $lang = ['en', 'tl', 'bik'][$idx % 3];
        $tpl = pick($TEMPLATES[$type][$lang]);
        $a = $SLOT_A[$type][$lang] ?? null; $b = $SLOT_B[$type][$lang] ?? null;
        $narr = str_replace(['{A}', '{B}'], [$a ? pick($a) : '', $b ? pick($b) : ''], $tpl);

        $src = wpick(['web' => 45, 'app' => 35, 'sms' => 20]);
        $channel = $src === 'app' ? 'tanod_alerted' : ($src === 'sms' ? 'sms' : (chance(75) ? 'walk_in' : 'other'));
        $reportedBy = $src === 'app' ? pick($TANODS) : ($src === 'web' ? pick([$SEC, $SEC, $ADMIN]) : null);
        $deviceId = $src === 'app' ? $deviceOf[$reportedBy] : null;
        $cevt = $src === 'app' ? uuidv4() : null;
        $offAt = null; $syncedAt = null;
        if ($src === 'app' && chance(30)) {                       // captured offline, synced later
            $delayMin = mt_rand(4, 95);
            $offAt = fmt($created->modify("-{$delayMin} minutes"));
            $syncedAt = fmt($created);
            $offlineDelays[] = $delayMin;
        }
        $redacted = null; $redBy = null; $redAt = null;
        if (in_array($st, ['resolved', 'cancelled'], true)) {
            $redacted = $narr; $redBy = $SEC; $redAt = fmt($created->modify('+' . mt_rand(10, 90) . ' minutes'));
        }
        $lifeBy = null; $lifeAt = null;
        if (in_array($st, ['duplicate', 'invalid', 'cancelled', 'reopened'], true)) {
            $lifeBy = $SEC; $lifeAt = fmt($created->modify('+' . mt_rand(15, 240) . ' minutes'));
        }
        // A school-zone incident is something a tanod met OUTSIDE the school (gate, perimeter, the road in front). What
        // happens inside the grounds is the school's own matter, not the tanod's, so no seeded location is inside one.
        $sch = (stripos($sp['loc'], 'school') !== false) ? $schoolId[0] : null;
        $respondent = in_array($type, $RESPONDENT_ELIGIBLE_TYPES, true) && chance(60) ? pick($NAMES) : null;
        $display = sprintf('INC-%s-%03d', $created->modify('+8 hours')->format('Y'), $idx + 1);
        $noDispatchResolve = ($st === 'resolved' && chance(14));
        $resolveReason = $noDispatchResolve ? 'Resolved on the spot by the reporting tanod; no dispatch needed.' : null;
        $insInc->execute([BARANGAY_ID, $reportedBy, $deviceId, $type, $PRIORITY_BY_TYPE[$type], $narr, $redacted, $redBy, $redAt,
            $st, $lifeBy, $lifeAt, $src, $channel, $sp['lat'], $sp['lng'], fmt($created), $offAt, $cevt, $syncedAt, fmt($created),
            pick($NAMES), $respondent, chance(70) ? '09' . mt_rand(100000000, 999999999) : null, $sp['loc'], $display, $sch,
            $sch ? ($C1_SUMMARY[$type] ?? $C1_SUMMARY['other']) : null, $sch ? pick($C1_ACTION) : null, $resolveReason]);
        $iid = (int) $pdo->lastInsertId();
        $incs[$idx] = $sp + ['id' => $iid, 'src' => $src, 'channel' => $channel, 'reported_by' => $reportedBy, 'priority' => $PRIORITY_BY_TYPE[$type],
            'noDispatch' => $noDispatchResolve, 'narr' => $narr, 'display' => $display, 'school' => $sch];
        $cnt['incident_' . $st] = ($cnt['incident_' . $st] ?? 0) + 1;
    }
    // duplicates point at an earlier incident of the same type
    foreach ($incs as $idx => $inc) {
        if ($inc['status'] !== 'duplicate') continue;
        for ($j = $idx - 1; $j >= 0; $j--) {
            if ($incs[$j]['type'] === $inc['type'] && !in_array($incs[$j]['status'], ['duplicate', 'invalid'], true)) {
                $pdo->prepare('UPDATE incident SET duplicate_of_incident_id = ? WHERE incident_id = ?')->execute([$incs[$j]['id'], $inc['id']]);
                break;
            }
        }
    }
    // a few "related" links between same-location follow-ups
    $relCount = 0;
    foreach ($incs as $idx => $inc) {
        if ($relCount >= 4 || $idx < 10 || $inc['status'] !== 'resolved' || !chance(8)) continue;
        $pdo->prepare('UPDATE incident SET related_incident_id = ? WHERE incident_id = ?')->execute([$incs[$idx - 1 - mt_rand(0, 6)]['id'], $inc['id']]);
        $relCount++;
    }

    // ------------------------------------------------------------- dispatches
    $insDisp = $pdo->prepare('INSERT INTO dispatch (incident_id, dispatched_by, tanod_id, priority, route_json, route_status, status, dispatched_at, en_route_at, arrived_at, completed_at,
        cancelled_at, cancelled_by, created_client_request_id, cancel_reason, override_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    $dispatches = []; // dispatch_id => info
    $firstArrive = []; // incident idx => minutes created->first arrival (resolved/reopened, completed trips)
    $uatDispatchedSeen = 0; $uatFixture = [];   // UAT: which dispatched incident is which scenario fixture
    $overrideReasons = ['Nearest tanod was on break; assigned next available tanod.', 'Assigned a second responder because the situation needed more than one tanod.'];
    foreach ($incs as $idx => &$inc) {
        $st = $inc['status'];
        $needsDispatch = in_array($st, ['dispatched', 'reopened'], true) || ($st === 'resolved' && !$inc['noDispatch']) || ($st === 'cancelled' && $idx % 3 !== 0);
        if (!$needsDispatch) continue;
        $created = $inc['created'];
        $nTan = (in_array($inc['priority'], ['critical', 'high'], true) && chance(22)) ? 2 : 1;
        $uatRole = null;
        if ($UAT && $st === 'dispatched') {
            // 1st = LIVE en_route (espinosa), 2nd = LIVE arrived (banares), the rest = all dispatches completed
            // (the incident still reads "dispatched" until the Admin resolves it).
            $uatRole = ['live_en_route', 'live_arrived', 'completed', 'completed', 'completed'][$uatDispatchedSeen] ?? 'completed';
            $uatDispatchedSeen++;
            $nTan = 1;
        }
        $chosen = [];
        if ($uatRole === 'live_en_route') $chosen = [$uid['tanod.espinosa']];
        elseif ($uatRole === 'live_arrived') $chosen = [$uid['tanod.banares']];
        elseif ($uatRole === 'completed') $chosen = [pick([$uid['tanod.delacruz'], $uid['tanod.gubaton']])];
        else {
            // UAT: reyes/delacruz/gubaton/dichoso/espinosa/banares must start with NO active dispatch except the two live ones above,
            // so history dispatches (completed/cancelled) may use anyone: they are not active.
            while (count($chosen) < $nTan) { $t = pick($TANODS); if (!in_array($t, $chosen, true)) $chosen[] = $t; }
        }
        $dBy = chance(60) ? $ADMIN : $SEC;
        foreach ($chosen as $k => $tanod) {
            $dAt = $created->modify('+' . ($inc['priority'] === 'critical' ? mt_rand(60, 180) : mt_rand(90, 420)) . ' seconds');
            $enAt = $dAt->modify('+' . mt_rand(30, 180) . ' seconds');
            $travel = mt_rand(180, 720) + (chance(8) ? mt_rand(900, 1800) : 0); // occasional slow response
            $arAt = $enAt->modify("+{$travel} seconds");
            $coAt = $arAt->modify('+' . mt_rand(600, 4500) . ' seconds');
            $status = 'completed'; $cancelAt = null; $cancelBy = null; $cancelReason = null;
            if ($uatRole === 'live_en_route') {
                $dAt = $now->modify('-17 minutes'); $enAt = $now->modify('-14 minutes'); $arAt = $coAt = null; $status = 'en_route';
            } elseif ($uatRole === 'live_arrived') {
                $dAt = $now->modify('-45 minutes'); $enAt = $now->modify('-41 minutes'); $arAt = $now->modify('-27 minutes'); $coAt = null; $status = 'arrived';
            } elseif ($uatRole === 'completed') {
                $dAt = $now->modify('-' . mt_rand(60, 170) . ' minutes'); $enAt = $dAt->modify('+2 minutes'); $arAt = $enAt->modify('+9 minutes'); $coAt = $arAt->modify('+35 minutes'); $status = 'completed';
            } elseif ($st === 'dispatched') {
                if ($now < $enAt) { $status = 'assigned'; $enAt = $arAt = $coAt = null; }
                elseif ($now < $arAt) { $status = 'en_route'; $arAt = $coAt = null; }
                else { $status = 'arrived'; $coAt = null; }
            } elseif ($st === 'cancelled') {
                $status = 'cancelled'; $cancelAt = $enAt; $cancelBy = $ADMIN; $cancelReason = 'False alarm confirmed by the caller.';
                $enAt = $arAt = $coAt = null;
            }
            // route: simulated straight-ish line from a patrol post to the incident
            [$pd, $postLat, $postLng] = pick($LOCATIONS);
            $coords = [];
            for ($s = 0; $s <= 6; $s++) {
                $f = $s / 6;
                $coords[] = [round($postLng + ($inc['lng'] - $postLng) * $f + mt_rand(-4, 4) / 100000, 6), round($postLat + ($inc['lat'] - $postLat) * $f + mt_rand(-4, 4) / 100000, 6)];
            }
            $distM = round(111000 * hypot($inc['lat'] - $postLat, ($inc['lng'] - $postLng) * cos(deg2rad(12.92))) * 1.3, 1);
            $route = json_encode(['geometry' => ['type' => 'LineString', 'coordinates' => $coords], 'distance_m' => $distM,
                'duration_s' => round($distM / 4.2), 'steps' => [], 'simulated' => true], JSON_UNESCAPED_SLASHES);
            $override = ($k === 1 ? $overrideReasons[1] : (chance(5) ? $overrideReasons[0] : null));
            $insDisp->execute([$inc['id'], $dBy, $tanod, $inc['priority'], $route, 'available', $status, fmt($dAt), $enAt ? fmt($enAt) : null,
                $arAt ? fmt($arAt) : null, $coAt ? fmt($coAt) : null, $cancelAt ? fmt($cancelAt) : null, $cancelBy, uuidv4(), $cancelReason, $override]);
            $did = (int) $pdo->lastInsertId();
            if ($uatRole) {
                $uatFixture[$uatRole][] = $inc['display'];
                if ($inc['created'] >= $dAt) {
                    $newCreated = $dAt->modify('-3 minutes');
                    $pdo->prepare('UPDATE incident SET created_at = ?, updated_at = ? WHERE incident_id = ?')->execute([fmt($newCreated), fmt($newCreated), $inc['id']]);
                    $inc['created'] = $newCreated; $created = $newCreated;
                }
            }
            $dispatches[$did] = ['id' => $did, 'inc' => $idx, 'incident_id' => $inc['id'], 'tanod' => $tanod, 'by' => $dBy, 'status' => $status,
                'd' => $dAt, 'en' => $enAt, 'ar' => $arAt, 'co' => $coAt, 'cancelled' => $cancelAt, 'cancel_reason' => $cancelReason];
            if ($arAt && (!isset($firstArrive[$idx]) || $arAt < $firstArrive[$idx]['t'])) {
                $firstArrive[$idx] = ['t' => $arAt, 'min' => ($arAt->getTimestamp() - $created->getTimestamp()) / 60];
            }
        }
        // incident.updated_at follows the last thing that happened
        $lastTs = $created;
        foreach ($dispatches as $d) if ($d['inc'] === $idx) foreach (['co', 'ar', 'en', 'd', 'cancelled'] as $f) if ($d[$f] && $d[$f] > $lastTs) $lastTs = $d[$f];
        if ($st === 'resolved') $lastTs = $lastTs->modify('+' . mt_rand(5, 50) . ' minutes');
        $pdo->prepare('UPDATE incident SET updated_at = ? WHERE incident_id = ?')->execute([fmt($lastTs), $inc['id']]);
    }
    unset($inc);
    $respMins = array_map(fn($f) => $f['min'], $firstArrive);
    $M['response_time_minutes_created_to_first_arrival'] = stats($respMins) + ['definition' => "incident.created_at to the incident's first dispatch.arrived_at (same rule as the Reports screen; that screen only counts the date range it is showing, so its average can differ slightly)"];

    // ---------------------------------------------------------- dispatch offers
    // "Night" dispatches (22:00-05:59 Philippine time) go out as offers: the
    // accepting tanod is the one who got dispatched. One open offer for a pending incident.
    $insOffer = $pdo->prepare('INSERT INTO dispatch_offer (incident_id, barangay_id, round, status, created_at, expires_at, accepted_by, accepted_dispatch_id, created_by, closed_at, request_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    $insRecip = $pdo->prepare('INSERT INTO dispatch_offer_recipient (offer_id, user_id, status, notified_at) VALUES (?,?,?,?)');
    $offers = 0;
    foreach ($dispatches as $d) {
        if ($offers >= 6 || $d['status'] === 'cancelled') continue;
        $h = (int) $incs[$d['inc']]['created']->modify('+8 hours')->format('G');
        if (!($h >= 22 || $h < 6)) continue;
        $offerAt = $d['d']->modify('-40 seconds');
        $round = chance(30) ? 2 : 1;
        $insOffer->execute([$d['incident_id'], BARANGAY_ID, $round, 'accepted', fmt($offerAt), fmt($offerAt->modify('+120 seconds')), $d['tanod'], $d['id'], $d['by'], fmt($d['d']), uuidv4()]);
        $oid = (int) $pdo->lastInsertId();
        $others = array_values(array_diff($TANODS, [$d['tanod']])); shuffle($others);
        $insRecip->execute([$oid, $d['tanod'], 'accepted', fmt($offerAt)]);
        foreach (array_slice($others, 0, 2) as $o) $insRecip->execute([$oid, $o, pick(['released', 'expired']), fmt($offerAt)]);
        $offers++;
    }
    foreach ($incs as $inc) {
        if ($UAT) break;   // UAT: no pre-opened offer; the facilitator opens one (T-14, A-09, C-05), and it must not already exist
        if ($inc['status'] !== 'pending') continue;
        $offerAt = $now->modify('-' . mt_rand(20, 80) . ' seconds');
        $insOffer->execute([$inc['id'], BARANGAY_ID, 1, 'open', fmt($offerAt), fmt($offerAt->modify('+120 seconds')), null, null, $ADMIN, null, uuidv4()]);
        $oid = (int) $pdo->lastInsertId();
        foreach (array_slice($TANODS, 0, 3) as $t) $insRecip->execute([$oid, $t, 'offered', fmt($offerAt)]);
        $offers++;
        break;
    }
    $M['dispatch_offers'] = $offers;

    // ---------------------------------------------------------------- shifts
    $zones = ['Purok 1-2', 'Purok 3-4', 'Purok 5-6', 'National road', 'Seawall / fish landing', 'School zone'];
    $shiftDefs = [[6, 14], [14, 22], [22, 30]]; // PHT hours; 30 = 06:00 next day
    $insShift = $pdo->prepare('INSERT INTO shift_schedule (barangay_id,user_id,patrol_zone,start_at,end_at,created_by,version,client_request_id,updated_at,approval_status,approved_by,approved_at,
        pending_reapproval) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?)');
    $shifts = []; $slot = 0; $reapprovalLeft = 2;
    // ---- UAT roster. "Rostered window" W = from three hours ago to nine hours ahead, so a session started within
    // nine hours of the reset finds published shifts covering "now". 12 h = the daily cap (422 DAILY_HOURS_EXCEEDED).
    $wStart = $now->setTime((int) $now->format('G'), 0, 0)->modify('-3 hours'); $wEnd = $wStart->modify('+12 hours');
    $uatHours = [];   // user => PHT date => hours already rostered (the 12 h/day cap must hold in the seed too)
    $uatAddHours = function (int $user, DateTimeImmutable $a, DateTimeImmutable $b) use (&$uatHours) {
        for ($c = $a; $c < $b;) {
            $pht = $c->modify('+8 hours'); $nextMid = $pht->setTime(0, 0)->modify('+1 day')->modify('-8 hours');
            $segEnd = $b < $nextMid ? $b : $nextMid;
            $k = $pht->format('Y-m-d'); $uatHours[$user][$k] = ($uatHours[$user][$k] ?? 0) + ($segEnd->getTimestamp() - $c->getTimestamp()) / 3600;
            $c = $segEnd;
        }
    };
    $uatFits = function (int $user, DateTimeImmutable $a, DateTimeImmutable $b) use (&$uatHours) {
        for ($c = $a; $c < $b;) {
            $pht = $c->modify('+8 hours'); $nextMid = $pht->setTime(0, 0)->modify('+1 day')->modify('-8 hours');
            $segEnd = $b < $nextMid ? $b : $nextMid;
            if (($uatHours[$user][$pht->format('Y-m-d')] ?? 0) + ($segEnd->getTimestamp() - $c->getTimestamp()) / 3600 > 12) return false;
            $c = $segEnd;
        }
        return true;
    };
    $uatShiftSeen = [];
    if ($UAT) {
        foreach (['tanod.reyes' => 'Purok 1-2', 'tanod.delacruz' => 'Purok 3-4', 'tanod.gubaton' => 'Purok 5-6', 'tanod.espinosa' => 'National road', 'tanod.banares' => 'Seawall / fish landing'] as $un => $zone) {
            $insShift->execute([BARANGAY_ID, $uid[$un], $zone, fmt($wStart), fmt($wEnd), $SEC, uuidv4(), fmt($wStart->modify('-5 days')), 'published', $PB, fmt($wStart->modify('-3 days')), 0]);
            $shifts[] = ['id' => (int) $pdo->lastInsertId(), 'user' => $uid[$un], 'start' => $wStart, 'end' => $wEnd, 'draft' => false, 'dayOff' => 0, 'noduty' => $un === 'tanod.reyes'];
            $uatAddHours($uid[$un], $wStart, $wEnd);
        }
    }
    for ($dayOff = -$DAYS; $dayOff <= 7; $dayOff++) {
        $dayStart = $today->modify(($dayOff >= 0 ? '+' : '') . $dayOff . ' days');
        foreach ($shiftDefs as $s => [$h1, $h2]) {
            for ($k = 0; $k < 2; $k++) {
                $tanod = $TANODS[$slot % count($TANODS)]; $slot++;
                $start = $dayStart->setTime(0, 0)->modify(sprintf('%+d hours', $h1 - PHT_OFFSET_H));
                $end = $dayStart->setTime(0, 0)->modify(sprintf('%+d hours', $h2 - PHT_OFFSET_H));
                if ($UAT && $dayOff >= -1) {
                    // inside W the roster is the fixed UAT one; reyes and candelaria keep controlled futures (see below)
                    if ($end > $wStart && $start < $wEnd) continue;
                    if ($dayOff >= 1 && $dayOff <= 4 && in_array($tanod, [$uid['tanod.reyes'], $uid['tanod.candelaria']], true)) continue;
                    if (!$uatFits($tanod, $start, $end)) continue;
                    $uatAddHours($tanod, $start, $end);
                }
                $future = $start > $now;
                $isDraft = $dayOff >= 5;
                $reappr = (!$isDraft && $future && $reapprovalLeft > 0 && $k === 1 && $s === 1 && $dayOff >= 2) ? 1 : 0;
                if ($reappr) $reapprovalLeft--;
                $created = $start->modify('-10 days');
                $approvedAt = $isDraft ? null : $start->modify('-' . mt_rand(2, 4) . ' days');
                $insShift->execute([BARANGAY_ID, $tanod, $zones[($s * 2 + $k) % count($zones)], fmt($start), fmt($end), $SEC, uuidv4(), fmt($created),
                    $isDraft ? 'draft' : 'published', $isDraft ? null : $PB, $approvedAt ? fmt($approvedAt) : null, $reappr]);
                $shifts[] = ['id' => (int) $pdo->lastInsertId(), 'user' => $tanod, 'start' => $start, 'end' => $end, 'draft' => $isDraft, 'dayOff' => $dayOff];
            }
        }
    }
    if ($UAT) {
        // reyes (the Tanod tester): two published shifts to ask a swap on, one draft that must NOT appear on his phone (T-23, T-24).
        // candelaria: nothing rostered on D+2..D+4, with whole-day availability there (A-13, A-14, A-19).
        foreach ([[1, 6, 14, 'published', 'National road'], [2, 14, 22, 'published', 'Purok 3-4'], [3, 6, 14, 'published', 'School zone'], [6, 6, 14, 'draft', 'Purok 1-2']] as [$dOff, $h1, $h2, $stt, $zone]) {
            $dayStart = $today->modify("+{$dOff} days");
            $a = $dayStart->setTime(0, 0)->modify(sprintf('%+d hours', $h1 - PHT_OFFSET_H)); $b = $dayStart->setTime(0, 0)->modify(sprintf('%+d hours', $h2 - PHT_OFFSET_H));
            $pub = $stt === 'published';
            $insShift->execute([BARANGAY_ID, $uid['tanod.reyes'], $zone, fmt($a), fmt($b), $SEC, uuidv4(), fmt($a->modify('-6 days')), $stt, $pub ? $PB : null, $pub ? fmt($a->modify('-2 days')) : null, 0]);
            $shifts[] = ['id' => (int) $pdo->lastInsertId(), 'user' => $uid['tanod.reyes'], 'start' => $a, 'end' => $b, 'draft' => !$pub, 'dayOff' => $dOff];
        }
    }
    $M['shifts'] = count($shifts);

    // swap requests (future shifts)
    $futureByUser = [];
    foreach ($shifts as $sh) if (!$sh['draft'] && $sh['start'] > $now->modify('+1 day')) $futureByUser[$sh['user']][] = $sh;
    $swapDefs = [['pending', null], ['pending', null], ['approved', $SEC], ['denied', $SEC]];
    $swapReq = [0, 1, 2, 3];
    if ($UAT) {   // four pending requests for the Admin to approve (A-16) from tanods other than reyes, who files his own (T-24)
        $swapDefs = [['pending', null], ['pending', null], ['pending', null], ['pending', null], ['approved', $SEC], ['denied', $SEC]];
        $swapReq = [1, 2, 3, 5, 4, 6];
    }
    foreach ($swapDefs as $i => [$stt, $by]) {
        $req = $TANODS[$swapReq[$i]]; $list = $futureByUser[$req] ?? [];
        if (!$list) continue;
        $sh = $list[0]; $target = $TANODS[($swapReq[$i] + 3) % count($TANODS)];
        $reqAt = $now->modify('-' . mt_rand(1, 5) . ' days');
        $pdo->prepare('INSERT INTO shift_swap_request (requesting_user_id, shift_id, target_user_id, reason, status, requested_at, resolved_at, resolved_by, version, client_request_id) VALUES (?,?,?,?,?,?,?,?,1,?)')
            ->execute([$req, $sh['id'], $target, pick(['Family event that day.', 'Clinic appointment.', 'Needs to attend a school meeting.', 'Fiesta preparations.']), $stt, fmt($reqAt), $by ? fmt($reqAt->modify('+1 day')) : null, $by, uuidv4()]);
    }

    // ---------------------------------------------------------- availability
    $dowToday = (int) $now->modify('+8 hours')->format('N'); // 1=Mon
    $thisMon = $today->modify('-' . ($dowToday - 1) . ' days');
    // Availability is the tanod's fixed statement and every shift must fit inside it. Window contract (see
    // AvailabilityController): end AFTER start, date inside the weekly row, "23:59" = midnight, so an overnight
    // span (22:00-06:00) is TWO windows (D 22:00-23:59 and D+1 00:00-06:00, the latter in D+1's weekly row).
    $insAv = $pdo->prepare('INSERT INTO tanod_availability (barangay_id,user_id,period_start,period_end,windows_json,status,reviewed_by,reviewed_at,review_note,version,client_event_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)');
    $mondayOf = function (string $date): string {
        $d = new DateTimeImmutable($date . ' 00:00:00');
        return $d->modify('-' . ((int) $d->format('N') - 1) . ' days')->format('Y-m-d');
    };
    $spanWindows = function (DateTimeImmutable $ms, DateTimeImmutable $me): array {
        $sd = $ms->format('Y-m-d'); $ed = $me->format('Y-m-d');
        if ($sd === $ed) return [['date' => $sd, 'start' => $ms->format('H:i'), 'end' => $me->format('H:i')]];
        return [['date' => $sd, 'start' => $ms->format('H:i'), 'end' => '23:59'], ['date' => $ed, 'start' => '00:00', 'end' => $me->format('H:i')]];
    };
    $presets = [['06:00', '14:00'], ['14:00', '22:00'], ['22:00', '06:00']];
    foreach ($TANODS as $ti => $t) {
        $byWeek = []; // monday => [windows]
        $put = function (array $w) use (&$byWeek, $mondayOf) {
            $m = $mondayOf($w['date']);
            foreach ($byWeek[$m] ?? [] as $x) if ($x == $w) return;
            $byWeek[$m][] = $w;
        };
        // 1) a window for every seeded shift (Manila time = UTC+8; DateTimes here are naive wall-clock, so shift by hand).
        foreach ($shifts as $sh) {
            if ($sh['user'] !== $t) continue;
            foreach ($spanWindows($sh['start']->modify('+8 hours'), $sh['end']->modify('+8 hours')) as $w) $put($w);
        }
        // 2) a few extra windows around last week / this week / next week so the grid shows spare availability.
        foreach ([-7, 0, 7] as $off) {
            for ($dd = 0; $dd < 7; $dd++) {
                if (chance(40)) continue;
                $day = $thisMon->modify(sprintf('%+d days', $off + $dd));
                $p = pick($presets);
                $endDay = $p[1] <= $p[0] ? $day->modify('+1 day') : $day;
                foreach ($spanWindows(new DateTimeImmutable($day->format('Y-m-d') . ' ' . $p[0] . ':00'), new DateTimeImmutable($endDay->format('Y-m-d') . ' ' . $p[1] . ':00')) as $w) $put($w);
            }
        }
        if ($UAT && $t === $uid['tanod.candelaria']) {
            foreach ([2, 3, 4] as $off) $put(['date' => $today->modify("+{$off} days")->format('Y-m-d'), 'start' => '00:00', 'end' => '23:59']);
        }
        ksort($byWeek);
        foreach ($byWeek as $mon => $win) {
            usort($win, fn ($a, $b) => [$a['date'], $a['start']] <=> [$b['date'], $b['start']]);
            $ps = new DateTimeImmutable($mon . ' 00:00:00'); $pe = $ps->modify('+6 days');
            $future = $ps >= $thisMon->modify('+7 days');
            $st2 = $future ? 'submitted' : 'accepted'; $note = null; $rev = $future ? null : $SEC;
            if ($future && $ti === 2 && $ps == $thisMon->modify('+7 days')) { $st2 = 'revised'; $rev = $SEC; $note = 'Please also add a night window; we are short on 22:00-06:00.'; }
            $created = $ps->modify('-' . mt_rand(3, 6) . ' days');
            $insAv->execute([BARANGAY_ID, $t, $ps->format('Y-m-d'), $pe->format('Y-m-d'), json_encode($win, JSON_UNESCAPED_SLASHES), $st2, $rev, $rev ? fmt($created->modify('+1 day')) : null, $note, uuidv4(), fmt($created), fmt($created)]);
        }
    }

    // -------------------------------------------------------------- SOS alerts
    $insSos = $pdo->prepare('INSERT INTO tanod_sos (user_id,barangay_id,dispatch_id,latitude,longitude,location_source,location_recorded_at,triggered_at,received_at,status,acknowledged_by,acknowledged_at,resolved_by,resolved_at,client_event_id,fallback_channel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    $sosDelays = ['app' => [], 'sms' => []]; $sosN = 14; $sosRows = [];
    for ($i = 0; $i < $sosN; $i++) {
        $uatActive = $UAT && $i === 2;                              // UAT: a second ACTIVE SOS, so the web tester and the phone console tester each have one to acknowledge
        $chan = $uatActive ? 'app' : ($i % 3 === 2 || $i === 4 ? 'sms' : 'app');           // 5 sms, 9 app
        $trig = ($i === 0 || $uatActive) ? $now->modify('-' . mt_rand(3, 9) . ' minutes') : phtMoment($today, mt_rand(0, $DAYS - 1), (int) wpick($HOUR_W), mt_rand(0, 59), mt_rand(0, 59));
        if ($i > 0 && !$uatActive && $trig > $now->modify('-30 minutes')) $trig = $trig->modify('-3 days');
        $delay = $chan === 'app' ? mt_rand(1, 6) : mt_rand(9, 48);
        $recv = $trig->modify("+{$delay} seconds");
        $sosDelays[$chan][] = $delay;
        $locSrc = chance(75) ? 'live' : (chance(70) ? 'last_known' : 'no_fix');
        [$sd, $sla, $sln] = pick($LOCATIONS);                                  // always a real land point
        $lat = $locSrc === 'no_fix' ? null : round($sla + mt_rand(-12, 12) / 100000, 7);
        $lng = $locSrc === 'no_fix' ? null : round($sln + mt_rand(-12, 12) / 100000, 7);
        if ($i === 0 || $uatActive) { $status = 'active'; } elseif ($i === 1) { $status = 'acknowledged'; } else { $status = 'resolved'; }
        $ackAt = $status === 'active' ? null : $recv->modify('+' . mt_rand(20, 150) . ' seconds');
        $resAt = $status === 'resolved' ? $ackAt->modify('+' . mt_rand(300, 2400) . ' seconds') : null;
        $sosRows[] = ['user' => pick($TANODS), 'chan' => $chan, 'trig' => $trig, 'recv' => $recv];
        $insSos->execute([$sosRows[$i]['user'], BARANGAY_ID, null, $lat, $lng, $locSrc, $locSrc === 'no_fix' ? null : fmt($trig->modify('-' . ($locSrc === 'live' ? 2 : 240) . ' seconds')),
            fmt($trig), fmt($recv), $status, $ackAt ? pick([$ADMIN, $SEC]) : null, $ackAt ? fmt($ackAt) : null, $resAt ? $ADMIN : null, $resAt ? fmt($resAt) : null, uuidv4(), $chan]);
    }
    $M['sos'] = ['total' => $sosN, 'app' => count($sosDelays['app']), 'sms_fallback' => count($sosDelays['sms']),
        'median_delay_seconds_app' => stats($sosDelays['app'])['median'], 'median_delay_seconds_sms' => stats($sosDelays['sms'])['median']];

    // ------------------------------------------------- duty status + GPS tracks
    $gps = []; $gpsDelays = []; $duty = [];
    $gpsFrom = $now->modify('-48 hours');
    $walk = []; // per-tanod last position
    foreach ($shifts as $sh) {
        if ($sh['draft'] || $sh['end'] < $now->modify('-7 days') || $sh['start'] > $now || !empty($sh['noduty'])) continue;
        $u = $sh['user'];
        $duty[] = ['user_id' => $u, 'status' => 'on_duty', 'channel' => chance(94) ? 'app' : 'sms', 'client_event_id' => uuidv4(), 'changed_at' => fmt($sh['start']->modify('+' . mt_rand(0, 6) . ' minutes'))];
        if ($sh['end'] <= $now) $duty[] = ['user_id' => $u, 'status' => 'off_duty', 'channel' => 'app', 'client_event_id' => uuidv4(), 'changed_at' => fmt($sh['end']->modify('+' . mt_rand(0, 8) . ' minutes'))];
        if ($sh['end'] < $gpsFrom) continue;
        $t0 = max($sh['start']->getTimestamp(), $gpsFrom->getTimestamp()); $t1 = min($sh['end']->getTimestamp(), $now->getTimestamp() - 20);
        if (!isset($walk[$u])) { [$d0, $la0, $ln0] = pick($LOCATIONS); $walk[$u] = [$la0, $ln0, $la0, $ln0]; }
        [$lat, $lng, $wl, $wn] = $walk[$u];   // patrol = walk between nearby real land points, never open water
        for ($ts = $t0; $ts <= $t1; $ts += 120) {
            if (abs($wl - $lat) < 0.00012 && abs($wn - $lng) < 0.00012) { [$wl, $wn] = nearWaypoint($lat, $lng, $LOCATIONS); }
            $lat += ($wl - $lat) * 0.2 + mt_rand(-2, 2) / 100000; $lng += ($wn - $lng) * 0.2 + mt_rand(-2, 2) / 100000;
            $rec = (new DateTimeImmutable('@' . $ts))->setTimezone(new DateTimeZone('UTC'));
            $offline = chance(8);
            $delay = $offline ? mt_rand(120, 1200) : mt_rand(1, 4);
            $gpsDelays[] = $delay;
            $gps[] = ['user_id' => $u, 'dispatch_id' => null, 'latitude' => round($lat, 7), 'longitude' => round($lng, 7), 'accuracy_m' => round(frand(4, 22), 2),
                'recorded_at' => fmt($rec), 'received_at' => fmt($rec->modify("+{$delay} seconds")), 'synced_at' => $offline ? fmt($rec->modify("+{$delay} seconds")) : null, 'client_event_id' => uuidv4()];
        }
        $walk[$u] = [$lat, $lng, $wl, $wn];
    }
    // GPS along each recent dispatch (en route -> arrived)
    foreach ($dispatches as $d) {
        if (!$d['en'] || $d['d'] < $now->modify('-7 days') || $d['status'] === 'cancelled') continue;
        $end = $d['ar'] ?? $now; if ($end <= $d['en']) continue;
        $inc = $incs[$d['inc']];
        $span = max(30, $end->getTimestamp() - $d['en']->getTimestamp()); $n = max(2, (int) floor($span / 30));
        [$dd0, $lat0, $lng0] = pick($LOCATIONS);
        for ($j = 0; $j <= $n; $j++) {
            $f = $j / $n; $rec = $d['en']->modify('+' . (int) round($span * $f) . ' seconds');
            if ($rec > $now) break;
            $gps[] = ['user_id' => $d['tanod'], 'dispatch_id' => $d['id'], 'latitude' => round($lat0 + ($inc['lat'] - $lat0) * $f, 7), 'longitude' => round($lng0 + ($inc['lng'] - $lng0) * $f, 7),
                'accuracy_m' => round(frand(4, 18), 2), 'recorded_at' => fmt($rec), 'received_at' => fmt($rec->modify('+2 seconds')), 'synced_at' => null, 'client_event_id' => uuidv4()];
            $gpsDelays[] = 2;
        }
        $duty[] = ['user_id' => $d['tanod'], 'status' => 'responding', 'channel' => 'app', 'client_event_id' => uuidv4(), 'changed_at' => fmt($d['en'])];
        if ($d['co']) $duty[] = ['user_id' => $d['tanod'], 'status' => 'on_duty', 'channel' => 'app', 'client_event_id' => uuidv4(), 'changed_at' => fmt($d['co'])];
    }
    if ($UAT) {
        // Current duty state of the tanods the UAT scenarios depend on. reyes + candelaria: OFF duty now (T-01/T-02, and the
        // off-duty tanod the Admin must not be offered, A-05). dichoso: ON duty with NO published shift covering now, last
        // heard 40 min ago, so the map shows a stale unit (A-02) and the Admin gets the override prompt (A-04).
        $cut = fmt($now->modify('-14 hours'));
        $quiet = [$uid['tanod.reyes'], $uid['tanod.candelaria'], $uid['tanod.dichoso']];
        $duty = array_values(array_filter($duty, fn($r) => !(in_array($r['user_id'], $quiet, true) && $r['changed_at'] > $cut)));
        $gps = array_values(array_filter($gps, fn($r) => !(in_array($r['user_id'], $quiet, true) && $r['recorded_at'] > $cut)));
        foreach ([$uid['tanod.reyes'], $uid['tanod.candelaria']] as $u) {
            $duty[] = ['user_id' => $u, 'status' => 'off_duty', 'channel' => 'app', 'client_event_id' => uuidv4(), 'changed_at' => fmt($now->modify('-20 minutes'))];
        }
        $duty[] = ['user_id' => $uid['tanod.dichoso'], 'status' => 'on_duty', 'channel' => 'app', 'client_event_id' => uuidv4(), 'changed_at' => fmt($now->modify('-95 minutes'))];
        [$d0, $la, $ln] = pick($LOCATIONS);
        for ($ts = $now->modify('-95 minutes'); $ts <= $now->modify('-40 minutes'); $ts = $ts->modify('+2 minutes')) {
            $la += mt_rand(-2, 2) / 100000; $ln += mt_rand(-2, 2) / 100000;
            $gps[] = ['user_id' => $uid['tanod.dichoso'], 'dispatch_id' => null, 'latitude' => round($la, 7), 'longitude' => round($ln, 7), 'accuracy_m' => round(frand(4, 22), 2),
                'recorded_at' => fmt($ts), 'received_at' => fmt($ts->modify('+3 seconds')), 'synced_at' => null, 'client_event_id' => uuidv4()];
        }
    }
    bulk($pdo, 'gps_track', $gps, 500);
    bulk($pdo, 'duty_status', $duty, 500);
    $M['gps'] = ['rows' => count($gps), 'delivery_delay_seconds' => stats($gpsDelays), 'note' => 'about 8% of fixes are marked as sent late (offline batch); the rest arrive within 1-4 s'];
    $M['duty_status_rows'] = count($duty);

    // --------------------------------------------------------------- referrals
    $refMap = ['fire' => ['bfp'], 'medical_emergency' => ['ambulance_ems', 'doh'], 'domestic_dispute' => ['vaw_desk', 'social_welfare', 'pnp'],
        'physical_injury' => ['pnp', 'ambulance_ems'], 'theft' => ['pnp'], 'traffic_incident' => ['pnp'], 'missing_person' => ['pnp'],
        'vandalism' => ['pnp', 'barangay_official'], 'disturbance' => ['pnp', 'barangay_official'], 'animal_complaint' => ['other'], 'other' => ['dpwh', 'higher_lgu', 'other']];
    $refs = []; $refBy = [];
    foreach ($incs as $inc) {
        if (!in_array($inc['status'], ['resolved', 'dispatched', 'reopened'], true)) continue;
        $p = in_array($inc['type'], ['fire', 'medical_emergency'], true) ? 85 : (in_array($inc['type'], ['domestic_dispute', 'physical_injury'], true) ? 55 : 14);
        if (!chance($p)) continue;
        $to = pick($refMap[$inc['type']]);
        $at = $inc['created']->modify('+' . mt_rand(20, 180) . ' minutes'); if ($at > $now) continue;
        $refs[] = ['incident_id' => $inc['id'], 'barangay_id' => BARANGAY_ID, 'referred_to' => $to, 'other_text' => $to === 'other' ? ($inc['type'] === 'animal_complaint' ? 'Municipal agriculture office' : 'Municipal engineering office') : null,
            'contact_name' => chance(50) ? 'Duty officer (simulated)' : null, 'referred_at' => fmt($at), 'reference_no' => chance(55) ? sprintf('SIM-%04d', mt_rand(1, 9999)) : null,
            'created_by' => pick([$SEC, $ADMIN]), 'client_event_id' => uuidv4(), 'created_at' => fmt($at)];
        $refBy[$to] = ($refBy[$to] ?? 0) + 1;
    }
    bulk($pdo, 'incident_referral', $refs);
    $M['referrals'] = ['total' => count($refs), 'by_office' => $refBy];

    // ------------------------------------------------------ accomplishment reports
    $texts = ['Roving patrol around Purok 1 to 3', 'Roving patrol along the national road and waiting shed', 'Traffic assistance at the school gate during dismissal', 'Night patrol near the seawall and fish landing',
        'Assisted the barangay secretary at the hall', 'Responded to a disturbance report and mediated', 'Checked streetlights and reported the broken ones', 'Escorted residents during the barangay assembly',
        'Joined the clean-up drive in Purok 5', 'Visited the day care center and the elementary school perimeter', 'Patrolled the riverside path after a flood advisory'];
    $accReports = []; $accStat = [];
    $prevMonthStart = $today->modify('first day of last month'); $thisMonthStart = $today->modify('first day of this month');
    $prevM = $prevMonthStart->format('Y-m'); $thisM = $thisMonthStart->format('Y-m');
    $insRep = $pdo->prepare('INSERT INTO accomplishment_report (barangay_id,user_id,month,status,prepared_at,return_reason,total_minutes_confirmed,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)');
    $insEnt = [];
    $plan = [  // [tanod index, month key, status]
        [0, 'prev', 'prepared'], [1, 'prev', 'prepared'], [2, 'prev', 'prepared'], [3, 'prev', 'returned'], [4, 'prev', 'prepared'],
        [0, 'this', 'open'], [1, 'this', 'prepared'], [2, 'this', 'open'], [3, 'this', 'prepared'], [4, 'this', 'prepared'],
    ];
    if ($UAT) $plan[0] = [0, 'prev', 'open'];   // reyes (Tanod tester): BOTH months open, so he can submit one online (T-21) and try the other offline (T-22)
    foreach ($plan as [$ti, $mk, $status]) {
        $t = $TANODS[$ti]; $mStart = $mk === 'prev' ? $prevMonthStart : $thisMonthStart; $month = $mStart->format('Y-m');
        $days = (int) $mStart->format('t');
        $workDays = [];
        for ($dd = 1; $dd <= $days; $dd++) {
            $day = $mStart->modify('+' . ($dd - 1) . ' days');
            if ($day >= ($UAT && $ti === 0 ? $today->modify('-3 days') : $today)) break;   // never in the future (UAT: reyes keeps the last 3 days free for the T-20 entry)
            if (chance(55)) $workDays[] = $day;
        }
        $entries = []; $sum = 0;
        foreach ($workDays as $wi => $day) {
            $startH = pick([6, 7, 8, 14, 18, 22]); $dur = pick([120, 180, 240, 300, 360, 420, 480]);
            $flag = ($wi === 0 && $ti === 1 && $mk === 'prev') ? 1 : 0;
            if ($flag) $dur = 780;                         // a duration the system flags as too long
            $startT = sprintf('%02d:00:00', $startH); $endMin = $startH * 60 + $dur;
            $endT = sprintf('%02d:%02d:00', intdiv($endMin, 60) % 24, $endMin % 60);
            $entries[] = ['text' => pick($texts), 'date' => $day->format('Y-m-d'), 'st' => $startT, 'en' => $endT, 'dur' => $dur, 'sug' => $flag ? 480 : $dur, 'flag' => $flag];
            $sum += $dur;
        }
        $created = $mStart->modify('+1 day');
        $prepared = in_array($status, ['prepared', 'returned'], true) ? ($mk === 'prev' ? $thisMonthStart->modify('+1 day') : $today->modify('-1 day')) : null;
        $insRep->execute([BARANGAY_ID, $t, $month, $status, $prepared ? fmt($prepared) : null,
            $status === 'returned' ? 'Please add the time out for the 3rd week entries.' : null, $status === 'prepared' ? $sum : null, fmt($created), fmt($prepared ?? $created)]);
        $rid = (int) $pdo->lastInsertId();
        foreach ($entries as $e) {
            $insEnt[] = ['report_id' => $rid, 'barangay_id' => BARANGAY_ID, 'user_id' => $t, 'work_date' => $e['date'], 'accomplishment_text' => $e['text'], 'start_time' => $e['st'], 'end_time' => $e['en'],
                'duration_minutes' => $e['dur'], 'suggested_duration_minutes' => $e['sug'], 'duration_flag' => $e['flag'], 'client_event_id' => uuidv4(), 'created_at' => fmt($created), 'updated_at' => null];
        }
        $accStat[$status] = ($accStat[$status] ?? 0) + 1;
    }
    bulk($pdo, 'accomplishment_entry', $insEnt);
    $M['accomplishment_reports'] = ['by_status' => $accStat, 'entries' => count($insEnt), 'months' => [$prevM, $thisM]];

    // ------------------------------------------------------- school check-ins
    $checkins = []; $deploymentDays = 0;
    for ($dd = 1; $dd <= 21; $dd++) {
        $day = $today->modify("-{$dd} days"); if ((int) $day->format('N') > 5) continue;
        foreach ([0 => $TANODS[$dd % 2], 1 => $TANODS[2 + ($dd % 2)]] as $si => $t) {
            $in = $day->modify(sprintf('%+d minutes', 6 * 60 + 40 + mt_rand(0, 40) - PHT_OFFSET_H * 60));
            $out = $day->modify(sprintf('%+d minutes', 16 * 60 + 30 + mt_rand(0, 45) - PHT_OFFSET_H * 60));
            if ($in > $now) continue;
            $checkins[] = ['school_id' => $schoolId[$si], 'barangay_id' => BARANGAY_ID, 'user_id' => $t, 'checked_in_at' => fmt($in), 'checked_out_at' => $out > $now ? null : fmt($out),
                'client_event_id' => uuidv4(), 'created_at' => fmt($in)];
            $deploymentDays++;
        }
    }
    bulk($pdo, 'school_checkin', $checkins);

    // ---------------------------------------------------------- SSZ term report
    $termStart = $today->modify('-45 days'); $termEnd = $today->modify('+45 days');
    $row = $pdo->prepare('SELECT COUNT(*) c FROM incident WHERE school_id IS NOT NULL AND created_at >= ?'); $row->execute([fmt($termStart)]);
    $schoolIncidents = (int) $row->fetch()['c'];
    $ref = $pdo->prepare("SELECT r.referred_to, COUNT(*) c FROM incident_referral r JOIN incident i ON i.incident_id = r.incident_id WHERE i.school_id IS NOT NULL AND i.created_at >= ? GROUP BY r.referred_to");
    $ref->execute([fmt($termStart)]); $rc = []; foreach ($ref->fetchAll() as $r) $rc[$r['referred_to']] = (int) $r['c'];
    $withReferral = array_sum($rc);
    $pdo->prepare('INSERT INTO ssz_term_report (barangay_id,term_label,term_start,term_end,status,total_tanods,total_schools,total_deployment_days,total_incidents,incidents_barangay_only,incidents_pnp,incidents_bfp,incidents_higher_lgu,incidents_doh,incidents_dpwh,incidents_other_agencies,other_institutions,remarks,prepared_by,prepared_at,version,created_by,client_request_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)')
        ->execute([BARANGAY_ID, 'Simulated term (Chapter 4 test data)', $termStart->format('Y-m-d'), $termEnd->format('Y-m-d'), 'prepared', 4, 3, $deploymentDays, $schoolIncidents,
            max(0, $schoolIncidents - $withReferral), $rc['pnp'] ?? 0, $rc['bfp'] ?? 0, $rc['higher_lgu'] ?? 0, $rc['doh'] ?? 0, $rc['dpwh'] ?? 0,
            ($rc['ambulance_ems'] ?? 0) + ($rc['vaw_desk'] ?? 0) + ($rc['social_welfare'] ?? 0) + ($rc['other'] ?? 0) + ($rc['barangay_official'] ?? 0),
            null, 'Figures computed from the simulated check-in and incident rows.', $SEC, fmt($today->modify('-1 day')), $SEC, uuidv4(), fmt($termStart), fmt($today->modify('-1 day'))]);
    $M['school_zones'] = ['schools' => 3, 'checkins' => count($checkins), 'school_linked_incidents' => $schoolIncidents];

    // ----------------------------------------------------------------- SMS log
    $sms = [];
    $gateway = '09170000001';
    foreach ($incs as $inc) {
        if ($inc['src'] !== 'sms') continue;
        $sms[] = ['report_id' => null, 'incident_id' => $inc['id'], 'dispatch_id' => null, 'barangay_id' => BARANGAY_ID, 'sender_number' => '09' . mt_rand(100000000, 999999999), 'receiver_number' => $gateway,
            'transport' => 'gsm_modem', 'message_type' => 'incident', 'direction' => 'inbound', 'gateway_message_id' => null, 'modem_message_id' => (string) mt_rand(100, 999), 'correlation_id' => uuidv4(),
            'status' => 'received', 'sent_at' => null, 'received_at' => fmt($inc['created']), 'failure_reason' => null, 'created_at' => fmt($inc['created']),
            'message_body' => mb_substr($inc['narr'], 0, 150), 'read_at' => fmt($inc['created']->modify('+3 minutes')), 'legal_hold' => 0];
    }
    foreach ($dispatches as $d) {
        if (!chance(60)) continue;
        $bad = chance(6);
        $sms[] = ['report_id' => null, 'incident_id' => $d['incident_id'], 'dispatch_id' => $d['id'], 'barangay_id' => BARANGAY_ID, 'sender_number' => $gateway, 'receiver_number' => $contactOf[$d['tanod']],
            'transport' => 'gsm_modem', 'message_type' => 'dispatch', 'direction' => 'outbound', 'gateway_message_id' => null, 'modem_message_id' => (string) mt_rand(100, 999), 'correlation_id' => uuidv4(),
            'status' => $bad ? 'failed' : 'sent', 'sent_at' => $bad ? null : fmt($d['d']->modify('+3 seconds')), 'received_at' => null, 'failure_reason' => $bad ? 'Modem reported no network signal.' : null,
            'created_at' => fmt($d['d']), 'message_body' => 'DISPATCH: ' . $incs[$d['inc']]['display'] . ' ' . $incs[$d['inc']]['loc'], 'read_at' => null, 'legal_hold' => 0];
    }
    foreach ($sosRows as $s) {
        if ($s['chan'] !== 'sms') continue;
        $sms[] = ['report_id' => null, 'incident_id' => null, 'dispatch_id' => null, 'barangay_id' => BARANGAY_ID, 'sender_number' => $contactOf[$s['user']], 'receiver_number' => $gateway,
            'transport' => 'gsm_modem', 'message_type' => 'sos', 'direction' => 'inbound', 'gateway_message_id' => null, 'modem_message_id' => (string) mt_rand(100, 999), 'correlation_id' => uuidv4(),
            'status' => 'received', 'sent_at' => null, 'received_at' => fmt($s['recv']), 'failure_reason' => null, 'created_at' => fmt($s['recv']),
            'message_body' => '[simulated encrypted SOS envelope]', 'read_at' => null, 'legal_hold' => 0];
    }
    bulk($pdo, 'sms_log', $sms);
    $M['sms_log_rows'] = count($sms);

    // ---------------------------------------------------- citizen reports, health, audit
    $cr = []; $usedForCitizen = [];
    foreach (range(1, 10) as $i) {
        $conv = $i <= 4; $sub = $now->modify('-' . mt_rand(1, 20) . ' days');
        $linked = null;
        if ($conv) {   // one citizen report per incident (uq_citizen_report_incident), so never reuse an incident
            do { $cand = $incs[mt_rand(5, count($incs) - 5)]; } while (isset($usedForCitizen[$cand['id']]));
            $usedForCitizen[$cand['id']] = true; $linked = $cand;
        }
        $cl = pick($LOCATIONS);
        $cr[] = ['barangay_id' => BARANGAY_ID, 'incident_id' => $linked['id'] ?? null, 'contact_number' => chance(70) ? '09' . mt_rand(100000000, 999999999) : null,
            'description' => pick(['Streetlight beside the chapel is out again.', 'Stray dogs near the school gate in the afternoon.', 'Loud karaoke past midnight in Purok 3.', 'Garbage piling up near the creek crossing.', 'Suspicious person seen near the seawall.']),
            'latitude' => round($cl[1] + mt_rand(-10, 10) / 100000, 7), 'longitude' => round($cl[2] + mt_rand(-10, 10) / 100000, 7), 'submitted_at' => fmt($sub),
            'converted_at' => $conv ? fmt($sub->modify('+2 hours')) : null, 'retention_expires_at' => fmt($sub->modify('+90 days')), 'legal_hold' => 0];
    }
    bulk($pdo, 'citizen_report', $cr);
    $hc = [];
    for ($h = 24; $h >= 0; $h--) {
        $hc[] = ['recorded_at' => fmt($now->modify("-{$h} hours")), 'db_status' => 'ok', 'osrm_status' => 'not_configured', 'ors_status' => 'configured', 'ollama_status' => 'not_configured',
            'gsm_status' => 'configured', 'fcm_status' => 'configured', 'sms_status' => 'configured'];
    }
    bulk($pdo, 'health_check_log', $hc);

    $audit = [];
    $aud = function (string $action, string $etype, ?int $eid, int $actor, DateTimeImmutable $at, array $meta = []) use (&$audit) {
        $meta['simulated'] = true;
        $audit[] = ['barangay_id' => BARANGAY_ID, 'actor_user_id' => $actor, 'action' => $action, 'entity_type' => $etype, 'entity_id' => $eid,
            'metadata_json' => json_encode($meta, JSON_UNESCAPED_SLASHES), 'ip_address' => '127.0.0.1', 'user_agent' => 'seed-ch4', 'created_at' => fmt($at)];
    };
    foreach ($schoolId as $sid) $aud('school_created', 'school', $sid, $SEC, $now->modify('-' . ($DAYS + 20) . ' days'));
    foreach ($dispatches as $d) {
        $aud('dispatch_created', 'dispatch', $d['id'], $d['by'], $d['d'], ['incident_id' => $d['incident_id'], 'tanod_id' => $d['tanod']]);
        if ($d['status'] === 'cancelled') $aud('dispatch_cancelled', 'dispatch', $d['id'], $ADMIN, $d['cancelled'], ['reason' => $d['cancel_reason']]);
    }
    foreach ($incs as $inc) {
        if ($inc['status'] === 'resolved') $aud('incident_resolved', 'incident', $inc['id'], pick([$ADMIN, $SEC]), $inc['created']->modify('+' . mt_rand(40, 200) . ' minutes'));
        if (in_array($inc['status'], ['duplicate', 'invalid', 'cancelled', 'reopened'], true)) $aud('incident_lifecycle_changed', 'incident', $inc['id'], $SEC, $inc['created']->modify('+2 hours'), ['to' => $inc['status']]);
    }
    $aud('seed_ch4_loaded', 'system', null, $ADMIN, $now, ['label' => $M['label'], 'seed' => $seedNo]);
    usort($audit, fn($a, $b) => strcmp($a['created_at'], $b['created_at']));
    bulk($pdo, 'audit_log', $audit);

    if ($UAT) {
        // SOS fallback numbers (T-07/T-08): fictitious, valid PH mobile format. The phone only texts the backup number.
        $insSet = $pdo->prepare('INSERT INTO system_settings (setting_key, setting_value, updated_at, updated_by) VALUES (?,?,?,?)');
        $insSet->execute(['sos_fallback.backup_contact_number', '09170000099', fmt($now), $ADMIN]);
        $insSet->execute(['sos_fallback.gateway_number', '09170000001', fmt($now), $ADMIN]);
    }

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    $pdo->exec('SET FOREIGN_KEY_CHECKS=1');
    fwrite(STDERR, "SEED FAILED: " . $e->getMessage() . "\n" . $e->getTraceAsString() . "\n");
    exit(1);
}
$pdo->exec('SET FOREIGN_KEY_CHECKS=1');

// ------------------------------------------------------------------ manifest
$M['incidents'] = ['total' => count($incs), 'by_status' => array_combine(array_map(fn($k) => substr($k, 9), array_keys($cnt)), array_values($cnt))];
$byType = []; $bySrc = [];
foreach ($incs as $i) { $byType[$i['type']] = ($byType[$i['type']] ?? 0) + 1; $bySrc[$i['src']] = ($bySrc[$i['src']] ?? 0) + 1; }
$M['incidents']['by_type'] = $byType; $M['incidents']['by_source'] = $bySrc;
$M['incidents']['offline_captured'] = ['count' => count($offlineDelays), 'capture_to_sync_delay_minutes' => stats($offlineDelays)];
$M['dispatches'] = count($dispatches);
$M['accounts'] = array_keys($uid);
if ($UAT) {
    $M['label'] = 'SIMULATED TEST DATA - UAT / final-evaluation seed (Barangay Dao only, not field data)';
    $q = fn(string $sql, array $a = []) => (function () use ($pdo, $sql, $a) { $st = $pdo->prepare($sql); $st->execute($a); return $st->fetchAll(); })();
    $col = fn(array $rows) => array_map(fn($r) => array_values($r)[0], $rows);
    $M['uat_fixtures'] = [
        'rostered_window_utc' => [fmt($wStart), fmt($wEnd)],
        'tanod_tester_account' => 'tanod.reyes: OFF duty, published shift covering the window, nothing active; both accomplishment months open',
        'on_duty_free_with_published_shift' => ['tanod.delacruz', 'tanod.gubaton'],
        'on_duty_without_published_shift' => 'tanod.dichoso (last GPS fix 40 min ago = stale unit)',
        'busy_tanods' => ['tanod.espinosa (en_route)', 'tanod.banares (arrived)'],
        'off_duty' => ['tanod.reyes', 'tanod.candelaria'],
        'suspended' => 'tanod.olayvar',
        'pending_incidents_no_dispatch' => $col($q("SELECT display_id FROM incident WHERE status='pending' ORDER BY created_at")),
        'dispatched_live_en_route' => $uatFixture['live_en_route'] ?? [], 'dispatched_live_arrived' => $uatFixture['live_arrived'] ?? [],
        'dispatched_all_completed_awaiting_resolve' => $uatFixture['completed'] ?? [],
        'reopened_incidents' => $col($q("SELECT display_id FROM incident WHERE status='reopened'")),
        'resolved_incidents_for_duplicate_target' => (int) $q("SELECT COUNT(*) c FROM incident WHERE status='resolved'")[0]['c'],
        'active_sos' => (int) $q("SELECT COUNT(*) c FROM tanod_sos WHERE status='active'")[0]['c'],
        'pending_swap_requests' => (int) $q("SELECT COUNT(*) c FROM shift_swap_request WHERE status='pending'")[0]['c'],
        'draft_shifts_awaiting_publish' => (int) $q("SELECT COUNT(*) c FROM shift_schedule WHERE approval_status='draft'")[0]['c'],
        'accomplishment_reports_by_status' => $q("SELECT status, COUNT(*) c FROM accomplishment_report GROUP BY status"),
        'flagged_duration_entries' => (int) $q("SELECT COUNT(*) c FROM accomplishment_entry WHERE duration_flag=1")[0]['c'],
        'unconverted_citizen_reports' => (int) $q("SELECT COUNT(*) c FROM citizen_report WHERE incident_id IS NULL")[0]['c'],
        'school_linked_incidents' => (int) $q("SELECT COUNT(*) c FROM incident WHERE school_id IS NOT NULL")[0]['c'],
        'sos_fallback_numbers' => 'backup 09170000099, gateway 09170000001 (fictitious)',
    ];
}
$M['live_state'] = 'pending/dispatched incidents, the active SOS and the open dispatch offer are timed relative to the moment the seed ran; re-run the reset for a fresh "now".';
$dir = dirname(__DIR__) . '/storage';
if (!is_dir($dir)) @mkdir($dir, 0775, true);
file_put_contents($dir . ($UAT ? '/uat-seed-manifest.json' : '/ch4-seed-manifest.json'), json_encode($M, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));

echo ($UAT ? "UAT seed" : "Chapter 4 seed") . " loaded into {$dbName} (SIMULATED TEST DATA).\n";
echo sprintf("  incidents %d | dispatches %d | shifts %d | gps fixes %d | sos %d | referrals %d | sms_log %d\n",
    count($incs), count($dispatches), count($shifts), count($gps), $sosN, count($refs), count($sms));
echo "  manifest: backend/storage/" . ($UAT ? 'uat' : 'ch4') . "-seed-manifest.json\n  login: admin.dao / secretary.dao / punong.dao / tanod.reyes ... password Demo@2026\n";

function stats(array $v): array
{
    if (!$v) return ['n' => 0, 'median' => null, 'mean' => null, 'max' => null];
    sort($v); $n = count($v);
    $median = $n % 2 ? $v[intdiv($n, 2)] : ($v[$n / 2 - 1] + $v[$n / 2]) / 2;
    return ['n' => $n, 'median' => round((float) $median, 1), 'mean' => round(array_sum($v) / $n, 1), 'p95' => round((float) $v[(int) floor(0.95 * ($n - 1))], 1), 'max' => round((float) max($v), 1)];
}

/** one of the 4 land points nearest to (lat,lng), other than where we already are */
function nearWaypoint(float $lat, float $lng, array $locs): array
{
    usort($locs, fn($a, $b) => (($a[1] - $lat) ** 2 + ($a[2] - $lng) ** 2) <=> (($b[1] - $lat) ** 2 + ($b[2] - $lng) ** 2));
    $c = array_slice($locs, 1, 4);
    $p = $c[mt_rand(0, count($c) - 1)];
    return [$p[1], $p[2]];
}
