# K1: domknięcie tożsamości i scoped access — dziennik postępu

Start: 2026-09-26. Baza: `65775e9` (main). Gałąź: `t3code/review-authentication-backlog`.
Zadanie: [FEAT-20260913-knowledge-k1-identity](../../feature/FEAT-20260913-knowledge-k1-identity.json).
Kierunek: [globalne tryby](../NOTE-20260909-self-hosted-saas-plan/authentication-modes-and-plugin.md)
— K1 NIE implementuje trybów open/token (to FEAT-20260829-independent-auth-modes);
K1 domyka istniejącą tożsamość, granty i scoped MCP tak, by etap 1 mógł na niej stanąć.

## Stan zastany (zweryfikowany w kodzie)

- K1 zmergowane wcześniej: `cdd21e9` foundation, `6065312` owner bootstrap,
  `20c2de5` scoped identity management, `d9bd6ea` hardening. K2–K7 zbudowane na tym.
- `src/server/modules/identity/identity-service.ts`: bootstrap/recover/renew
  właściciela, agenci, tokeny `wts_<uuid>_<64hex>` (sha256 verifier, timingSafeEqual),
  granty wiedzy, `authorizeKnowledge`, `knowledge:approve` tylko owner_session.
- HTTP: `/api/knowledge` (Bearer principal), `/api/identity/bootstrap` (pairing token),
  `/api/identity/admin` (owner Bearer), `/api/identity` (describe), SSE filtruje
  zdarzenia wiedzy przez `authorizeKnowledge` przy każdym zdarzeniu.
- MCP: legacy token albo principal (`ControllerAuthentication`).
- CLI `identity <cmd>`: online przez `/api/identity/admin` z `WORKTREE_SWITCHER_OWNER_TOKEN`,
  offline pod controller lock. `recover-owner` działa tylko offline.

## Analiza luk (w toku)

Macierz kryteriów odbioru K1 → istniejące testy (stan `65775e9`):

| Kryterium | Pokrycie |
| --- | --- |
| bootstrap / renew online / recover offline | `identity-service.test.ts`, `cli/identity-management.test.ts`, `http-server.test.ts` |
| sesja właściciela bezterminowa, opcjonalnie 60–3600 s | `identity-service.test.ts:101` |
| agent lifecycle, revoke tokenu, revoke grantu per operacja | `identity-service.test.ts:195`, `identity-queries.test.ts:123` |
| RFC3339 expiry normalizacja | `identity-service.test.ts:186` |
| tylko verifier/prefiks w SQLite i audycie; scrub legacy prefiksów | `identity-queries.test.ts:72,88` |
| agent A nie widzi projektu B; granty w eksporcie/załącznikach/SSE | `knowledge-transports.test.ts:148`, `knowledge-attachments.test.ts:27`, `events.test.ts`, transfer/memory testy |
| `human:*`/etykieta nie daje approve | `identity-service.test.ts:245`, `knowledge-memory.test.ts:95` |
| klient wiedzy nie wywoła runtime (HTTP + MCP) | `http-server.test.ts:129`, `mcp-http-server.test.ts:89` |
| zmiana poświadczeń w sesji MCP odrzucona | `mcp-runtime.ts` authenticationKey + `mcp-http-server.test.ts:89` |
| legacy pairing / MCP token | `http-server.test.ts:219`, `mcp-http-server.test.ts:161` |

Wniosek: kod K1 spełnia zakres; „owner flow needs completion” z problemu itemu
zostało przejęte przez etap 1 (drugie pole logowania wiedzy w UI, self-grant
właściciela). Drobne obserwacje (nie blokują K1):
- `owner_already_initialized` przez HTTP zwraca 400 (generyczny handler), nie 409.
- `recover-owner` tylko offline (udokumentowane w README) — kanał online
  należy do etapu 1 (lokalny kanał administracyjny chroniony przez OS).
- Właściciel po `create-knowledge-project` nie ma automatycznie grantu; README
  opisuje jawny self-grant. W etapie 1 token instalacji ma pełny dostęp.

## Weryfikacja

- `pnpm install --frozen-lockfile` w worktree (brak node_modules).
- Kolejka MCP: bazowy `node:test` run `5fa42c40-6034-42b8-9a05-e076a9fb4ede`:
  64 plików / 436 testów passed, exit 0. Faza `failed` wyłącznie z powodu
  `dirty_source` (nieśledzona notatka) — nie jest to błąd testów.

## Zmiany w kodzie

1. `POST /api/identity/bootstrap` przy istniejącym właścicielu zwraca 409
   `{ code: "owner_already_initialized", error }` (wcześniej generyczne 400).
   Pliki: `src/server/http-server.ts`, `src/i18n/server-errors.ts` (EN tłumaczenie),
   test `src/server/http-server.test.ts` „reports a repeated owner bootstrap as a conflict”.
   Celowane vitest: 27/27 passed.

2. `pnpm check` przez kolejkę, run `6d7a770c-f0aa-4ac7-bfef-285b585eef1a`:
   eslint + tsc + vitest 64 pliki / 437 testów + 7 testów zasobów, exit 0.
   Atrybucja „changed” — w trakcie dopisano wyłącznie pliki backlogu
   (note.json, index.json), bez zmian kodu.

## Następne kroki

- Właściciel zatwierdził zamknięcie K1 (2026-09-26). Zamknięte przez
  `done/DONE-20260926-knowledge-k1-identity.json` w jednym commicie z poprawką 409.
  Reszta „owner flow” (drugie logowanie wiedzy w UI, self-grant) → etap 1.
- Kolejny etap: FEAT-20260829-independent-auth-modes (etap 1).

## Decyzje do etapu 1 (2026-09-26)

- Tryb tej instalacji po wdrożeniu etapu 1: `token` (decyzja właściciela).
- Kanał administracyjny: rekomendacja unix socket 0600 w katalogu 0700; oczekuje
  na potwierdzenie. Zapisane w notes[] FEAT-20260829-independent-auth-modes.
