# Etap 1 uwierzytelniania: projekt implementacji i dziennik

Start: 2026-09-26. Baza: `e3f4b4c` (gałąź `t3code/review-authentication-backlog`).
Zadanie: [FEAT-20260829-independent-auth-modes](../../feature/FEAT-20260829-independent-auth-modes.json).
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
