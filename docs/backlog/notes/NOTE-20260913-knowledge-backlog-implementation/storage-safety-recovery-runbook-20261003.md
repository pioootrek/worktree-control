# Odbiór aktualizacji i odzyskania oraz przekazanie do S6

Zakres uzgodniony 2026-10-03: kod i izolowane testy teraz; docelowy host,
klucze oraz rollout osobno. Poniższa procedura nie uruchamia wdrożenia.
Backupy pozostają opcjonalne, z konfiguracją usługi wyłącznie przez CLI.
Harmonogramy użytkowników działają tylko w granicach tej polityki.

## Powtarzalna próba pakietów

1. Przygotować czysty, osobny checkout
   `a727fd8ff01e141c6494615531e27e72a23f6320`, z jego oryginalnym lockfile.
   To historyczny fixture schematu 24, nie deklaracja wersji produkcyjnej.
   Użyć `pnpm install --frozen-lockfile`, odkrytego presetu WTS `build`
   i istniejącego w tym wydaniu `pnpm package:trial`. Jeśli dla pakowania
   nie ma presetu, użyć tego skończonego polecenia sekwencyjnie.
2. Zachować tarball i `provenance.json`. Sprawdzić czysty source SHA, hash,
   rozmiar pakietu, wersję Node, platformę i pochodzenie modułu SQLite.
   Starego źródła nie poprawiać na potrzeby udanej próby.
3. Zbudować czysty bieżący checkout przez jego odkryty preset WTS. W osobnym,
   tymczasowym profilu testów wskazać lokalne pliki przez
   `WORKTREE_SWITCHER_TEST_OLD_ARTIFACT`, `WORKTREE_SWITCHER_TEST_OLD_PROVENANCE`,
   `WORKTREE_SWITCHER_TEST_RESTIC` i `WORKTREE_SWITCHER_TEST_REST_SERVER`.
   Ostatnie dwa wskazują zweryfikowane binaria fixture, nie produkcyjne klucze.
4. Przez `list_worktrees` i `list_test_presets` ustalić dokładną ścieżkę i preset
   `node:test:package:upgrade`. Uruchomić `run_test`, zachować idempotency key
   i odpytywać `get_test_run` do stanu końcowego. Nie zastępować kolejki tym samym
   poleceniem uruchomionym bezpośrednio. Po teście usunąć własny profil i przypisania.
5. Zachować zweryfikowany raport z source/artifact SHA, wynikami, trybem cleanup,
   odmowami dostępu i ograniczeniami. Test diagnostyczny samego sterownika
   nie zastępuje pełnego smoke pakietu. Nie przechowywać tokenów ani surowych
   błędów aplikacji w raporcie.

Oba pakiety instalują się do osobnych katalogów z zależnościami produkcyjnymi.
Aplikacja, CLI, HTTP, assets i SQLite pochodzą z tych instalacji. Sterownik testu,
przechwycenie wywołań systemowych i sterowanie procesami pochodzą z repozytorium.
Hash pakietu i skopiowanych wykonywalnych pomocników jest sprawdzany przed użyciem.

Pozytywny historyczny fixture używa `umask 0077`, zgodnego z definicją starej
usługi. Osobny wariant `0022` ma zostać odrzucony przez nową wersję przed migracją,
bez zmiany bajtów, schematu i praw. Przed prawdziwą aktualizacją operator sprawdza
własność, aliasy i prawa wybranych katalogów danych/stanu/kopii. Ewentualne zawężenie
praw jest jawną operacją po tej inspekcji; fixture nie naprawia ich ukrytym chmod.

Stare API obsługuje ownera, agentów, granty, dyskusje i odpowiedzi, zadania,
historię, pamięć i załączniki. Relacja `derived_from` powstaje przez
`task_from_thread`; arbitralna operacja `create_relation` nie istnieje.
Scoped agent nie otrzymuje uprawnienia zatwierdzania wiedzy zarezerwowanego dla
ownera. Stare `backup create|restore` przyjmują pojedynczy katalog, a ścieżki
instalacji przez `WORKTREE_SWITCHER_DATA_DIR` i `WORKTREE_SWITCHER_STATE_DIR`.

Próba ma obejmować domyślne backup-off oraz włączony gate przed migracją,
cztery reprezentatywne przerwania procesu, odmowy dla uszkodzonego/nieobsługiwanego
źródła i zajętej bazy, zastąpienie poprzedniej generacji, ponowny restart po nowych
zapisach i odtworzenie historycznej kopii do osobnego katalogu. Przed odzyskaniem
z HTTPS usuwa wszystkie oryginalne i pochodne lokalne dane fixture. Następnie
porównuje treści, historię, audyt, bajty załączników i uprawnienia odzyskanej instalacji.
Szersze macierze awarii pozostają w raportach S1–S4; SIGKILL nie jest testem zaniku zasilania.

## Późniejsza operacyjna próba odzyskania

1. W osobnym zakresie wdrożenia wybrać host, właściciela operacji, profil CLI,
   okno przerwy i kryteria odbioru. Sprawdzić faktyczne zainstalowane wydanie
   i schemat; nie przenosić numerów fixture na produkcję. Zabezpieczyć stare
   i nowe pakiety z sumami. Uzgodnić wpływ zatrzymania kontrolera na jego serwery
   i kolejkę testów.
2. Przy backupach wyłączonych pominąć tworzenie kopii i transfer, zachowując
   kontrolę schematu, integralności i odbiór aplikacji. Ten profil nie zapewnia
   powrotu przez odtworzenie kopii. Przy włączonej ochronie wskazać pełną kopię
   i sprawdzić ją przed migracją. Błąd wymaganego gate zatrzymuje migrację.
3. Przy ochronie zdalnej zapisać repozytorium, jego kryptograficzną tożsamość,
   wybrany punkt odzyskania oraz wiek danych `dataAt`. Zapewnić dostęp do klucza
   szyfrowania, danych dostępu i pakietu także bez źródłowego hosta i jego SQLite.
   Kluczy nie wpisywać do raportu ani argumentów zapisujących je w historii powłoki.
4. Zatrzymać jedynego właściciela bazy i uzgodniony automatyczny restart usługi.
   Przy zmianie celu postępować według procedury `backup remote rebind` w README:
   przygotować nowe parametry, zachować stare receipts/pins i wznowić usługę
   dopiero z pasującą konfiguracją. Nowy cel wymaga własnego potwierdzenia oraz
   próby odzyskania; stary sukces go nie chroni.
5. Pobrać wybrany zdalny snapshot przez restic do świeżego prywatnego katalogu,
   z weryfikacją odtworzenia (`restore <snapshot-id> --target <directory> --verify`)
   i uprzednio przygotowaną konfiguracją repozytorium oraz plikami kluczy.
   Nie polegać na utraconym lokalnym dzienniku transferów. Z właściwego
   zainstalowanego pakietu wykonać offline `backup restore <directory>` dla
   jawnie wskazanych katalogów danych/stanu. Polecenie sprawdza manifest, bazę,
   załączniki i wyłączną własność przed zastąpieniem danych.
6. Uruchomić odzyskaną instalację w uzgodnionej izolacji. Sprawdzić rekordy,
   historię/audyt, hashe załączników i dozwolony oraz zabroniony dostęp.
   Offline restore odtwarza poświadczenia ze snapshotu: skontrolować dawne
   sesje, tokeny i granty oraz odwołać nieaktualne przed udostępnieniem usługi.
   Online/catalog restore ma osobny fence unieważniający sesje i scoped
   credentials; nie zakładać, że oba tryby mają identyczny skutek.
7. Powrót do starego wydania wykonywać z pasującą starą kopią w osobnym katalogu.
   Nie uruchamiać starego kodu na zmigrowanej bazie. Najpierw zabezpieczyć
   i rozliczyć zapisy powstałe po aktualizacji; wybrać przeniesienie zmian
   albo naprawę naprzód, zamiast cicho je odrzucać.
8. Zapisać faktyczny wiek odzyskanych danych, utracone zmiany, czas całego
   odtworzenia, wynik sprawdzeń, cleanup i ograniczenia. Dopiero rzeczywista
   próba poza hostem może stanowić dowód operacyjnego RPO/RTO. Wznowić dostęp
   po odbiorze operatora; monitor i kanał powiadomień skonfigurować dla wybranej
   polityki w osobnym zakresie operacyjnym.

Osiągnięcie limitu dziennika jest jawną odmową dalszych operacji, a nie zgodą
na kasowanie receipts. W szczególności 1024 zachowane ręczne klucze idempotencji
nie mają automatycznego resetu; nie usuwać ani nie edytować dziennika i nie
zakładać, że offline `backup create` omija ten limit. Trwały workflow zarządzania
tym limitem pozostaje osobnym zadaniem przed szerszym użyciem operacyjnym.

## Przekazanie do S6

S6 oznacza przełączenie wybranego projektu na jeden zapis przez Switchera,
zgodnie z [planem](storage-safety-implementation-plan.md#s6-przełączenie-pierwszego-projektu-i-zamknięcie-tematu).
Po spełnieniu odbioru funkcjonalnego K7 właściciel wybiera projekt i okno zmiany.
Końcowy import musi rozliczyć rekordy, autorstwo, daty, relacje i załączniki.
Człowiek i dwaj agenci sprawdzają GUI/MCP/CLI, odmowy dostępu i trwałość po restarcie.
Instrukcje oraz narzędzia przechodzą na jedno miejsce zapisu; stare pliki zostają
archiwum. Uzgodniony okres obserwacji obejmuje normalną pracę, a przy włączonych
backupach również kopię i próbę odzyskania.

Techniczny odbiór S5 nie zamyka tego przełączenia, K7–K9, produkcyjnego rolloutu
ani zadania publikacji pakietu. Pozostają one w rekordach rodziców backloga.
