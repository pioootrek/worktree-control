# K7a: pilot w trybie tokenowym, 2026-09-27

Próba na odizolowanej kopii danych. Nie przełącza żadnego projektu na nową bazę.
Git-backed backlog tego repozytorium pozostaje źródłem prawdy, a zadanie
[FEAT-20260905-shared-project-memory](../../feature/FEAT-20260905-shared-project-memory.json)
pozostaje otwarte.

## Rewizje

| Element | Wartość |
| --- | --- |
| Implementacja skryptów | `e64e65dfbc73200deedeaba1912883f9dbb5669b` (gałąź `feat/knowledge-pilot-token-mode`, czyste drzewo) |
| Baza implementacji | `origin/main` `81069845634a3fed6365589ae32a5c3430a57478` |
| Importowane źródło backloga | commit `81069845634a3fed6365589ae32a5c3430a57478`, `docs/backlog` |
| Walidator Huba | przypięty `22afb656c74b2fde84cb92f1aefcf8b427697cc6`, czysty checkout, `valid: true` |
| Plan importu | `mappingVersion` 2, hash `8243a5a9278f5de9b412e094d99d94346daf408968b4fe43408dcc8b4f446416` |
| Schemat SQLite | 25 |
| Tryb uwierzytelniania kopii | `token` |

Kolejne commity tej gałęzi zmieniają tylko dokumentację backloga; nie zmieniają
skryptów ani kodu użytego w próbie.

## Weryfikacja przez kolejkę Worktree Switcher

- `node:check` na `e64e65d`: przeszedł (lint, typecheck, 71 plików / 483 testy
  vitest, 7 testów zasobów); atrybucja źródła `observed_match`.
- `node:build` na `e64e65d`: przeszedł; atrybucja `observed_match`.

Serwer pilota uruchomiono wyłącznie claimem MCP na worktree gałęzi, z osobnym
profilem środowiska wskazującym prywatny katalog pilota i osobny port MCP.
Kontroler słuchał na loopback, na przydzielonym porcie projektu. Po próbie
serwer zatrzymano, przywrócono profil `default` i zwolniono claim. Prawdziwa
baza kontrolera nie była otwierana.

## Wynik offline: import i odtworzenie

Wszystkie kontrole przeszły:

1. `auth token generate` przez publiczne CLI inicjalizuje tryb tokenowy świeżej
   bazy; offline CLI tożsamości odrzuca brak i zły token, przyjmuje token instalacji.
2. Import w 10 partiach po najwyżej 32 mapowania jako principal `installation`; staging
   niewidoczny, kursor przetrwał ponowne otwarcie połączenia, pełna publikacja.
3. Liczności, oryginalne payloady, hashe źródeł i bajty załączników zgodne z planem.
4. Streszczenia zakończeń i autorzy/daty komentarzy historycznych czytelne z proweniencji.
5. Każdy zaimportowany rekord zachowuje tytuł; otwarte pozycje zachowują status
   i priorytet. Rozwiązane `related_ids` i `followup_ids` dają dokładnie zbiór
   74 relacji zadanie–zadanie. Hashe 143 załączników są równe plikom notatek w commicie.
6. Partia i zaimportowane rekordy wskazują principal `installation`; partia nie
   ma pola metody uwierzytelnienia (patrz ograniczenia).
7. Ponowny identyczny import nie zmienia pełnej migawki.
8. Logiczny eksport/odtworzenie z osobną kopią tożsamości daje identyczną migawkę.
9. Backup/restore kontrolera daje identyczną migawkę.

| Plan | Liczba |
| --- | --- |
| Pliki / bajty | 221 / 6 674 145 |
| Pozycje otwarte / zakończenia / notatki | 12 / 20 / 18 |
| Komentarze osadzone / załączniki / dokumenty | 92 / 143 / 26 |
| Mapped / source-only / skipped | 285 / 27 / 1 |
| Brakujące / konflikty / nierozwiązane relacje | 0 / 0 / 0 |

| Migawka | Liczba |
| --- | --- |
| Wątki / odpowiedzi / zadania / pamięć | 12 / 92 / 32 / 18 |
| Relacje (w tym zadanie–zadanie) / załączniki | 86 (74) / 143 |
| Źródła importu / wiersze historii | 313 / 0 |

## Wynik live: GUI, CLI i dwa klienty MCP

Wszystkie 12 kontroli przeszło w pierwszym przebiegu:

1. HTTP, MCP i online CLI odrzucają brak i zły token.
2. Online CLI z tokenem instalacji tworzy dwóch agentów, granty i tokeny;
   token agenta czyta wiedzę przez CLI.
3. Dwa klienty MCP uwierzytelniają się jako różni agenci, bez narzędzi runtime
   i kolejki testów.
4. Agent 1 czyta zaimportowany backlog przez MCP.
5. Treść streszczeń jest wyszukiwalna; proweniencja komentarzy historycznych jest widoczna przez MCP.
6. GUI odrzuca zły token i loguje przez formularz dostępu tokenem instalacji
   (token nie trafia do URL).
7. GUI pokazuje historycznego autora i datę osobno od principal importu.
8. Człowiek tworzy zadanie w GUI; agent 1 czyta ten sam rekord.
9. Agent 1 proponuje decyzję z idempotentnym ponowieniem; agent 2 dodaje
   pytanie i nie może zatwierdzić (`knowledge_forbidden`).
10. Właściciel zatwierdza w GUI; historia przypisuje utworzenie agentowi 1
    (`agent_token`), a zatwierdzenie instalacji (`installation_token`).
11. Nowa sesja MCP, wywołanie CLI i nowa sesja przeglądarki odczytują
    zatwierdzoną decyzję i otwarte pytanie dla zadania.
12. Widok pamięci przy 390 px nie ma poziomego przepełnienia.

Zrzuty ekranu obejrzano ręcznie: zadanie człowieka, decyzja „Active · Approved”
z „Approved by installation” i widok mobilny.

## Prywatność poświadczeń

Token instalacji jest tylko w prywatnym pliku katalogu pilota (0600, katalog
0700, `umask 077`). Skrypty przekazują poświadczenia wyłącznie nagłówkami,
potokami i środowiskiem procesów potomnych. Po próbie przeszukano cały katalog
pilota: sekret instalacji występuje tylko w pliku tokena, a żaden ciąg w
formacie tokena agenta lub instalacji nie występuje w bazach, logach, raportach
ani zrzutach. Prywatne artefakty nie są częścią repozytorium.

## Ograniczenia

- `knowledge_import_batches` zapisuje `actor_principal_id`, ale nie metodę
  uwierzytelnienia. W tej próbie principal to `installation`, a raport zapisuje
  `batchAuthenticationMethod: "not recorded"`. Zaimportowane rekordy mają
  `created_by = installation` i nie mają wierszy `knowledge_history`. Metody dla
  wcześniejszych partii nie da się ustalić i nie wolno jej zgadywać.
- Atrybucja historyczna z Huba (autor i data komentarza) jest oddzielna od
  atrybucji importu i pozostaje dostępna w proweniencji; nie jest to brak.
- Dotyczy jednego zbioru danych (backlog tego repozytorium) i jednego przebiegu.
  Nie dowodzi dowolnych mapowań, odporności na przerwanie procesu ani pojemności.
- Lista pamięci pokazuje treść zaimportowanych notatek jako surowy JSON, a
  autorów jako identyfikatory principal. To istniejące ograniczenie prezentacji.
- Kontrola „kolejnej sesji” to nowe połączenia MCP/CLI/przeglądarki w tym samym
  działającym kontrolerze, nie restart kontrolera.
- Główne CI nie uruchamia tego pilota.

## Pozostałe braki przed przełączeniem (K7)

- Zapisywać metodę uwierzytelnienia partii importu dla nowych partii, a dla
  starych jawnie oznaczać ją jako nieznaną.
- Uzgodnić kryteria K2–K6 z kodem i testami.
- Zmierzyć użyteczność codziennej pracy i wysiłek wyszukiwania.
- Wskazać projekt i osobę odpowiedzialną, wykonać jawne przełączenie z jednym
  źródłem zapisu i ścieżką rollbacku. Ten raport nie zatwierdza przełączenia.
- Później: K8 (playbooki, inspekcja instrukcji) i K9 (składanie zatwierdzonych reguł).
