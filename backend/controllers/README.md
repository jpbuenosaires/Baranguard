# controllers
Request/response handling for each §6 endpoint: parse/validate input,
call the relevant service/model, shape the response per §6's documented
response fields. Tenant/role/ownership checks happen here (or in
middleware) — never trust client-supplied barangay_id/user_id.
