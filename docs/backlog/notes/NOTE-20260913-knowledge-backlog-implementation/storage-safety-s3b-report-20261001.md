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
- Dokładny końcowy SHA implementacji z poprawką UI: `99f53b69441a33617abacd6cbca8516e1632c9d9`.
  Rdzeń restore zamknięto wcześniej na `34533a7c9f4eba85cee27f91d56f1217916e7719`.
  Pierwszy commit implementacji: `486061f677001b6b3dd6e2f9992c596be986f79d`.
- Scalony do `main`: [PR #71](https://github.com/pioootrek/worktree-switcher/pull/71).
  Merge SHA: `42859c9d34db15b060e2f553c5e75a55af8c1175`, czas: 2026-10-01T18:42:22Z. S3b zamknięte; bez wdrożenia produkcyjnego.
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

## Weryfikacja rdzenia restore przed poprawką UI

Wszystkie polecenia uruchomiono przez kolejkę Worktree Switcher, na dokładnej
ścieżce z `list_worktrees`, według `list_test_presets`. Zadania wykonywano
kolejno. Nie uruchamiano ani nie przełączano zarządzanego serwera developerskiego.
Środowisko: Linux, Node 24.19.0, better-sqlite3 13.0.3; fixture przerwań
na ext4 w prywatnym katalogu poza `/tmp`.

| Preset | SHA | Run ID | Wynik |
| --- | --- | --- | --- |
| `node:check` | `34533a7` | `6248bf80-5eec-467d-a047-6889e52078d7` | PASS: lint, typecheck, 722 Vitest / 84 pliki + 7 testów skryptów |
| `node:build` | `34533a7` | `c7911158-bc7c-4084-9681-6844411e9cde` | PASS: statyczny dashboard i bundle CLI |
| `node:test:integration` | `34533a7` | `41f58ce4-d18a-4a7e-bfab-b18c079223f0` | PASS: 26 testów / 5 plików, fingerprint zbudowanego artefaktu |
| `node:test:ui` | `34533a7` | `528eeef3-81b8-4a3f-a171-060b0cfe6f99` | PASS: 134 Chromium, w tym mobilny `detail-focus.spec.ts` |

Przebiegi w tabeli mają `dirty=false` na enqueue/preflight/finish,
`observed_match`, exit 0 i fazę `passed`. Surowe, ograniczone ogony
wyników oraz obserwacje Git zapisano w
[pliku dowodów](storage-safety-s3b-evidence-20261001.json), bez identyfikatorów
sesji MCP i wartości środowiska.

76 nowych testów restore obejmują rzeczywisty SIGKILL przed i po każdym
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

## Domknięcie synchronizacji i wyników zleceń

`0da67ea` usuwa założenie, że `/tmp` musi być na innym urządzeniu niż repo:
fixture wybiera istniejący alternatywny mount spośród `/dev/shm` i `/tmp`.
Nie tworzy mountów ani nie zmienia hosta. Pierwszy GitHub CI na `486061f`
([run 36892991060](https://github.com/pioootrek/worktree-switcher/actions/runs/36892991060))
wykrył właśnie to założenie; 717 testów przeszło, ten jeden nie.

`ae32054` utrwala wpisy nowych prywatnych katalogów w ich rodzicach.
Odmowa fsync usuwa wyłącznie własny, nadal pusty katalog i zatrzymuje operację.
`30f0dd3` przed intencją podmiany synchronizuje obie ścieżki rodziców celów
do wspólnego przodka, również gdy katalogi pozostały po przerwanym mkdir.
Dwa warianty testu odmowy fsync potwierdzają brak podmiany i poprawne ponowienie.

`856072c` ponawia fsync katalogu dziennika i jego rodzica przy recovery
stanu `verified`. Znacznik mógł być widoczny po rename, zanim proces zakończył
fsync. Nie porównuje przy tym bazy ze starym hashem ani nie cofa późniejszych
zapisów. Odmowa ponownego fsync blokuje otwarcie i zwalnia owner.lock.

`4f70957` wiąże publiczny status `verified` z potwierdzeniem executora,
a nie samą widocznością znacznika dziennika. Brakujące potwierdzenie pozostaje
`requested`; ponowienie executora pod lockiem odczytuje także archiwalny wynik,
naprawia potwierdzenie i nie wykonuje kolejnej podmiany.
`34533a7` ponawia fsync katalogu zleceń i jego rodzica przed przyjęciem
powtórzenia lub wykonaniem. Błąd publikacji zlecenia nie pozwala podmienić
aktywnych danych; po naprawie pozostaje ten sam operationId.

Roboczy clean-source check na `4f70957` miał jeden błąd starszej asercji,
która oczekiwała `verified` przed naprawą potwierdzenia. To samo wykrył
[GitHub CI 36896917586](https://github.com/pioootrek/worktree-switcher/actions/runs/36896917586).
Asercję dostosowano do jawnego potwierdzenia executora; test nadal sprawdza
archiwalny wynik i zachowanie późniejszych zapisów. Końcowy check ma 722 PASS.

Pełny [GitHub CI na zgłoszonym head SHA `0da67ea`](https://github.com/pioootrek/worktree-switcher/actions/runs/36893537050)
przeszedł check/build/HTTPS/integration/UI/E2E, smoke pakietu na Node 22.23.2
oraz 24.21.0 i lifecycle systemd na disposable runnerze.
To dodatkowy wynik wcześniejszej rewizji, nie dowód starego artefaktu ani
wdrożenia na tym hoście. Workflow PR korzysta z syntetycznego merge checkout.
Późniejsze przebiegi CI anulowane przez kolejne commity nie są zaliczone.
[Historyczny GitHub CI dla `34533a7`, attempt 1](https://github.com/pioootrek/worktree-switcher/actions/runs/36897518466/attempts/1)
zakończył się błędem UI: 133 PASS, 1 FAIL. Check, build, HTTPS i integration
przeszły; E2E, pakowanie i zależne próby pakietu nie zostały wykonane.
Wszystkie cztery lokalne presety w powyższej tabeli przeszły na `34533a7`.
Wyniki końcowego `99f53b6` po poprawce UI są zapisane poniżej.

## Diagnoza i usunięcie blokady CI

CI `36897518466`, attempt 1, zatrzymało się na mobilnym teście Escape:
szczegóły pozostawały otwarte po naciśnięciu klawisza. Attempt 2 anulowano
po poleceniu właściciela; nie jest zaliczonym wynikiem. Stary workflow nie
opublikował trace, więc dokładnej sekwencji tamtego przebiegu nie da się
potwierdzić. Późniejsza lokalna diagnoza odtworzyła odpowiadający mu mechanizm.

Mobilna nawigacja pozostawała zamontowana podczas animacji wyjścia. Szczegóły
otrzymywały autofocus, zanim Radix przeniósł listener Escape na nową najwyższą
warstwę. Rzeczywisty klawisz Playwright wysłany w tym oknie trafiał do starej
nawigacji i pozostawiał szczegóły otwarte. W reprezentatywnym śladzie Escape
nastąpił po 797,0 ms, a listener szczegółów pojawił się dopiero po 807,2 ms.

Próby diagnostyczne przez kolejkę, na syntetycznym statycznym dashboardzie:

| Próba | Wynik przeglądarki |
| --- | --- |
| Oryginalny test bez zmian, 20 powtórzeń | 20 PASS |
| Instrumentacja, CPU rates 1 i 6 | 16 PASS |
| Rzeczywisty Escape natychmiast po autofocus | 5 FAIL |
| Escape po gotowości listenera | 5 PASS |
| Otwarcie szczegółów po demontażu nawigacji | 5 PASS |

Te robocze przebiegi miały brudne źródło; wyniki procesu diagnozują mechanizm,
ale nie certyfikują czystego commita. Ślady pozostają lokalnie w
`/tmp/wts-escape-diagnosis-20261001/`; trwałe podsumowanie jest w tym raporcie.

Commit `99f53b6` demontuje zawartość mobilnej nawigacji od razu po zamknięciu.
Usuwa jej animację wyjścia; animacja otwierania zostaje. Nie dodaje globalnego
handlera klawiatury ani opóźnień. Deterministyczny test regresyjny wysyła DOM
keydown Escape synchronicznie przy autofocus, aby czas transmisji sterownika
nie ukrywał wyścigu. Dotychczasowe testy rzeczywistej klawiatury, powrotu fokusu
i zmiany breakpointu pozostają. Dodano preset `test:ui:detail-focus` i upload
`test-results/` po błędzie CI z retencją siedmiu dni.

Regresja przed poprawką: run `21d24d0c-52d0-4b6b-bebb-7b7435af8a0a`, exit 1,
1 FAIL + 9 PASS. Po poprawce: `84f5eaae-4d80-4254-b29a-992b487932ac`, exit 0,
10 PASS. Oba wyniki są robocze; pierwszy ma także zmianę źródła podczas biegu
(edycja workflow, nie kodu przeglądarki). Nie przedstawiamy ich jako czystych
zaliczeń kolejki. Roboczy build początkowo wykrył błąd typu przy rzutowaniu
Window w regresji; po korekcie build przeszedł (`f63cb374-e4df-4319-8bba-aaf5a2611822`).

## Końcowa weryfikacja i zamknięcie S3b

- Dokładny czysty head `99f53b69441a33617abacd6cbca8516e1632c9d9`: kolejka `node:check`, run
  `b0e33349-7e32-4cf6-85bd-0fe39d3130f4`, `passed`, exit 0,
  `observed_match`; lint, typy, 722 Vitest (76 restore) i 7 testów skryptów.
- [Pełny CI dla tego head](https://github.com/pioootrek/worktree-switcher/actions/runs/36907715558): PASS — check, build, HTTPS,
  integracja (26), Chromium UI (135), E2E, pakowanie, smoke Node 22.23.2
  i 24.21.0 oraz lifecycle systemd na jednorazowym runnerze.
  Workflow PR testuje syntetyczny merge checkout; nie utożsamiamy go z
  lokalnym dokładnym SHA. Nie wykonywano ponownego pełnego lokalnego zestawu,
  ponieważ CI zweryfikowało końcowy build i przepływy przeglądarkowe.
- PR #71 scalono jako `42859c9d34db15b060e2f553c5e75a55af8c1175`. Nie pozostały otwarte wątki review.
  Dokumentacja i backlog są oddzielną aktualizacją na `main`.

Poprzednia blokada CI jest usunięta. Kolejny slice to S4a: polityka CLI,
opcjonalny harmonogram usługi, retencja i operacje GUI operatora. Niezależne
harmonogramy użytkowników pozostają S4u; odbiór operacyjny S5. Automatyczne
backupy pozostają domyślnie wyłączone. Produkcji nie wdrażano.

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
instalacji systemd/launchd na tym hoście ani testów na produkcyjnej bazie. Testy Chromium
sprawdzają istniejący eksport dashboardu, a nie przyszłe GUI restore.
Stare generacje, orphan objects i staging po SIGKILL mogą zużywać dysk;
nie ma automatycznego GC. Te granice są częścią przekazania do S4/S5.

Zadanie nadrzędne pozostaje otwarte na S4/S5. S3b scalono w PR #71.
Nie wdrożono go na produkcję.

## Podstawa synchronizacji

Fsync pliku nie utrwala automatycznie wpisu katalogu; rename nie zastępuje
synchronizacji katalogów. Zastosowana kolejność wynika z dokumentacji
[fsync](https://man7.org/linux/man-pages/man2/fsync.2.html) i
[rename](https://man7.org/linux/man-pages/man2/rename.2.html).
Kopia SQLite wykorzystuje istniejący
[Backup API](https://www.sqlite.org/backup.html); normalizacja odbywa się
wyłącznie na własnej kopii.
