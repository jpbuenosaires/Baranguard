<?php
declare(strict_types=1);

/**
 * seed-dao-demo.php — replaces ALL Barangay Dao (barangay_id=1) incident
 * data in `baranguard_uiseed` with a fresh, realistic set: multilingual
 * narratives (Tagalog/English/Bikol), recent dates (last 30 days), and
 * locations grounded in Dao's real geography (centroid 12.9223,123.6725 —
 * PhilAtlas; Dao is Pilar's former Poblacion, with a real seawall/fishery
 * brokers' center landmark the old seed data never used).
 *
 * SAFETY: refuses to run unless the active DB_NAME is literally
 * "baranguard_uiseed" — this must never touch the real `baranguard` DB.
 * Runs inside one transaction; a mysqldump backup should be taken before
 * running this (see DEVLOG.md for this session's backup).
 *
 * Usage: php scripts/seed-dao-demo.php
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "CLI only.\n");
    exit(1);
}

require dirname(__DIR__) . '/config/env.php';
baranguard_load_env();

$dbName = baranguard_env('DB_NAME');
if ($dbName !== 'baranguard_uiseed') {
    fwrite(STDERR, "Refusing to run: DB_NAME is '{$dbName}', not 'baranguard_uiseed'.\n");
    exit(1);
}

require dirname(__DIR__) . '/config/db.php';
$pdo = baranguard_db();

const BARANGAY_ID = 1;
const TOTAL_INCIDENTS = 123;
const DAYS_WINDOW = 30;
const ADMIN_ID = 1;      // admin.dao
const SECRETARY_ID = 2;  // secretary.dao
const TANOD_IDS = [4, 5, 6, 7, 8]; // active Dao tanods only (reyes, delacruz, gubaton, dichoso, espinosa)

function uuidv4(): string
{
    $data = random_bytes(16);
    $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
    $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

function pick(array $arr) { return $arr[array_rand($arr)]; }

// --- Real-geography locations (Dao centroid 12.9223,123.6725, PhilAtlas) ---
// Real neighboring barangays (Marifosque, Santa Fe, Banuyo, Guiron, San
// Antonio) are referenced for boundary-adjacent spots — same source.
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
    ['Elementary school covered court', 12.9206, 123.6714],
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
$TYPE_COUNTS = [
    'theft' => 22, 'disturbance' => 20, 'animal_complaint' => 14, 'vandalism' => 8,
    'traffic_incident' => 12, 'domestic_dispute' => 14, 'physical_injury' => 10,
    'medical_emergency' => 8, 'fire' => 3, 'missing_person' => 3, 'other' => 9,
];
assert(array_sum($TYPE_COUNTS) === TOTAL_INCIDENTS);

$PRIORITY_BY_TYPE = [
    'fire' => 'critical', 'medical_emergency' => 'critical', 'missing_person' => 'critical',
    'physical_injury' => 'high', 'domestic_dispute' => 'high', 'traffic_incident' => 'high',
    'theft' => 'normal', 'disturbance' => 'normal', 'animal_complaint' => 'normal',
    'vandalism' => 'normal', 'other' => 'normal',
];

$RESPONDENT_ELIGIBLE_TYPES = ['domestic_dispute', 'physical_injury', 'vandalism'];

$LANGS = ['en', 'tl', 'bik'];

// Build a flat list of (type) rows respecting TYPE_COUNTS, then shuffle
// and assign dates/languages/etc. across it.
$typeQueue = [];
foreach ($TYPE_COUNTS as $type => $count) {
    for ($i = 0; $i < $count; $i++) $typeQueue[] = $type;
}
shuffle($typeQueue);

// Language assignment: 41/41/41.
$langQueue = array_merge(array_fill(0, 41, 'en'), array_fill(0, 41, 'tl'), array_fill(0, 41, 'bik'));
shuffle($langQueue);

// Status plan: 3 pending, 5 dispatched (both very recent, 0-3 days ago),
// 1 cancelled, 1 duplicate, 113 resolved (spread across the full window).
$statusPlan = array_merge(
    array_fill(0, 3, 'pending'),
    array_fill(0, 5, 'dispatched'),
    ['cancelled'],
    ['duplicate'],
    array_fill(0, 113, 'resolved')
);
assert(count($statusPlan) === TOTAL_INCIDENTS);
shuffle($statusPlan);

$now = new DateTimeImmutable('now');

echo "Backing up not performed by this script — confirm a dump was taken separately.\n";
echo "Deleting existing Dao (barangay_id=1) incident tree...\n";

$pdo->beginTransaction();
try {
    $pdo->exec('SET FOREIGN_KEY_CHECKS=0');

    $incidentIdsSql = '(SELECT incident_id FROM incident WHERE barangay_id=' . BARANGAY_ID . ')';
    $dispatchIdsSql = '(SELECT dispatch_id FROM dispatch WHERE incident_id IN ' . $incidentIdsSql . ')';
    $notifIdsSql = '(SELECT notification_id FROM notification WHERE incident_id IN ' . $incidentIdsSql . ' OR dispatch_id IN ' . $dispatchIdsSql . ')';

    $pdo->exec("DELETE FROM notification_delivery WHERE notification_id IN {$notifIdsSql}");
    $pdo->exec("DELETE FROM notification_target WHERE notification_id IN {$notifIdsSql}");
    $pdo->exec("DELETE FROM notification WHERE incident_id IN {$incidentIdsSql} OR dispatch_id IN {$dispatchIdsSql}");
    $pdo->exec("DELETE FROM gps_track WHERE dispatch_id IN {$dispatchIdsSql}");
    $pdo->exec("DELETE FROM tanod_sos WHERE dispatch_id IN {$dispatchIdsSql}");
    $pdo->exec("DELETE FROM sms_log WHERE incident_id IN {$incidentIdsSql} OR dispatch_id IN {$dispatchIdsSql}");
    $pdo->exec("DELETE FROM evidence_attachment WHERE incident_id IN {$incidentIdsSql}");
    $pdo->exec("UPDATE citizen_report SET incident_id=NULL WHERE incident_id IN {$incidentIdsSql}");
    $pdo->exec("DELETE FROM dispatch WHERE incident_id IN {$incidentIdsSql}");
    $pdo->exec("DELETE FROM incident WHERE barangay_id=" . BARANGAY_ID);

    $pdo->exec('SET FOREIGN_KEY_CHECKS=1');

    echo 'Deleted. Generating ' . TOTAL_INCIDENTS . " new incidents...\n";

    $insertIncident = $pdo->prepare(
        'INSERT INTO incident
            (barangay_id, reported_by, device_id, incident_type, priority, raw_narrative,
             redacted_narrative, redaction_approved_by, redaction_approved_at, status,
             source, latitude, longitude, created_at, updated_at, complainant_name,
             respondent_name, complainant_contact_number, location_description, display_id)
         VALUES
            (:barangay_id, :reported_by, NULL, :incident_type, :priority, :raw_narrative,
             :redacted_narrative, :redaction_approved_by, :redaction_approved_at, :status,
             :source, :latitude, :longitude, :created_at, :updated_at, :complainant_name,
             :respondent_name, :complainant_contact_number, :location_description, :display_id)'
    );

    $insertDispatch = $pdo->prepare(
        'INSERT INTO dispatch
            (incident_id, dispatched_by, tanod_id, priority, route_status, status,
             dispatched_at, en_route_at, arrived_at, completed_at, created_client_request_id)
         VALUES
            (:incident_id, :dispatched_by, :tanod_id, :priority, \'available\', :status,
             :dispatched_at, :en_route_at, :arrived_at, :completed_at, :client_request_id)'
    );

    $insertedIncidentIds = [];
    $incidentIdByType = [];
    $incNo = 1;

    foreach ($typeQueue as $i => $type) {
        $status = $statusPlan[$i];
        $lang = $langQueue[$i];
        $priority = $PRIORITY_BY_TYPE[$type];
        [$locDesc, $lat0, $lng0] = pick($LOCATIONS);
        // Small real-feeling jitter so not every incident of the same
        // location type shares the identical exact point.
        $lat = $lat0 + (mt_rand(-15, 15) / 100000);
        $lng = $lng0 + (mt_rand(-15, 15) / 100000);

        // Recent date: last 30 days, weighted so pending/dispatched land
        // in the most recent 0-3 days (an active-feeling queue).
        if (in_array($status, ['pending', 'dispatched'], true)) {
            $daysAgo = mt_rand(0, 3);
        } else {
            $daysAgo = mt_rand(0, DAYS_WINDOW);
        }
        $createdAt = $now->modify("-{$daysAgo} days")->setTime(mt_rand(5, 23), mt_rand(0, 59), mt_rand(0, 59));

        $templates = $TEMPLATES[$type][$lang];
        $template = pick($templates);
        $slotAPool = $SLOT_A[$type][$lang] ?? null;
        $slotBPool = $SLOT_B[$type][$lang] ?? null;
        $narrative = str_replace(
            ['{A}', '{B}'],
            [$slotAPool !== null ? pick($slotAPool) : '', $slotBPool !== null ? pick($slotBPool) : ''],
            $template
        );

        $source = pick(['web', 'web', 'web', 'app', 'app', 'sms']); // ~50% web, ~33% app, ~17% sms
        if ($source === 'app') {
            $reportedBy = pick(TANOD_IDS);
        } elseif ($source === 'web') {
            $reportedBy = pick([SECRETARY_ID, SECRETARY_ID, ADMIN_ID]);
        } else {
            $reportedBy = null; // anonymous SMS report
        }

        $complainantName = pick($NAMES);
        $respondentName = in_array($type, $RESPONDENT_ELIGIBLE_TYPES, true) && mt_rand(0, 100) < 60
            ? pick($NAMES)
            : null;
        $contactNumber = mt_rand(0, 100) < 70 ? ('09' . mt_rand(100000000, 999999999)) : null;

        // Redaction: only "already processed" for resolved-track incidents,
        // approved shortly after creation — never for still-open ones,
        // matching the real pipeline order (redact only after intake).
        $redactedNarrative = null;
        $redactionApprovedBy = null;
        $redactionApprovedAt = null;
        if (in_array($status, ['resolved', 'cancelled'], true)) {
            $redactedNarrative = $narrative;
            $redactionApprovedBy = SECRETARY_ID;
            $redactionApprovedAt = $createdAt->modify('+' . mt_rand(10, 90) . ' minutes')->format('Y-m-d H:i:s');
        }

        $displayId = sprintf('INC-2026-%03d', $incNo++);

        $insertIncident->execute([
            'barangay_id' => BARANGAY_ID,
            'reported_by' => $reportedBy,
            'incident_type' => $type,
            'priority' => $priority,
            'raw_narrative' => $narrative,
            'redacted_narrative' => $redactedNarrative,
            'redaction_approved_by' => $redactionApprovedBy,
            'redaction_approved_at' => $redactionApprovedAt,
            'status' => $status === 'duplicate' ? 'duplicate' : ($status === 'cancelled' ? 'cancelled' : $status),
            'source' => $source,
            'latitude' => $lat,
            'longitude' => $lng,
            'created_at' => $createdAt->format('Y-m-d H:i:s'),
            'updated_at' => $createdAt->format('Y-m-d H:i:s'),
            'complainant_name' => $complainantName,
            'respondent_name' => $respondentName,
            'complainant_contact_number' => $contactNumber,
            'location_description' => $locDesc,
            'display_id' => $displayId,
        ]);
        $incidentId = (int) $pdo->lastInsertId();
        $insertedIncidentIds[] = $incidentId;
        $incidentIdByType[$type][] = $incidentId;

        // --- Dispatch ---
        $needsDispatch = in_array($status, ['dispatched'], true)
            || ($status === 'resolved' && (
                in_array($priority, ['critical', 'high'], true) ? mt_rand(0, 100) < 90 : mt_rand(0, 100) < 45
            ));
        $dispatchId = null;
        if ($needsDispatch) {
            $tanodId = pick(TANOD_IDS);
            $dispatchedAt = $createdAt->modify('+' . mt_rand(3, 20) . ' minutes');
            if ($status === 'dispatched') {
                $dStatus = pick(['assigned', 'en_route', 'arrived']);
                $enRouteAt = in_array($dStatus, ['en_route', 'arrived'], true) ? $dispatchedAt->modify('+' . mt_rand(2, 10) . ' minutes')->format('Y-m-d H:i:s') : null;
                $arrivedAt = $dStatus === 'arrived' ? $dispatchedAt->modify('+' . mt_rand(10, 25) . ' minutes')->format('Y-m-d H:i:s') : null;
                $completedAt = null;
            } else {
                $dStatus = 'completed';
                $enRouteAt = $dispatchedAt->modify('+' . mt_rand(2, 10) . ' minutes')->format('Y-m-d H:i:s');
                $arrivedAt = $dispatchedAt->modify('+' . mt_rand(10, 25) . ' minutes')->format('Y-m-d H:i:s');
                $completedAt = $dispatchedAt->modify('+' . mt_rand(30, 90) . ' minutes')->format('Y-m-d H:i:s');
            }
            $insertDispatch->execute([
                'incident_id' => $incidentId,
                'dispatched_by' => ADMIN_ID,
                'tanod_id' => $tanodId,
                'priority' => $priority,
                'status' => $dStatus,
                'dispatched_at' => $dispatchedAt->format('Y-m-d H:i:s'),
                'en_route_at' => $enRouteAt,
                'arrived_at' => $arrivedAt,
                'completed_at' => $completedAt,
                'client_request_id' => uuidv4(),
            ]);
            $dispatchId = (int) $pdo->lastInsertId();
        }

    }

    // --- Post-pass: wire up the one 'cancelled' and one 'duplicate' demo row ---
    $cancelledIdx = array_search('cancelled', $statusPlan, true);
    $duplicateIdx = array_search('duplicate', $statusPlan, true);
    $cancelledIncidentId = $insertedIncidentIds[$cancelledIdx];
    $duplicateIncidentId = $insertedIncidentIds[$duplicateIdx];
    $duplicateType = $typeQueue[$duplicateIdx];
    // Pick a sibling of the same type to point at (never itself).
    $siblingCandidates = array_diff($incidentIdByType[$duplicateType] ?? [], [$duplicateIncidentId]);
    $duplicateTargetId = $siblingCandidates !== [] ? reset($siblingCandidates) : $insertedIncidentIds[0];

    $pdo->prepare('UPDATE incident SET lifecycle_changed_by=:by, lifecycle_changed_at=updated_at WHERE incident_id=:id')
        ->execute(['by' => SECRETARY_ID, 'id' => $cancelledIncidentId]);
    $pdo->prepare('UPDATE incident SET duplicate_of_incident_id=:target, lifecycle_changed_by=:by, lifecycle_changed_at=updated_at WHERE incident_id=:id')
        ->execute(['target' => $duplicateTargetId, 'by' => SECRETARY_ID, 'id' => $duplicateIncidentId]);

    // --- Reattach the two real evidence files (photo+voice, verified
    // real bytes on disk) to one app-sourced theft/vandalism incident so
    // the evidence viewer stays demoable with genuine files, not just
    // metadata rows pointing nowhere. ---
    $evidenceHostStmt = $pdo->prepare(
        "SELECT incident_id, reported_by FROM incident
         WHERE incident_id IN (" . implode(',', $insertedIncidentIds) . ")
           AND source='app' AND incident_type IN ('theft','vandalism')
         ORDER BY incident_id LIMIT 1"
    );
    $evidenceHostStmt->execute();
    $evidenceHost = $evidenceHostStmt->fetch(PDO::FETCH_ASSOC);
    if ($evidenceHost !== false) {
        $uploadedBy = $evidenceHost['reported_by'] ?? ADMIN_ID;
        $insertEvidence = $pdo->prepare(
            'INSERT INTO evidence_attachment
                (incident_id, type, file_path, uploaded_by, uploaded_at, sha256, byte_size, mime_type, original_filename, client_request_id)
             VALUES (:incident_id, :type, :file_path, :uploaded_by, NOW(), :sha256, :byte_size, :mime_type, :original_filename, :client_request_id)'
        );
        $insertEvidence->execute([
            'incident_id' => $evidenceHost['incident_id'],
            'type' => 'photo',
            'file_path' => 'incident-119-966b57735986ea09',
            'uploaded_by' => $uploadedBy,
            'sha256' => '212b16a46075910c25ec45a21e9e98354658e120cf2f58507794977d174a7fc1',
            'byte_size' => 179892,
            'mime_type' => 'image/jpeg',
            'original_filename' => 'evidence_photo.jpg',
            'client_request_id' => uuidv4(),
        ]);
        $insertEvidence->execute([
            'incident_id' => $evidenceHost['incident_id'],
            'type' => 'voice',
            'file_path' => 'incident-119-a1ba05c902574a76',
            'uploaded_by' => $uploadedBy,
            'sha256' => '2d6ab7fbda15e33834df2346b2a6d1f3681790dfeaf4d9f1b0f025e15aadc934',
            'byte_size' => 74978,
            'mime_type' => 'audio/aac',
            'original_filename' => 'evidence_voice.aac',
            'client_request_id' => uuidv4(),
        ]);
        echo "Reattached real evidence files to incident_id={$evidenceHost['incident_id']}.\n";
    }

    $pdo->commit();
    echo "Done. Inserted " . count($insertedIncidentIds) . " incidents.\n";
} catch (\Throwable $e) {
    $pdo->exec('SET FOREIGN_KEY_CHECKS=1');
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    fwrite(STDERR, 'FAILED: ' . $e->getMessage() . "\n" . $e->getTraceAsString() . "\n");
    exit(1);
}
