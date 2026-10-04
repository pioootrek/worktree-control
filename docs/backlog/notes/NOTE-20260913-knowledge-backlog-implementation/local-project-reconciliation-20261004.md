# Porównanie lokalnych backlogów z bazą Switchera

Data inspekcji: 2026-10-04. Zakres zlecony przez właściciela: sprawdzić
projekty w `~/development` przed aktualizacją kontrolera i przenoszeniem
backlogów. Raport nie oznacza zgody na import ani przełączenia źródła zapisu.

Status: inwentaryzacja plików wykonana; porównanie z bazą zablokowane przez
brak odpowiedniego poświadczenia. Nie ustalono jeszcze różnic pliki/baza.

## Obowiązujące instrukcje

| Projekt | Źródło backlogu według instrukcji |
| --- | --- |
| WinPath | `docs/backlog/`, JSON w Git na `staging` |
| Prosty Prawnik | `docs/backlog/`, Git; Hub tylko odczytuje |
| Borrow Everything | `docs/backlog/`, JSON w Git na `master` |
| Worktree Switcher | `docs/backlog/`, JSON w Git na `main` |

Dowody: `AGENTS.md` oraz `docs/backlog/AGENTS.md` w odpowiednich repozytoriach.
Są to instrukcje dla agentów, a nie dowód, że nikt nie zapisywał równolegle
w bazie. Faktyczny zapis i rozbieżności wymagają odczytu rekordów wiedzy.

## Spis lokalnych plików

Skan znalazł 48 katalogów roboczych i rozróżnił 8 repozytoriów Git według
wspólnego katalogu Git. Lista zarejestrowanych worktree obejmuje także ścieżki
poza katalogiem skanowania; liczby worktree nie są liczbami projektów wiedzy.
Pięć głównych katalogów repozytoriów ma backlog:

| Repozytorium | Otwarte pliki zadań | Zakończenia | Manifesty notatek | Razem | Pliki towarzyszące notatkom |
| --- | ---: | ---: | ---: | ---: | ---: |
| borrow-everything | 10 | 1 | 0 | 11 | 0 |
| llm-ops-hub | 2 | 1 | 0 | 3 | 0 |
| prosty-prawnik | 51 | 4 | 6 | 61 | 15 |
| win-path-6 | 182 | 340 | 47 | 569 | 888 |
| worktree-switcher | 15 | 21 | 20 | 56 | 361 |
| Łącznie | 260 | 367 | 73 | 700 | 1264 |

Pozostałe repozytoria to `agent-skills` oraz fixture Angular i Django,
bez `docs/backlog` w głównych katalogach. Skan nie znalazł powtórzonych ID
ani błędów odczytu w wymienionych głównych backlogach. Liczby pochodzą
z plików roboczych, nie ze zdalnych gałęzi ani produkcyjnej bazy. Liczba 1264
oznacza pliki w katalogach notatek, nie zweryfikowane załączniki w bazie.
Spis Switchera obejmuje też nowy, jeszcze niezatwierdzony raport tego audytu.

Prywatny materiał roboczy: `/tmp/wts-readonly-reconcile-8z5cbixj/`.
`local-inventory.json` zawiera ID, ścieżki, SHA256 plików, hashe kanonicznego
JSON, commity, gałęzie i metadane worktree; `production-access-evidence.json`
zawiera wynik próby dostępu bez tokenów. Te pliki są lokalne i tymczasowe.

### Różnice między katalogiem głównym a wybranym worktree

| Projekt i checkout | Commit | Zadania otwarte / zakończenia / notatki | Stan plików roboczych |
| --- | --- | --- | --- |
| WinPath, główny `staging` | `814ba95f1455763a7d10b3cfc0d0d3415fec10b3` | 182 / 340 / 47 | 2 zmienione śledzone pliki, 13 nieśledzonych |
| WinPath, `se-forecast-integration`, gałąź `se-forcast-management-rework` | `8365653ae086e43e0760e11a7b08daecedb2f9c4` | 187 / 348 / 46 | czysty |
| Prosty Prawnik, główny `main` | `c5d09bc21e1ae23f2662147e0a66b9c30a0c396f` | 51 / 4 / 6 | 1 zmieniony śledzony plik |
| Prosty Prawnik, `.t3/worktrees/prosty-prawnik/t3code-71522313`, gałąź `feature/client-inbox` | `674e1d2047f94b0b99499c7afb68254cd516aa17` | 52 / 10 / 7 | czysty |

Liczby zmienionych plików dotyczą całych checkoutów. Nie wszystkie zmiany
muszą dotyczyć backlogu. Wybrany worktree runtime nie jest automatycznie
źródłem importu. Różne liczby rekordów i hashe wymagają wskazania konkretnego
commita oraz rozliczenia zmian przed importem. Audyt nie resetował katalogów,
nie przełączał gałęzi i nie scalał zmian między nimi.

Względem głównego katalogu wybrany worktree Prosty Prawnik ma 9 innych ID
dodatkowo, brakuje w nim 1 ID, a 5 wspólnych rekordów ma zmieniony hash.
Dla WinPath liczby wynoszą odpowiednio 15, 3 i 4. To różnice plików między
checkoutami, nie ustalone konflikty z bazą. Część usuniętych ID zadań ma
odpowiadające wpisy zakończenia przez `item_id`. W WinPath niezatwierdzone
zmiany obejmują backlog, w tym notatkę i zakończenie worker-infrastructure.
Nie należy ich pomijać ani nadpisywać podczas przygotowania źródła importu.

Odczyt `git ls-remote` z 09:49 UTC wykazał zgodność lokalnego HEAD z wybraną
gałęzią zdalną dla Borrow Everything (`master`), WinPath (`staging`)
i Switchera (`main`, przed zatwierdzeniem tego raportu). Dwa katalogi nie
odpowiadały bieżącemu zdalnemu `main`:

- Prosty Prawnik: lokalnie `c5d09bc21e1ae23f2662147e0a66b9c30a0c396f`,
  zdalnie `a4c27a6fbdb9a273ecaf562b80f263cae9762f4d`.
- LLM Ops Hub: lokalnie `22afb656c74b2fde84cb92f1aefcf8b427697cc6`,
  zdalnie `4cc02da94169cdb556b714d836c22b51c9853e19`.

Bez pobrania i porównania drzew tych commitów nie można przenosić lokalnych
liczb rekordów na stan zdalny. Nie wykonywano fetch, pull ani reset.
Katalogi Dify i recovery nie były niezależnymi repozytoriami Git; audyt nie
traktuje ich jako pustych projektów wiedzy ani nie porównuje ich z bazą.

## Co oznacza import i dostęp MCP

Historyczny kod wydania `a727fd8` w `hub-import-plan.ts` odczytuje wskazany
40-znakowy SHA commita. `hub-import-execution.ts` zachowuje identyfikator źródła,
commit i hash planu. Import nie synchronizuje późniejszych zmian w plikach.
Plan produktu w `docs/shared-project-memory-plan.md` wymaga osobnego
przełączenia każdego projektu i aktualizacji jego instrukcji.

Historyczny `mcp-runtime.ts` rozdziela narzędzia według poświadczenia.
Poświadczenie legacy udostępnia operacje serwerów i testów; poświadczenie
tożsamości udostępnia narzędzia wiedzy i `get_identity`. HTTP `/api/knowledge`
również wymaga poświadczenia tożsamości. Sam działający MCP runtime nie dowodzi
dostępu do wiedzy ani korzystania z niej przez dany projekt.

Sprawdzono wspólny manifest `agent-skills/mcp/servers.json`, aktywną
rejestrację Codex oraz odpowiedź `tools/list` produkcyjnego serwera.
Odczyt 2026-10-04 o 09:47 UTC potwierdził 29 narzędzi runtime, bez narzędzi
wiedzy i bez kolejnej strony listy. Skonfigurowane poświadczenie jest tokenem
legacy runtime. Próba odczytu operacji `projects` przez właściwy endpoint
HTTP wiedzy zwróciła `401 invalid_credential`. Połączenie jest sprawne;
brakuje poświadczenia tożsamości z dostępem do wiedzy. Własną sesję diagnostyczną
MCP zamknięto przez DELETE, z odpowiedzią 200.

Nie znaleziono tokena ownera/agenta w sprawdzanej konfiguracji i zmiennych
środowiska. Nie przeszukiwano sesji przeglądarki ani innych magazynów sekretów.
Do dalszego odczytu potrzebny jest aktywny token z `knowledge:read` dla
odpowiednich projektów. Nie należy umieszczać tokena w raporcie ani czacie.

## Stan kontrolera podczas odczytu

Zarejestrowane projekty runtime: django-testing, Prosty Prawnik, WinPath,
Worktree Switcher. WinPath działał; pozostałe serwery były zatrzymane.
Żaden projekt nie miał rezerwacji, kolejka testów miała 0 uruchomionych
i 0 oczekujących zadań. Jest to odczyt chwilowy, wymagający powtórzenia
przed ewentualnym zatrzymaniem kontrolera.

## Zasady dalszego porównania

1. Rozróżnić niezależne repozytoria i worktree tego samego projektu.
2. Zachować liczbę rekordów, identyfikatory, hashe, wybraną gałąź i commit.
   Osobno odnotować niezapisane zmiany i różnice między worktree.
3. Przez autoryzowane API odczytać projekty wiedzy i rekordy, w tym archiwalne.
   Brak dostępu nie oznacza pustej bazy ani braku importu.
4. Porównać rekordy z przypisanym źródłem importu. Rozdzielić nowe wpisy
   w plikach, nowe wpisy w bazie, zmiany treści i statusu oraz brakujące relacje
   i załączniki. Zachować późniejsze wpisy bazy przed ponownym importem.
5. Dopiero po rozliczeniu różnic ustalić końcowy import i jedno miejsce zapisu.

Nie otwierano produkcyjnej SQLite bezpośrednio, nie uruchamiano migracji,
nie zmieniano poświadczeń, nie importowano danych i nie zatrzymywano usług.

Zachowane dowody bez sekretów:

- [Spis, różnice ID i zdalne referencje](local-project-reconciliation-evidence-20261004.json).
- [Rejestracja, dostępne narzędzia MCP i odmowa odczytu wiedzy](local-project-access-evidence-20261004.json).

Skan plików nie był atomową migawką; równoległe zmiany mogły wpłynąć na
odczyt. Przed importem należy powtórzyć porównanie dla ustalonego commita.
Następny krok to autoryzowany odczyt wiedzy oraz rozliczenie właściwych
źródeł Git. Na obecnym materiale nie można jeszcze zatwierdzić pełnej migracji.
