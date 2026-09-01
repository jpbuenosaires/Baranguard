# Serving the API locally (XAMPP)

Sprint 1 picked **PHP 8.2** to serve `/api/v1/*` (Node stays for the
Sprint 0 CLI scripts — `bootstrap-admin.js`, and `config/db.js` if a
future Node service ever needs it — this is a project decision, logged in
`DEVLOG.md`, not a guess).

The API is a single front controller at `backend/public/index.php`. Two
ways to run it locally:

## Option A — XAMPP's Apache (matches how this will actually run)

1. Open XAMPP Control Panel → Apache → **Config** → `httpd-vhosts.conf`.
2. Add a vhost whose `DocumentRoot` points at `backend/public` (not
   `backend/` — see the comment in `backend/.htaccess` for why):

   ```apache
   <VirtualHost *:80>
       ServerName baranguard.local
       DocumentRoot "C:/Users/Jayson Buenosaires/Videos/Baranguard/backend/public"
       <Directory "C:/Users/Jayson Buenosaires/Videos/Baranguard/backend/public">
           AllowOverride All
           Require all granted
       </Directory>
   </VirtualHost>
   ```
3. Add `127.0.0.1 baranguard.local` to `C:\Windows\System32\drivers\etc\hosts`.
4. Restart Apache from the XAMPP Control Panel.
5. `POST http://baranguard.local/api/v1/auth/login`

## Option B — PHP's built-in server (quick local testing, no vhost needed)

```
cd backend/public
php -S 127.0.0.1:8080
```

Then `POST http://127.0.0.1:8080/api/v1/auth/login`. This is what
`backend/scripts/verify-sprint1-auth.sh` uses, since it doesn't require
editing Apache config just to run a test.

## Required `.env` values

Beyond Sprint 0's `DB_*` values, this needs:

- `JWT_SECRET` — a real random secret, not the blank placeholder in
  `.env.example`. Generate one with:
  `php -r "echo bin2hex(random_bytes(32)), PHP_EOL;"`
- `JWT_EXPIRES_IN_MINUTES` — defaults to 15 per §2 Rule 9 if unset.
- `CORS_ALLOWED_ORIGIN` — optional, defaults to `*` for local dev.
