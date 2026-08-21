// apiService.ts
// The ONLY place snake_case API/DB response keys convert to camelCase for
// use in mobile TS code. Never convert ad-hoc inside components.
// See Baranguard_Naming_Conventions.md ("Boundary rule").

const BASE_URL = "/api/v1";

export async function apiService(path: string, options: RequestInit = {}) {
  // TODO: fetch wrapper, Authorization: Bearer <token> header injection,
  // snake_case -> camelCase response conversion, standardized error handling
  // per Baranguard_API_Contract.md error format.
}
