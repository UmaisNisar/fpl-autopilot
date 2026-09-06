/**
 * `server-only` throws on import outside a React Server Component, which would
 * block every test of the server-side libraries. Aliased to this no-op so the
 * guard still protects the app bundle while the tests can import the modules.
 */
export {};
