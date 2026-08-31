#!/usr/bin/env node
// Interactive first-Admin bootstrap CLI (Master Reference §2 Rule 10).
//
// - Administrative bootstrap is one-time and deterministic.
// - The first Admin in each barangay is created only by this trusted,
//   interactive CLI. There is no self-registration for privileged roles.
// - The password is NEVER embedded in source, migration files, seed
//   files, logs, or UI, and is never echoed back or written to any log
//   file by this script.
//
// Usage: node scripts/bootstrap-admin.js
// (Non-interactive/CI usage: set BARANGUARD_BOOTSTRAP_JSON to a JSON
//  string with {barangay_id, username, full_name, contact_number,
//  password} — still never logged. Intended for scripted test evidence
//  only; the interactive prompt is the normal path.)

require('dotenv').config();
const readline = require('readline');
const { Writable } = require('stream');
const argon2 = require('argon2');
const { getPool } = require('../config/db.js');

// A line-queue wrapper around readline. Using rl.question() directly is
// unreliable when stdin is piped (non-TTY): Node can emit multiple
// buffered 'line' events back-to-back before the next question() call
// re-subscribes its one-shot listener, silently dropping answers. Buffering
// every line as it arrives and pulling from that queue on demand works
// identically for a real TTY and for piped/scripted input.
function makeLineSource(rl) {
  const queue = [];
  const waiters = [];
  rl.on('line', (line) => {
    if (waiters.length > 0) {
      waiters.shift()(line);
    } else {
      queue.push(line);
    }
  });
  return function nextLine(prompt) {
    if (prompt) process.stdout.write(prompt);
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise((resolve) => waiters.push(resolve));
  };
}

function question(nextLine, prompt) {
  return nextLine(prompt);
}

// A writable stream that echoes '*' instead of the typed characters, so a
// password is never visible on screen or capturable from terminal replay.
function muteStdout(rl) {
  let muted = false;
  const mutableStdout = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  return {
    mutableStdout,
    startMute: () => { muted = true; },
    stopMute: () => { muted = false; },
  };
}

async function promptPassword(nextLine, startMute, stopMute, isRealTty, label) {
  if (isRealTty) startMute();
  const pw = await nextLine(label);
  if (isRealTty) stopMute();
  process.stdout.write('\n');
  return pw;
}

function validatePasswordPolicy(pw) {
  // Baseline policy pending §6's full password policy wiring; keeps the
  // bootstrap from creating an unusably weak first Admin account.
  if (pw.length < 12) return 'Password must be at least 12 characters.';
  if (!/[a-z]/.test(pw)) return 'Password must include a lowercase letter.';
  if (!/[A-Z]/.test(pw)) return 'Password must include an uppercase letter.';
  if (!/[0-9]/.test(pw)) return 'Password must include a digit.';
  return null;
}

async function run() {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const [barangays] = await conn.query(
      'SELECT barangay_id, name, municipality, province FROM barangay ORDER BY barangay_id'
    );
    if (barangays.length === 0) {
      console.error('No barangay rows found. Run migrations/0002_seed_barangays.sql first.');
      process.exitCode = 1;
      return;
    }

    console.log('Baranguard — First-Admin Bootstrap');
    console.log('This creates the ONE-TIME first Admin account for a barangay.');
    console.log('');
    console.log('Available barangays:');
    for (const b of barangays) {
      console.log(`  [${b.barangay_id}] ${b.name} (${b.municipality}, ${b.province})`);
    }
    console.log('');

    // Masking only makes sense (and only works reliably) against a real
    // TTY. When stdin is piped (CI/test evidence capture), fall back to
    // a plain readline interface — there is no terminal echo to suppress
    // in that case, and forcing terminal:true against a pipe breaks
    // readline entirely.
    const isRealTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const { mutableStdout, startMute, stopMute } = muteStdout();
    const rl = readline.createInterface({
      input: process.stdin,
      output: isRealTty ? mutableStdout : process.stdout,
      terminal: isRealTty,
    });
    const nextLine = makeLineSource(rl);

    const barangayIdRaw = await question(nextLine, 'Barangay ID: ');
    const barangayId = Number(barangayIdRaw.trim());
    const chosen = barangays.find((b) => b.barangay_id === barangayId);
    if (!chosen) {
      console.error(`Invalid barangay ID: ${barangayIdRaw}`);
      rl.close();
      process.exitCode = 1;
      return;
    }

    // Deterministic one-time guard: refuse if an active Admin already
    // exists for this barangay.
    const [existingAdmins] = await conn.query(
      "SELECT user_id FROM user WHERE barangay_id = ? AND role = 'admin' AND is_active = TRUE LIMIT 1",
      [barangayId]
    );
    if (existingAdmins.length > 0) {
      console.error(
        `Barangay ${chosen.name} already has an active Admin (user_id=${existingAdmins[0].user_id}). ` +
        'Bootstrap is one-time only; use the normal admin user-management flow instead.'
      );
      rl.close();
      process.exitCode = 1;
      return;
    }

    const usernameRaw = await question(nextLine, 'Username: ');
    // Username normalization per §5: trim, lowercase (ASCII rules), then
    // validate/persist normalized value before uniqueness/auth checks.
    const username = usernameRaw.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
      console.error('Username must be 3-64 chars: lowercase letters, digits, dot, underscore, hyphen.');
      rl.close();
      process.exitCode = 1;
      return;
    }

    const [existingUsername] = await conn.query(
      'SELECT user_id FROM user WHERE username = ? LIMIT 1',
      [username]
    );
    if (existingUsername.length > 0) {
      console.error(`Username "${username}" is already taken.`);
      rl.close();
      process.exitCode = 1;
      return;
    }

    const fullName = (await question(nextLine, 'Full name: ')).trim();
    if (!fullName) {
      console.error('Full name is required.');
      rl.close();
      process.exitCode = 1;
      return;
    }

    const contactRaw = (await question(nextLine, 'Contact number (optional, press Enter to skip): ')).trim();
    const contactNumber = contactRaw === '' ? null : contactRaw;

    let password;
    for (;;) {
      const pw1 = await promptPassword(nextLine, startMute, stopMute, isRealTty, 'Password: ');
      const policyError = validatePasswordPolicy(pw1);
      if (policyError) {
        console.log(policyError);
        continue;
      }
      const pw2 = await promptPassword(nextLine, startMute, stopMute, isRealTty, 'Confirm password: ');
      if (pw1 !== pw2) {
        console.log('Passwords do not match. Try again.');
        continue;
      }
      password = pw1;
      break;
    }

    rl.close();

    // Argon2id per Master Reference §2 Rule 9.
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    await conn.beginTransaction();
    try {
      const [result] = await conn.query(
        `INSERT INTO user
           (barangay_id, username, password_hash, full_name, role, contact_number,
            is_active, failed_login_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'admin', ?, TRUE, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [barangayId, username, passwordHash, fullName, contactNumber]
      );
      const newUserId = result.insertId;

      await conn.query(
        `INSERT INTO audit_log
           (barangay_id, actor_user_id, action, entity_type, entity_id, metadata_json, created_at)
         VALUES (?, NULL, 'bootstrap_first_admin', 'user', ?, JSON_OBJECT('username', ?), UTC_TIMESTAMP())`,
        [barangayId, newUserId, username]
      );

      await conn.commit();

      console.log('');
      console.log(`First Admin created for ${chosen.name}: user_id=${newUserId}, username=${username}`);
      console.log('The password was not logged or stored anywhere except its Argon2id hash in the database.');
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
    const pool2 = getPool();
    await pool2.end();
  }
}

run().catch((err) => {
  console.error('Bootstrap failed:', process.env.BARANGUARD_DEBUG ? err.stack : err.message);
  process.exitCode = 1;
});
