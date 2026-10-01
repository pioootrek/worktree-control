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
- Dokładny końcowy SHA implementacji: `34533a7c9f4eba85cee27f91d56f1217916e7719`.
  Pierwszy commit implementacji: `486061f677001b6b3dd6e2f9992c596be986f79d`.
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
[GitHub CI dla końcowego head SHA, attempt 1](https://github.com/pioootrek/worktree-switcher/actions/runs/36897518466/attempts/1)
zakończył się błędem UI: 133 PASS, 1 FAIL. Check, build, HTTPS i integration
przeszły; E2E, pakowanie i zależne próby pakietu nie zostały wykonane.
Wszystkie cztery końcowe lokalne presety przeszły przez kolejkę na dokładnym SHA.

## Diagnoza CI i pozostały blocker

Nieudany przypadek to `test details return focus after Escape and a breakpoint
change from 390px`, w `tests/ui/detail-focus.spec.ts:10`. Panel był widoczny,
a przycisk `Jump to log` miał fokus. Po pojedynczym `Escape` asercja w linii 28
przez 5 sekund i 14 odczytów widziała dialog z `data-state="open"`.
Awaria nastąpiła przed sprawdzaniem powrotu fokusu i zmianą breakpointu;
nie jest błędem końcowej animacji ukrycia panelu ze stanem `closed`.

Porównanie z bazą `c5c49e2` nie wykazuje zmian w `src/app`, `src/features`,
`src/components`, `src/shared`, `tests/ui` ani `playwright.config.ts`.
Fixture ładuje statyczny dashboard i podstawia odpowiedzi przeglądarki;
ten przypadek nie uruchamia SQLite ani restore. Zaliczenie tego samego testu
w lokalnej kolejce na `34533a7` nie ustala przyczyny różnicy środowisk.

Hipoteza do ukierunkowanego sprawdzenia: wyścig gotowości warstwy Radix
obsługującej Escape przy przejściu z mobilnej nawigacji do szczegółów.
`openSection()` zamyka nawigację i od razu pozwala otworzyć szczegóły przez
fokus/Enter. Nie czeka na demontaż poprzedniego Sheet. `ProjectNavigation`
ustawia `openMobile=false`, ale Sheet pozostaje podczas animacji wyjścia,
a jego `onCloseAutoFocus` przywraca fokus triggerowi. W zainstalowanym
`@radix-ui/react-dismissable-layer` 1.1.19 rejestracja warstwy, aktualizacja
stosu warstw i instalacja listenera Escape odbywają się w osobnych
efektach; listener dostaje wyłącznie najwyższa warstwa. Sam fokus przycisku
nie potwierdza gotowości tego listenera. Jest to mechanizm możliwego wyścigu,
nie potwierdzona przyczyna tego konkretnego przebiegu.

Nie można rozstrzygnąć hipotezy z dostępnego logu. GitHub API zwróciło zero
artefaktów; wskazane w logu screenshot, `error-context.md` i `trace.zip`
nie zostały opublikowane. Workflow `verify.yml` wysyła w tym jobie tylko
pakiet po udanej weryfikacji, bez publikacji diagnostyki Playwright po błędzie.
Nie dopisano retry, opóźnień ani zmian UI, które maskowałyby brak diagnozy.

Attempt 2 został zlecony przed otrzymaniem polecenia wstrzymania ponowień,
następnie anulowany; stan terminalny to `cancelled`, podczas `pnpm check`.
Nie jest wynikiem zaliczonej weryfikacji. Po poleceniu nie rozpoczęto nowych
pełnych przebiegów ani zmian restore. Udostępnione presety kolejki nie mają
wariantu ograniczonego do `detail-focus.spec.ts`; nie obchodzono kolejki.

Handoff: implementacja i dokumentacja S3b są przygotowane do oceny, ale
pozostaje blocker CI dla `detail-focus.spec.ts:28`. Przed następnym pełnym
ponowieniem potrzebna jest ukierunkowana próba mobilnego przypadku z zapisem
zdarzeń keydown, gotowości najwyższej warstwy i czasu demontażu nawigacji,
oraz zachowany trace błędu. Dopiero ten materiał rozstrzygnie wyścig
listenera lub wskaże inną przyczynę. Pełnego CI na końcowym SHA nie zaliczono.

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
