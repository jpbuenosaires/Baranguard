<?php
declare(strict_types=1);

/**
 * seed-demo-data.php — replaces ALL incident-tree data (and creates the
 * missing user accounts) for ALL FOUR pilot barangays in
 * `baranguard_uiseed`, for UAT testing across Dao, Binanuahan,
 * Marifosque, and Banuyo.
 *
 * Supersedes seed-dao-demo.php (Dao-only, kept for history but no longer
 * the one to run) — this does the same thing, generalized across all
 * four barangays in one consistent pass so dates/style/quality match
 * across the whole dataset rather than mixing two separate runs.
 *
 * Real geography (PhilAtlas, 2026-09-29): all four are Pilar's old
 * Poblacion cluster — Dao, Marifosque, and Banuyo are each literally
 * "formerly Poblacion"; Binanuahan is the one true non-Poblacion
 * neighbor. Centroids used below are each barangay's real one.
 *
 * SAFETY: refuses to run unless DB_NAME is literally "baranguard_uiseed".
 * Runs inside one transaction. Take a mysqldump backup before running.
 *
 * Usage: php scripts/seed-demo-data.php
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

const DAYS_WINDOW = 30;
// Existing Dao (barangay_id=1) accounts — reused, not recreated.
const DAO_ADMIN_ID = 1;
const DAO_SECRETARY_ID = 2;
const DAO_TANOD_IDS = [4, 5, 6, 7, 8];

function uuidv4(): string
{
    $data = random_bytes(16);
    $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
    $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

function pick(array $arr) { return $arr[array_rand($arr)]; }

// Same hash as every existing demo account ("Demo@2026") — reused
// verbatim so new accounts share the documented shared demo password.
const DEMO_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=4,p=1$ZmYwUTFDWGpDdVhIbWhvQg$JNTncGjMGRrxGskIsG4HC9zTPdDofF/yt9sfVDAR2G8';

// --- Per-barangay config: real centroid (PhilAtlas), real locations,
// user roster (created if missing), incident volume. ---
$BARANGAYS = [
    1 => [
        'slug' => 'dao',
        'incident_count' => 123,
        'centroid' => [12.9223, 123.6725],
        'locations' => [
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
            ["Seawall near the Fishery Brokers' Center", 12.9198, 123.6702],
            ['Fish landing area beside the seawall', 12.9195, 123.6705],
            ['Backyard near the rice paddies, boundary with Santa Fe', 12.9250, 123.6738],
        ],
        'roster' => [
            'admin' => ['username' => 'admin.dao', 'existing_id' => DAO_ADMIN_ID],
            'secretary' => ['username' => 'secretary.dao', 'existing_id' => DAO_SECRETARY_ID],
            'tanods' => ['existing_ids' => DAO_TANOD_IDS],
        ],
    ],
    2 => [
        'slug' => 'binanuahan',
        'incident_count' => 40,
        'centroid' => [12.9237, 123.6769],
        'locations' => [
            ['Purok 1, along the barangay road', 12.9241, 123.6762],
            ['Purok 2, near the covered court', 12.9233, 123.6775],
            ['Purok 3, riverside', 12.9245, 123.6758],
            ['National road, near the boundary with Banuyo', 12.9248, 123.6752],
            ['Barangay hall, Binanuahan proper', 12.9237, 123.6769],
            ['Near the day care center', 12.9230, 123.6772],
            ['Purok 4, backyard area', 12.9225, 123.6780],
            ['Waiting shed near the boundary with Calongay', 12.9250, 123.6785],
        ],
        'roster' => [
            'admin' => ['username' => 'admin.binanuahan', 'full_name' => 'Teodoro Malto'],
            'secretary' => ['username' => 'secretary.binanuahan', 'full_name' => 'Corazon Nierras'],
            'punong_barangay' => ['username' => 'kapitan.binanuahan', 'full_name' => 'Herminio Escurel'],
            'tanods' => ['names' => ['Roberto Guevarra', 'Susana Fabricante', 'Wilfredo Ognita', 'Angelita Bonavente']],
        ],
    ],
    3 => [
        'slug' => 'marifosque',
        'incident_count' => 40,
        'centroid' => [12.9259, 123.6670],
        'locations' => [
            ['Purok 1, near the chapel', 12.9263, 123.6663],
            ['Purok 2, along the national road', 12.9255, 123.6676],
            ['National road, boundary with Dao', 12.9245, 123.6690],
            ['Barangay hall, Marifosque proper', 12.9259, 123.6670],
            ['Near the elementary school', 12.9266, 123.6660],
            ['Purok 3, riverside path', 12.9250, 123.6665],
            ['Sitio area near the boundary with Santa Fe', 12.9270, 123.6655],
            ['Waiting shed, national road', 12.9262, 123.6680],
        ],
        'roster' => [
            'admin' => ['username' => 'admin.marifosque', 'full_name' => 'Fernando Guyala'],
            'secretary' => ['username' => 'secretary.marifosque', 'full_name' => 'Milagros Espadero'],
            'punong_barangay' => ['username' => 'kapitan.marifosque', 'full_name' => 'Ariston Gerundio'],
            'tanods' => ['names' => ['Ernesto Balanay', 'Ligaya Fortuna', 'Dominador Grande', 'Remedios Solano']],
        ],
    ],
    4 => [
        'slug' => 'banuyo',
        'incident_count' => 40,
        'centroid' => [12.9250, 123.6750],
        'locations' => [
            ['Purok 1, near the public market', 12.9254, 123.6744],
            ['Purok 2, along the national road', 12.9246, 123.6756],
            ['Barangay hall, Banuyo proper', 12.9250, 123.6750],
            ['Near the covered court', 12.9257, 123.6746],
            ['Purok 3, riverside', 12.9243, 123.6760],
            ['National road, boundary with Dao', 12.9235, 123.6735],
            ['Near the day care center', 12.9260, 123.6753],
            ['Waiting shed, boundary with Marifosque', 12.9255, 123.6700],
        ],
        'roster' => [
            'admin' => ['username' => 'admin.banuyo', 'full_name' => 'Salvador Nazareno'],
            'secretary' => ['username' => 'secretary.banuyo', 'full_name' => 'Corazon Gragasin'],
            'punong_barangay' => ['username' => 'kapitan.banuyo', 'full_name' => 'Vicente Escalona'],
            'tanods' => ['names' => ['Pablito Ravago', 'Norma Gerundio', 'Federico Balanon', 'Adoracion Frando']],
        ],
    ],
];

$NAMES = [
    'Marites Obligar', 'Ronaldo Fajardo', 'Cristina Belga', 'Danilo Escobal', 'Perla Guinto',
    'Warlito Nacpil', 'Josefina Rebutazo', 'Alvin Torreliza', 'Emelita Sabater', 'Restituto Balane',
    'Leonora Escoto', 'Gerardo Villagracia', 'Fe Domagsang', 'Rodrigo Parcon', 'Teresita Abrera',
    'Bonifacio Guray', 'Analiza Fetalvero', 'Melchor Grepo', 'Concepcion Ranises', 'Edgardo Sabornido',
];

// --- Narrative templates: same set used for Dao, shared across all
// barangays (the underlying Tagalog/English/Bikol content is
// barangay-agnostic; only locations/names/users vary per barangay). ---
$TEMPLATES = [
    'theft' => [
        'en' => ['A {A} was taken from {B} while the owner was away. No witnesses have come forward yet.',
            'Resident reported {A} missing after leaving {B} unattended for a short time.'],
        'tl' => ['May nawalang {A} sa labas habang wala ang may-ari. Wala pang saksi na lumabas.',
            'Nag-report ang residente na nawala ang {A} matapos iwanang bantay ang {B} ng ilang minuto lamang.'],
        'bik' => ['May nawara na {A} mientras wara an kagsadiri. Mayo pang testigo na nagpahayag.',
            'Nagreport an residente na nawara an {A} pagkatapos bayaan an {B} nin pira ka minuto sana.'],
    ],
    'disturbance' => [
        'en' => ['Group of {A} drinking and shouting late at night, disturbing nearby residents.',
            'Loud argument and shouting reported along the road; no weapons involved.'],
        'tl' => ['Grupo ng mga {A} na umiinom at sumisigaw nang gabing-gabi, nakakagambala sa mga kapitbahay.',
            'May naiulat na malakas na away at sigawan sa daan; walang gamit na sandata.'],
        'bik' => ['Grupo nin mga {A} na nag-iinom asin nagkukurahaw sa gab-i, nakaki-istorbo sa mga kataraed.',
            'May report nin makusog na iriwal asin kurahaw sa tinampo; mayo nin ginamit na armas.'],
    ],
    'animal_complaint' => [
        'en' => ['Stray dogs gathering near the school during dismissal time. No bites reported.',
            'Resident reports a neighbor\'s {A} repeatedly entering their yard and damaging plants.'],
        'tl' => ['Maraming askal na nagtitipon malapit sa paaralan tuwing oras ng uwian. Walang naiulat na kagat.',
            'Nagreklamo ang residente tungkol sa {A} ng kapitbahay na paulit-ulit na pumapasok sa bakuran.'],
        'bik' => ['Dakol na ayam na nagtitiripon harani sa eskwelahan pag-oras nin pag-uli. Mayo nin naireport na pangkagat.',
            'Nagreklamo an residente sa {A} kan kataraed na parateng nagsusulod sa harong-baybay.'],
    ],
    'vandalism' => [
        'en' => ['Spray paint discovered on the barangay hall wall this morning. Person(s) responsible unknown.',
            'Property damage reported — a fence was deliberately broken overnight.'],
        'tl' => ['May nakitang graffiti sa pader ng barangay hall ngayong umaga. Hindi pa kilala ang gumawa.',
            'May naiulat na sinasadyang pagkasira ng bakod kagabi.'],
        'bik' => ['May nahiling na graffiti sa pader kan barangay hall ngunyan na aga. Dai pa aram kun siisay an naggibo.',
            'May report nin tuyong pagkarawa kan bakod kagab-i.'],
    ],
    'traffic_incident' => [
        'en' => ['Motorcycle skidded on the wet road; rider sustained minor abrasions and is conscious.',
            'Two-vehicle collision along the national road; no serious injuries reported.'],
        'tl' => ['Naduling ang motorsiklo sa basang kalsada; may malay ang driver, may bahagyang sugat.',
            'Banggaan ng dalawang sasakyan sa national road; walang seryosong sugat na naiulat.'],
        'bik' => ['Naduhagi an motorsiklo sa basang tinampo; may malay an nagmamaneho, may gamay na sugat.',
            'Nagbanggaan an duwang sakyan sa national road; mayo nin grabeng sugat na naireport.'],
    ],
    'fire' => [
        'en' => ['Cooking fire spread to a kitchen wall; neighbors helped put it out. No injuries.',
            'Small grass fire reported near the rice fields, possibly from unattended burning.'],
        'tl' => ['Kumalat ang sunog mula sa lutuan patungo sa pader ng kusina; tinulungan ito ng mga kapitbahay na patayin. Walang nasugatan.',
            'May naiulat na maliit na sunog sa damo malapit sa palayan, posibleng mula sa hindi binantayang pagsunog.'],
        'bik' => ['Naglakop an kalayo hale sa lutuan pasiring sa pader kan kusina; nagbulig an mga kataraed na paluon iyan. Mayo nin nasugatan.',
            'May report nin sadit na sunog sa doot harani sa oma, tibaad hale sa daing bantay na pagsulo.'],
    ],
    'medical_emergency' => [
        'en' => ['Elderly resident collapsed at home, breathing but unresponsive. Family requesting immediate transport.',
            'Pregnant resident reporting early labor signs; family requesting assistance to reach the health center.'],
        'tl' => ['Matandang residente ang nabuwal sa bahay, may hininga pero hindi tumutugon. Humihingi ng agarang saklolo ang pamilya.',
            'May buntis na residente na nagpapakita ng senyales ng maagang panganganak; humihingi ng tulong ang pamilya.'],
        'bik' => ['An gurang na residente nabuka sa harong, nakakahangos alagad dai nagrerespondi. Naghahagad nin tulong an pamilya.',
            'May bados na residente na may senyas nin maaga na pangaanak; naghahagad nin tabang an pamilya.'],
    ],
    'missing_person' => [
        'en' => ['Child did not return home from school. Last seen wearing a white school uniform.',
            'Elderly resident wandered off earlier today; family searching nearby areas.'],
        'tl' => ['Hindi umuwi mula sa paaralan ang bata. Huling nakita na nakasuot ng puting uniporme.',
            'May matandang residente na naglakad palayo kaninang araw; naghahanap ang pamilya sa mga karatig na lugar.'],
        'bik' => ['Dai nag-uli hale sa eskwelahan an aki. Huring nahiling na nakasulot nin puting uniporme.',
            'May gurang na residente na naglakaw palayo kasu-kasu na aldaw; naghahanap an pamilya sa mga kataraed na lugar.'],
    ],
    'physical_injury' => [
        'en' => ['Fistfight between two men after a drinking session; one sustained a cut above the eye.',
            'Resident injured after falling from a ladder while doing yard work.'],
        'tl' => ['Nagsuntukan ang dalawang lalaki matapos ang inuman; may sugat sa ibabaw ng mata ang isa.',
            'Nasugatan ang residente matapos mahulog sa hagdan habang naglilinis ng bakuran.'],
        'bik' => ['Nagsusumbagan an duwang lalaki pagkatapos nin pag-inom; may sugat sa ibabaw kan mata an saro.',
            'Nasugatan an residente pagkatapos na mahulog sa hagdan mientras naglilinig kan harong-baybay.'],
    ],
    'domestic_dispute' => [
        'en' => ['Loud argument between spouses reported by a neighbor. No weapons, no injuries reported.',
            'Family dispute over a debt escalated into shouting; barangay tanod requested to mediate.'],
        'tl' => ['May naiulat na malakas na away ng mag-asawa mula sa kapitbahay. Walang sandata, walang sugat.',
            'Umigting ang alitan ng pamilya tungkol sa utang hanggang sa sigawan; hiniling ang tanod para mamagitan.'],
        'bik' => ['May report nin makusog na iriwal kan mag-agom hale sa kataraed. Mayo nin armas, mayo nin sugat.',
            'Naglala an ka-iriwalan kan pamilya manongod sa utang sagkod sa kurahaw; hinagad an tanod na mamagitan.'],
    ],
    'other' => [
        'en' => ['Street light has been out for several nights; residents requesting repair.',
            'Resident reporting a foul odor coming from a clogged drainage near their home.'],
        'tl' => ['Ilang gabi nang sira ang ilaw ng poste; humihiling ang mga residente ng ayos.',
            'May residenteng nag-uulat ng masangsang na amoy mula sa nakasarang kanal malapit sa bahay nila.'],
        'bik' => ['Pira ng banggi na luyop an ilaw kan poste; naghahagad an mga residente nin ayos.',
            'May residente na nagrereport nin maalot na baho hale sa nakasarang kanal harani sa harong ninda.'],
    ],
];

$SLOT_A = [
    'theft' => [
        'en' => ['bicycle', 'cellphone', 'cash', 'chickens', 'laundry from the clothesline'],
        'tl' => ['bisikleta', 'cellphone', 'pera', 'manok', 'damit sa sampayan'],
        'bik' => ['bisikleta', 'cellphone', 'kwarta', 'manok', 'bado sa sampayan'],
    ],
    'disturbance' => [
        'en' => ['men', 'youths'], 'tl' => ['lalaki', 'kabataan'], 'bik' => ['lalaki', 'hoben'],
    ],
    'animal_complaint' => [
        'en' => ['carabao', 'goat', 'pig'], 'tl' => ['kalabaw', 'kambing', 'baboy'], 'bik' => ['kalabaw', 'kanding', 'baboy'],
    ],
];
$SLOT_B = [
    'theft' => [
        'en' => ['the house', 'the store', 'the yard'], 'tl' => ['bahay', 'tindahan', 'bakuran'], 'bik' => ['harong', 'tindahan', 'harong-baybay'],
    ],
];

$TYPE_COUNTS_BASE = [
    'theft' => 0.179, 'disturbance' => 0.163, 'animal_complaint' => 0.114, 'vandalism' => 0.065,
    'traffic_incident' => 0.098, 'domestic_dispute' => 0.114, 'physical_injury' => 0.081,
    'medical_emergency' => 0.065, 'fire' => 0.024, 'missing_person' => 0.024, 'other' => 0.073,
];
$PRIORITY_BY_TYPE = [
    'fire' => 'critical', 'medical_emergency' => 'critical', 'missing_person' => 'critical',
    'physical_injury' => 'high', 'domestic_dispute' => 'high', 'traffic_incident' => 'high',
    'theft' => 'normal', 'disturbance' => 'normal', 'animal_complaint' => 'normal',
    'vandalism' => 'normal', 'other' => 'normal',
];
$RESPONDENT_ELIGIBLE_TYPES = ['domestic_dispute', 'physical_injury', 'vandalism'];
$now = new DateTimeImmutable('now');

$pdo->beginTransaction();
try {
    $pdo->exec('SET FOREIGN_KEY_CHECKS=0');

    echo "Step 1: creating missing user accounts...\n";
    $insertUser = $pdo->prepare(
        'INSERT INTO user (barangay_id, username, password_hash, full_name, role, contact_number, is_active, created_at)
         VALUES (:barangay_id, :username, :password_hash, :full_name, :role, :contact_number, 1, NOW())'
    );
    $resolvedIds = []; // [barangay_id][role] => id or [barangay_id]['tanods'] => [ids]

    foreach ($BARANGAYS as $barangayId => $cfg) {
        $roster = $cfg['roster'];
        $contactSeed = 90000000 + ($barangayId * 1000);

        // Admin
        if (isset($roster['admin']['existing_id'])) {
            $resolvedIds[$barangayId]['admin'] = $roster['admin']['existing_id'];
        } else {
            $u = $roster['admin'];
            $insertUser->execute(['barangay_id' => $barangayId, 'username' => $u['username'], 'password_hash' => DEMO_PASSWORD_HASH, 'full_name' => $u['full_name'], 'role' => 'admin', 'contact_number' => '0917' . ($contactSeed++)]);
            $resolvedIds[$barangayId]['admin'] = (int) $pdo->lastInsertId();
        }
        // Secretary
        if (isset($roster['secretary']['existing_id'])) {
            $resolvedIds[$barangayId]['secretary'] = $roster['secretary']['existing_id'];
        } else {
            $u = $roster['secretary'];
            $insertUser->execute(['barangay_id' => $barangayId, 'username' => $u['username'], 'password_hash' => DEMO_PASSWORD_HASH, 'full_name' => $u['full_name'], 'role' => 'secretary', 'contact_number' => '0917' . ($contactSeed++)]);
            $resolvedIds[$barangayId]['secretary'] = (int) $pdo->lastInsertId();
        }
        // Punong Barangay (Dao already has kapitan.dao — reuse without recreating)
        if ($barangayId === 1) {
            $resolvedIds[$barangayId]['punong_barangay'] = 3; // kapitan.dao
        } else {
            $u = $roster['punong_barangay'];
            $insertUser->execute(['barangay_id' => $barangayId, 'username' => $u['username'], 'password_hash' => DEMO_PASSWORD_HASH, 'full_name' => $u['full_name'], 'role' => 'punong_barangay', 'contact_number' => '0917' . ($contactSeed++)]);
            $resolvedIds[$barangayId]['punong_barangay'] = (int) $pdo->lastInsertId();
        }
        // Tanods
        if (isset($roster['tanods']['existing_ids'])) {
            $resolvedIds[$barangayId]['tanods'] = $roster['tanods']['existing_ids'];
        } else {
            $ids = [];
            foreach ($roster['tanods']['names'] as $idx => $fullName) {
                $slugParts = explode(' ', $fullName);
                $username = 'tanod.' . strtolower(preg_replace('/[^a-zA-Z]/', '', end($slugParts)));
                $insertUser->execute(['barangay_id' => $barangayId, 'username' => $username, 'password_hash' => DEMO_PASSWORD_HASH, 'full_name' => $fullName, 'role' => 'tanod', 'contact_number' => '0917' . ($contactSeed++)]);
                $ids[] = (int) $pdo->lastInsertId();
            }
            $resolvedIds[$barangayId]['tanods'] = $ids;
        }
        echo "  Barangay {$cfg['slug']}: admin={$resolvedIds[$barangayId]['admin']} secretary={$resolvedIds[$barangayId]['secretary']} pb={$resolvedIds[$barangayId]['punong_barangay']} tanods=[" . implode(',', $resolvedIds[$barangayId]['tanods']) . "]\n";
    }

    echo "Step 2: deleting existing incident-tree data for all 4 barangays...\n";
    $allBarangayIds = implode(',', array_keys($BARANGAYS));
    $incidentIdsSql = "(SELECT incident_id FROM incident WHERE barangay_id IN ({$allBarangayIds}))";
    $dispatchIdsSql = "(SELECT dispatch_id FROM dispatch WHERE incident_id IN {$incidentIdsSql})";
    $notifIdsSql = "(SELECT notification_id FROM notification WHERE incident_id IN {$incidentIdsSql} OR dispatch_id IN {$dispatchIdsSql})";

    $pdo->exec("DELETE FROM notification_delivery WHERE notification_id IN {$notifIdsSql}");
    $pdo->exec("DELETE FROM notification_target WHERE notification_id IN {$notifIdsSql}");
    $pdo->exec("DELETE FROM notification WHERE incident_id IN {$incidentIdsSql} OR dispatch_id IN {$dispatchIdsSql}");
    $pdo->exec("DELETE FROM gps_track WHERE dispatch_id IN {$dispatchIdsSql}");
    $pdo->exec("DELETE FROM tanod_sos WHERE dispatch_id IN {$dispatchIdsSql}");
    $pdo->exec("DELETE FROM sms_log WHERE incident_id IN {$incidentIdsSql} OR dispatch_id IN {$dispatchIdsSql}");
    $pdo->exec("DELETE FROM evidence_attachment WHERE incident_id IN {$incidentIdsSql}");
    $pdo->exec("UPDATE citizen_report SET incident_id=NULL WHERE incident_id IN {$incidentIdsSql}");
    $pdo->exec("DELETE FROM dispatch WHERE incident_id IN {$incidentIdsSql}");
    $pdo->exec("DELETE FROM incident WHERE barangay_id IN ({$allBarangayIds})");

    $pdo->exec('SET FOREIGN_KEY_CHECKS=1');

    echo "Step 3: generating incidents for all 4 barangays...\n";

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
    // Global sequential display_id counters (INC-2026-NNN / BLT-2026-NNN
    // are unique across the whole system, not per-barangay).
    $incNo = 1;
    $totalInserted = 0;

    foreach ($BARANGAYS as $barangayId => $cfg) {
        $adminId = $resolvedIds[$barangayId]['admin'];
        $secretaryId = $resolvedIds[$barangayId]['secretary'];
        $tanodIds = $resolvedIds[$barangayId]['tanods'];
        $locations = $cfg['locations'];
        $count = $cfg['incident_count'];

        // Build this barangay's type queue from the shared proportions.
        $typeQueue = [];
        $remaining = $count;
        $types = array_keys($TYPE_COUNTS_BASE);
        foreach ($types as $idx => $type) {
            $n = $idx === count($types) - 1 ? $remaining : (int) round($TYPE_COUNTS_BASE[$type] * $count);
            $n = min($n, $remaining);
            for ($i = 0; $i < $n; $i++) $typeQueue[] = $type;
            $remaining -= $n;
        }
        while (count($typeQueue) < $count) $typeQueue[] = 'other';
        shuffle($typeQueue);

        $third = (int) floor($count / 3);
        $langQueue = array_merge(
            array_fill(0, $third, 'en'),
            array_fill(0, $third, 'tl'),
            array_fill(0, $count - 2 * $third, 'bik')
        );
        shuffle($langQueue);

        // Status plan scaled from Dao's proportions (min 1 pending/dispatched for smaller barangays).
        $numActive = max(2, (int) round($count * 0.065));
        $numPending = (int) ceil($numActive * 0.375);
        $numDispatched = $numActive - $numPending;
        $numResolved = $count - $numActive - ($count >= 20 ? 2 : 0);
        $statusPlan = array_merge(
            array_fill(0, $numPending, 'pending'),
            array_fill(0, $numDispatched, 'dispatched'),
            $count >= 20 ? ['cancelled', 'duplicate'] : [],
            array_fill(0, $numResolved, 'resolved')
        );
        while (count($statusPlan) < $count) $statusPlan[] = 'resolved';
        $statusPlan = array_slice($statusPlan, 0, $count);
        shuffle($statusPlan);

        $insertedIncidentIds = [];
        $incidentIdByType = [];

        foreach ($typeQueue as $i => $type) {
            $status = $statusPlan[$i];
            $lang = $langQueue[$i];
            $priority = $PRIORITY_BY_TYPE[$type];
            [$locDesc, $lat0, $lng0] = pick($locations);
            $lat = $lat0 + (mt_rand(-15, 15) / 100000);
            $lng = $lng0 + (mt_rand(-15, 15) / 100000);

            $daysAgo = in_array($status, ['pending', 'dispatched'], true) ? mt_rand(0, 3) : mt_rand(0, DAYS_WINDOW);
            $createdAt = $now->modify("-{$daysAgo} days")->setTime(mt_rand(5, 23), mt_rand(0, 59), mt_rand(0, 59));

            $template = pick($TEMPLATES[$type][$lang]);
            $slotAPool = $SLOT_A[$type][$lang] ?? null;
            $slotBPool = $SLOT_B[$type][$lang] ?? null;
            $narrative = str_replace(['{A}', '{B}'], [$slotAPool !== null ? pick($slotAPool) : '', $slotBPool !== null ? pick($slotBPool) : ''], $template);

            $source = pick(['web', 'web', 'web', 'app', 'app', 'sms']);
            if ($source === 'app') {
                $reportedBy = pick($tanodIds);
            } elseif ($source === 'web') {
                $reportedBy = pick([$secretaryId, $secretaryId, $adminId]);
            } else {
                $reportedBy = null;
            }

            $complainantName = pick($NAMES);
            $respondentName = in_array($type, $RESPONDENT_ELIGIBLE_TYPES, true) && mt_rand(0, 100) < 60 ? pick($NAMES) : null;
            $contactNumber = mt_rand(0, 100) < 70 ? ('09' . mt_rand(100000000, 999999999)) : null;

            $redactedNarrative = null; $redactionApprovedBy = null; $redactionApprovedAt = null;
            if (in_array($status, ['resolved', 'cancelled'], true)) {
                $redactedNarrative = $narrative;
                $redactionApprovedBy = $secretaryId;
                $redactionApprovedAt = $createdAt->modify('+' . mt_rand(10, 90) . ' minutes')->format('Y-m-d H:i:s');
            }

            $displayId = sprintf('INC-2026-%03d', $incNo++);
            $insertIncident->execute([
                'barangay_id' => $barangayId, 'reported_by' => $reportedBy, 'incident_type' => $type,
                'priority' => $priority, 'raw_narrative' => $narrative, 'redacted_narrative' => $redactedNarrative,
                'redaction_approved_by' => $redactionApprovedBy, 'redaction_approved_at' => $redactionApprovedAt,
                'status' => in_array($status, ['duplicate', 'cancelled'], true) ? $status : $status,
                'source' => $source, 'latitude' => $lat, 'longitude' => $lng,
                'created_at' => $createdAt->format('Y-m-d H:i:s'), 'updated_at' => $createdAt->format('Y-m-d H:i:s'),
                'complainant_name' => $complainantName, 'respondent_name' => $respondentName,
                'complainant_contact_number' => $contactNumber, 'location_description' => $locDesc, 'display_id' => $displayId,
            ]);
            $incidentId = (int) $pdo->lastInsertId();
            $insertedIncidentIds[] = $incidentId;
            $incidentIdByType[$type][] = $incidentId;

            $needsDispatch = $status === 'dispatched' || ($status === 'resolved' && (in_array($priority, ['critical', 'high'], true) ? mt_rand(0, 100) < 90 : mt_rand(0, 100) < 45));
            $dispatchId = null;
            if ($needsDispatch) {
                $tanodId = pick($tanodIds);
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
                    'incident_id' => $incidentId, 'dispatched_by' => $adminId, 'tanod_id' => $tanodId,
                    'priority' => $priority, 'status' => $dStatus, 'dispatched_at' => $dispatchedAt->format('Y-m-d H:i:s'),
                    'en_route_at' => $enRouteAt, 'arrived_at' => $arrivedAt, 'completed_at' => $completedAt,
                    'client_request_id' => uuidv4(),
                ]);
                $dispatchId = (int) $pdo->lastInsertId();
            }

        }

        // Cancelled/duplicate demo rows for this barangay (if present in the plan).
        $cancelledIdx = array_search('cancelled', $statusPlan, true);
        $duplicateIdx = array_search('duplicate', $statusPlan, true);
        if ($cancelledIdx !== false) {
            $pdo->prepare('UPDATE incident SET lifecycle_changed_by=:by, lifecycle_changed_at=updated_at WHERE incident_id=:id')
                ->execute(['by' => $secretaryId, 'id' => $insertedIncidentIds[$cancelledIdx]]);
        }
        if ($duplicateIdx !== false) {
            $dupType = $typeQueue[$duplicateIdx];
            $dupId = $insertedIncidentIds[$duplicateIdx];
            $siblings = array_diff($incidentIdByType[$dupType] ?? [], [$dupId]);
            $target = $siblings !== [] ? reset($siblings) : $insertedIncidentIds[0];
            $pdo->prepare('UPDATE incident SET duplicate_of_incident_id=:target, lifecycle_changed_by=:by, lifecycle_changed_at=updated_at WHERE incident_id=:id')
                ->execute(['target' => $target, 'by' => $secretaryId, 'id' => $dupId]);
        }

        // Reattach the two real evidence files to one app-sourced theft/vandalism
        // incident per barangay run — only Dao needs the real files (verified
        // bytes), others get metadata-only rows pointing at the SAME real files
        // (harmless — read-only demo, no duplicate disk usage).
        $evidenceHostStmt = $pdo->prepare(
            "SELECT incident_id, reported_by FROM incident
             WHERE incident_id IN (" . implode(',', $insertedIncidentIds) . ")
               AND source='app' AND incident_type IN ('theft','vandalism')
             ORDER BY incident_id LIMIT 1"
        );
        $evidenceHostStmt->execute();
        $evidenceHost = $evidenceHostStmt->fetch(PDO::FETCH_ASSOC);
        if ($evidenceHost !== false && $barangayId === 1) {
            $uploadedBy = $evidenceHost['reported_by'] ?? $adminId;
            $insertEvidence = $pdo->prepare(
                'INSERT INTO evidence_attachment (incident_id, type, file_path, uploaded_by, uploaded_at, sha256, byte_size, mime_type, original_filename, client_request_id)
                 VALUES (:incident_id, :type, :file_path, :uploaded_by, NOW(), :sha256, :byte_size, :mime_type, :original_filename, :client_request_id)'
            );
            $insertEvidence->execute(['incident_id' => $evidenceHost['incident_id'], 'type' => 'photo', 'file_path' => 'incident-119-966b57735986ea09', 'uploaded_by' => $uploadedBy, 'sha256' => '212b16a46075910c25ec45a21e9e98354658e120cf2f58507794977d174a7fc1', 'byte_size' => 179892, 'mime_type' => 'image/jpeg', 'original_filename' => 'evidence_photo.jpg', 'client_request_id' => uuidv4()]);
            $insertEvidence->execute(['incident_id' => $evidenceHost['incident_id'], 'type' => 'voice', 'file_path' => 'incident-119-a1ba05c902574a76', 'uploaded_by' => $uploadedBy, 'sha256' => '2d6ab7fbda15e33834df2346b2a6d1f3681790dfeaf4d9f1b0f025e15aadc934', 'byte_size' => 74978, 'mime_type' => 'audio/aac', 'original_filename' => 'evidence_voice.aac', 'client_request_id' => uuidv4()]);
            echo "  Reattached real evidence files to incident_id={$evidenceHost['incident_id']} ({$cfg['slug']}).\n";
        }

        $totalInserted += count($insertedIncidentIds);
        echo "  {$cfg['slug']}: inserted " . count($insertedIncidentIds) . " incidents.\n";
    }

    $pdo->commit();
    echo "Done. Inserted {$totalInserted} incidents across 4 barangays.\n";
} catch (\Throwable $e) {
    $pdo->exec('SET FOREIGN_KEY_CHECKS=1');
    if ($pdo->inTransaction()) $pdo->rollBack();
    fwrite(STDERR, 'FAILED: ' . $e->getMessage() . "\n" . $e->getTraceAsString() . "\n");
    exit(1);
}
