# Etap 1 uwierzytelniania: projekt implementacji i dziennik

## Stan po scaleniu, 2026-09-27

PR #54 scalony do main `17d0c9d`. CI 36312411574 przeszło w całości,
włącznie z HTTPS, package-smoke dla obu wersji Node i systemd lifecycle.
Wcześniejszy brak lokalnego CADDY_BIN i nieudane próby smoke są historyczne.
Pozostała luka CLI w trybie open została naprawiona w PR #55, commit
`2186904`, scalony do main jako `bc0dd74`. Main CI
[36342502959](https://github.com/pioootrek/worktree-switcher/actions/runs/36342502959)
przeszło dla tej rewizji: check/build/HTTPS/integration/UI/E2E, systemd lifecycle
i package-smoke na Node 22/24. Etap 1 jest zamknięty; nie powtarzać A–F.

Nowe testy sprawdzają wiedzę i administrację przez rzeczywisty HTTP oraz
administrację, Hub import i logiczny transfer na odizolowanej bazie offline.
Obejmują brak tokenów w open, odrzucenia w trybie chronionym, zakresy agentów,
historię anonimowego aktora i odmowę dostępu przy zajętym singleton lock.
Test CLI execute-import zastępuje weryfikację planu przez seam testowy;
nie zastępuje odbioru rzeczywistego importu Huba.

Partia importu zapisuje principal, ale nie metodę uwierzytelnienia. PR #55
odnotował ten istniejący brak metadanych; dalszy odbiór jest zapisany w zadaniu
pamięci projektu. Zamknięcie nie zmienia działającej instalacji ani nie oznacza
przeprowadzenia pilota K7.

Start: 2026-09-26. Baza: `e3f4b4c` (gałąź `t3code/review-authentication-backlog`).
Wynik: [DONE-20260927-independent-auth-modes](../../done/DONE-20260927-independent-auth-modes.json).
Kierunek: [plan trybów](../NOTE-20260909-self-hosted-saas-plan/authentication-modes-and-plugin.md).

## Decyzje właściciela (2026-09-26)

- Ta instalacja po wdrożeniu działa w trybie `token`.
- Administracja działającego kontrolera: unix socket `0600` w katalogu `0700`.
  Offline: singleton lock + bezpośrednio SQLite (jak dziś `identity`).

## Stan zastany, który wpływa na projekt

- Trzy poświadczenia: token parowania (losowy przy każdym starcie, w `accessUrl`
  w `service-access.json` 0600), trwały `mcp-token` (surowy sekret w pliku),
  poświadczenia tożsamości (`wts_<uuid>_<hex>`, tylko verifier w SQLite).
- Aktorzy wiedzy to FK do `remote_principals(id)` z `CHECK(kind IN
  ('owner','agent','worker'))`; `knowledge_history.authentication_method` ma
  `CHECK IN ('owner_session','agent_token','worker_token')`; ten sam enum jest w
  `shared/contracts/knowledge.ts` i `project-transfer-schema.ts`.
- `SqliteStateStore` włącza `foreign_keys = ON` przed `initializeSchema`.
- Ustawienia kontrolera: `controller_settings(key, value_json, updated_at)`.
- Wspierane platformy: Linux (główna), macOS. Windows poza zakresem.

## Model

- Polityka: `controller_settings` klucz `authentication`:
  `{ mode: "legacy" | "open" | "token" | "better-auth", token: null | { id, prefix,
  verifierHash, createdAt }, generation }`. Brak wiersza w istniejącej bazie →
  `legacy` (dzisiejsze zachowanie, do jawnej migracji). Świeża baza → `token`
  bez tokena: kontroler nie startuje i podaje `auth token generate`.
- Token instalacji: `wsi_<uuid>_<64hex>`, sha256 verifier, timingSafeEqual;
  surowy sekret tylko w prywatnym wyjściu CLI. `generate` odmawia, gdy token
  istnieje; `rotate` podmienia i podbija `generation`.
- Autorytet instalacji: jeden wiersz `remote_principals` kind `installation`
  (stałe ID). Metody: `installation_token`, `none` (open). Wymaga migracji:
  przebudowa `remote_principals` (12-krokowa procedura SQLite z
  `foreign_keys=OFF` poza transakcją + `foreign_key_check`) i `knowledge_history`.
- `authorizeKnowledge`: autorytet instalacji ma pełny dostęp, także approve,
  z zachowaniem walidacji statusu projektu. Scoped tokeny bez zmian.
- Kontekst wywołania transportów: `installation` (token/none) | `principal`
  (scoped) | `legacy` (pairing/mcp-token, tylko w trybie `legacy`).
- `better-auth`: `auth mode set better-auth` → `auth_provider_unavailable`
  „Better Auth: to be implemented soon”, tryb bez zmian. Ręcznie wpisany → start
  kontrolera kończy się błędem przed nasłuchem. Nigdy fallback do `open`.
- Przeglądarka w trybie `token` używa bezpośrednio tokena instalacji (Bearer,
  sessionStorage) zamiast osobnej sesji: rotacja unieważnia wszystko od razu,
  bez dodatkowej tabeli sesji. „Wyloguj” czyści storage.

## Plan PR-ów (stos, scalane razem przed wydaniem)

1. **A — polityka + migracja + CLI offline.** Moduł `auth`, migracja 25
   (kind `installation`, metody historii), `auth status|token generate|token
   rotate|mode set` pod lockiem, walidacja startu, placeholder better-auth.
   Egzekwowanie jeszcze w trybie `legacy` — CLI odmawia `mode set token|open`
   z komunikatem, że tryb wejdzie w B/C, dopóki egzekwowanie nie istnieje.
2. **B — tryb `token` w backendzie.** HTTP API/SSE/identity admin/knowledge
   i MCP (runtime + knowledge) przyjmują token instalacji; pairing i mcp-token
   odrzucane poza `legacy`; odblokowanie `mode set token`.
3. **C — dashboard jednego tokena.** Ekran logowania tokenem, usunięcie
   drugiego pola wiedzy, `service open`/`config mcp` bez ukrytego sekretu.
4. **D — tryb `open`.** Anonimowy autorytet instalacji, jawne oznaczenie w
   statusie/UI/audycie, `mode set open`.
5. **E — kanał admin (unix socket) + unieważnianie na żywo.** Zmiana trybu i
   rotacja przy działającym kontrolerze, zamknięcie starych sesji MCP i SSE.
6. **F — migracja i odbiór.** Instrukcja migracji tej instalacji do `token`,
   pełna macierz HTTP/MCP/CLI/Web, build, e2e, test paczki.

## Dziennik

- 2026-09-26: projekt zapisany; rozpoczęto PR A.
- 2026-09-26 PR A (gałąź `t3code/auth-stage1-a-policy`), gotowe i przetestowane:
  migracja 25 (`rebuildTable` w `migrations.ts`, FK OFF poza transakcją +
  `foreign_key_check`), `INSTALLATION_PRINCIPAL_ID = "installation"`, polityka
  domyślna `legacy` dla każdej bazy w A; moduł `src/server/modules/authentication/`
  (`AuthenticationService`: status/generateToken/rotateToken/setMode/
  assertStartupPolicy/verifyInstallationToken; `ENFORCED_MODES = {legacy}`);
  `infrastructure/sqlite/authentication-queries.ts` (fail-closed parse, audyt bez
  sekretu); `PrincipalKind` + `installation`, granty go odrzucają. Testy: 15/15.
  Decyzja w A: świeża baza też startuje w `legacy`; domyślne `token` dla nowych
  instalacji wchodzi razem z egzekwowaniem (B) i poprawą fixture'ów e2e/https.
  Następne w A: CLI `auth` (offline, lock) + `assertStartupPolicy` w `start`.
- 2026-09-26 PR A, cd.: CLI `src/cli/auth-management.ts` (walidacja argumentów
  przed lockiem, odmowa przy działającym kontrolerze, JSON na wyjściu, aktor
  `local-cli`), `start` wywołuje `assertStartupPolicy` przed uruchomieniem.
  Naprawa: migracja 25 jest idempotentna (`rebuildTable(from, to)` pomija tabelę
  z nowym CHECK), bo testy naprawcze kasują rekordy migracji > 12. Testy
  docelowe 125/125, eslint OK. Backup: limit wersji schematu podniesiony do 25
  (`controller-backup.ts`). `node:check` run 2b4ea1c6… exit 0 (processOutcome
  passed, 451 testów; „failed” tylko z atrybucji dirty_source). PR A zacommitowany
  lokalnie, bez push. Następne: PR B (egzekwowanie trybu `token`).
- 2026-09-26 PR B (gałąź `t3code/auth-stage1-b-token` na A), zacommitowany
  lokalnie; `node:check` run ed57de47… exit 0 (processOutcome passed). Zakres: `resolveControllerAuthentication` (moduł authentication) — jedyne
  miejsce reguł: `wsi_` tylko w `token`, sekret legacy (pairing/mcp-token)
  tylko w `legacy`, scoped `wts_` w legacy i token, inne tryby → null.
  `ControllerAuthentication` + `installation`; `AuthenticationMethod` +
  `installation_token`/`none`; `InstallationAuthority` (identity) implementuje
  `AuthenticationService.isCurrentInstallationActor` (tryb token + id tokena →
  rotacja unieważnia aktora). Identity: `requireOwnerSession` = sesja właściciela
  LUB instalacja; `renewOwnerSession` tylko prawdziwy właściciel; approve dla
  instalacji; `describeIdentity` instalacji → `credential: null`,
  `installationAuthority: true`. HTTP: runtime przyjmuje token instalacji w
  `X-Worktree-Switcher-Token` lub Bearer; bootstrap właściciela tylko w legacy;
  SSE filtruje wiedzę aktorem instalacji. MCP: sesja instalacji = narzędzia
  runtime + wiedzy + get_identity. CLI offline (`knowledge execute-import`,
  `backup export/import-project`) przez `src/cli/offline-actor.ts`.
  `ENFORCED_MODES = {legacy, token}`. Otwarte (C/E): CLI `project-management`
  i `service open`/`config mcp` używają pairing/mcp-token — w trybie token nie
  zadziałają do C/E.
  Testy B: `installation-token-transports.test.ts` (prawdziwe HTTP/MCP/SQLite:
  runtime, legacy odrzucone, historia `installation_token`, narzędzia MCP,
  rotacja), `controller-authentication.test.ts` (macierz trybów), testy
  identity/auth-service/CLI. README celowo bez zmian do F (dashboard w C).
  Następne: PR C (dashboard jednego tokena, `service open`, `config mcp`).
- 2026-09-26 PR C (gałąź `t3code/auth-stage1-c-dashboard` na B), kod gotowy:
  poprawka backendu z B — `projects`/`project` dla instalacji listują wszystkie
  projekty jako writable (`listKnowledgeProjects(null, …)`); test manipulacji
  tokenem w B był niestabilny (1/16), poprawiony. Przeglądarka:
  `AccessTokenForm` (brak tokena lub 401 → formularz, klucze `access.*`,
  usunięty `dashboard.missingToken`), `signIn`/`signOut` w `use-dashboard`,
  token `wsi_` służy też wiedzy (bez drugiego logowania; wylogowanie z wiedzy =
  pełne wylogowanie), `approvable` dla `installationAuthority`. CLI: `start`
  poza legacy daje link bez pairing tokena i zapisuje `authenticationMode` w
  service-access; `controllerAccessToken` (env `WORKTREE_SWITCHER_TOKEN` albo
  pairing z URL) dla `project`/`service status`; `config mcp` przez
  `src/cli/mcp-config.ts` (env `wsi_`, w trybie token placeholder, nigdy
  mcp-token). UI: `tests/ui/access.spec.ts`, fixture z parametrem tokena.
  `node:check` run 74b25655… exit 0; C = `42f223b` + `9a2dc56` (kolejność
  route w access.spec). `node:build` 9eda74bd… passed, `node:test:ui`
  32914509… passed (68, observed_match). Następne: PR D (tryb open).
- 2026-09-26 PR D (gałąź `t3code/auth-stage1-d-open` na C), kod + testy gotowe:
  `open` w `ENFORCED_MODES`; `anonymousInstallation()` → aktor `installation`,
  `credentialId: "open"`, metoda `none`, ważny tylko gdy tryb = open. Resolver:
  w open każdy wywołujący (także z tokenem scoped/wsi/śmieciem) = anonimowy
  autorytet instalacji (granty nie są granicą, zgodnie z planem). MCP bez
  nagłówka w open. `/api/dashboard` zwraca `authentication {mode, listen}`,
  `McpStatus.authentication` `bearer|none`. UI: sonda `/api/dashboard` bez
  tokena → `OPEN_ACCESS` (nie zapisywany), czerwony badge „Open mode — no
  authentication (host:port)”, bez „Sign out”. CLI: `config mcp` bez nagłówków
  w open, ostrzeżenie `cli.openMode` przy starcie, `cli.tokenMode` w token.
  Brak bramek aktywacji open (wymóg planu). Testy: transport open (historia
  `none`, powrót do token → 401 i aktor nieważny), resolver, auth-service, CLI,
  UI `access.spec.ts` (open).
  `node:check` run 5e2fdcb6… exit 0 (processOutcome passed). D = `5d5bf66`;
  `node:build` 21ed2774… passed, `node:test:ui` 4bdd982a… passed (observed_match).
- 2026-09-26 PR E (gałąź `t3code/auth-stage1-e-admin-socket`) — projekt:
  `paths.adminSocketPath = <stateDirectory>/admin.sock`; kontroler przy starcie
  (trzyma lock, więc istniejący socket jest nieaktualny → unlink tylko gdy to
  socket) ustawia katalog 0700, nasłuch HTTP na unix socket, chmod 0600.
  POST `/auth` `{command, value?}` → wspólna funkcja wykonawcza z
  `auth-management.ts` (aktor `local-admin`). Po zmianie polityki: zamknięcie
  wszystkich sesji MCP (`McpRuntime.close` przez `mcp.closeSessions()`) i
  rozłączenie SSE (`EventStream.disconnectAll`). CLI `auth`: gdy lock zajęty →
  zapytanie przez socket zamiast błędu. Przeglądarka: `connectDashboardEvents`
  z `onUnauthorized` → bootstrap → formularz przy 401.
- 2026-09-26 PR E, kod + testy gotowe: `modules/authentication/authentication-commands.ts`
  (parse z argumentów i ścisły z JSON, `executeAuthenticationCommand` →
  `policyChanged` dla rotate i realnej zmiany trybu; generate nie unieważnia),
  `src/server/admin-socket.ts` (`listenAdminSocket` 0700/0600, usuwa tylko stary
  socket, odmawia zwykłego pliku; `requestAdminSocket`),
  `src/server/authentication-admin.ts` (handler: zamyka sesje MCP i SSE, w
  service-mode przepisuje service-access), `paths.adminSocketPath`. CLI `auth`:
  lock wolny → offline; zajęty → socket; brak socketu → komunikat o restarcie.
  Przeglądarka: SSE 401 → `onUnauthorized` → bootstrap → formularz. Testy:
  admin-socket, CLI przez socket, SSE 401, unieważnienie na żywo (prawdziwe MCP
  i SSE w `installation-token-transports.test.ts`).
  `node:check` run 161768e2… exit 0 (processOutcome passed). E = `d70790d`;
  `node:build` 2a682bb7… passed, `node:test:integration` 8b1bf258… passed,
  `node:test:e2e` d75ca410… passed. `node:test:https` e2eff032… NIE uruchomiony:
  profil kolejki `tooling` nie ma `CADDY_BIN` (błąd konfiguracji vitest przed
  testami) — niezweryfikowane, nie obchodzić bez zgody właściciela.
- PR F (gałąź `t3code/auth-stage1-f-default`) — plan: świeża baza → `token`
  bez tokena (start odmawia z instrukcją `auth token generate`), istniejąca →
  `legacy`; fixture'y integration/e2e generują token offline przed startem;
  README + instrukcja migracji tej instalacji; pełna macierz.
- 2026-09-26 PR F W TOKU (commit WIP na `t3code/auth-stage1-f-default`): świeża
  baza → `token` bez tokena (`initializeSchema` wykrywa brak tabeli `projects`;
  migracja 25 zapisuje `token`/`legacy`), `auth` ignoruje `--data-dir/--state-dir`
  (`withoutPathOptions`). Testy jednostkowe zaktualizowane: `vitest run src`
  474/474. ZROBIONE po WIP: (1) fixture (token przez `auth token generate`,
  `installationToken`, accessUrl z fragmentem) i (2) knowledge-flow. Wcześniej:
  NIE ZROBIONE: (1) `tests/support/controller-fixture.ts` — przed
  pierwszym startem `node dist/cli/index.js auth token generate --data-dir
  <data> --state-dir <state>`, token instalacji jako X-header i Bearer MCP,
  `accessUrl = ${endpoint}/#token=${token}`; (2) `tests/integration/knowledge-flow.test.ts`
  — zamiast `/api/identity/bootstrap` (tylko legacy) użyć tokena instalacji do
  admin/approve; (3) `tests/https/controller-https.test.ts` i
  `scripts/package-smoke.mjs` — to samo (nieweryfikowalne tu: brak CADDY_BIN);
  (4) README + instrukcja migracji tej instalacji do token; (5) `node:check`,
  build, test:ui, test:integration, test:e2e.
- 2026-09-26 PR F cd.: `node:build` 29269a30… passed (HEAD e9852cb).
  `node:test:integration` c6df43d2… w toku. Niezacommitowane: fixture `cli()`
  przekazuje `WORKTREE_SWITCHER_TOKEN` (CLI na żywo w trybie token tego
  wymaga); `controller-https.test.ts` i `package-smoke.mjs` przerobione na tryb
  token (token offline przed startem, brak sekretu w access record, redakcja
  `wsi_`) — niezweryfikowane (brak CADDY_BIN / smoke poza kolejką). Obserwacja
  do follow-upu: lokalne CLI w trybie token wymaga zmiennej
  `WORKTREE_SWITCHER_TOKEN`; rozważyć przekazywanie przez admin socket.
- 2026-09-26 PR F cd. 2: integration c6df43d2… exit 0, ale źródło zmieniane w
  trakcie (dirty_source) — nie liczy się. Dodane: komunikat `cli.tokenMissing`
  przy starcie w trybie token bez tokena; `cli.project.installationTokenRequired`;
  `WORKTREE_SWITCHER_TOKEN` jako fallback w knowledge/backup/identity CLI;
  identity CLI offline używa `authenticateOfflineActor` (token instalacji działa
  jako właściciel); `docs/authentication.md` (tryby, `auth`, migracja legacy →
  token); README zaktualizowane. `vitest run src/cli` 52/52. Następnie: commit
  i pełna macierz check/build/integration/e2e/ui.
- 2026-09-26 PR F ZAMKNIĘTY lokalnie: commit `a369ffd` (squash WIP). Na drzewie
  1e9ed6f (różni się od a369ffd tylko usunięciem martwego `cli.tokenMissing` i
  poprawkami dokumentacji): `node:check` db394831… passed, `node:build`
  5c3e8374… passed, `node:test:integration` 4bffe3dc… passed, `node:test:e2e`
  8cff94b7… passed, `node:test:ui` 2685cea2… passed — wszystkie
  observed_match. Na a369ffd: `node:check` 8cdf8f4f… passed, `node:build`
  58f9ab83… passed. NIEZWERYFIKOWANE: `node:test:https` (brak CADDY_BIN) i
  `scripts/package-smoke.mjs` (poza presetami kolejki). Uwaga: start w trybie
  token bez tokena kończy się błędem `installation_token_missing`
  (`assertStartupPolicy`) — usługa systemd zrestartuje się do limitu.
  Stos A–F lokalnie, bez push/PR. Zamknięcie FEAT-20260829 (done/) dopiero na
  `main` po scaleniu stosu. Follow-up: lokalne CLI przez admin socket zamiast
  `WORKTREE_SWITCHER_TOKEN`; migracja tej instalacji według
  `docs/authentication.md` (wymaga zgody właściciela).
- 2026-09-27 Dokumentacja przed PR: sekcja „Upgrade notes and breaking changes”
  w `docs/authentication.md` (brak downgrade po migracji 25, brak powrotu do
  legacy, eksport wiedzy z nowymi metodami, bootstrap HTTP tylko legacy, nowe
  instalacje wymagają tokena), ramka w README, aktualizacja package-trial,
  user-service, controller-https, reservations-and-mcp. Właściciel wybrał
  wariant A: 2 PR-y — (1) K1 + dokumenty decyzji (`t3code/review-authentication-backlog`
  → main), (2) etap 1 A–F (`t3code/auth-stage1-f-default` → gałąź PR 1).
- 2026-09-27 Review n8n (#53, #54) i CI: 3 wątki inline, wszystkie `fix` i
  rozwiązane. #53: martwy link w audycie K1 → done/ (90907d3). #54: `config mcp`
  przy kontrolerze na pierwszym planie pyta admin socket o tryb zamiast
  zwracać legacy `mcp-token`; CLI projektów i `service status` działają w
  `open` bez tokena (c8b7428). CI: `package-service-lifecycle` padał, bo
  `scripts/package-lifecycle-trial.mjs` instalował usługę bez tokena —
  poprawione; `package-smoke` padał na linku README do notatki backlogu
  (również na main) i do niespakowanego `docs/authentication.md` — link na URL,
  plik dodany do `files`. Merge #53 → #54 (ecb3348). Kolejka na ecb3348:
  `node:check` feaf2923… passed, `node:build` fc4dc4db… passed,
  `node:test:integration` 431faf8f… passed.
  CI po ecb3348: #53 zielony (check-build, lifecycle, smoke 22/24); #54
  lifecycle i check-build passed, `package-smoke` padał w scenariuszu
  „damaged asset” (świeża baza bez tokena → kontroler kończy pracę) —
  scenariusz generuje teraz token przed startem.
