# Plan domknięcia bezpieczeństwa danych SQLite

Aktualizacja: 2026-10-03. Status: S1–S3, S4a, S4u, S4b i S5a scalone;
S5b i S5c pozostają do wykonania.
Stan realizacji jest poniżej; pierwotna diagnoza zachowana jako punkt odniesienia.
Zadanie: [RWK-20260928-sqlite-data-safety](../../rework/RWK-20260928-sqlite-data-safety.json).
Kod sprawdzony przy tworzeniu planu: `6a9df6e0879b4b9ad69969b1cc4b5bd4264a363c`.
[Ocena z 28 września](storage-safety-assessment-20260928.md) pozostaje
historycznym punktem odniesienia. Powiązane prace:
[migracja wiedzy](implementation-plan.md) i
[aktualizacja pakietu](../NOTE-20260908-portable-verification-plan/controller-package-trial.md).

## Stan realizacji po scaleniu S5a — 2026-10-03

S1a/S2a, S1b/S2b, S3a i S3b są na `main` przez PR #68–#71.
S3b zamknięto w `42859c9d34db15b060e2f553c5e75a55af8c1175` po poprawce mobilnego Escape i zielonym CI.
[Raport S3b](storage-safety-s3b-report-20261001.md) rozdziela końcowe wyniki,
wcześniejsze próby oraz niezweryfikowaną utratę zasilania i upgrade starego artefaktu.
S4a scalono w [PR #72](https://github.com/pioootrek/worktree-switcher/pull/72)
jako `0c2f187a2865549ce73b3ad79e8be84b4ebf55f4`. Końcowy head:
`4914ef90e807aa8b3afe54309fc6b66a5c6fe297`. Zakres obejmuje opcjonalne
operacyjne backupy, politykę CLI, harmonogram usługi, retencję i GUI operatora
z kontrolowanym restore S3b oraz poprawką ponownego otwierania panelu po
braku receipt zlecenia. [Raport S4a](storage-safety-s4a-report-20261001.md)
rozdziela lokalne wyniki dla kodu aplikacji od końcowego CI `36998292347`:
782 Vitest, 7 testów skryptów, build, HTTPS, 30 integracyjnych, 149 UI,
3 E2E, smoke pakietu Node 22/24 i lifecycle na jednorazowym runnerze.
Przyczyna wcześniejszych timeoutów pozostaje nieustalona; dodano diagnostykę
bez zmiany timeoutów, asercji ani retry.

S4u scalono w [PR #73](https://github.com/pioootrek/worktree-switcher/pull/73)
jako `1f9c90fff36af25d5ca609299270d51dabc70a96`, z końcowego head
`6f3db2f6a6bb82187ae472e8d39b0d18d9907cb4`. Oba lokalne wątki agentów
weszły do tego PR-a. Niezależna polityka CLI domyślnie wyłącza harmonogramy
użytkowników; GUI/API zarządza własnymi harmonogramami eksportu
`knowledge-discussions` w jej granicach. Wspólny executor zachowuje priorytet
backupów usługi, a zewnętrzne wersje, terminy i klucze nie cofają się z SQLite.

Domknięcie obejmuje ograniczoną historię czterech potwierdzeń na harmonogram,
bez ponownego wykonania wygasłych żądań, oraz jawne odzyskiwanie miejsca przez
operatora. Zweryfikowane eksporty, także staging po przerwaniu i udane kopie,
można usunąć przez prywatne CLI po podglądzie i potwierdzeniu. Nieznane lub
niebezpieczne pliki pozostają; niepewne operacje zachowują obciążenie quota.
Usunięcie ostatniej udanej kopii wymaga jawnego potwierdzenia operatora.

[Raport domknięcia](storage-safety-s4u-closeout-20261003.md) zawiera wyniki,
review i ograniczenia. Końcowe CI `37117584381`: 890 Vitest + 7 skryptów,
build/HTTPS, 33 integracyjne, 166 UI, 3 E2E, smoke pakietu Node 22/24
oraz lifecycle systemd na jednorazowym runnerze. Review n8n: dwie nowe uwagi
Claude naprawiono, Codex nie znalazł nowych problemów w końcowym commicie,
zero nierozwiązanych wątków. Kimi przekroczył limit 20 minut i nie opublikował
wyniku; tego przebiegu nie zaliczono jako ukończonego review.

S4b scalono w [PR #74](https://github.com/pioootrek/worktree-switcher/pull/74)
jako `963b011aa2bc5b5c04b90a33dcb1005246173992`, z head `04f4d01`.
Opcjonalny transfer restic HTTPS REST jest domyślnie wyłączony, sterowany tylko
CLI i współdzieli wykonanie backupów. Trwałe potwierdzenia, ograniczone próby,
ochrona oczekujących źródeł i weryfikacja kompletnego drzewa przeszły testy.
Izolowane odzyskanie po usunięciu źródła przywróciło zadanie, token i załącznik;
nie jest to pomiar utraty prawdziwego hosta. [Raport S4b](storage-safety-s4b-report-20261003.md)
zawiera dowody, review n8n i zielone CI `37124183610` (921 Vitest + 7 skryptów,
33 integracje, 166 UI, 3 E2E, smoke Node 22/24 i lifecycle). Dwa testy restic
przeszły osobno w kolejce MCP; CI bez binariów fixture je pomija.

S5a scalono w [PR #75](https://github.com/pioootrek/worktree-switcher/pull/75)
jako `4bebff93956a2bd8a0ed664845f76fdc57850b3d`. Opcjonalny monitor CLI odczytuje
ograniczone metadane poza procesem kontrolera, rozróżnia wiek danych lokalnych
oraz zdalnych i zwraca jednoznaczne kody błędów. [Raport S5a](storage-safety-s5a-report-20261003.md)
zawiera końcowe testy, review i CI. Monitor nie potwierdza dostępności repozytorium
ani zdolności odtworzenia na podstawie samych metadanych.

S5b realizuje [kontrakt zmiany repozytorium i uzgadniania historii](storage-safety-s5b-contract-20261003.md).
S5c obejmie aktualizację zainstalowanych artefaktów, izolowane awarie i recovery
oraz procedurę S6. Docelowy host, klucze, wdrożenie monitora i powiadomień,
rzeczywisty pomiar RPO/RTO i rollout pozostają osobnym etapem zgodnie z wyborem
właściciela. Zadanie nadrzędne pozostaje otwarte. Backupy są opcjonalne i domyślnie
wyłączone; produkcja nie została zmieniona.

## Historyczny punkt startowy — przed S1

| Obszar | Kod w punkcie startowym i znaczenie dla planu |
| --- | --- |
| Kopia przed aktualizacją | `src/cli/backup-management.ts` tworzy `SqliteStateStore` przed backupem. Konstruktor uruchamia migracje. Samo wywołanie nowego CLI nie zapewnia więc kopii starego schematu. |
| Wersja schematu | `src/server/infrastructure/sqlite/migrations.ts` kończy się migracją 27. Restore ma osobny limit `actual > 27`; normalne otwarcie nie ma równoważnej odmowy przed DDL. Ocena z września opisywała schemat 26. |
| Trwałość | Adapter ustawia WAL, FK i `busy_timeout`, ale nie `synchronous`. Upload, importy i fizyczny backup nie mają wspólnego protokołu synchronizacji plików i katalogów. |
| Fizyczny backup | `src/server/controller-backup.ts` używa Backup API i kopiuje załączniki wskazane przez migawkę. Zakłada istnienie `knowledge_attachments`; trzeba obsłużyć wspierane starsze schematy. |
| Odtwarzanie | Restore sprawdza hash i `integrity_check`, lecz nie waliduje manifestu schematem ani nie wykonuje `foreign_key_check`. Kolejne podmiany plików nie mają trwałego dziennika recovery. |
| Własność | `controller-lock.ts` blokuje katalog stanu; `paths.ts` pozwala niezależnie wskazać katalog bazy. Trzeba zamknąć przypadek tej samej bazy i różnych katalogów stanu. |
| Produkcja | Diagnostyka usługi wskazała pakiet `0.1.0-trial.1` w wydaniu `a727fd8`, podczas gdy checkout ma `6a9df6e`. Nie odczytywano produkcyjnej bazy ani jej efektywnych PRAGMA; wersji schematu produkcji nie ustalono. |

Przegląd kodu i status usługi nie są testem odtwarzania. Nie uruchomiono
backupu, migracji, wdrożenia ani zmiany usług produkcyjnych.

## Cel i zakres

Przygotować Switchera do utrzymywania backloga, dyskusji i pamięci jako jedynego
źródła zapisu w SQLite. Aktualizacja, backup i odtwarzanie mają zachowywać dane
oraz jasno odmawiać działania, gdy ich bezpieczeństwa nie da się potwierdzić.

Zostają jeden kontroler, lokalny SQLite, obecne API i osobny magazyn załączników.
Nie wprowadzamy PostgreSQL ani ORM w ramach tej pracy. Eksport do plików służy
przenoszeniu danych i odczytowi, nie równoległej edycji. Dokumenty związane
z wersją kodu i AGENTS.md pozostają w Git.

Plan obejmuje utratę procesu, przerwaną aktualizację, uszkodzenie kopii,
błędną operację i utratę hosta. Backup zawiera również konfigurację i dane
uwierzytelniania, dlatego jego ochrona jest częścią zakresu. Etapy S1–S5
przygotowują oprogramowanie i dowody odbioru; S6 opisuje późniejsze
przełączenie wskazanego projektu. Wdrożenie produkcyjne ma osobną procedurę
poniżej i nie wymaga wcześniejszego przeniesienia backloga z Git.

## Opcjonalność i konfiguracja

Wymaganie właściciela z 2026-10-01: backup ma być opcjonalny i konfigurowalny.
Nowa instalacja ma wszystkie automatyczne kopie wyłączone. Aktualizacja
zachowuje wcześniejszy wybór; brak konfiguracji nie włącza backupów.
Kontroler działa i wykonuje wspierane migracje bez skonfigurowanego backupu.
Ręczne zlecenie kopii uruchamia tylko tę operację, bez włączania harmonogramu.

| Ustawienie | Zachowanie |
| --- | --- |
| Harmonogram usługi | Domyślnie wyłączony; operator definiuje częstotliwość i katalog docelowy przez CLI |
| Harmonogram użytkownika | Osobny, domyślnie wyłączony; użytkownik ustawia go w GUI, jeśli operator dopuści tę funkcję i jej zakres |
| Wymagana kopia przed migracją | Domyślnie wyłączona; po włączeniu kopia musi się udać przed zmianą schematu |
| Kopia przed dużym importem | Osobna opcja, domyślnie wyłączona; po włączeniu nieudana kopia zatrzymuje import |
| Kopia zewnętrzna | Osobna opcja, domyślnie wyłączona; lokalny backup nie wymaga VPS-a, konta w chmurze ani klucza transferu |
| Retencja i limity | Konfigurowalny czas/liczba kopii, ochrona wskazanych punktów, budżet dysku i czas wykonania |
| Powiadomienia i cele odzyskiwania | Konfigurowalne dla włączonych funkcji; wyłączona funkcja ma stan „wyłączone”, bez alarmu o zaległej kopii |

Konfiguracją usługi i nadrzędnymi limitami zarządza operator wyłącznie przez parametry CLI
uruchamiające kontroler lub instalujące usługę. Argumenty są zachowane
w konfiguracji uruchomienia usługi, poza ustawieniami edytowalnymi przez web.
Zmiana polityki wymaga zastosowania nowych parametrów uruchomienia; GUI,
HTTP API i MCP nie mają operacji zmieniającej harmonogram usługi, jej cele,
retencję, limity ani dostępność akcji. Dodatkowe harmonogramy użytkowników
opisane poniżej są osobną konfiguracją. Przywrócona baza nie nadpisuje
polityki uruchomienia usługi.
Walidacja parametrów następuje przed otwarciem bazy i zmianą konfiguracji usługi;
błędne argumenty nie powodują cichego użycia innego trybu.

Poniższa tabela zachowuje propozycje z pierwotnego planu, w tym flagi przyszłych
slice'ów. Faktyczny kontrakt S4a (`--backup-interval-seconds`, oddzielne
`--backup-retain-count`/`--backup-retain-days` i limity) jest opisany w
[raporcie S4a](storage-safety-s4a-report-20261001.md) i README. Nie należy
traktować pozostałych propozycji jako istniejących poleceń:

| Parametr CLI | Znaczenie |
| --- | --- |
| `--backup-dir` | Dozwolony katalog kopii; samo wskazanie nie włącza harmonogramu |
| `--backup-interval` | Jawne włączenie kopii okresowych; brak parametru oznacza wyłączony harmonogram |
| `--backup-before-migration`, `--backup-before-import` | Niezależne włączenie wymaganej kopii przed daną operacją |
| `--backup-retention`, `--backup-max-bytes` | Retencja oraz budżet miejsca dla kopii |
| `--backup-transfer-config` | Jawne włączenie transferu przez wskazany prywatny plik konfiguracji; sekretów nie podajemy jako argumentów procesu |
| `--backup-ui-actions` | Polityka serwera dopuszczająca `create`, `restore` lub obie akcje operatora; domyślnie brak akcji |
| `--backup-user-schedules` | Dopuszczenie dodatkowych harmonogramów użytkowników; domyślnie wyłączone, niezależne od harmonogramu usługi |
| Limity harmonogramów użytkowników | Osobne parametry CLI określą minimalny odstęp, maksymalną liczbę harmonogramów, budżet miejsca, zakres danych i dozwolone cele |

Wyłączenie danego harmonogramu nie usuwa istniejących kopii ani nie uruchamia
jego retencji. Nie wyłącza też pozostałych harmonogramów.
Przy stosowaniu nowych parametrów zakończyć lub bezpiecznie przerwać aktywną
kopię według zasad zamykania kontrolera; nie raportować przerwanej jako gotowej.
Sekrety transferu nie trafiają do odpowiedzi API ani diagnostyki argumentów.

### Dodatkowy harmonogram w „user space”

Doprecyzowanie właściciela: obok harmonogramu usługi może działać niezależny
harmonogram użytkownika. „User space” oznacza tutaj ustawienia w aplikacji,
a nie drugi proces kontrolera ani osobny timer systemd.

| Właściwość | Usługa | Użytkownik |
| --- | --- | --- |
| Źródło konfiguracji | Argumenty CLI/definicja uruchomienia | Osobny rekord w bazie, edytowany przez uprawnionego użytkownika w GUI/API |
| Własność | Operator wdrożenia | Konkretny principal i zakres projektu/organizacji |
| Terminy i retencja | Ustalone przez operatora | Własne, ograniczone polityką operatora |
| Włączenie/wyłączenie | Przez CLI | Przez GUI, bez wpływu na harmonogram usługi |
| Cel | Operator wskazuje dozwolone miejsce | Użytkownik wybiera udostępniony cel po ID, bez ścieżek i własnych poświadczeń infrastruktury |
| Wykonanie | Wspólna kolejka i limit zasobów | Ta sama kolejka i limit zasobów |

Rekord użytkownika zawiera ID, właściciela, zakres danych, włączenie,
częstotliwość lub termin ze strefą czasową, ID celu, retencję, wersję konfiguracji
oraz ostatni/następny termin. Każda zmiana i każde wykonanie ponownie sprawdzają
politykę CLI oraz aktualne granty. Wyłączenie harmonogramu usługi nie zatrzymuje
harmonogramów użytkowników; operator może oddzielnie wyłączyć całą funkcję
harmonogramów użytkowników. Usunięcie użytkownika lub odebranie dostępu blokuje
nowe wykonania, bez usuwania kopii innych właścicieli.

Harmonogram użytkownika nie zmienia wymagania kopii przed migracją, ustawień
transferu, globalnych limitów ani retencji usługi. Po odtworzeniu bazy historyczne
harmonogramy przechodzą ponowną walidację przed wznowieniem. Nie odtwarzamy
starych parametrów uruchomienia i nie wykonujemy wszystkich zaległych terminów.

W SaaS zwykły użytkownik może planować tylko kopię logiczną dozwolonego projektu
lub zakresu danych. Wykorzystujemy istniejące operacje eksportu projektu po
sprawdzeniu ich zakresu; pełna migawka SQLite pozostaje wyłącznie dla operatora.
Grant do projektu nie uprawnia do dołączenia całej bazy, sekretów instalacji
ani danych innych klientów. Jeśli bezpieczna kopia danego zakresu nie jest
zaimplementowana, opcja pozostaje niedostępna. Własny harmonogram nie nadaje
prawa do restore; odtwarzanie zakresu klienta wymaga osobnego kontraktu.

Każda kopia zapisuje źródło (`service`, `user` lub `manual`), właściciela,
zakres i ID harmonogramu. Retencja użytkownika obejmuje tylko jego kopie;
nie usuwa kopii usługi ani kopii chronionych przed migracją. Pierwsza wersja
nie scala dwóch terminów w jeden artefakt, dzięki czemu retencja i uprawnienia
pozostają jednoznaczne. Idempotencja identyfikuje harmonogram, wersję i termin.

Gdy terminy się nakładają, kopie czekają w jednej ograniczonej kolejce.
Harmonogram usługi ma pierwszeństwo przy wyborze następnego zadania, bez
przerywania już działającego. Limity per użytkownik, łączna pojemność kolejki
i limit czasu zapobiegają blokowaniu kopii usługi przez zadania użytkowników.
Opóźnienia, pominięte terminy i odrzucenia z powodu limitów są widoczne osobno
przy każdym harmonogramie; nie są raportowane jako udany backup.

### GUI do obsługi kopii, bez edycji konfiguracji usługi

Właściciel proponuje w GUI przeglądanie, backup na żądanie i restore. Przyjmujemy
ten podział z uprawnieniami instalacji i polityką akcji ustawioną przez CLI:

| Funkcja | Kontrakt |
| --- | --- |
| Przeglądanie | Lista kopii dostępnych dla danej tożsamości, data danych, rozmiar, zgodność i wynik weryfikacji; harmonogram usługi tylko do odczytu dla operatora, bez sekretów i ścieżek infrastruktury |
| „Utwórz teraz” | Jedna kopia do celu skonfigurowanego przez operatora; nie zmienia harmonogramu. Dostępna także przy wyłączonych kopiach okresowych, jeśli CLI dopuszcza akcję i wskazuje poprawny cel |
| „Przywróć” | Wybór istniejącej kopii po identyfikatorze, sprawdzenie kompletności i zgodności, podgląd skutków oraz jawne potwierdzenie przed rozpoczęciem |
| Konfiguracja usługi | Brak edycji harmonogramu usługi i jego retencji, usuwania jego kopii, wyboru dowolnej ścieżki lub uploadu dowolnego archiwum z GUI |
| Własny harmonogram | Tworzenie, zmiana i wyłączenie dodatkowego harmonogramu oraz jego retencji w ramach uprawnień i limitów operatora; bez zmiany ustawień usługi |

GUI wywołuje wąskie operacje HTTP korzystające ze wspólnych operacji aplikacji.
Serwer sprawdza politykę CLI i uprawnienia przy każdym wywołaniu; ukryty przycisk
nie jest zabezpieczeniem. Żądanie niesie ID kopii i klucz idempotencji, nie
katalog, komendę ani poświadczenia. Edycja własnego harmonogramu ma osobny,
ściśle walidowany kontrakt opisany poniżej. Podwójny klik lub ponowienie nie uruchamia
drugiego backupu/restore. CLI nadal może jawnie zlecić operację administracyjną
w granicach uprawnień systemowych; nie jest to uprawnienie klienta SaaS.

W SaaS lista pełnych kopii oraz ich tworzenie i odtwarzanie należą wyłącznie
do operatora instalacji. Administrator klienta/organizacji nie otrzymuje tych
uprawnień. Pełny restore zmienia całą bazę, w tym inne organizacje i dostęp.
Odzyskanie pojedynczego projektu/klienta to osobny zakres, a nie filtr na
pełnym restore. Jeśli nie ma wiarygodnego rozróżnienia operatora i klienta,
akcje web pozostają wyłączone. Tryb bez uwierzytelniania nie udostępnia tych akcji.

Przed restore GUI pokazuje datę kopii, zakres całej instalacji, utratę zmian
po tej dacie i wpływ na działające serwery/testy. Najpierw trwa walidacja kopii;
po potwierdzeniu operacja przechodzi w tryb utrzymania, blokuje nowe zapisy
oraz koordynuje wygaszenie zarządzanych procesów. Podmiana wymaga zamknięcia
połączenia SQLite i zachowania wyłącznej własności. HTTP jedynie zleca trwałą
operację, nie podmienia plików otwartej bazy. Restart/przekazanie wykonania
musi mieć określony protokół przejęcia locka, identyfikację własnych procesów
i status dostępny po ponownym połączeniu klienta. Odtworzonych sesji i grantów
nie uznajemy automatycznie za aktualne. Akcje rejestrują aktora, ID kopii,
przebieg i wynik bez treści sekretów; dowód restore musi przetrwać podmianę bazy.

Błąd kopii okresowej nie zatrzymuje aplikacji. Błąd kopii przed migracją lub
importem blokuje tę operację tylko przy włączonej odpowiedniej opcji.
Wyłączone backupy nie powodują dodatkowego potwierdzenia przy każdym starcie
ani migracji. Operator widzi w statusie, że automatyczne odzyskanie
z kopii nie jest zapewnione. Własność bazy, kontrola zgodności schematu,
transakcje i trwałość zapisów obowiązują niezależnie od konfiguracji backupów.
Dziennik i kwarantanna niezbędne do dokończenia jawnie zleconego restore są
częścią poprawności tej operacji, a nie automatycznym harmonogramem kopii.

## Kolejność

| Etap | Wynik | Zależności |
| --- | --- | --- |
| S0 | Ustalony kontrakt bezpieczeństwa i odzyskiwania | Ocena istniejącego kodu |
| S1 | Wyłączny właściciel bazy, trwałe zapisy i prywatne pliki | S0 |
| S2 | Kopia przed zmianą i bezpieczny migrator | S1a dla S2a; pełne S1 dla odbioru S2 |
| S3 | Trwałe załączniki i odtwarzanie po przerwaniu | S1–S2 |
| S4 | Opcjonalne kopie, konfiguracja i procedura odzyskiwania | S2–S3 |
| S5 | Raport prób aktualizacji, awarii i odtworzenia | S1–S4 |
| S6 | Jeden projekt przełączony na jedno miejsce zapisu | S5 i odbiór funkcjonalny K7 |

Każdy etap implementacyjny powinien mieć osobny, ograniczony zakres przeglądu.
Przed rozpoczęciem odświeżyć stan kodu i ustalić aktualną gałąź docelową według
obowiązującego workflow. Historyczny plan gałęzi K0/K1 nie wyznacza automatycznie
gałęzi dla tej pracy. Raport etapu wskazuje SHA, zakres, wyniki i pozostałe braki.

Pierwszy zakres kodowania to S1a i S2a z tabeli PR-ów poniżej: wyłączna
własność, otwarcie bez migracji oraz zweryfikowana kopia starego schematu.
Automatyczny harmonogram korzysta dopiero z poprawnej operacji backupu.

## S0. Kontrakt i granice ochrony

- Zapisać macierz wspieranych aktualizacji: które wydane schematy i artefakty
  aktualizujemy, które wymagają pośredniej wersji, które odrzucamy.
- Rozróżnić awarię procesu, awarię hosta, awarię dysku, błędną operację użytkownika
  i bezpośrednią ingerencję procesu mającego dostęp do plików.
- Przygotować wybór maksymalnej utraty danych i czasu odtworzenia. Propozycja
  dla pierwszego projektu: najwyżej godzina pracy i odtworzenie do godziny;
  to wartości do uzgodnienia i zmierzenia, nie obecna gwarancja.
- Zapisać granicę dostępu agentów. Prawa plików i granty API nie izolują procesów
  tego samego użytkownika systemowego. Jeśli taka izolacja jest wymagana,
  przygotować osobny plan tożsamości usługi i dostępu wyłącznie przez API.
- Ustalić wymagania szyfrowania kopii, miejsce ich przechowywania i właściciela
  kluczy. Ochrona przed kradzieżą dysku i przed działającym agentem to różne cele.

Odbiór: zapisany kontrakt odróżnia wymagania od propozycji. Nierozstrzygnięte
parametry operacyjne nie blokują prac na izolowanych fixture, ale muszą zostać
rozstrzygnięte przed włączeniem odpowiedniej funkcji w S4. S6 dokumentuje
wybraną politykę, również gdy automatyczne kopie pozostają wyłączone.
Ochrony przed agentem tego samego UID nie wolno uznać
za wdrożoną bez osobnej granicy uprawnień i testu odmowy dostępu.

### Proponowana polityka pierwszej instalacji

Poniższe wartości tworzą przykładowy profil do dobrowolnego włączenia w pilocie.
Nie są ustawieniami domyślnymi ani wymaganiem używania aplikacji. Operator
może je zmienić przez CLI, włączyć tylko kopie lokalne albo pozostawić backupy wyłączone.

| Parametr | Propozycja | Jak sprawdzamy |
| --- | --- | --- |
| Dopuszczalna utrata danych (RPO) | Do 60 minut, również przy utracie całego hosta | Wiek danych w najnowszej kompletnej, zweryfikowanej kopii poza hostem; sam czas zakończenia uploadu nie wystarcza |
| Czas odzyskania (RTO) | Do 60 minut od rozpoczęcia procedury z gotowym hostem zastępczym i dostępem do kluczy | Zmierzone pobranie, odszyfrowanie, walidacja, restore i dostęp przez klienta; czas organizacji hosta i uzyskania dostępu raportowany osobno |
| Częstotliwość | Co 30 minut; lokalna kopia i potwierdzenie transferu łącznie do 15 minut w pilocie | Test pod reprezentatywnym obciążeniem; wolniejszy przebieg wymaga zmiany harmonogramu lub jawnej zmiany celu |
| Kopie przed zmianą | W tym profilu włączone przed migracją i dużym importem; przed restore zachowany obecny stan | Błąd kopii blokuje migrację/import tylko przy włączonej opcji; materiał uszkodzony nie jest oznaczany jako poprawny backup |
| Retencja lokalna | Ostatnie 48 kopii półgodzinnych i 7 dziennych | Zachowanie wymaganych punktów, także gdy jedna kopia należy do kilku kategorii |
| Retencja poza hostem | 48 półgodzinnych, 14 dziennych, 8 tygodniowych, 6 miesięcznych | Test granic czasu, powtórnych prób i błędu celu |
| Kopie chronione przed retencją | Kopia sprzed aktualizacji co najmniej 30 dni i do odbioru wydania; zawsze ostatnia kopia z udanym odtworzeniem | Retencja nie usuwa chronionego punktu nawet po osiągnięciu limitu miejsca |
| Próba odzyskania | Przed pierwszym wdrożeniem, po zmianie formatu/migratora i co miesiąc | Odtworzenie z kopii pobranej spoza hosta do pustej lokalizacji, sprawdzenie danych i dostępu |
| Powiadomienia | Każdy błąd; ostrzeżenie przy wieku kopii ponad 45 minut, naruszenie celu ponad 60 minut | Osobny wiek kopii lokalnej i zewnętrznej; błędny odczyt statusu nie oznacza zdrowia |

RPO liczymy konserwatywnie od początku tworzenia migawki, chyba że implementacja
potrafi dowieść późniejszego punktu danych. Czas transferu nie odmładza kopii.
Opóźnienie, wyłączony kontroler lub niedostępny cel muszą być widoczne jako
przekroczenie celu. Monitor poza procesem kontrolera wykrywa również jego brak.

Przed włączeniem transferu zewnętrznego właściciel wybiera jego cel i miejsce
odzyskania kluczy; powiadomienia konfiguruje osobno. Nasz VPS jest kandydatem na drugi
host, ale samo konto SSH używane przez agentów nie zapewnia oddzielnej ochrony
kopii. Konto przesyłające kopie powinno mieć ograniczony zakres; kasowanie
retencji i klucz odzyskiwania wymagają osobnej kontroli. Dodatkowy punkt
offline albo magazyn z wymuszoną retencją chroni przed skasowaniem obu kopii
przez przejęte konto. Wariant i koszt wymagają wyboru przed rolloutem.

Transport ma korzystać ze sprawdzonego narzędzia do szyfrowanych backupów.
Nie projektujemy własnej kryptografii. Weryfikacja SHA-256 wykrywa zmianę
bajtów, lecz nie potwierdza autentyczności manifestu zmienionego razem z nimi.
Kopia opuszcza host w postaci zaszyfrowanej i uwierzytelnionej; materiał do
jej odszyfrowania nie może istnieć wyłącznie na źródłowym hoście.

### Co obejmuje odzyskanie

| Element | Postępowanie |
| --- | --- |
| SQLite | Cała spójna migawka, w tym konfiguracja projektów i środowisk, granty, historia, polityka uwierzytelniania i stany operacji |
| Załączniki | Wszystkie obiekty wskazane przez tę migawkę, z rozmiarem i hashem |
| Manifest | Wersja formatu, schemat odczytany z migawki, wersja aplikacji i silnika, identyfikator kopii, czas rozpoczęcia/zakończenia, identyfikacja artefaktu i hashe |
| Sekrety poza bazą | Osobny zaszyfrowany pakiet odzyskiwania lub udokumentowana rotacja: legacy MCP token, konfiguracja TLS i inne wymagane pliki instalacji; test musi wskazać, co odzyskano, a co wygenerowano ponownie |
| Program i konfiguracja uruchomienia | Zachowany sprawdzony artefakt, checksum, zgodna wersja Node i instrukcja instalacji; samo `0.1.0-trial.1` nie identyfikuje rewizji |
| Stan chwilowy | Nie aktywować starych locków, socketów, PID-ów ani `service-access.json`; nie uznawać przywróconych zleceń lub claimów za działające procesy |
| Repozytoria i logi | Backup kontrolera nie zastępuje kopii repozytoriów, niezatwierdzonych zmian ani pełnych logów procesów; wykaz tych zależności należy do instrukcji odzyskania hosta |

WAL/SHM nie są osobno synchronizowaną repliką bazy. Publikowany backup powstaje
przez SQLite Backup API, zamknięcie i weryfikację kompletnej migawki. Awaryjny
materiał z zatrzymanej uszkodzonej instalacji zachowuje natomiast także jej
pliki dziennika, aby nie utracić możliwości odzyskania.

## S1. Własność bazy, trwałość i prawa plików

Obszary: `paths.ts`, `controller-lock.ts`, adapter SQLite, bootstrap kontrolera,
offline CLI, ścieżki tworzenia i odtwarzania plików.

- Powiązać wyłączną własność z kanonicznym zasobem bazy, także gdy dwa wywołania
  wskazują różne katalogi stanu. Zachować istniejący lock kontrolera i wspólną
  koordynację cyklu życia; nie tworzyć niezależnych reguł dla każdego transportu.
- Ustalić jednolitą kolejność przejmowania locków i zwalniania po błędzie.
  Testować równoczesny start, alias ścieżki i odzyskanie po niepełnym zapisie
  locka; nie usuwać go tylko dlatego, że parser nie odczytał rekordu. Odrzucać
  nieobsługiwane aliasy, np. hardlink bazy, zamiast omijać własność pliku.
- Ustawiać i odczytywać efektywne WAL, `foreign_keys=ON`, `synchronous=FULL`
  oraz limit oczekiwania na blokadę. Nie modyfikować nieobsługiwanej bazy
  przed sprawdzeniem jej wersji w S2.
- Zapewnić prywatne tworzenie katalogów i plików danych także w bezpośrednim CLI,
  bez polegania wyłącznie na masce usługi. Sprawdzać własność, symlinki i istniejące
  uprawnienia. Przy niebezpiecznej konfiguracji podać sposób naprawy.
- Diagnostyka podaje wersję biblioteki SQLite aplikacji, schemat i ustawienia,
  bez wartości danych, tokenów ani sekretów.

Odbiór: druga instancja nie otwiera tej samej bazy do operacji aplikacyjnych;
próba z innym katalogiem stanu również jest odrzucona. CLI uruchomiony z szeroką
maską tworzenia plików nie ujawnia nowej bazy, sidecarów ani kopii innym użytkownikom.
Zmierzyć opóźnienie reprezentatywnych zapisów przy FULL.

## S2. Kopia sprzed migracji i kontrolowane aktualizacje

Obszary: `sqlite-state-store.ts`, `migrations.ts`, `controller-backup.ts`,
`backup-management.ts` i wszystkie miejsca otwierające bazę.

- Oddzielić inspekcję istniejącego schematu, backup, migrację i udostępnienie
  adaptera. `backup create` nie może wywoływać migracji przez konstruktor.
- Wprowadzić wspólny opis obsługiwanej wersji i rejestr migracji. Przed zmianami
  odrzucać nowsze lub nierozpoznane schematy. Pusta instalacja i niekompletna
  inicjalizacja wymagają odrębnego rozpoznania; nie wolno resetować bazy.
- Jeśli wymagana kopia przed migracją jest włączona, wykonać ją przed zmianą
  schematu, z metadanymi poprzedniego schematu, aplikacji i załącznikami.
  Obsłużyć starsze schematy bez tabel wiedzy. Błąd kopii blokuje migrację
  tylko w tym trybie. Przy opcji wyłączonej migracja przechodzi zwykłe kontrole
  zgodności i integralności bez tworzenia kopii i bez wymogu jej celu.
- Zmianę schematu/danych i wpis migracji zapisywać w tej samej transakcji.
  Objąć kontrolowaną inicjalizacją również bazowy DDL. Historyczne migracje
  zamrozić; nowe opatrywać nazwą i checksumą. Starszym zapisom nie przypisywać
  fikcyjnego statusu historycznie zweryfikowanej checksumy.
- Przy przebudowie zachować indeksy, triggery i widoki. Sprawdzić FK, integralność
  i reguły domenowe przed przyjmowaniem żądań. Błąd zamyka zasoby i zatrzymuje start.
- Ponowienie rozpoznaje zatwierdzone kroki; nie tworzy bez ograniczeń kolejnych
  kopii przy pętli nieudanego startu. Retencja nie usuwa jedynej kopii ratunkowej.
- Czytać numer schematu i wymagane obiekty z ukończonej migawki, nie z żywego
  źródła w późniejszym momencie. Nie rozpoznawać zgodności wyłącznie po
  `max(version)`: sprawdzać kompletność rejestru i znane definicje struktur.
- Otwieranie obcej, nieznanej lub nowszej bazy kończy się odmową. Nie wykonywać
  na niej DDL, ustawienia trwałego trybu dziennika ani inicjalizacji polityki
  uwierzytelniania. Nie używać `immutable` do odczytu aktywnej bazy WAL.

Odbiór: ręczna lub włączona kopia przed migracją zawiera stary schemat.
Domyślny tryb bez backupu przechodzi migrację bez tworzenia kopii i zadań.
Znane stare bazy przechodzą do aktualnej wersji bez utraty rekordów; nowszy
schemat pozostaje niezmieniony po odmowie. Awaria wewnątrz kroku wycofuje ten
krok i jego wpis, a ponowny start bezpiecznie rozpoznaje wcześniejsze kroki.

Macierz aktualizacji obejmuje świeżą instalację, bazę utworzoną przez
produkcyjny artefakt `a727fd8`, obecny schemat 27, historyczny schemat bez
tabel wiedzy przewidziany do wsparcia oraz nieznany/nowszy schemat. Numeru
schematu produkcji nie zgadujemy z nazwy wydania. Najpierw reprodukujemy go
przez zachowany artefakt, a rzeczywisty stan rozpoznajemy w kontrolowanej
procedurze kopii. Aktualizacja pakietu bez zmiany schematu też wymaga testu.

## S3. Załączniki oraz restore odporny na przerwanie

- Ujednolicić trwałe publikowanie załączników w uploadzie, imporcie Huba,
  imporcie projektu i restore. Bajty i wpis katalogowy muszą być utrwalone
  przed zatwierdzeniem referencji SQL. Nie usuwać współdzielonego obiektu przy
  wycofaniu jednej operacji. Kontrola osieroconych plików ma działać konserwatywnie.
- Walidować fizyczny manifest jak dane zewnętrzne: format, wersje, typy, limity,
  jednoznaczne ścieżki, zwykłe pliki, brak symlinków i kompletność załączników.
  Sprawdzać SHA-256, `integrity_check`, `foreign_key_check` i relacje domenowe.
- Zachowując publiczne ścieżki, preferować trwały dziennik etapów restore.
  Przed kodowaniem opisać stany: przygotowane, stare dane zabezpieczone,
  nowa baza zainstalowana, nowe załączniki zainstalowane, całość zweryfikowana.
  Określić wznowienie lub wycofanie dla każdego stanu i wymagane synchronizacje
  plików/katalogów. Generacje katalogów są alternatywą, jeśli uproszczą dowód
  poprawności bez niepotrzebnej zmiany kompatybilności.
- Recovery uruchamiać pod wyłącznym lockiem przed zwykłym otwarciem bazy.
  Nie łączyć starego WAL z nową bazą. Nie usuwać poprzedniej kopii przed
  sprawdzeniem nowego kompletu. Niejednoznaczny stan zatrzymuje start z instrukcją.
- Obsłużyć brak miejsca i różne systemy plików; nie zakładać, że każde `rename`
  może atomowo przenieść katalog do wskazanej lokalizacji.

Odbiór: przerwanie w każdej granicy restore kończy się po restarcie kompletnym
starym albo kompletnym nowym stanem, ewentualnie jawną odmową bez utraty materiału
do odzyskania. Nie powstaje pozornie poprawna baza z brakującymi załącznikami.

Projekt dziennika restore ma obejmować również przerwanie pomiędzy operacją
na plikach a zapisaniem jej wyniku. Intencja jest utrwalona przed zmianą;
recovery rozpoznaje rzeczywiste pliki po identyfikatorze operacji i hashach.
Samo zapisanie nazwy etapu po `rename` nie wystarcza.

| Stan | Zachowanie po ponownym uruchomieniu |
| --- | --- |
| Przygotowana i zweryfikowana nowa kopia, stary komplet aktywny | Zachować stary komplet; wznowić albo porzucić wyłącznie własny staging |
| Intencja podmiany, część starych plików w kwarantannie | Rozliczyć każdy przeniesiony plik, następnie dokończyć albo cofnąć operację pod lockiem |
| Nowa baza i niekompletny nowy magazyn załączników | Nie udostępniać kontrolera; dokończyć instalację zweryfikowanych obiektów albo odtworzyć cały stary komplet |
| Nowy komplet zweryfikowany, znacznik zakończenia trwały | Uruchomić na nowym komplecie; zachować poprzedni do zakończenia okresu ochrony |
| Uszkodzony dziennik, brak plików lub sprzeczne hashe | Zatrzymać start; zachować oba zestawy i instrukcję ręcznego odzyskania |

Restore kopiuje wejście do prywatnego stagingu i weryfikuje to, co zostanie
zainstalowane, aby zmiana pliku źródłowego między walidacją i podmianą nie
ominęła kontroli. Wspierana pierwsza konfiguracja wymaga lokalnego filesystemu;
nieobsługiwany układ wielu filesystemów jest odrzucany przed podmianą.
Szczegóły `fsync` i zachowania platform muszą mieć testy oraz jawne ograniczenia.

## S4. Backup operacyjny i instrukcja odzyskiwania

- Dodać operację backupu wewnątrz kontrolera na jego połączeniu SQLite, aby
  harmonogram nie wymagał ciągłego zatrzymywania serwerów. Serializować backupy;
  zagwarantować dostępność obiektów wskazanych przez migawkę do końca kopiowania.
- Publikować tylko ukończone i sprawdzone kopie. Ograniczyć zużycie zasobów,
  sprzątać rozpoznane niekompletne kopie, raportować datę ostatniego sukcesu
  i błąd ostatniej próby. Błąd kopii nie może być raportowany jako sukces.
- Wdrożyć opcjonalny harmonogram, retencję i osobno włączany transfer poza
  hostem. Brak konfiguracji oznacza brak automatycznych zadań. Wybrać mechanizm
  na podstawie S0; dane dostępowe nie trafiają do backloga.
  Nie zakładać, że sam backup lokalny spełnia wymaganie utraty hosta.
- Przygotować procedurę odtworzenia na pustej instalacji: artefakt aplikacji,
  zgodność schematu, uprawnienia, klucze, dane i załączniki, test dostępu oraz
  ponowna ocena przywróconych poświadczeń. Stary backup może przywrócić dawny
  stan unieważnienia tokenów, więc opisać rotację po incydencie.
- Opisać rollback przed i po przyjęciu nowych zapisów. Po nowych zapisach
  najpierw zabezpieczyć bieżący stan; określić eksport zmian lub naprawę naprzód.

### Jedna operacja backupu, kilka sposobów wywołania

1. Kontroler, offline CLI i harmonogramy korzystają ze wspólnej operacji
   aplikacyjnej. Działający kontroler pozostaje właścicielem połączenia;
   wywołanie CLI kierujemy do jego uwierzytelnionego kanału administracyjnego.
   Pełny backup wymaga uprawnień operatora instalacji, nie tylko grantu projektu
   lub administracji organizacją. Dopuszczone akcje GUI używają tych samych operacji.
   Brak odpowiedzi aktywnego kontrolera nie pozwala otworzyć drugiego właściciela.
2. W jednej chwili działa najwyżej jeden backup. Harmonogram usługi i własne
   harmonogramy użytkowników mają osobne terminy i wyniki, ale wspólne
   ograniczone wykonanie. Po restarcie każdy aktywny harmonogram zgłasza
   najwyżej jedną zaległą próbę do kolejki o określonym limicie. Nie tworzymy
   drugiej kolejki testów ani nie zmieniamy limitów hosta.
3. Operacja blokuje usuwanie/przepisywanie obiektów mogących wejść do migawki
   od rozpoczęcia backupu SQLite do ukończenia kopiowania załączników.
   Nowe obiekty są niezmienne; upload i rollback importu nie mogą usuwać
   obiektu potrzebnego aktywnemu backupowi. Po uzyskaniu migawki kopiujemy
   dokładnie wskazany przez nią zbiór.
4. W stagingu wykonujemy kontrolę schematu, integralności, FK, zależności
   domenowych i załączników. Zamykamy bazę kopii, utrwalamy pliki i katalogi,
   publikujemy finalny manifest oraz ukończony katalog. Niekompletna kopia
   nigdy nie pojawia się jako gotowy punkt odzyskania.
5. Przy włączonym transferze zewnętrzne narzędzie szyfruje i przesyła wyłącznie
   ukończone kopie. Wyłączony transfer nie tworzy zadań ani prób połączenia.
   Lokalny sukces, potwierdzony transfer i udana próba odtworzenia mają osobne
   statusy. Powtórzenie transferu tej samej kopii jest idempotentne.
6. Retencja działa po sukcesie, respektuje ochronę kopii i nie dotyka obiektów
   aktywnej bazy. Przerwany transfer zachowuje lokalne źródło potrzebne do
   ponowienia. Rosnąca kolejka transferów ma limit i alarm, nie zapełnia dysku
   bez ograniczeń ani nie usuwa jedynego punktu ratunkowego.

Hashowanie i kopiowanie dużych plików mają ograniczone zużycie pamięci.
Obecne `readFileSync` całej bazy w funkcji hash zastępujemy strumieniowaniem.
Limit czasu, budżet stagingu, wolne miejsce i liczba zaległych transferów są
sprawdzane przed rozpoczęciem i podczas pracy. Rozmiar budżetu wyznacza pomiar
bazy, unikalnych załączników, chronionych kopii i zapasu na restore.
Nie zwalniamy miejsca automatycznym kasowaniem WAL ani danych kontrolera.

Status operacyjny zawiera datę danych ostatniej kopii lokalnej i zewnętrznej,
ostatni błąd, czas i rozmiar próby, termin następnej, stan retencji oraz datę
ostatniego odtworzenia. Ujawnia bezpieczne metadane, nie ścieżki z sekretami,
pełne manifesty, zawartość bazy czy komendy zawierające dane dostępowe.

Odbiór: włączona kopia powstaje podczas pracy kontrolera i przechodzi niezależne
odtworzenie. Retencja i awaria celu kopii mają testy. Dla wybranego profilu
zmierzony wiek kopii oraz czas odtworzenia mieszczą się w ustalonych wymaganiach.
Tryby bez backupu i z wyłącznie lokalnym backupem są pełnoprawnymi konfiguracjami.
Ochronę przed utratą hosta deklarować dopiero po potwierdzonym odtworzeniu kopii
zewnętrznej, jeśli użytkownik ją włączył.

## S5. Dowody odbioru

### Kolejność implementacji S5

Właściciel zlecił 2026-10-03 tę samą procedurę co dla S4b. Koduje jeden
worker `gpt-6.1-sol` z reasoning `high`; root prowadzi zakres, odbiór,
review n8n i scalenie. Każdy kolejny PR zaczyna się od zsynchronizowanego
main po poprzednim merge. Nie łączymy wszystkich kontraktów S5 w jeden PR.

| PR | Zakres | Warunek odbioru |
| --- | --- | --- |
| S5a | Skończone wywołanie CLI monitora poza kontrolerem; ograniczony odczyt bezpiecznych metadanych | Rozróżnia brak kontrolera i błędny odczyt od zdrowia; osobny wiek danych lokalnych i zdalnych, błędy prób; wyłączona polityka nie generuje alarmu zaległości |
| S5b | Jawna zmiana repozytorium restic, zachowane poprzednie dowody i źródła; ograniczone uzgadnianie historii częściowych migawek | Nowy cel nie dziedziczy starych potwierdzeń; tylko jawnie wybrane kopie mogą zostać wysłane; historia ponad 32 kandydatów ma ograniczoną ścieżkę obsługi bez automatycznego kasowania |
| S5c | Istniejące narzędzia dystrybucji rozszerzone o aktualizację starego i nowego zainstalowanego artefaktu, próby awarii i recovery; procedura S6 | Dokładne SHA i sumy pakietów, zachowane dane i dostęp, odtworzenie bez źródła, jawne ograniczenia i procedura po nowych zapisach |

Właściciel potwierdził zakres 2026-10-03: teraz kod i izolowane testy;
docelowy host, klucze i rollout osobno. Rzeczywisty odbiór
poza hostem wymaga wskazania celu, konta, sposobu przechowywania kluczy,
kanału powiadomień i profilu obciążenia. Te wybory nie blokują implementacji.
Nie deklarować produkcyjnego RPO/RTO na podstawie małego fixture. Historyczny
commit `a727fd8ff01e141c6494615531e27e72a23f6320` może być bazą oznaczonego
fixture aktualizacji; nie jest potwierdzeniem obecnej wersji produkcyjnej.


Otwarty zakres operacyjny po review S4b (PR #74): przygotować jawny workflow
zamiany repozytorium restic na inne, o nowym kryptograficznym ID. Zachować
poprzednie potwierdzenia i źródła oczekujące na transfer; nie uznawać ich za
ochronę w nowym celu. Wymagane są ograniczone, jawnie zlecone ponowne wysyłki
i nowy dowód odzyskania. Zmiana adresu tego samego repozytorium zachowuje ID
i nie wymaga takiej migracji. Do czasu tego workflow operator może wyłączyć
transfer, pozostawić chronione źródła i wykonywać lokalne kopie ratunkowe do
jawnie podanej lokalizacji. Usuwanie dziennika transferów nie jest procedurą
zmiany celu.

| Próba | Oczekiwany wynik |
| --- | --- |
| Wspierane stare schematy → aktualny; ponowne otwarcie | Dane, tożsamości i historia zachowane, brak ponownej transformacji |
| Nowa baza; inicjalizacja przerwana; nieznana wersja | Jawne rozpoznanie stanu, bez cichego resetu ani osłabienia uwierzytelniania |
| Błąd SQL lub zabicie procesu w migracji | Brak połowicznego kroku, rejestr zgodny z danymi |
| Włączona wymagana kopia przed migracją; błąd backupu | Stary schemat w kopii; migracja nie zaczyna się po błędzie |
| Nowa instalacja i aktualizacja bez konfiguracji backupu | Brak kopii, harmonogramu, transferu i alarmów zaległości; wspierana migracja działa |
| Backup ręczny, tylko lokalny, włączanie/wyłączanie i restart | Ręczna kopia nie włącza automatyzacji; ustawienia są zachowane; wyłączenie nie usuwa istniejących kopii |
| Błąd kopii okresowej lub błędne parametry konfiguracji | Błąd okresowej kopii nie zatrzymuje aplikacji; złe argumenty są odrzucone przed mutacją bazy/definicji usługi |
| Próba zmiany polityki usługi przez GUI/API/MCP lub restore | Brak mutacji konfiguracji usługi; parametry uruchomienia pozostają źródłem nadrzędnej polityki |
| Dwa niezależne harmonogramy i ich wyłączenie | Zmiana/usunięcie własnego nie zmienia harmonogramu usługi, kopii chronionych ani retencji drugiego źródła |
| Jednoczesne terminy usługi i użytkowników, restart i duplikaty | Jedno aktywne wykonanie, ograniczona kolejka i idempotencja; brak lawiny zaległych prób i zagłodzenia harmonogramu usługi |
| Cofnięcie grantu, usunięty użytkownik, obce ID celu/projektu | Zlecenie odrzucone przed wykonaniem; harmonogram użytkownika nie daje dostępu do całej bazy ani cudzych kopii |
| Restore starych harmonogramów użytkowników | Ponowna walidacja obecnych grantów, polityki CLI i celu; brak wykonania na podstawie samych historycznych uprawnień |
| Tenant/admin organizacji, brak tożsamości operatora, wyłączone akcje CLI | API odmawia listowania pełnych kopii i niedozwolonych działań zgodnie z uprawnieniami; brak wycieku między klientami |
| Backup na żądanie i podwójny klik restore | Jedna operacja, bez zmiany harmonogramu, powtarzalny status i trwały ślad aktora |
| Restore z GUI przy aktywnych zapisach, zerwanym HTTP lub restarcie | Potwierdzenie zakresu, walidacja przed przerwą, kontrolowany tryb utrzymania i recovery; żadnej podmiany otwartej bazy |
| Przerwanie uploadu, importu i restore | Brak opublikowanych referencji do brakujących obiektów; recovery zgodne z S3 |
| Pełny dysk i brak praw zapisu | Czytelny błąd, zachowane dane i materiał do odzyskania |
| Zmieniony hash, brak załącznika, złe FK, symlink, zbyt duży manifest | Odmowa przed podmianą bieżących danych |
| Dwa procesy, ta sama baza, różne katalogi stanu | Jedna skuteczna operacja właściciela |
| Odtworzenie poza źródłową instalacją | Zgodne rekordy, załączniki, historia, dostęp i konfiguracja |
| Powrót po nowych zapisach | Nowe zmiany zachowane lub jawnie rozliczone; brak cichego ich porzucenia |
| Backup podczas uploadu, importu i usuwania obiektów | Każda referencja migawki ma zgodne bajty w kopii; brak nieograniczonego zatrzymania zapisów |
| Niedostępny cel zewnętrzny, brak klucza, przerwany transfer | Lokalny sukces nie udaje ochrony poza hostem; odzyskanie i alarm sprawdzone osobno |
| Retencja i limit miejsca | Chronione kopie pozostają, aktywne pliki są nietknięte, przekroczenie limitu jest widoczne |
| Baza nowsza od programu, alias ścieżki, szeroki umask | Odmowa przed mutacją, jeden właściciel, prywatne pliki |
| Odtworzenie dawnych grantów i stanów procesów | Brak automatycznego uruchamiania historycznych zleceń; ponowna ocena dostępu przed otwarciem usługi |

Próby awarii wykonywać na odizolowanych danych. SIGKILL nie dowodzi odporności
na utratę zasilania; ten scenariusz wymaga osobnego środowiska z kontrolą I/O.
Raport rozdziela wykonane próby od niezweryfikowanych gwarancji sprzętowych.

Wykorzystać istniejące testy adaptera, backupu, CLI, załączników i importów.
Uruchomić `pnpm check`, a po zmianach modułów/bundlowania także `pnpm build`
i odpowiedni test zainstalowanego artefaktu. Korzystać z presetów kolejki MCP,
gdy są dostępne; prace wymagające serwera podlegają osobnemu claimowi. Ciężkie
zadania wykonywać pojedynczo. Zatrzymanie przez mechanizm hosta oznacza porażkę.

Raport odbioru zapisuje SHA aplikacji, wersję silnika, schematy fixture, ID
uruchomień, wyniki, czas odtworzenia i pozostałe ograniczenia. Istniejący pilot
K7a nie zastępuje tych prób. Wyniki aktualizacji artefaktu powiązać z zadaniem
dystrybucji, bez powielania jego harnessu.

## Podział implementacji na PR-y

### Strategia Git i runów

1. Plan, prompt startowy i rekord backloga otrzymują osobny commit dokumentacji
   na `main`, po `fmt`, `validate` i `git diff --check`. Synchronizacja tego
   commita udostępnia plan kolejnemu workerowi i Hubowi. Pliki istniejące tylko
   w lokalnym working tree nie są jeszcze opublikowanym punktem startowym.
2. Każdy slice implementujemy na osobnej feature branch i w osobnym worktree,
   od aktualnego, zsynchronizowanego `main`. Pierwsza gałąź to
   `feat/sqlite-pre-migration-backup`. Jeden PR kierujemy do `main`.
3. Następny zależny slice zaczyna się po review, poprawkach, przejściu wymaganych
   kontroli i merge poprzedniego. Aktualizujemy `main`, tworzymy nową gałąź
   i ponownie sprawdzamy założenia względem kodu. Nie utrzymujemy zbiorczej
   gałęzi z całą niezmergowaną funkcją ani stosu zależnych PR-ów.
4. Jeden run workera obejmuje jeden slice: rozpoznanie, implementację,
   weryfikację i PR. Gdy pojawią się uwagi albo limit kontekstu, kolejny run
   kontynuuje ten sam slice na tej samej gałęzi. Granicą jest zaakceptowany
   zakres PR-a, a nie czas trwania sesji. Kolejnego slice'a nie dopisujemy
   do pierwszego PR-a.
5. Po każdym slice zachowujemy raport z SHA, wynikami testów, ograniczeniami
   i linkiem do PR-a. Aktualizacje backloga i trwałe raporty trafiają osobnym
   commitem na `main` zgodnie z jego workflow. W trakcie pracy dane potrzebne
   do kontynuacji pozostają w opisie PR-a lub handoffie; implementacja nie
   zamyka całego zadania S0–S6 po pierwszym merge.
6. Merge kodu i wdrożenie są osobnymi operacjami. Run pierwszego slice'a kończy
   się przygotowanym PR-em oraz wynikami weryfikacji. Nie obejmuje merge,
   aktualizacji produkcji, uruchamiania migracji na prawdziwej bazie ani
   instalowania workera na VPS-ie.

Przed pierwszym runem użyć [promptu S1a + S2a](storage-safety-worker-01.md).
W kolejnych promptach zachować ten sam model pracy i wskazać tylko aktualny
slice oraz wyniki poprzednika. Powyższa strategia nie wymaga pracy równoległych
agentów; zależne zmiany wykonujemy kolejno.

### Zakresy kolejnych PR-ów

Etapy S0–S6 pozostają nazwami kryteriów odbioru. Tabela dzieli je na zakresy
do implementacji; numery PR-ów zostaną nadane przy ich utworzeniu.

| Zakres | Zmiana i główne pliki | Warunek zakończenia |
| --- | --- | --- |
| S1a + S2a | `controller-lock.ts`, `paths.ts`, `sqlite-state-store.ts`, `backup-management.ts`, `controller-backup.ts`: jeden właściciel, inspekcja bez migracji, wspólny limit schematu i kopia starych danych | Nowe CLI robi kopię starego schematu; błąd kopii blokuje migrację tylko przy włączonej ochronie; tryb bez backupu działa; nieznana baza pozostaje niezmieniona; ta sama baza przez drugi katalog stanu jest zablokowana |
| S1b + S2b | Adapter i `migrations.ts`: prywatne pliki, jawne FULL, transakcyjna inicjalizacja, rejestr migracji i kontrola integralności | Historyczne fixture i przerwana inicjalizacja nie tracą danych ani nie zmieniają niejawnie trybu uwierzytelniania |
| S3a | `attachment-service.ts`, `project-transfer.ts`, publikacja importu w adapterze: wspólne trwałe publikowanie obiektów i koordynacja z backupem | Przerwanie uploadu/importu oraz rollback współdzielonego obiektu zachowują poprawne referencje |
| S3b | `controller-backup.ts`, bootstrap i CLI: manifest, staging, dziennik restore i recovery przed otwarciem adaptera; protokół kontrolowanego zlecenia restore z GUI | Awaria w każdej granicy podmiany odzyskuje kompletny stan lub zatrzymuje start z zachowanym materiałem |
| S4a | Konfiguracja usługi tylko parametrami CLI; opcjonalny harmonogram i retencja; GUI operatora z listą, „Utwórz teraz” i zleceniem restore przez wspólne operacje | Domyślnie brak automatyzacji i akcji web; operator włącza je przez CLI; uprawnienia wymuszone w API; GUI nie edytuje konfiguracji; testy PL/EN, klawiatury, potwierdzenia i ponownego połączenia |
| S4u | Osobne harmonogramy użytkowników w GUI/API, trwałe przypisanie właściciela i zakresu, retencja w granicach CLI oraz wspólne wykonanie | Niezależność od harmonogramu usługi, kontrola zakresu przy wykonaniu, ograniczenia kolejki i testy braku wpływu na cudze kopie |
| S4b | Opcjonalny adapter restic, polityka CLI, trwały status transferu i ochrona lokalnych źródeł; izolowana próba pobrania i odzyskania | Zweryfikowana kopia przechodzi szyfrowany transport i odzyskanie na fixture; domyślnie brak transferu; błędy i ponowienia nie udają sukcesu |
| S5 | Niezależny monitor, operacyjna instrukcja odzyskania i harness aktualizacji pakietu | Kopia z wybranego celu poza hostem odtworzona bez źródłowej instalacji; zmierzone cele; próba starego i nowego artefaktu |

Doprecyzowanie wykonawcze z 2026-10-03: po scaleniu S4u oddzielamy S4b od
odbioru S5, aby zachować jeden zakres na PR. Pierwszy adapter S4b korzysta
z restic i backendu HTTPS REST; konfiguracja pozostaje wyłącznie po stronie
operatora CLI. Testy transportu używają izolowanych, sztucznych danych.
Wybór celu produkcyjnego, przechowywania kluczy i włączenie usługi wymagają
osobnego zakresu wdrożenia. Izolowana próba nie dowodzi ochrony przed utratą
rzeczywistego hosta ani spełnienia produkcyjnego RPO/RTO. S4b nie dodaje
transportu pełnej bazy do harmonogramów użytkowników.

Nowe odpowiedzialności wydzielamy przy ich pierwszym użyciu zgodnie z
[mapą modułów](../../../codebase-organization.md). Nie dokładamy całej logiki
do CLI ani nowego niezależnego połączenia do aktywnej bazy. S1b/S2b nie mogą
trafić na produkcję przed działającą ochroną z S1a/S2a.

## Wdrożenie na obecnej produkcji

Poniższa procedura jest rekomendowanym wariantem po wybraniu profilu z kopiami.
Wariant z backupami wyłączonymi pomija kroki kopii i transferu, zachowując
kontrole schematu, integralności i odbiór aplikacji. Brak kopii oznacza brak
możliwości powrotu przez jej odtworzenie, nie blokadę wdrożenia w produkcie.

1. Przed oknem zmiany ustalić aktualne wydanie, schemat, tryb uwierzytelniania,
   rozmiary danych i wymagane pliki zewnętrzne, bez ujawniania ich wartości.
   Zachować stary i kandydacki artefakt z checksumami. Samo `backup create`
   z nowszego pakietu nie jest ochroną przed migracją, dopóki jego ścieżka
   otwierania bazy nie przejdzie kryteriów S2.
2. Przećwiczyć aktualizację i odtworzenie na fixture utworzonym przez stary
   artefakt, następnie na prywatnej, spójnej kopii bieżącej instalacji.
   Ograniczyć dostęp i łączność kopii; nie pozwolić jej uruchamiać projektów,
   zleceń ani używać produkcyjnych poświadczeń do działań zewnętrznych.
3. Gdy produkt i kopie przejdą S5, przygotować konkretne okno przerwy.
   Zatrzymanie kontrolera wpływa na jego zarządzane serwery i testy; uwzględnić
   ich użytkowników, rezerwacje i kolejkę. Nie restartować kontrolera w ciemno.
4. W oknie wdrożenia zamrozić zapisy, wykonać końcową kopię starego stanu
   sprawdzoną ścieżką bez migracji, zabezpieczyć ją poza hostem i uruchomić
   migrator nowego artefaktu. Błąd kontroli zatrzymuje otwarcie usługi.
5. Sprawdzić rekordy, załączniki, logowanie, uprawnienia, GUI/MCP/CLI i pierwszą
   zaplanowaną kopię z transferem. Dopiero wtedy przywrócić normalne zapisy.
   Wdrożenie nie zmienia automatycznie trybu logowania ani klientów MCP.
6. Przed nowymi zapisami można wrócić do starego artefaktu i pasującej kopii
   całego stanu. Po nowych zapisach najpierw zabezpieczyć je i ustalić
   przeniesienie zmian lub naprawę naprzód. Nie otwierać nowszej bazy starym
   programem, którego zabezpieczenia nie zostały sprawdzone.
7. Przez proponowane siedem dni śledzić wiek kopii, błędy, zajętość dysku,
   opóźnienia zapisów i dostęp po restartach. Zapisać odbiór wdrożenia osobno
   od technicznego zamknięcia S5 i migracji wiedzy S6.

Przed rolloutem zapisujemy wybraną konfigurację. Cel, narzędzie transferu
i klucze są potrzebne tylko przy włączeniu kopii zewnętrznej; harmonogram,
retencję i alarmy ustalamy dla włączonych funkcji. Osobną decyzją pozostaje
izolacja usługi od kont agentów. Plan nie wykonuje tych zmian.

## S6. Przełączenie pierwszego projektu i zamknięcie tematu

Po spełnieniu S0–S5 oraz kryteriów funkcjonalnych K7 przygotować konkretny raport
dla wskazanego projektu. Decyzja o rzeczywistym przełączeniu jest osobnym krokiem
operacyjnym; samo zlecenie zapisania tego planu jej nie udziela.

1. Ustalić właściciela operacji, punkt odniesienia w Git, okno zamrożenia zapisów
   i wybraną konfigurację backupu. Przy włączonej ochronie przygotować kopię
   ratunkową. Zablokować równoległą edycję źródłowych plików.
2. Powtórzyć import na końcowym commicie. Rozliczyć rekordy, treści, autorstwo,
   daty, relacje, załączniki i każde pominięte lub nierozwiązane mapowanie.
3. Jeśli wykonano kopię, sprawdzić jej odtworzenie. Niezależnie od konfiguracji
   sprawdzić GUI/MCP/CLI, człowieka i dwóch agentów,
   odmowy dostępu oraz zapis i odczyt po rzeczywistym restarcie kontrolera.
4. Przełączyć instrukcje i narzędzia na jeden zapis przez Switchera. Stare pliki
   pozostawić jako archiwum. Ewentualny eksport musi być oznaczony jako pochodny.
5. Przeprowadzić okres codziennej pracy; przy włączonych backupach objąć nim
   kopię i próbę odzyskania;
   proponowane minimum to siedem dni, do uzgodnienia przed przełączeniem.
   Zapisać napotkane problemy i decyzję o dopuszczeniu kolejnych projektów.

Zadanie ochrony danych zamknąć po S5 i dostarczeniu procedury S6. Faktyczne
przełączenie i jego okres obserwacji pozostają kryterium rodzica
`FEAT-20260905-shared-project-memory`; zamknięcie technicznego zadania nie zamyka
automatycznie K7, K8 ani K9. Przy zamknięciu zastąpić otwarty rekord wpisem
`done/` z dowodami w jednym commicie, zgodnie z regułami backloga.

## Podstawa techniczna

- Spójną kopię działającej bazy tworzy [SQLite Backup API](https://sqlite.org/backup.html).
  Spójność załączników pozostaje odpowiedzialnością aplikacji.
- [PRAGMA synchronous](https://sqlite.org/pragma.html#pragma_synchronous)
  opisuje trwałość FULL w WAL; efektywne ustawienie należy sprawdzić w aplikacji.
  [integrity_check](https://sqlite.org/pragma.html#pragma_integrity_check)
  nie zastępuje [foreign_key_check](https://sqlite.org/pragma.html#pragma_foreign_key_check).
- [WAL](https://sqlite.org/wal.html) wymaga lokalnego współdzielenia pamięci
  przez procesy i nie służy do współdzielenia aktywnej bazy między hostami.
  Kopia na VPS-ie jest punktem odzyskania, nie drugim właścicielem tej bazy.
- [Opis przyczyn uszkodzeń SQLite](https://sqlite.org/howtocorrupt.html)
  wyjaśnia ryzyko kopiowania aktywnego pliku i oddzielania go od dziennika.

Źródła sprawdzono 2026-10-01. Nie zastępują testów konkretnego artefaktu,
biblioteki SQLite, systemu plików i procedury odtworzenia.
