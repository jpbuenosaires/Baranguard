# Manual test stack (disposable)

```bash
bash backend/scripts/start-test-stack.sh          # rebuild + start (idempotent)
bash backend/scripts/start-test-stack.sh --stop   # stop servers, drop DB + user
```

Builds database `baranguard_testui` (user `baranguard_testui_app`) from the full
migration chain, seeds six accounts (`admin.test`, `pb.test`, `sec.test`,
`kagawad.test`, `tanod.one`, `tanod.two`, all with password `TestUi@2026`) and
sample data for the tanod-workflow screens, then leaves two detached servers
running: the API on `127.0.0.1:8690` and the static web dashboard on
`127.0.0.1:8691`.

Open `http://127.0.0.1:8691/index.html?api_base=http://127.0.0.1:8690/api/v1`
(`web/index.html` saves `api_base` to localStorage for that origin; it only
needs to be given once).

It never touches `baranguard`, `baranguard_uiseed` or `backend/.env` (`.env` is
read only for `DB_PORT`; DB/JWT/CORS settings go in as process env vars, and
GSM/FCM are disabled for the stack). PIDs live in `%TEMP%\baranguard_testui.pids`;
server logs are `backend/scripts/test-stack-*.log` (git-ignored).
