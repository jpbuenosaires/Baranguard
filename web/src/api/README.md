# api
The ONE central `apiClient.js` boundary (§4 "Boundary rule") that talks
to `/api/v1` and converts snake_case JSON <-> camelCase JS. No other file
in `web/` should do this conversion ad-hoc.
