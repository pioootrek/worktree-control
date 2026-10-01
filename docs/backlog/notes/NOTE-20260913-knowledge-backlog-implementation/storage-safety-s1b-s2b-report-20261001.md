# Raport S1b + S2b, 2026-10-01

Zadanie [RWK-20260928-sqlite-data-safety](../../rework/RWK-20260928-sqlite-data-safety.json)
pozostaje otwarte. Ten slice zaczął się od `main` na merge'u PR #68,
`afe9f20d86c7336021684b7a55aeb7dcf41fe338`.

- SHA feature: `fced54c4f94111fb0f815ba4a100de2d864372e2`.
- Gałąź: `feat/sqlite-durable-migrations`.
- Osobny worktree: `worktree-switcher-sqlite-durable-migrations`.
- PR: [#69](https://github.com/pioootrek/worktree-switcher/pull/69), otwarty do `main`.

## Dostarczone zachowanie

Adapter rozpoznaje schemat i sprawdza dane przez połączenie read-only,
przed otwarciem do zapisu, trwałym PRAGMA, DDL i inicjalizacją auth.
Po otwarciu do zapisu wymaga efektywnych `journal_mode=WAL`,
`synchronous=FULL`, `foreign_keys=ON` i `busy_timeout=3000`.
Ponownie sprawdza ustawienia po migracji.

Nowe katalogi danych i stanu mają tryb 0700. Baza jest tworzona jako 0600;
SQLite dziedziczy ten tryb dla WAL/SHM. Kopia bazy jest wstępnie tworzona
jako 0600 przed Backup API, a staging i opublikowany katalog kopii są prywatne.
Istniejące wybrane pliki bazy i sidecary mogą zostać zawężone do 0600 dopiero
pod lockiem bazy, po sprawdzeniu UID, typu, liczby linków i tożsamości deskryptora.
Nie są zmieniane prawa innych plików ani katalogów.

Nieprywatny istniejący katalog docelowy, niebezpieczny zapisywalny przodek,
obcy właściciel, symlink lub hardlink pliku powoduje odmowę. Kanoniczne aliasy
katalogów nadal wskazują tę samą własność bazy. Niebezpiecznej konfiguracji
katalogów program nie naprawia automatycznie; operator musi sprawdzić właściciela,
aliasy i wybrać prywatny katalog. Symlink do nieistniejącego celu backupu również
jest traktowany jako zajęte miejsce.

Bazowy DDL, historyczne transformacje, nowa migracja 28 i ich wpisy wykonują się
w jednej transakcji IMMEDIATE. Historyczne transformacje 1–27 pozostają bez zmian.
Migracja 28 dodaje nazwę i SHA-256 deterministycznego opisu nowej migracji.
Starsze wpisy zachowują NULL, również przy nowym wykonaniu historycznej transformacji.
Odczyt odrzuca luki, niezgodne nazwy/checksumy i wymyśloną proweniencję starszych wpisów.

Tworzenie bazy zapisuje i synchronizuje prywatny znacznik `.initializing`, powiązany
z urządzeniem i inode pliku. Pusta baza może zostać zainicjalizowana tylko z takim
znacznikiem. Rollback i SIGKILL przed COMMIT pozwalają ponowić rozpoznaną inicjalizację
bez przejścia do legacy auth. Awaria po COMMIT, przed usunięciem znacznika, rozpoznaje
ukończony schemat. Pusty plik bez znacznika, niezgodny znacznik, częściowy DDL
lub nieznana struktura pozostają zachowane i blokują start.
Przerwanie w krótkiej granicy przed publikacją kompletnego znacznika może wymagać
inspekcji operatora; program nie zgaduje i nie usuwa takiego pliku.

Przed migracją oraz przed COMMIT działają `integrity_check`, `foreign_key_check`
i kontrole aktywnych lease, polityki auth, principal instalacji, projektu odpowiedzi,
celu załącznika oraz postępu importu. Końcowy schemat jest rozpoznawany jeszcze
w transakcji. Migrator wyłącza FK poza transakcją na czas historycznej przebudowy
referencjonowanego parenta w migracji 25, sprawdza FK przed COMMIT i przywraca ustawienie
w finally. Błąd zamyka połączenie i zwalnia własny lock, bez resetu danych lub auth.

Migracja 4 historycznie dodawała kolumny lease bez przebudowy CHECK.
Rozpoznawanie akceptuje tę konkretną linię, a walidator sprawdza aktywne lease.
Relacje z niedostępnym lub obcym celem pozostają wspieranym stanem czytnika;
nie są usuwane ani zamieniane w błąd startu.

Zachowano domyślnie wyłączone backupy, opcjonalną kopię przed migracją przez CLI,
ręczny backup bez migracji, jednego właściciela i odzyskanie zatwierdzonego WAL.
Nowy wspólny limit schematu to 28; schemat 29 jest odrzucany również z WAL.

## Weryfikacja

Końcowe check/build/integration/pomiar korzystają z presetów kolejki MCP Worktree
Switcher, z dokładnym odkrytym worktree, pojedynczo, na czystym końcowym SHA feature.
Chromium przeszedł na czystym `9b0fcc3`; późniejszy `fced54c` zmienił wyłącznie
tworzenie prywatnych katalogów w fixture'ach integracji/HTTPS, skryptach smoke/benchmark
i workflow lifecycle. Kod runtime i dashboardu nie zmienił się po runie UI.
Nie przejmowano ani nie uruchamiano zarządzanego serwera deweloperskiego.

| Polecenie | Wynik | ID uruchomienia |
| --- | --- | --- |
| `pnpm check` | passed, 585 Vitest w 80 plikach i 7 testów skryptów, lint/typecheck, observed_match | `1f7e5c92-b43a-42da-af87-ef97c7d62691` |
| `pnpm build` | passed, statyczny eksport i bundle CLI, observed_match | `c97cef3c-a21b-4947-a95a-cbc6d4750b18` |
| `pnpm test:integration` | passed, 23 testy w 5 plikach, observed_match | `b02f63fa-efb1-442d-848c-b3bb73ff48da` |
| `pnpm test:ui` | passed, 134 Chromium, observed_match na `9b0fcc3` | `9a6e5e9b-dd29-47a7-9502-426dc2fd664f` |
| `pnpm test:sqlite-cost` | passed, 3 serie każdego trybu/operacji, observed_match | `52cf1726-5515-46d6-983e-007dce64b05a` |

`pnpm smoke:package` na końcowym `fced54c` przy umask 022 przeszedł 14 kroków,
exit 0, 29,7 s, cleanup graceful. Użyto publicznego polecenia przez
`llm-worker-heavy-runner`, ponieważ dla smoke nie ma presetu kolejki.
Paczka była instalowana w jednorazowym prefiksie zawierającym spacje;
sprawdzono natywne SQLite, offline CLI, auth, izolowany kontroler, zasoby paczki
i MCP. Artefakt SHA-256: `bd8d3ff9b01d4799957e835cefa9b69d2f95ef74476bc004a70f553348dc1069`.
Nie jest to aktualizacja starego zainstalowanego artefaktu.

Testy obejmują świeżą instalację, zamrożone fixture 12/24/26 i istniejące regresje
historycznych migracji, w tym lease schematu 3. Testy awarii obejmują wyjątek po DDL,
rollback FK/integralności, prawdziwy SIGKILL przed COMMIT inicjalizacji i migracji,
niekompletny znacznik oraz błąd jego usuwania po COMMIT. Sprawdzają zamknięcie połączenia,
ponowne przejęcie własności, brak zmiany danych przy odmowie i zachowanie auth.

Prywatność obejmuje rzeczywisty offline CLI przy umask 000, bazę, WAL/SHM i kopie,
aliasy sidecarów, obcego właściciela i zachowanie uprawnień niezwiązanych plików.
Przypadek obcego UID jest symulowany w teście; nie zmieniano kont systemowych.

Pierwsze robocze runy ujawniły błędy fixture i oczekiwań po zmianie rejestru,
które poprawiono. Run `6c421c2b-9c10-41ed-a5af-e6a9dfb70128` na `a2536a1`
zakończył się czterema błędami czasowymi/assertion, kiedy pomiar na ext4 działał
równolegle z testami jednostkowymi. Ten run jest failed, mimo observed_match.
Pomiar przeniesiono do osobnego finite presetu; nie zmieniano timeoutów, liczby workerów,
limitów hosta ani guardów. Późniejsze check/build/integration na `c9eb927` przeszły,
a testy przyszłego schematu zostały potem uzupełnione dla schematu 29.
Końcowy przegląd wykrył również fixture'y tworzące katalogi danych z domyślnym
umask. Tworzą teraz jawne 0700, aby CI z umask 022 nie opierało się na umask usługi.
Nie zmieniono kontroli prywatności istniejących katalogów aplikacji.

`git diff --check` przeszedł. Lint zachowuje wcześniejszy warning
`react-hooks/exhaustive-deps` w `knowledge-dashboard.tsx:87` dotyczący `selection.tab`.

## Pomiar FULL

Preset `pnpm test:sqlite-cost` tworzy jednorazowe bazy na systemie plików rodzica
repozytorium i usuwa je po pomiarze. Na tym hoście był to ext4. `/tmp` jest tmpfs,
więc jego pomiar nie został użyty jako koszt trwałego zapisu na dysk.
Dla każdego trybu wykonuje trzy serie, po 20 zapisów rozgrzewki i 200 mierzonych
zapisów na operację. Mierzy rzeczywiste wywołania adaptera: rejestrację projektu
oraz transakcję polityki auth z audytem. NORMAL jest porównaniem wyłącznie
na jednorazowych połączeniach testowych; aplikacja nadal wymaga FULL.

SQLite 3.53.4, Node 24.19.0. Poniżej mediana trzech median p50 i zakres p95 FULL;
każda seria obejmowała 200 mierzonych operacji. Różnica p50 wynosi około 1,2–1,35 ms
na operację. Wartości zależą od lokalnego storage i nie są gwarancją czasu odpowiedzi.

| Operacja | NORMAL p50 (ms) | FULL p50 (ms) | FULL p95, zakres serii (ms) |
| --- | ---: | ---: | ---: |
| Rejestracja projektu | 0,203 | 1,547 | 1,853–3,459 |
| Polityka auth i audyt, jedna transakcja | 0,072 | 1,274 | 1,526–1,725 |

Surowe serie i metadane runów: [evidence](storage-safety-s1b-s2b-evidence-20261001.json).

## Ograniczenia

SIGKILL testuje przerwanie procesu. Nie wykonano próby utraty zasilania ani nie
zweryfikowano sprzętu, firmware i gwarancji synchronizacji storage. Pomiar jest
lokalną próbą syntetycznych zapisów, bez ustalenia produkcyjnego SLO.
[SQLite opisuje FULL w WAL](https://www.sqlite.org/pragma.html#pragma_synchronous)
i [ograniczenie zmiany FK w transakcji](https://www.sqlite.org/pragma.html#pragma_foreign_keys).
[Założenia atomic commit](https://www.sqlite.org/atomiccommit.html) zależą również od storage.

Nie instalowano systemd/launchd, nie wykonano aktualizacji zainstalowanego starego
artefaktu ani próby na produkcyjnej bazie. Nie zmieniono usług lub ustawień hosta.
Pełne trwałe publikowanie załączników i protokół restore, retencja, harmonogramy,
GUI backupów i transfer zewnętrzny pozostają kolejnymi slice'ami.
Nie wykonano merge, wdrożenia, cutover ani kolejnego slice'a.
