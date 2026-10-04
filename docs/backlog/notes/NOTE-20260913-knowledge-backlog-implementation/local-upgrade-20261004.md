# Lokalna aktualizacja kontrolera i dostęp do wiedzy

Właściciel 2026-10-04 zezwolił na wygenerowanie sekretów, lokalną konfigurację
dostępu, zatrzymanie usług na czas prac, migrację i testy. Sekrety pozostają
poza repozytorium; właściciel zamierza później rotować je ręcznie.
Kod i skrypty operacyjne przygotowuje Sol 6.1 high; Astra prowadzi analizę,
koordynację i odbiór. Nie zmieniamy limitów ani mechanizmów ochrony hosta.

## Punkt powrotu

Przed zmianą działało wydanie `0.1.0-trial.1` z katalogu `a727fd8` na Node
24.19.0. Kolejka była pusta, wszystkie rezerwacje zwolnione. Jedynym działającym
zarządzanym serwerem był WinPath, port 3000, worktree
`/home/pioootrek/development/.worktrees/win-path-6/se-forecast-integration`.

Pełną kopię wykonano starym zainstalowanym CLI po zatrzymaniu kontrolera:
`/home/pioootrek/wts-recovery-20261004-qtlq4_wi/baseline-backup`.
Katalog odzyskiwania ma prawa 0700. Prywatnie zachowano też definicję usługi,
pliki konfiguracji i metadane starego artefaktu.

- Schemat bazy: 24; rozmiar: 4247552 B.
- SHA256 bazy: `810f94ca16d54e8575b0cdfaab841d062824058ca31dff722332b9c7680ece81`.
- `integrity_check`: `ok`; liczba naruszeń kluczy obcych: 0.
- 152 obiekty załączników, razem 7092925 B; hashe, rozmiary i referencje
  bazy zgodne z manifestem.

Odzyskano sesję właściciela obsługiwaną komendą offline starego CLI.
Ten sam stary kontroler uruchomiono ponownie. WinPath pozostaje zatrzymany
podczas okna prac. Pierwsza kopia poprzedza utworzenie nowych poświadczeń;
przed przełączeniem potrzebny jest drugi, końcowy snapshot.

Kopia zawiera jeden aktywny projekt wiedzy `k7a-worktree-switcher` o nazwie
Worktree Switcher. Nie należy utożsamiać czterech projektów runtime z czterema
projektami wiedzy. Różnice importu wobec plików wymagają osobnego rozliczenia.

## Skonfigurowany dostęp lokalny

Dodano rejestrację Codex `worktree-switcher-knowledge`, korzystającą
z istniejącego launchera `~/.local/bin/agent-mcp-worktree-switcher`.
Dotychczasowe rejestracje zachowano. Nowe połączenie wskazuje osobny plik
sekretu i osobny plik nagłówka, więc nie nadpisuje poświadczenia runtime.

Prywatny katalog `~/.config/agent-config/worktree-switcher-knowledge` ma
prawa 0700, a pliki `secrets.env`, `knowledge.headers` i `owner-token` mają
0600. W konfiguracji harnessu są tylko ścieżki, bez wartości sekretów.
Osobny token agenta ma `knowledge:read` i `attachments:read` dla istniejącego
projektu `k7a-worktree-switcher`. Token właściciela nigdy nie został podłączony
do MCP agentów. Oba poświadczenia są bezterminowe, do uzgodnionej ręcznej
rotacji; odzyskana wcześniej sesja tymczasowa wygasa osobno.

Sprawdzono uwierzytelnioną tożsamość (HTTP 200), listę 35 narzędzi wiedzy,
projekt z `writable: false` i odmowę administracji właściciela tokenem agenta
(HTTP 403). Obecność narzędzi zapisu na liście nie daje uprawnień zapisu:
obowiązują granty w kontrolerze. Sesję diagnostyczną zamknięto poprawnie.
Już uruchomione sesje harnessów mogą wymagać ponownego wczytania konfiguracji,
aby pokazać dodatkowy serwer MCP. Protokół sprawdzono bez restartowania T3.

## Porównanie wiedzy z plikami

Uwierzytelniony odczyt potwierdził identyfikatory rekordów z kopii: 37 zadań,
17 wątków, 85 odpowiedzi, 18 pamięci i 152 załączniki. W bazie jest również
91 relacji i 6 wpisów historii wiedzy. Trzy zadania i dwie pamięci nie mają
bezpośredniego mapowania importu; pozostają pełnoprawnymi danymi do zachowania.

Zachowało się 314 wpisów pochodzenia importu z commita
`c80de67109d9185d8b957ca921156c5126cb5793`, mimo braku wierszy partii importu.
Porównanie ze źródłem `20bbdded7f343ee6f08095715d5f6f120cc3422a`:

| Typ źródła | Zgodny hash | Zmieniony hash | Brak lub niemożliwy odczyt |
| --- | ---: | ---: | ---: |
| Fizyczny plik | 172 | 36 | 21 |
| Osadzona notatka JSON | 69 | 5 | 11 |
| Razem | 241 | 41 | 32 |

Lokalizacje `#notes/N` oznaczają elementy tablicy JSON, nie osobne pliki.
Brak dawnej ścieżki nie dowodzi utraty rekordu: zakończone zadania mogą mieć
inne ścieżki i ID, z powiązaniem przez `item_id`. Pięć dawnych rekordów nie
występuje pod wcześniejszą ścieżką; 11 obecnych rekordów kanonicznych nie ma
odpowiednika w metadanych importu. Nie wykonano automatycznej synchronizacji
ani nadpisania wiedzy plikami. Prywatne szczegóły porównania znajdują się
w `production-knowledge-reconciliation.json` w katalogu odzyskiwania.

## Kandydat do aktualizacji

Pobrano artefakt z zakończonego powodzeniem CI
[37193541001](https://github.com/pioootrek/worktree-switcher/actions/runs/37193541001).
`check-build`, oba smoke pakietu dla Node 22 i 24 oraz test cyklu życia usługi
zakończyły się powodzeniem.

- Źródło: czysty commit `20bbdded7f343ee6f08095715d5f6f120cc3422a`.
- Pakiet: `worktree-switcher-0.1.0-trial.1.tgz`, 859401 B.
- SHA256: `ec87b9240bf70dfcb70be8639c4e56678c252a5526b31d4fc8d5ec506b2bd677`.
- Sprawdzono cztery sumy z `SHA256SUMS`; raport smoke Node 24 wskazuje ten
  sam hash pakietu i poprawne załadowanie prebuilt SQLite.
- Zainstalowano w osobnym prefiksie, następnie przeniesiono go do docelowego
  `/home/pioootrek/.local/lib/worktree-switcher/releases/20bbdde`.
  Hash CLI po przeniesieniu pozostał zgodny. Próba używa docelowej instalacji.
- SHA256 zainstalowanego `dist/cli/index.js`:
  `d7e3902abd3876739a4a0f7bc85c22990b147d86ee9a20d70afea82033b3801f`.

Numer wersji pakietu jest taki sam jak wcześniej. Identyfikację aktualizacji
zapewniają commit, hash artefaktu i ścieżka uruchomionego programu.

## Warunki przełączenia

Przed produkcją odtworzyć pełną kopię do prywatnych katalogów, wykonać migrację
24→28 kandydackim pakietem oraz sprawdzić zachowanie rekordów, historii,
uprawnień i załączników. Próba nie może uruchamiać nadzorowanych projektów
ani wykonywać zadań lub połączeń zewnętrznych z poświadczeniami kopii.

Istniejące katalogi `.local`, `.local/share`, `.local/state` mają 0775,
a katalog danych Switchera również 0775. Nowy kod odrzuca takie ścieżki.
Właścicielem jest pioootrek, grupa prywatna pioootrek; brak rozszerzonych ACL.
Rozwiązanie przed przełączeniem: zawęzić prawa trzech wymienionych katalogów
nadrzędnych do 0755 i katalogu danych do 0700, bez rekursji. Zachowuje to
dotychczasowe ścieżki danych, stanu i odkrywania usługi przez CLI.

Automatyczne backupy, harmonogramy użytkowników i transfer zdalny pozostają
wyłączone. Ręczne kopie tego wdrożenia nie włączają tych funkcji. Nie wykonano
jeszcze próby odzyskania poza hostem ani pełnego przełączenia backlogów.

## Wynik pierwszej próby na danych produkcyjnych

Kandydat `20bbdde` odmówił otwarcia odtworzonej kopii przed migracją:
`Unsupported or unrecognized database schema (constraint in reservations: lease)`.
Produkcji nie przełączono; stary kontroler pozostaje aktywny.

Porównanie ograniczeń wszystkich tabel wskazało jeden nierozpoznany wariant:
historyczny CHECK w `reservations`, sprawdzający `kind` i `expires_at`.
Migracja 4 dodawała kolejne kolumny bez przebudowy tego ograniczenia.
Obecny walidator rozpoznaje inną starszą postać tabeli, lecz pomija tę obecną
w produkcyjnej bazie. Pozostałe różnice mają obsługę zależną od wersji albo
wynikają z kolejności ograniczeń.

Poprawka wymaga syntetycznego testu regresji, rozpoznania dokładnie znanej
historycznej postaci i zachowania walidacji danych aktywnych rezerwacji.
Nie wolno obchodzić walidatora ani zmieniać ręcznie schematu produkcji.
Po przeglądzie i testach trzeba zbudować nowy przypisany do commitu artefakt
i powtórzyć pełną próbę przed przełączeniem usługi.

## Poprawka historycznego schematu

[PR #78](https://github.com/pioootrek/worktree-switcher/pull/78) scalono jako
`1be609bda1a54b2385ba8e607224c876b8544b95`. Końcowy commit poprawki:
`189e389c3c477209cecd4f970acea3e05b8c1686`.

Minimalny syntetyczny fixture odtworzył odmowę bez danych produkcyjnych.
Rozpoznawany jest dokładny historyczny zestaw dwóch CHECK; walidacja aktywnych
rezerwacji pozostaje obowiązkowa. Review n8n (`all`) wskazało jedną trafną
uwagę: znane ograniczenie nie może ukrywać dodatkowego, nieznanego CHECK.
Dwa testy odtworzyły ten przypadek przed poprawką. Uwaga została naprawiona,
wyjaśniona i zamknięta; ponowny odczyt wątków potwierdził brak otwartych uwag.

Końcowy test w kolejce `5e085281-e5fa-4c27-8df6-016244457f15` na czystym
commicie przeszedł z `observed_match`: lint, typy, 972 testy jednostkowe
i 18 testów zasobów. Wcześniejsze wyniki nie zastępują tego odbioru.
[CI 37201285579](https://github.com/pioootrek/worktree-switcher/actions/runs/37201285579)
zakończyło wszystkie cztery zadania powodzeniem, w tym przeglądarkę,
instalację pakietu na Node 22/24 i cykl życia usługi systemd.

- Źródło artefaktu CI: `e54980ab5b32f1b41ed8fc317ead132923d606a2`, czyste.
- Pełne porównanie drzewa tego commita ze scalonym `1be609b` nie wykazało różnic.
- Pakiet: 859524 B; SHA256
  `01c2861b309e7fb9ecb6066b6cfa43382409662cce7285ba2d0cb975b9dbe79b`.
- Wszystkie cztery sumy manifestu poprawne; raport smoke Node 24 wskazuje
  ten sam hash, działający prebuilt SQLite i poprawne zakończenie procesów.
- Osobna instalacja:
  `/home/pioootrek/.local/lib/worktree-switcher/releases/1be609b`.
- SHA256 zainstalowanego CLI:
  `0e2df447d6550f9c3a5494c27f5d8aff0edda6c7cb04357b57e24059e3c74770`.

Po utworzeniu nowych poświadczeń wykonano starym CLI kolejną pełną kopię:
`/home/pioootrek/wts-recovery-20261004-qtlq4_wi/post-credentials-old-backup-y9worh5p/backup`.
Schemat 24, integrity OK, brak naruszeń FK, 152 załączniki (7092925 B).
SHA256 bazy: `1b5fa5ad142d7952cbdef5977021af41050c3ca11d054e688c6a88622e7d0fab`.
Wszystkie 287 obiektów kopii mają oczekiwane prawa 0700/0600.
Po wykonaniu kopii uruchomiono tę samą starą usługę.

Pierwsza próba nowego pakietu w `accepted-rehearsal-ugvv62_u` poprawnie
zmigrowała kopię do schematu 28: integrity OK, brak naruszeń FK, wszystkie
wcześniejsze wiersze 29 tabel zachowane, 152 obiekty załączników zgodne.
Przewidziane przez migrację dodatki to principal instalacji i ustawienie
kontrolera; nie usunięto ani nie zmieniono wcześniejszych wierszy.

Pełne `doctor` zwróciło kod 1 z niezależnym problemem discovery Prostego
Prawnika. Stary CLI przez działający stary kontroler zgłasza ten sam błąd.
Odczyt MCP wykazał siedem nieistniejących worktree pod `/tmp`; ich `git status`
zwraca 128. Nie usuwano wpisów Git ani nie zmieniano projektu, aby uzyskać
zielony wynik. Szczegóły są w prywatnym `doctor-discovery-evidence.json`.
Nie należy raportować pełnego `doctor` jako zaliczonego. Dalszy odbiór kopii
oddziela istniejący błąd discovery od sprawdzeń bazy i API.

## Odbiór kopii i przełączenie produkcji

Końcowa próba na kopii zakończyła się powodzeniem. Dwa poprawnie zakończone
cykle kontrolera zachowały wszystkie wcześniejsze wiersze; porównanie pomija
wyłącznie oczekiwaną zmianę `principal_credentials.last_used_at` po odczytach.
Każdy cykl sprawdził treść i rewizje 37 zadań, 17 wątków, 18 pamięci,
85 odpowiedzi oraz pobrał i sprawdził 152 załączniki. Istniejące poświadczenia
agenta i właściciela działały; zły token dawał 401, a zapis wiedzy i administracja
właściciela tokenem agenta — 403. Dashboard i pięć zasobów statycznych zwróciły
200. Nie wykonano osobnego klikanego przepływu przeglądarki na tej kopii.

Skrypt próby wymagał dwóch korekt transportu: uruchomienia izolowanego
kontrolera z `--service-mode --no-open` dla pliku gotowości oraz odczytu
globalnej polityki backupu przez lokalne CLI. Sesja właściciela wiedzy
i starszy token parowania nie mają uprawnień `installation_token`; odmowa
HTTP była zgodna z kontraktem. Nie rozszerzano grantów ani nie zmieniano
trybu uwierzytelniania. Wcześniejsze nieudane próby skryptu zachowano prywatnie.

Produkcję przełączono na pakiet odpowiadający `1be609b`. Końcowy backup
starej wersji znajduje się w:
`/home/pioootrek/wts-recovery-20261004-qtlq4_wi/production-rollout-237qezea/final-old-backup`.
Ma schemat 24, integrity OK, FK0 i 152 zweryfikowane załączniki; SHA256 bazy
`003f42ee04398f5ffb654d668bc5cd165e26847ed500d5d0159b137e545d38bb`.

Definicja usługi i rzeczywiste argumenty procesu wskazują nowy pakiet,
z zachowaniem Node 24.19.0, portów, ścieżek danych/stanu i adresu publicznego.
Zastosowano wyłącznie opisane wyżej cztery zmiany praw katalogów, bez rekursji.
Limity systemd i mechanizmy ochrony hosta pozostały niezmienione. Kontroler
po przełączeniu jest aktywny, PID 251771, licznik restartów 0.

Uwierzytelniony odbiór produkcji ponownie potwierdził te same rekordy,
treści, rewizje i pobranie 152 zgodnych załączników, zachowanie grantów,
czterech projektów runtime oraz limitów serwerów 2 i testów 1.
Nie wykonywano prób zapisu do wiedzy produkcyjnej.
Automatyczne backupy, transfer zdalny, akcje GUI i harmonogramy użytkowników
pozostają wyłączone; odczytano rzeczywistą politykę przez CLI i API.

Nowa produkcja wykonała także backup online, operacja
`035bd4ae-63b8-4c93-a121-0072c503f745` zakończona jako `succeeded`:
`/home/pioootrek/wts-recovery-20261004-qtlq4_wi/production-rollout-237qezea/post-upgrade-backup`.
Odczyt tej kopii potwierdził schemat 28, integrity OK i FK0. Hash bazy jest
zgodny z manifestem:
`f76bfc66877331119db920c8e7b098e6101af3e8d93e49edd7fc20ae80ff577e`.

Raporty odbioru i operacji pozostają w prywatnych katalogach próby i odzyskiwania.
Aktualizacja kontrolera i schematu nie jest przełączeniem lokalnych backlogów
na zapis do bazy: pliki pozostają ich dotychczasowym źródłem. Rozliczenie
różnic importu i niezacommitowanych zmian WinPath nadal wymaga osobnego kroku.

Końcowa weryfikacja kopii nowej produkcji potwierdziła hashe i rozmiary
wszystkich 152 obiektów oraz zachowanie wszystkich wcześniejszych wierszy
29 tabel względem końcowego backupu starej wersji. Nie wykryto zmian treści
wiedzy ani projektów. Prywatne wyniki: `post-upgrade-backup-verification.json`
i `post-upgrade-preservation-summary.json` w katalogu operacji.

WinPath przywrócono przez własny claim MCP na wcześniejszy worktree i port
3000, po czym zwolniono claim. Pierwszy test HTTPS w Pythonie odrzucił
istniejący łańcuch certyfikatów z powodu brakującego Authority Key Identifier;
ten nieudany wynik zachowano. Niezależny standardowy `curl --cacert` z CA
z konfiguracji, poprawnym SNI i `--resolve` zwrócił HTTP 200, kod 0 oraz
`ssl_verify_result: 0`. Nie użyto `-k`, nie zmieniono certyfikatów ani polityk
hosta. Świeży odczyt MCP potwierdził WinPath `running` na dokładnie wcześniejszym
worktree, brak rezerwacji, pozostałe trzy projekty zatrzymane i pustą kolejkę.
Raport: `winpath-restoration-6kb9ytiv/final-verification.json` w katalogu
odzyskiwania; początkowego raportu błędu nie nadpisano.

Status końcowy: lokalna aktualizacja kontrolera, migracja schematu 24→28,
konfiguracja odczytu wiedzy, backupy operacyjne i przywrócenie WinPath wykonane.
Nie wykonano przełączenia źródła zapisu backlogów ani odzyskania poza hostem.

## Korekta: jeden token do panelu i wiedzy

Po aktualizacji właściciel przypomniał wymaganie jednego tokena do całego GUI.
Migracja schematu zachowała historyczny tryb `legacy`, który osobno uwierzytelnia
panel i wiedzę. Wydanie dodatkowej sesji właściciela oraz instrukcja dwóch
logowań były błędną odpowiedzią operacyjną na to wymaganie. Kod aplikacji
obsługuje już wspólny token instalacji; nie wymagał poprawki.

Wygenerowano token instalacji przez obsługiwane CLI, zachowując sekret
w prywatnym `~/.config/agent-config/worktree-switcher-installation/token`
(0600, katalog 0700). Przy pustej kolejce i braku rezerwacji opublikowano
zgodne poświadczenia lokalnego launchera MCP w `secrets.env` oraz
`worktree-switcher.headers`, zachowując pozostałe wartości. Następnie
`auth mode set token` przez lokalny kanał administracyjny przełączyło działający
kontroler. PID 251771 pozostał ten sam; nie restartowano usługi ani WinPath.
Trybu `open` nie używano.

Odczyt przez publiczne HTTPS potwierdził HTTP 200 dla `/api/dashboard` oraz
`/api/knowledge` z tym samym nowym tokenem i poprawną weryfikacją TLS.
Potwierdzono również cztery projekty runtime przez MCP, dostęp instalacji
do projektu wiedzy i zachowanie istniejącego agenta tylko do odczytu.
Osobne poświadczenie agenta API nie stanowi dodatkowego logowania użytkownika
GUI w trybie `token`.

Prywatny raport zmiany: `installation-access-u9veajw3/status.json` w katalogu
odzyskiwania. Zmiana trybu zamyka wcześniejsze sesje MCP. `mcp-remote` czyta
plik nagłówków przy uruchomieniu, więc już działające bridge wymagają ponownego
połączenia klienta; podmiana pliku sama nie aktualizuje ich pamięci.

Rzeczywisty odbiór w izolowanej przeglądarce przez publiczne HTTPS przeszedł:
dokładnie jedno wysłanie głównego formularza, przejście do Knowledge, wybór
projektu, lista 20 widocznych rekordów, otwarcie rekordu i odświeżenie strony.
Drugiego formularza nie było; nie wpisywano osobnego poświadczenia wiedzy.
Przeglądarka użyła zaufanej lokalnej CA, bez ignorowania błędów HTTPS,
i została zamknięta. Jednorazowy proces Chromium wymagał `--no-sandbox`
w ograniczeniu do naszego origin; nie zmieniono polityki hosta. Narzędzie
`certutil` dostarczono tylko do prywatnego katalogu testu, bez globalnej
instalacji ani zmiany systemowego zaufania. Raport:
`one-token-gui-8p17i4fg/gui-summary.json` w katalogu odzyskiwania.

Aktualna instrukcja użytkownika: odświeżyć GUI i zalogować się tokenem
z `~/.config/agent-config/worktree-switcher-installation/token`.
Wcześniejsza instrukcja oddzielnych tokenów panelu i wiedzy jest nieaktualna.
