# models
Data-access layer — one module per §5 table (or closely related group,
e.g. notification + notification_target + notification_delivery).
Wraps parameterized queries against config/db.js (Node) or config/db.php
(PHP). No raw SQL string concatenation from request input, ever.
