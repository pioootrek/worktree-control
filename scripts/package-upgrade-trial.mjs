// The pre-fence schema-24→28 trial is historical, not 0.2.0 acceptance.
// Its original orchestration remains in Git history; the historical driver and
// acceptance source remain for research. Do not run them against release data.
console.error("The pre-fence schema-24 trial is retired. Use pnpm test:rbac-artifact and test:rbac-artifact:fresh.");
process.exitCode = 1;
