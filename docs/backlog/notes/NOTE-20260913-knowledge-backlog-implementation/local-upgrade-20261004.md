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

Status roboczy: kopia, odzyskanie dostępu i konfiguracja poświadczenia wykonane;
aktualizacja produkcji czeka na usunięcie wykrytej niezgodności walidatora.
