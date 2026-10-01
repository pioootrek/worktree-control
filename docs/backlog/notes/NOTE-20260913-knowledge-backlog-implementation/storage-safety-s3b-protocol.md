# Protokół S3b przed implementacją

Punkt startowy: `c5c49e2a6bcfd0a15db533b8acfa31d042666222`, merge PR #70
potwierdzony przez GitHub, 2026-10-01 15:37:15 UTC. Przeczytano plan S3,
raport S3a i zasady repozytorium. Zakres to S3b; GUI i harmonogramy są w S4.

## Stany i granice awarii

Restore wykonuje jeden właściciel bazy, bez otwartego połączenia SQLite.
Recovery działa po przejęciu kanonicznego locka bazy, przed jej otwarciem.
Dziennik i kwarantanna są rodzeństwem pliku bazy, poza podmienianymi danymi.

| Stan lub granica | Wynik przerwania i recovery |
| --- | --- |
| Kopiowanie stagingu, bez dziennika | Stary komplet pozostaje aktywny. Własny niekompletny staging nie uprawnia do podmiany. |
| `prepared` | Prywatna kopia przeszła kontrolę, pliki i katalogi są utrwalone. Recovery ponownie sprawdza kopię i zaczyna zabezpieczanie starego kompletu. |
| Intencja przeniesienia starego pliku/katalogu | Intencja jest utrwalona przed rename. Recovery rozróżnia źródło i kwarantannę przez zapisane device/inode oraz hash. Po rename, ale przed wynikiem, synchronizuje katalogi i rozlicza przeniesienie. |
| `previous_secured` | Cały poprzedni komplet, także WAL/SHM/rollback journal/initializing i magazyn obiektów, jest zachowany. Recovery instaluje nową bazę. |
| Intencja instalacji bazy / `database_installed` | Recovery rozpoznaje staged lub zainstalowany inode i hash. Nie otwiera mieszanej generacji. |
| Intencja instalacji załączników / `attachments_installed` | Recovery kończy podmianę i sprawdza cały nowy komplet. Żaden transport nie przyjmuje zapisów w trakcie. |
| Walidacja nowego kompletu, przed `verified` | Powtarza walidację schematu, integralności, FK, reguł domenowych i dokładnego zbioru obiektów. Błąd zatrzymuje start i zachowuje oba komplety. |
| `verified` | Trwały punkt zatwierdzenia. Zwykłe otwarcie i nowe zapisy są dozwolone. Kolejne recovery nie porównuje zmienionej przez aplikację bazy ze starym hashem kopii. |
| Uszkodzony dziennik, niezgodne ścieżki, brak obu lokalizacji lub sprzeczna tożsamość | Jawna odmowa startu; zachowane pliki i instrukcja odzyskania izolowanej kopii. Brak automatycznego usuwania lub zgadywania. |

Przed każdą podmianą zapis intencji przez prywatny plik tymczasowy, fsync pliku,
rename dziennika i fsync jego katalogu. Po podmianie fsync katalogu źródła
oraz celu, dopiero potem trwały zapis wyniku. Błąd fsync jest błędem operacji.
Staging jest ponownie walidowany przed zmianami, aby zmiana źródła nie omijała
kontroli. Poprzedni komplet pozostaje po potwierdzeniu; S3b nie dodaje GC.

## Układ i odmowy

Pierwsza wersja wspiera Linux i jawnie rozpoznane lokalne filesystemy.
Baza, staging, dziennik, kwarantanna oraz katalog docelowy załączników muszą
być na jednym urządzeniu, bez zagnieżdżenia lub kolizji ścieżek. Źródło kopii
może być na innym urządzeniu, ponieważ jest kopiowane przed podmianą.
Wszystkie ograniczenia i dostępność miejsca są sprawdzane przed rename danych.
ENOSPC/EACCES podczas przygotowania pozostawiają stary komplet; po intencji
zatrzymują operację, która po usunięciu przyczyny jest dokańczana pod lockiem.

## Zlecenie i przyszły klient

Klient przekazuje ID kopii, klucz idempotencji i jawne potwierdzenie pełnego
restore. Warstwa aplikacji sprawdza politykę operatora i aktora oraz rozwiązuje
ID na zaufaną ścieżkę. Dowód zlecenia i wynik są poza bazą. Wykonanie jest
osobnym krokiem: po utrzymaniu, wygaszeniu zweryfikowanych własnych procesów
i zamknięciu SQLite następuje przejęcie locka. Nie ma podmiany otwartej bazy.
S3b dostarcza protokół i offline CLI; nie udostępnia nowych tras HTTP/MCP,
nie implementuje utrzymania GUI ani automatycznego restartu usługi.

SIGKILL dowodzi odporności na utratę procesu. Próby nie dowodzą odporności
na utratę zasilania, awarię urządzenia ani ochrony przed procesem tego samego UID.
