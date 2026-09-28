# Plan domknięcia bezpieczeństwa danych SQLite

Data: 2026-09-28. Status: zapisany plan, implementacja nierozpoczęta.
Zadanie: [RWK-20260928-sqlite-data-safety](../../rework/RWK-20260928-sqlite-data-safety.json).
Podstawa: [ocena kodu i ryzyk](storage-safety-assessment-20260928.md) na
`be4e6556f4d2582583e521d6b3fb33e430d6c789` oraz
[plan migracji wiedzy](implementation-plan.md).

## Cel i zakres

Przygotować Switchera do utrzymywania backloga, dyskusji i pamięci jako jedynego
źródła zapisu w SQLite. Aktualizacja, backup i odtwarzanie mają zachowywać dane
oraz jasno odmawiać działania, gdy ich bezpieczeństwa nie da się potwierdzić.

Zostają jeden kontroler, lokalny SQLite, obecne API i osobny magazyn załączników.
Nie wprowadzamy PostgreSQL ani ORM w ramach tej pracy. Eksport do plików służy
przenoszeniu danych i odczytowi, nie równoległej edycji. Dokumenty związane
z wersją kodu i AGENTS.md pozostają w Git.

Zapis planu nie uruchamia wdrożenia, nie przełącza prawdziwego projektu i nie
zmienia kont systemowych ani usług. Etapy S1–S5 przygotowują oprogramowanie
i dowody odbioru; S6 opisuje późniejsze przełączenie wskazanego projektu.

## Kolejność

| Etap | Wynik | Zależności |
| --- | --- | --- |
| S0 | Ustalony kontrakt bezpieczeństwa i odzyskiwania | Ocena istniejącego kodu |
| S1 | Wyłączny właściciel bazy, trwałe zapisy i prywatne pliki | S0 |
| S2 | Kopia przed zmianą i bezpieczny migrator | S1 |
| S3 | Trwałe załączniki i odtwarzanie po przerwaniu | S1–S2 |
| S4 | Regularne kopie i procedura odzyskiwania | S2–S3 |
| S5 | Raport prób aktualizacji, awarii i odtworzenia | S1–S4 |
| S6 | Jeden projekt przełączony na jedno miejsce zapisu | S5 i odbiór funkcjonalny K7 |

Każdy etap implementacyjny powinien mieć osobny, ograniczony zakres przeglądu.
Przed rozpoczęciem odświeżyć stan kodu i ustalić aktualną gałąź docelową według
obowiązującego workflow. Historyczny plan gałęzi K0/K1 nie wyznacza automatycznie
gałęzi dla tej pracy. Raport etapu wskazuje SHA, zakres, wyniki i pozostałe braki.

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
rozstrzygnięte przed S6. Ochrony przed agentem tego samego UID nie wolno uznać
za wdrożoną bez osobnej granicy uprawnień i testu odmowy dostępu.

## S1. Własność bazy, trwałość i prawa plików

Obszary: `paths.ts`, `controller-lock.ts`, adapter SQLite, bootstrap kontrolera,
offline CLI, ścieżki tworzenia i odtwarzania plików.

- Powiązać wyłączną własność z kanonicznym zasobem bazy, także gdy dwa wywołania
  wskazują różne katalogi stanu. Zachować istniejący lock kontrolera i wspólną
  koordynację cyklu życia; nie tworzyć niezależnych reguł dla każdego transportu.
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
- Przed aktualizacją istniejącej bazy wykonać zweryfikowaną kopię z metadanymi
  poprzedniego schematu, aplikacji i powiązanymi załącznikami. Obsłużyć starsze
  schematy bez tabel wiedzy. Nieudany backup blokuje migrację.
- Zmianę schematu/danych i wpis migracji zapisywać w tej samej transakcji.
  Objąć kontrolowaną inicjalizacją również bazowy DDL. Historyczne migracje
  zamrozić; nowe opatrywać nazwą i checksumą. Starszym zapisom nie przypisywać
  fikcyjnego statusu historycznie zweryfikowanej checksumy.
- Przy przebudowie zachować indeksy, triggery i widoki. Sprawdzić FK, integralność
  i reguły domenowe przed przyjmowaniem żądań. Błąd zamyka zasoby i zatrzymuje start.
- Ponowienie rozpoznaje zatwierdzone kroki; nie tworzy bez ograniczeń kolejnych
  kopii przy pętli nieudanego startu. Retencja nie usuwa jedynej kopii ratunkowej.

Odbiór: kopia wykonana nowym programem zawiera stary schemat sprzed migracji.
Znane stare bazy przechodzą do aktualnej wersji bez utraty rekordów; nowszy
schemat pozostaje niezmieniony po odmowie. Awaria wewnątrz kroku wycofuje ten
krok i jego wpis, a ponowny start bezpiecznie rozpoznaje wcześniejsze kroki.

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

## S4. Backup operacyjny i instrukcja odzyskiwania

- Dodać operację backupu wewnątrz kontrolera na jego połączeniu SQLite, aby
  harmonogram nie wymagał ciągłego zatrzymywania serwerów. Serializować backupy;
  zagwarantować dostępność obiektów wskazanych przez migawkę do końca kopiowania.
- Publikować tylko ukończone i sprawdzone kopie. Ograniczyć zużycie zasobów,
  sprzątać rozpoznane niekompletne kopie, raportować datę ostatniego sukcesu
  i błąd ostatniej próby. Błąd kopii nie może być raportowany jako sukces.
- Wdrożyć konfigurowalny harmonogram, retencję i niezależną kopię poza hostem.
  Wybrać mechanizm na podstawie S0; dane dostępowe nie trafiają do backloga.
  Nie zakładać, że sam backup lokalny spełnia wymaganie utraty hosta.
- Przygotować procedurę odtworzenia na pustej instalacji: artefakt aplikacji,
  zgodność schematu, uprawnienia, klucze, dane i załączniki, test dostępu oraz
  ponowna ocena przywróconych poświadczeń. Stary backup może przywrócić dawny
  stan unieważnienia tokenów, więc opisać rotację po incydencie.
- Opisać rollback przed i po przyjęciu nowych zapisów. Po nowych zapisach
  najpierw zabezpieczyć bieżący stan; określić eksport zmian lub naprawę naprzód.

Odbiór: kopia powstaje podczas pracy kontrolera i przechodzi niezależne
odtworzenie. Retencja i awaria celu kopii mają testy. Zmierzony wiek kopii oraz
czas odtworzenia mieszczą się w uzgodnionych wymaganiach. Ochronę i dostępność
kopii poza hostem potwierdzić przed S6, nie tylko opisać w konfiguracji.

## S5. Dowody odbioru

| Próba | Oczekiwany wynik |
| --- | --- |
| Wspierane stare schematy → aktualny; ponowne otwarcie | Dane, tożsamości i historia zachowane, brak ponownej transformacji |
| Nowa baza; inicjalizacja przerwana; nieznana wersja | Jawne rozpoznanie stanu, bez cichego resetu ani osłabienia uwierzytelniania |
| Błąd SQL lub zabicie procesu w migracji | Brak połowicznego kroku, rejestr zgodny z danymi |
| Backup przed migracją; błąd backupu | Stary schemat w kopii; migracja nie zaczyna się po błędzie |
| Przerwanie uploadu, importu i restore | Brak opublikowanych referencji do brakujących obiektów; recovery zgodne z S3 |
| Pełny dysk i brak praw zapisu | Czytelny błąd, zachowane dane i materiał do odzyskania |
| Zmieniony hash, brak załącznika, złe FK, symlink, zbyt duży manifest | Odmowa przed podmianą bieżących danych |
| Dwa procesy, ta sama baza, różne katalogi stanu | Jedna skuteczna operacja właściciela |
| Odtworzenie poza źródłową instalacją | Zgodne rekordy, załączniki, historia, dostęp i konfiguracja |
| Powrót po nowych zapisach | Nowe zmiany zachowane lub jawnie rozliczone; brak cichego ich porzucenia |

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

## S6. Przełączenie pierwszego projektu i zamknięcie tematu

Po spełnieniu S0–S5 oraz kryteriów funkcjonalnych K7 przygotować konkretny raport
dla wskazanego projektu. Decyzja o rzeczywistym przełączeniu jest osobnym krokiem
operacyjnym; samo zlecenie zapisania tego planu jej nie udziela.

1. Ustalić właściciela operacji, punkt odniesienia w Git, okno zamrożenia zapisów
   i gotową kopię ratunkową. Zablokować równoległą edycję źródłowych plików.
2. Powtórzyć import na końcowym commicie. Rozliczyć rekordy, treści, autorstwo,
   daty, relacje, załączniki i każde pominięte lub nierozwiązane mapowanie.
3. Odtworzyć tę konkretną kopię; sprawdzić GUI/MCP/CLI, człowieka i dwóch agentów,
   odmowy dostępu oraz zapis i odczyt po rzeczywistym restarcie kontrolera.
4. Przełączyć instrukcje i narzędzia na jeden zapis przez Switchera. Stare pliki
   pozostawić jako archiwum. Ewentualny eksport musi być oznaczony jako pochodny.
5. Przeprowadzić okres codziennej pracy obejmujący backup i próbę odzyskania;
   proponowane minimum to siedem dni, do uzgodnienia przed przełączeniem.
   Zapisać napotkane problemy i decyzję o dopuszczeniu kolejnych projektów.

Zadanie ochrony danych zamknąć po S5 i dostarczeniu procedury S6. Faktyczne
przełączenie i jego okres obserwacji pozostają kryterium rodzica
`FEAT-20260905-shared-project-memory`; zamknięcie technicznego zadania nie zamyka
automatycznie K7, K8 ani K9. Przy zamknięciu zastąpić otwarty rekord wpisem
`done/` z dowodami w jednym commicie, zgodnie z regułami backloga.
