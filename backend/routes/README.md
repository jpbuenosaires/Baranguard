# routes
Express/PHP route definitions — maps §6 API Contract endpoints to controllers.
One file per resource group (e.g. `incidents.js`, `dispatch.js`, `auth.js`).
No business logic here; routes only wire HTTP method + path + auth
middleware to a controller function.
