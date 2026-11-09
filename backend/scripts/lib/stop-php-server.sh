# Stops the `php -S 127.0.0.1:<port>` test server(s) a verify suite started.
# netstat on this Windows machine reports the owner of these sockets as PID 0,
# so the suites' port -> PID -> taskkill loop never stopped them; servers from
# earlier runs then kept answering on the same ports (found 2026-11-05 via
# verify-dispatch-offers.sh "failure was not logged"). Matches only the exact
# `-S 127.0.0.1:<port>` command line, never the scheduled daemons or Apache.
stop_php_server() {
  local port="$1"
  [ -n "$port" ] || return 0
  command -v powershell.exe >/dev/null 2>&1 || return 0
  powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='php.exe'\" | Where-Object { \$_.CommandLine -match ' -S 127\.0\.0\.1:${port}(\s|\$)' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
  return 0
}
