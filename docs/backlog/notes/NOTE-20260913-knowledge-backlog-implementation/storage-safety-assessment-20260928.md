# Bezpieczeństwo danych i przejście z plików do SQLite

Data: 2026-09-28. Status: ocena i propozycja, bez zgody na przełączenie danych.
Przegląd kodu na `be4e6556f4d2582583e521d6b3fb33e430d6c789`.
Nie otwierano działającej bazy, nie zmieniano usługi ani ustawień hosta.

## Rekomendacja

SQLite pasuje do jednego lokalnego kontrolera. Przeniesienie backloga,
dyskusji i pamięci do jego API daje transakcje, kontrolę równoczesnych zmian
i historię operacji. Nie wymaga teraz PostgreSQL. Pełne przełączenie warto
poprzedzić poprawą migracji i odtwarzania oraz próbą awarii na kopii.

„Całkiem z plików” powinno oznaczać jedno autorytatywne miejsce zapisu wiedzy.
SQLite nadal zapisuje pliki na dysku. W obecnej architekturze treści rekordów
są w bazie, a bajty załączników w osobnym katalogu. Kod, AGENTS.md i dokumenty
opisujące konkretną wersję programu powinny nadal być wersjonowane z kodem.
Eksport JSON/Markdown może pozostać czytelną kopią, ale nie drugim miejscem edycji.

## Co już istnieje

- [Adapter SQLite](../../../../src/server/infrastructure/sqlite/sqlite-state-store.ts)
  włącza WAL, klucze obce i limit oczekiwania na blokadę. Operacje wiedzy mają
  transakcje, rewizje, historię i idempotencję w
  [KnowledgeQueries](../../../../src/server/infrastructure/sqlite/knowledge-queries.ts).
- [Migracje](../../../../src/server/infrastructure/sqlite/migrations.ts) mają
  numery 1–26. Kroki 2–26 zapisują zmianę i jej numer w transakcji. Migracja 25
  sprawdza klucze obce przed zatwierdzeniem przebudowy tabel.
- [Pełna kopia](../../../../src/server/controller-backup.ts) używa SQLite Backup
  API, dołącza załączniki wskazane przez migawkę i sprawdza rozmiary oraz SHA-256.
  Odtwarzanie sprawdza `integrity_check`. To właściwy kierunek; zwykła kopia
  działającego `state.sqlite3` może pominąć zmiany w WAL.
  Źródła: [Backup API](https://sqlite.org/backup.html),
  [WAL](https://sqlite.org/wal.html).
- [Pilot K7a](k7a-token-pilot-20260927.md) dokumentuje udany import i odtworzenie
  143 załączników na izolowanej kopii. Dotyczy schematu 25 i wskazanych tam
  rewizji. Nie jest testem nagłego przerwania ani dowodem wykonania cutoveru.
- [Import](../../../../src/server/modules/knowledge/hub-import-execution.ts)
  wiąże plan z commitem i hashem, wznawia staging oraz publikuje dane atomowo
  w SQLite. Powtórny import chroni lokalnie zmienione rekordy przed nadpisaniem.

## Braki przed jedynym źródłem danych

| Priorytet | Obserwacja w kodzie | Zalecana zmiana |
| --- | --- | --- |
| Przed przełączeniem | `backup create` tworzy `SqliteStateStore`, którego konstruktor migruje bazę przed backupem. | Oddzielić otwarcie i inspekcję bazy od migracji. Kopia sprzed aktualizacji musi powstać przed pierwszą zmianą schematu. |
| Przed przełączeniem | `initializeSchema` nie odrzuca nowszego schematu. Górny limit 26 występuje w restore, nie w zwykłym otwarciu. Dokumentacja obiecuje więcej niż kod. | Jedno źródło obsługiwanej wersji; kontrola przed DDL i zmianami ustawień bazy; stary program odmawia dostępu do nowszej bazy. |
| Przed przełączeniem | Adapter nie ustawia `synchronous`; zainstalowany pakiet better-sqlite3 13.0.3 w checkout main ma `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`. | Jawne `synchronous=FULL` dla trwałej wiedzy, kontrola efektywnego ustawienia i pomiar kosztu zapisu. Nie zakładać ustawień działającej usługi na podstawie checkoutu. |
| Przed przełączeniem | Restore przestawia bazę, WAL/SHM i katalog załączników kolejnymi `renameSync`. Obsługa wyjątków cofa zmiany, lecz nie działa po SIGKILL lub utracie zasilania. | Trwały dziennik odtwarzania albo generacje katalogów z atomowym wskazaniem aktywnej generacji, synchronizacja dysku i odzyskiwanie po restarcie. Zachować poprzednią generację do weryfikacji nowej. |
| Przed przełączeniem | Pliki załączników i transakcja SQL są odrębnymi zapisami. Upload zapisuje i zamyka plik, lecz nie wykonuje `fsync`. | Zapewnić trwałość pliku i wpisu katalogowego przed zatwierdzeniem referencji SQL; kontrolować brakujące i osierocone obiekty. Samo FULL dla SQLite nie zabezpieczy załączników. |
| Przed przełączeniem | Brak wymuszenia prywatnych praw katalogu danych i bazy w adapterze. Generator usługi Linux ustawia `UMask=0077`, lecz bezpośredni CLI nie ma tej samej gwarancji. | Jawne prawa 0700/0600, bezpieczne tworzenie i weryfikacja własności także dla CLI, kopii, WAL/SHM i odtworzenia. Nie rozszerzać uprawnień istniejących plików. |
| Przed przełączeniem | Restore sprawdza integralność SQLite, ale nie `foreign_key_check`; manifest fizycznej kopii jest rzutowany na typ bez walidacji schematu. | Walidacja manifestu, limitów, zwykłych plików i ścieżek bez symlinków, kontrola FK oraz relacji aplikacyjnych i hashy załączników. |
| Przed przełączeniem | Istnieją ręczne backupy, ale przejrzany kod nie zapewnia harmonogramu, niezależnej kopii i alarmu po błędzie backupu. | Wdrożyć i przetestować politykę backupu zgodną z dopuszczalną utratą danych. Kopia na tym samym dysku nie wystarczy na awarię hosta. |
| Wzmocnienie migratora | `schema_migrations` ma tylko numer i datę; początkowe `database.exec(schema)` jest poza transakcjami kroków. | Niezmienne migracje z nazwą i checksumą, jawna obsługa inicjalizacji oraz niekompletnego startu. Nie dopisywać historycznych checksum jako rzekomo zweryfikowanych. |
| Wzmocnienie własności | [Ścieżki](../../../../src/server/paths.ts) wiążą lock z katalogiem stanu, a bazę z osobno konfigurowanym katalogiem danych. | Związać wyłączną własność także z kanonicznym zasobem bazy; przetestować tę samą bazę z różnymi katalogami stanu. |

WAL z `synchronous=NORMAL` zachowuje spójność, ale po awarii hosta może utracić
ostatnio zatwierdzone transakcje. `FULL` dodaje synchronizację przy zatwierdzeniu;
nadal zależy od poprawnego działania systemu plików i sprzętu. `integrity_check`
nie zastępuje `foreign_key_check`.
Źródło: [PRAGMA](https://sqlite.org/pragma.html).

To ustalenia z analizy źródeł, nie wyniki nowych testów awarii. Nie zmierzono
efektywnych ustawień, praw dostępu ani wersji silnika działającej instalacji.

## Poufność i agenci

Przejście do SQLite samo nie szyfruje danych ani nie izoluje agentów. Proces
mający dostęp do plików jako ten sam użytkownik systemowy może je czytać,
zmieniać lub usuwać z pominięciem grantów HTTP/MCP. Historia w tej samej bazie
również nie jest odporna na taką ingerencję. To wynika z granicy uprawnień
systemu operacyjnego, nie z wyboru formatu danych.

Jeśli ochrona przed agentem z powłoką jest wymaganiem, kontroler i jego dane
powinny mieć osobną tożsamość systemową, niedostępną agentowi, a agent powinien
korzystać wyłącznie z API z ograniczonym tokenem. Sam kontener ze wspólnym
montowaniem katalogu danych lub z uprawnieniami administracyjnymi tego nie daje.
Osobna kopia powinna być niedostępna do usunięcia przez tę samą tożsamość.
To propozycja architektury, bez zmiany kont i usług w ramach tej oceny.

Dla kradzieży dysku potrzebne jest szyfrowanie dysku lub bazy i szyfrowane
kopie z osobno przechowywanym kluczem. Nie chroni to przed uprawnionym procesem
na odblokowanej maszynie. Standardowy format SQLite nie zapewnia takiej
poufności; SQLite oferuje ją m.in. przez osobne
[SQLite Encryption Extension](https://sqlite.org/see/doc/trunk/www/readme.wiki).
SHA-256 w edytowalnym manifeście wykrywa przypadkowe uszkodzenia, ale nie dowodzi
autentyczności kopii wobec osoby, która może podmienić pliki i manifest.

## Jak zarządzać kolejnymi migracjami

Proponowany proces aktualizacji programu:

1. Przejąć wyłączną własność bazy i zatrzymać przyjmowanie zapisów. Odczytać
   wersję bez automatycznej migracji; odrzucić nieobsługiwaną wersję i
   nieoczekiwane definicje. Sprawdzić dostępne miejsce.
2. Wykonać zweryfikowaną kopię przed migracją, z załącznikami, wersją aplikacji
   i schematu. Jeśli kopia się nie uda, nie rozpoczynać aktualizacji.
3. Uruchamiać numerowane, niezmienne kroki. Każdy krok zapisuje DDL/DML i
   wpis w rejestrze migracji w tej samej transakcji. Błąd zatrzymuje start
   kontrolera. Wcześniejsze zatwierdzone kroki pozostają zapisane; nie zakładać
   automatycznego cofnięcia całej wieloetapowej aktualizacji.
4. Sprawdzić integralność, FK, reguły aplikacji oraz załączniki przed
   udostępnieniem usługi. Przebudowy tabel muszą zachować indeksy, triggery
   i widoki zgodnie z faktycznym schematem.
   Źródło: [procedura ALTER TABLE](https://sqlite.org/lang_altertable.html).
5. Preferować dodanie nowych pól, przeniesienie danych i późniejsze usunięcie
   starych pól. Nie edytować już wydanych migracji w celu naprawy produkcji.
6. Powrót do starej aplikacji wymaga kompatybilnego schematu albo odtworzenia
   kopii. Jeśli po aktualizacji przyjęto nowe zapisy, odtworzenie starej kopii
   je utraci. Najpierw zabezpieczyć bieżący stan i ustalić sposób przeniesienia
   zmian; po otwarciu zapisów często bezpieczniejsza jest migracja naprawcza.

Nie ma potrzeby wprowadzania ORM tylko dla migracji. Obecny adapter może zostać,
jeśli dostanie wspólny migrator i procedurę recovery. ORM nie zastępuje kopii,
kontroli wersji, testów i izolacji uprawnień.

## Warunki przełączenia jednego projektu z Huba

1. Zabezpieczyć źródłowy commit i pliki. Zatrzymać ich edycję na czas końcowego
   importu i wskazać jednego właściciela przełączenia.
2. Importować do izolowanej kopii. Porównać ID, treści, daty, historyczne
   autorstwo, statusy, relacje, oryginalne payloady i bajty załączników.
   Każde `source-only`, `skipped` lub nierozwiązane mapowanie wymaga oceny.
3. Odtworzyć pełny backup w pustej lokalizacji i zweryfikować odczyt przez
   GUI/MCP oraz uprawnienia. Eksport projektu nie zastępuje pełnej kopii
   tożsamości, konfiguracji i stanu importów kontrolera.
4. Dopiero po odbiorze ustawić SQLite jako jedyne miejsce zapisu tego projektu.
   Zmienić instrukcje agentów, aby nie dopisywali równolegle do starego backloga.
   Zachować Git jako archiwum i ewentualny automatyczny eksport do odczytu.
5. Sprawdzić codzienną pracę na jednym projekcie przed przełączeniem reszty.
   Powrót do edytowalnych plików po nowych zapisach w SQLite wymaga eksportu
   i uzgodnienia zmian; stary commit nie zawiera tych zapisów.

Propozycja polityki do uzgodnienia: kopia przed każdą migracją/importem,
regularne kopie zgodnie z wybraną maksymalną utratą danych, część kopii poza
hostem oraz cykliczna próba odtworzenia. Najpierw ustalić, czy akceptowalna
utrata to np. godzina czy doba pracy, i ile może trwać przerwa. Obecne CLI
backup działa offline pod lockiem, więc częsty harmonogram wymaga zaplanowanych
przerw albo nowej operacji backupu w kontrolerze. SQLite Backup API umożliwia
kopiowanie działającej bazy; spójność z załącznikami pozostaje zadaniem aplikacji.

## Próby wymagane przed akceptacją

- Aktualizacja reprezentatywnych baz ze wspieranych wydań; powtórne otwarcie;
  odmowa starego programu wobec nowszego schematu.
- Przerwanie procesu podczas migracji, zapisu załącznika i każdego etapu
  restore; poprawny restart bez pozorowania nowej pustej instalacji.
- Pełny dysk, brak praw zapisu, błędny checksum, brak załącznika i naruszone FK.
- Odtworzenie w pustym katalogu z weryfikacją danych, grantów i historii.
- Backup sprzed migracji rzeczywiście zachowuje stary schemat.
- Ten sam plik bazy przy różnych katalogach stanu nadal ma jednego właściciela.

SIGKILL sprawdza awarię procesu, ale nie symuluje utraty buforów systemu i dysku.
Odporność na utratę zasilania wymaga osobnego środowiska i testów I/O.
Na tej podstawie rekomenduję najpierw domknięcie ochrony danych, następnie
kontrolowane przełączenie jednego projektu. Ocena nie zatwierdza migracji.
