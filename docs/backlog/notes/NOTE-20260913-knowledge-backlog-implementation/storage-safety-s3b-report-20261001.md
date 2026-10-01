# S3b — odzyskiwalne odtworzenie SQLite

Data: 2026-10-01. Zadanie: `RWK-20260928-sqlite-data-safety`.
Zakres: wyłącznie S3b z [planu](storage-safety-implementation-plan.md).

## Rewizja i punkt startowy

- GitHub potwierdził merge [PR #70](https://github.com/pioootrek/worktree-switcher/pull/70)
  o 15:37:15 UTC; merge SHA: `c5c49e2a6bcfd0a15db533b8acfa31d042666222`.
- Gałąź `feat/sqlite-recoverable-restore` powstała z pobranego, aktualnego
  `origin/main`, w osobnym worktree
  `/home/pioootrek/development/worktree-switcher-worktrees/sqlite-recoverable-restore`.
- Przed implementacją przeczytano AGENTS, plan, architekturę, backlog i raport S3a.
  [Stany i zachowanie po awarii](storage-safety-s3b-protocol.md) zapisano na
  `main` w commicie `0241440`, przed commitem implementacji.
- Dokładny SHA implementacji: `486061f677001b6b3dd6e2f9992c596be986f79d`.
- PR do `main`: [PR #71](https://github.com/pioootrek/worktree-switcher/pull/71).
- Raport i dowody są osobnym zapisem dokumentacyjnym na `main`.
  Wyniki poniżej dotyczą SHA kodu, nie późniejszego commita dokumentacji.

## Wynik implementacji

Walidacja rozpoznaje wyłącznie manifest formatu 1 i wspierany schemat 1–28.
Odrzuca obce pola, nieprawidłowe typy i ścieżki, powtórzone klucze JSON,
duplikaty obiektów, symlinki, niedozwolone hardlinki, pliki specjalne oraz
brakujące i nadmiarowe pliki. Sprawdza rozmiary i SHA-256 strumieniowo,
dokładny zbiór załączników względem SQLite, rozpoznany schemat, integralność,
FK i istniejące reguły domenowe. Prywatny staging musi należeć do bieżącego
UID i mieć prywatne pliki oraz katalogi.

Limity: manifest 8 MiB, dziennik 16 MiB, pojedynczy plik 64 GiB, komplet
128 GiB, 50 000 zadeklarowanych obiektów, 100 000 wpisów poprzedniego drzewa,
głębokość starego drzewa 8, zagnieżdżenie JSON 32, 1024 obiekty schematu.
Wyniki integrity/FK są ograniczone do pierwszego błędu. Kontrola wolnego
miejsca wymaga rozmiaru kopii plus 16 MiB rezerwy; błędy rzeczywistych zapisów
i fsync nadal zatrzymują operację.

Źródło nigdy nie jest otwierane w SQLite. Zweryfikowane bajty są kopiowane
do prywatnego stagingu i tam normalizowane do `journal_mode=DELETE`.
Dopuszczona zgodność z historycznymi kopiami S3a obejmuje pusty WAL
i ograniczony, pomocniczy SHM. Niepusty WAL, samotny SHM i rollback journal
w kopii są odrzucane. Oryginalne bajty i manifest kopii pozostają zachowane;
dziennik rozróżnia hash źródłowego manifestu i manifest znormalizowanej kopii.
Tworzenie nowych kopii również utrwala samodzielną bazę, obiekty, manifest
i katalog publikacji.

Dziennik `<database>.restore/journal.json` jest poza podmienianą bazą.
Ma wersję, checksum, identyfikator operacji, aktora, tożsamości plików i licznik
ośmiu kroków. Każdy rename poprzedza trwała intencja:
zapis prywatnego pliku → fsync pliku → rename dziennika → fsync katalogu.
Po rename danych synchronizowane są katalogi źródła i celu; dopiero potem
utrwalany jest wynik kroku. Błąd synchronizacji jest błędem restore.

| Stan | Recovery po przerwaniu |
| --- | --- |
| Przygotowanie, przed publikacją dziennika | Stary komplet aktywny; nieopublikowany staging nie uprawnia do podmiany. |
| `prepared` | Ponowna kontrola całego kandydata, rozpoczęcie zabezpieczania starego kompletu. |
| `securing_previous` | Dokończenie sześciu przeniesień: DB, WAL, SHM, rollback journal, initializing, załączniki. |
| `previous_secured` | Instalacja nowej bazy. |
| `database_installed` | Instalacja nowego magazynu załączników; brak zwykłego otwarcia mieszanej generacji. |
| `attachments_installed` | Kontrola całego nowego kompletu przed zatwierdzeniem. |
| `verified` | Zwykłe otwarcie; kolejne recovery nie odtwarza kopii ponad późniejszymi zapisami. |
| Nieczytelny dziennik albo sprzeczna tożsamość/materiał | Odmowa startu i instrukcja zachowania materiału do izolowanego odzyskania. |

Po rename bez wyniku w dzienniku recovery rozpoznaje docelowe device/inode/hash,
ponawia fsync i zapisuje wynik. Nie zgaduje przy sprzecznych lokalizacjach.
Recovery uruchamia wspólne przejęcie kanonicznej własności bazy, pod
`owner.lock`, przed utworzeniem zwykłego połączenia SQLite. Nie powstała
druga mapa locków ani połączenie do aktywnej bazy.

Poprzedni komplet zostaje w `previous/`, również po `verified`.
Następny restore archiwizuje zakończony dziennik i poprzedni komplet pod
identyfikatorem operacji. Zachowane są także stare orphan objects i znane
przerwane aliasy publikacji załączników. S3b nie usuwa tych generacji.

Przed podmianą wymagany jest Linux oraz jeden wspierany lokalny filesystem:
ext-family, XFS lub Btrfs; tmpfs służy także fixture procesowym i nie zapewnia
trwałości po utracie zasilania. Rodzice celów, staging, dziennik, kwarantanna,
aktualne cele i stare drzewo muszą mieć zgodne device i mount ID.
Mount ID z deskryptora wykrywa również bind mount na tym samym urządzeniu.
Nieobsługiwane filesystemy, montowane cele i kolizje/zagnieżdżenia ścieżek
są odrzucane przed podmianą. Źródło kopii może leżeć na innym urządzeniu.

## Protokół zlecenia dla późniejszego GUI

Warstwa aplikacji przyjmuje ID kopii, klucz idempotencji oraz jawne
`replace-entire-installation`. Dostarczana przez adapter polityka musi
egzekwować uprawnienia operatora instalacji i ustawienia CLI oraz rozwiązać
ID na zaufany katalog. Nie przyjmuje ścieżki od klienta. Prywatny, sprawdzany
checksumem zapis zlecenia jest poza bazą. Admission nie podmienia danych
i może działać przy otwartym SQLite.

Executor wymaga osobnego przekazania własności: utrzymania, zatrzymania
zweryfikowanych własnych procesów oraz zamknięcia SQLite przez kontroler.
Otwarty właściciel blokuje wykonanie. Uprawnienia są sprawdzane ponownie
przy wykonaniu i odczycie statusu. Status zawiera ograniczony wynik
`requested/verified`, ID i czas, bez ścieżek. Zmiana kopii lub katalogu
po potwierdzeniu zatrzymuje wykonanie. Powtórzenie rozpoznaje także archiwalny
wynik operacji. Historia zleceń ma limit 1024; wymaga potem przeglądu operatora.

Offline CLI korzysta z tego protokołu pod istniejącym lockiem kontrolera;
jego lokalne administracyjne wywołanie stanowi potwierdzenie. Nie dodano
tras HTTP/MCP, polityki GUI, automatycznego restartu ani harmonogramów.
Orkiestracja utrzymania i rzeczywista autoryzacja adaptera web pozostają S4.

## Weryfikacja dokładnego SHA

Wszystkie polecenia uruchomiono przez kolejkę Worktree Switcher, na dokładnej
ścieżce z `list_worktrees`, według `list_test_presets`. Zadania wykonywano
kolejno. Nie uruchamiano ani nie przełączano zarządzanego serwera developerskiego.
Środowisko: Linux, Node 24.19.0, better-sqlite3 13.0.3; fixture przerwań
na ext4 w prywatnym katalogu poza `/tmp`.

| Preset | Run ID | Wynik |
| --- | --- | --- |
| `node:check` | `542c409f-e5c3-416d-9084-d232a4a6251e` | PASS: lint, typecheck, 718 Vitest / 84 pliki + 7 testów skryptów |
| `node:build` | `33671930-dee0-4ff7-a10c-2a48c30ead17` | PASS: statyczny dashboard i bundle CLI |
| `node:test:integration` | `d9faaa85-8879-4bac-a333-d1a24704339c` | PASS: 26 testów / 5 plików, fingerprint zbudowanego artefaktu |
| `node:test:ui` | `d3f51dba-41be-4fb4-96c9-f810e8528189` | PASS: 134 Chromium |

Końcowe przebiegi mają `dirty=false` na enqueue/preflight/finish,
`observed_match`, exit 0 i fazę `passed`. Surowe, ograniczone ogony
wyników oraz obserwacje Git zapisano w
[pliku dowodów](storage-safety-s3b-evidence-20261001.json), bez identyfikatorów
sesji MCP i wartości środowiska.

72 nowe testy restore obejmują rzeczywisty SIGKILL przed i po każdym
z ośmiu rename, publikację prepared, zapis verified, przerwane recovery,
powtórne recovery, pusty cel i późniejsze zapisy aplikacji. Osobno sprawdzono
trwałość intencji i kolejność fsync, uszkodzony JSON/checksum/typy dziennika,
braki i konflikty plików, niekompletną kopię, naruszenia SQLite/FK/domeny,
niebezpieczne ścieżki, zmienione bajty i prywatność stagingu.

ENOSPC/EACCES/EIO w kopiowaniu, podmianie i fsync wstrzykiwano w kontrolowanych
punktach. Rzeczywiste odmowy dostępu sprawdzono przez tryby katalogów/plików,
także w kwarantannie z późniejszym recovery. Faktycznie różne urządzenia
testowano między ext4 i tmpfs. Inny mount ID przy równym device oraz
niewspierany typ filesystemu symulowano; nie tworzono nowych mountów.

## Wcześniejsze przebiegi i ograniczenia

Przebiegi robocze miały brudne źródło. Nawet exit 0 nie oznaczał zaliczenia
kolejki. Plik dowodów zachowuje wszystkie ich run ID, rezultaty i dostępne
ogony. Jeden własny przebieg anulowano przed startem, aby zakończyć poprawki.
Nie traktowano restartu procesu jako zakończenia testu.

Naprawione błędy obejmowały lint w mocku, prywatność świeżo utworzonego
rodzica worktree, historyczne puste sidecary WAL, przechwytywanie eksportów
fs w mockach, konflikt fixture repozytorium, nazwę parametru statusu,
zbyt szeroki warunek testu fsync i typ przeciążenia `readSync`.
Zmiana trybu 0700 dotyczyła wyłącznie nowego, utworzonego w tym zadaniu
katalogu nadrzędnego worktree. Nie zmieniano hostowych limitów ani usług.

SIGKILL nie dowodzi odporności na utratę zasilania. Nie przeprowadzono
fizycznego zapełnienia dysku, awarii urządzenia, prób na rzeczywistym bind
mount/XFS/Btrfs/macOS, aktualizacji ze starego zainstalowanego artefaktu,
instalacji systemd/launchd ani testów na produkcyjnej bazie. Testy Chromium
sprawdzają istniejący eksport dashboardu, a nie przyszłe GUI restore.
Stare generacje, orphan objects i staging po SIGKILL mogą zużywać dysk;
nie ma automatycznego GC. Te granice są częścią przekazania do S4/S5.

Zadanie nadrzędne pozostaje otwarte. S3b dostarczono do przeglądu w jednym PR.
Nie scalono tego PR i nie wdrożono go na produkcję.

## Podstawa synchronizacji

Fsync pliku nie utrwala automatycznie wpisu katalogu; rename nie zastępuje
synchronizacji katalogów. Zastosowana kolejność wynika z dokumentacji
[fsync](https://man7.org/linux/man-pages/man2/fsync.2.html) i
[rename](https://man7.org/linux/man-pages/man2/rename.2.html).
Kopia SQLite wykorzystuje istniejący
[Backup API](https://www.sqlite.org/backup.html); normalizacja odbywa się
wyłącznie na własnej kopii.
