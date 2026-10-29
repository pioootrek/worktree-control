/**
 * Removes migration 38 from a current test database so it can be rewound to an
 * older schema. Its tables are refused before their migration, like any
 * partial provider schema.
 */
export const WITHOUT_AUTHENTICATION_PROVIDER_STORAGE = `DROP TABLE authentication_provider_subjects;
  DROP TABLE "authentication_ba_session"; DROP TABLE "authentication_ba_account";
  DROP TABLE "authentication_ba_verification"; DROP TABLE "authentication_ba_user";
  DELETE FROM schema_migrations WHERE version = 38;`;
