# Raport S1a + S2a, 2026-10-01

Implementacja jest w otwartym [PR #68](https://github.com/pioootrek/worktree-switcher/pull/68)
do `main`. PR wymaga przeglądu i merge. Rekord
`RWK-20260928-sqlite-data-safety` pozostaje otwarty.

- SHA aplikacji: `7f9f82ce2a9bf24b7d174cbdacd939c1bb952ada`.
- Gałąź: `feat/sqlite-pre-migration-backup`.
- Osobny worktree: `worktree-switcher-sqlite-pre-migration-backup`.
- Uzgodniony plan został zapisany i wypchnięty na `main` w commicie
  `6cd50e69e1c02c9ad34d283fd5769c035ae942b1`.
- Środowisko testowe: Node.js `24.19.0`, SQLite `3.53.4`.

## Dostarczone zachowanie

Własność bazy zależy od jej kanonicznej ścieżki i obowiązuje także dla
różnych katalogów stanu. Aliasy katalogów przez symlink wskazują na ten sam
zasób. Symlinki i hardlinki samego pliku bazy są odrzucane. Blokada kontrolera
pozostaje, a blokada bazy obejmuje kontroler i operacje offline.

Inspekcja rozpoznaje schemat przed zmianą trybu dziennika, DDL i inicjalizacją
uwierzytelniania. Wspólny limit wynosi 27. Nowszy, obcy, niepełny lub
nierozpoznany schemat powoduje odmowę. Ręczne `backup create` otwiera źródło
bez migracji. Metadane i lista wymaganych załączników pochodzą z migawki.
Kopia jest sprawdzana przez `integrity_check` i `foreign_key_check`.
Obsługiwane schematy bez tabel wiedzy nie wymagają tych tabel do backupu.

Backup przed migracją pozostaje domyślnie wyłączony. Operator może go włączyć
na `start` lub `service install` przez
`--backup-before-migration --backup-dir <directory>`. Argumenty są walidowane
przed mutacją i zapisywane w definicji usługi. Włączona ochrona wymaga
zweryfikowanej kopii starego schematu przed migracją; błąd zatrzymuje start
bez zmiany źródła. Bez flagi migracja nie wymaga celu kopii i nie tworzy
zadań backupu. Świeża lub aktualna baza nie potrzebuje kopii przed migracją.

## Weryfikacja

Poniższe końcowe uruchomienia korzystały z presetów kolejki MCP Worktree
Switcher, pojedynczo. Każde zakończyło się `passed`, kodem 0, z przypisaniem
`observed_match` do czystego SHA aplikacji wskazanego wyżej.

| Polecenie | Wynik | ID uruchomienia |
| --- | --- | --- |
| `pnpm check` | lint i typecheck; 548 testów Vitest w 79 plikach oraz 7 testów skryptów | `b3283ea1-86f9-43bc-8fd1-a8a32cf3c8b9` |
| `pnpm build` | statyczny eksport dashboardu i bundle CLI | `2cd02c4a-2b6d-4d69-b374-fa97820f4e00` |
| `pnpm test:integration` | 22 testy w 5 plikach, w tym 6 nowych testów zbudowanego CLI | `50197983-60f3-4a17-8b97-9bbd62b21381` |
| `pnpm test:ui` | 134 testy Chromium statycznego eksportu, około 3,8 minuty | `239744f1-7c83-4def-84bd-06b32264502f` |

`git diff --check` przeszedł. Lint zachowuje jeden wcześniejszy warning
`react-hooks/exhaustive-deps` w `knowledge-dashboard.tsx:87` dotyczący
`selection.tab`.

Testy obszaru obejmują zachowanie rekordów i załączników w kopiach starych
schematów, brak zmian źródła po błędzie wymaganej kopii, migrację bez backupu,
odmowę dla nieobsługiwanej bazy, zwalnianie własnych zasobów i zachowanie
cudzego locka. Dwa rzeczywiste procesy konkurują o jedną bazę przez różne
katalogi stanu i alias katalogu. Testy CLI obejmują błędne flagi i zapis flag
w izolowanej definicji usługi.

Zamrożone fixture SQL pochodzą z historycznych migratorów: schemat 12 z
`bfa6cff`, 24 z `a727fd8`, 26 z `73e68ac`. Przygotowanie nie korzysta z
aktualnego konstruktora store. Dane są syntetyczne i izolowane. Pochodzenie
fixture z kodu starego wydania nie dowodzi stanu bazy produkcyjnej.

Zbudowany CLI wykonał ręczny backup oraz start i zatrzymanie izolowanego
kontrolera po migracji, z opcją włączoną i wyłączoną. Izolacja obejmuje
HOME, katalog stanu, katalog danych i port; odpowiedź dashboardu miała HTTP 200.
Testy przeglądarkowe korzystały ze statycznego eksportu i danych testowych.
Nie uruchamiano zarządzanego serwera deweloperskiego.

## Ograniczenia i dalszy zakres

Test definicji usługi używa izolowanego HOME i podstawionego wykonawcy
menedżera. Nie instalowano ani nie uruchamiano rzeczywistej jednostki
systemd/launchd. Nie przeprowadzono aktualizacji zainstalowanego starego
artefaktu ani testu na bazie produkcyjnej.

Niepełne locki i porzucone katalogi przejmowania blokady są zachowywane i
wymagają inspekcji operatora. Testy nie dowodzą odporności na utratę zasilania
ani gwarancji trwałości sprzętu. Nie wykonano pełnej próby odtworzenia
instalacji; czas restore i RTO pozostają niezmierzone.

S1b/S2b, trwała publikacja załączników, transakcyjny bootstrap, checksumy
migracji, koordynacja backupu pracującego kontrolera i pełny protokół restore
pozostają dalszym zakresem. Harmonogramy, retencja, transfer zewnętrzny oraz
GUI również nie wchodzą do tego PR-a.

Gałąź feature została wypchnięta. Nie wykonano merge, wdrożenia, zmian na
produkcji ani zmian limitów hosta. Nie rozpoczęto kolejnego slice'a.
