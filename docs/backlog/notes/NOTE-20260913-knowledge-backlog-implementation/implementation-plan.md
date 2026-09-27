# Wdrożenie backloga i pamięci projektu w Worktree Switcher

## Aktualny stan, 2026-09-27

Sprawdzona rewizja `main`: `17d0c9d`. Poniższa sekwencja K0–K9 opisuje plan
z 13 września; nie należy ponownie zaczynać implementacji od K0/K1.

| Etap | Dostarczone | Pozostały odbiór lub implementacja |
| --- | --- | --- |
| K0 | Kontrakt, inwentaryzacja, fixture i pomiary; DONE-20260927-knowledge-k0-contracts | Zamknięty zakres przygotowawczy, bez zgody na migrację danych. |
| K1 | Trwała tożsamość i granty; DONE-20260926-knowledge-k1-identity | Etap 1 auth i luka CLI w open zamknięte w DONE-20260927-independent-auth-modes. |
| K2–K3 | Serwis/SQLite, HTTP/MCP/CLI i dashboard, PR #42/#43 | Powiązać kryteria z bieżącymi testami, bez ponownej implementacji. |
| K4 | Pamięć, zatwierdzanie rewizji, wyszukiwanie i kontekst, PR #44 | Zachować testy kontekstu kolejnej sesji i unieważniania zatwierdzeń. |
| K5 | Załączniki, backup kontrolera i logiczny transfer projektu, PR #45/#46 | Potwierdzić restore na danych wybranego pilota. |
| K6 | Planowanie i wznawialny import Huba, PR #47/#48 oraz poprawki #51/#52 | Sprawdzić raport mapowania i nierozwiązane relacje dla wybranego źródła. |
| K7a | Skrypty pilota i poprawki GUI/importu, PR #49–#52; token-mode i próba na kopii przy `6423734` ([raport](k7a-token-pilot-20260927.md)) | Zapisywać metodę uwierzytelnienia partii importu; próba nie zatwierdza przełączenia. |
| K7 | Brak potwierdzonego przełączenia w tym przeglądzie | Jeden wybrany projekt, jedno miejsce zapisu, odbiór importu/restore i próba codziennej pracy. |
| K8–K9 | Plan | Playbooki, inspekcja instrukcji i składanie zatwierdzonych reguł. |

[Przegląd dowodów i luk](../NOTE-20260829-readiness-assessment/reconciliation-20260927.md)
odróżnia zielone CI od odbioru rzeczywistej migracji. Git-backed backlog tego
repozytorium pozostaje źródłem prawdy. Etapy K2–K7a są już scalone na main;
opis gałęzi integracyjnej niżej dotyczy zakończonej serii PR-ów.

## Historyczny plan

Stan: propozycja wdrożenia z 2026-09-13, bez zmian runtime i bez migracji danych.
Zadanie nadrzędne: [FEAT-20260905-shared-project-memory](../../feature/FEAT-20260905-shared-project-memory.json).
Kierunek produktu: [shared-project-memory-plan.md](../../../shared-project-memory-plan.md).

Aktualna decyzja właściciela: [najpierw działające SQLite, PostgreSQL później](database-portability.md).
K1 i dalszy przepływ realizujemy na SQLite. Migracja do PostgreSQL i wybór ORM
nie są warunkami obecnego odbioru. Ta decyzja zastępuje wcześniejsze
zalecenie wdrożenia PostgreSQL przed K1/K2.

## Cel i granice pierwszego wydania

Użytkownik mówi agentowi „zapisz to na później”. Agent zapisuje wątek lub
zadanie przez MCP albo CLI. Użytkownik widzi je w Switcherze, odpowiada,
ustala priorytet i zakres. Kolejna sesja odczytuje aktualny kontekst wraz ze
źródłami. Całość działa bez commita, synchronizacji Huba i uruchamiania
serwera projektu.

Pierwsze wydanie obejmuje dyskusje, backlog, podstawową pamięć, wyszukiwanie,
historię zmian, eksport i sprawdzony import z Huba. Playbooki, inspekcja
instrukcji i ich składanie mają kolejne etapy. Własny klient czatu, embeddingi,
autonomiczne uruchamianie agentów, synchronizacja dwukierunkowa i publiczny
SaaS pozostają poza tym wdrożeniem.

Rekomenduję najpierw zamknąć pełny przepływ dla nowego, testowego projektu,
potem przeprowadzić próbny import, a następnie przełączyć jeden rzeczywisty
projekt. Samo pojawienie się tabel lub ekranu nie kończy etapu.

## Zweryfikowany punkt wyjścia

Plan opiera się na odczycie Switchera w commicie
`72452b5c842b21e918c56cfe9910dc39746a2a98` i Huba w commicie
`22afb656c74b2fde84cb92f1aefcf8b427697cc6`. Przed implementacją trzeba
sprawdzić różnice względem tych rewizji. Nie uruchamiano testów aplikacji
w ramach tego rozpoznania.

| Obszar | Stan w kodzie | Konsekwencja |
| --- | --- | --- |
| Aplikacja | Jeden kontroler Node, statyczny eksport Next.js, fasada `src/server/control-service.ts` | Nowy moduł wewnątrz obecnej aplikacji; bez drugiego serwera |
| SQLite | `src/server/infrastructure/sqlite/sqlite-state-store.ts` otwiera połączenie i przekazuje je helperom; migracje w `migrations.ts` | Wykorzystać właściciela połączenia i obecną kolejność migracji |
| Usuwanie projektu | `removeProject()` wykonuje `DELETE FROM projects`; część tabel ma `ON DELETE CASCADE` | Wiedza nie może mieć życia zależnego od tej tabeli |
| Tożsamość | MCP w `src/server/mcp-http-server.ts` sprawdza wspólny bearer; moduł `remote-verification` ma principal i granty `submit/read` | Sesja MCP i nazwa autora nie zapewniają trwałej tożsamości; granty testów nie są grantami wiedzy |
| Transporty | HTTP w `http-server.ts`, MCP w `mcp-runtime.ts`, bootstrap w `src/cli/index.ts` | Rozszerzyć rzeczywiste punkty wejścia, zachować wspólne operacje |
| GUI | `src/features/dashboard/use-dashboard.ts` zarządza sesją, SSE i odświeżaniem | Osobny obszar wiedzy korzysta z istniejącej sesji i subskrypcji |
| Backup | Dokumentacja zaleca SQLite backup API; wyszukiwanie w `src/` nie znalazło wywołania `backup()` | Implementację oraz odtwarzanie trzeba dostarczyć i przetestować |
| Hub | `bin/hub.py` waliduje osobno items, done, notes i docs; schematy mogą mieć nadpisania projektowe | Import nie może opierać się wyłącznie na `index.json` |
| Notatki Huba | Manifest dopuszcza dodatkowe pola i dowolne `body`; validator odkrywa pliki w katalogu notatki | Zachować nieznane pola i załączniki, nie ufać wyłącznie deklarowanemu `files` |

Podział modułów opisuje [codebase-organization.md](../../../codebase-organization.md).
[Ocena architektury](../../../architecture-effort-assessment.md) i
[plan self-hosted/SaaS](../NOTE-20260909-self-hosted-saas-plan/implementation-plan.md)
pozostają kontekstem. Ich przykłady nie dowodzą, że dana funkcja już działa.

## Zalecane decyzje techniczne

Poniższe decyzje są rekomendacjami do wdrożenia. Etap K0 utrwala ostateczne
kontrakty i rozstrzyga wskazane zależności.

1. **Jedna lokalna baza SQLite.** Dodać tabele wiedzy i helper zapytań do
   obecnego adaptera. Serwis przyjmuje interfejs `KnowledgeStore`, bez dostępu
   do obiektu SQLite. Moduł nie otwiera połączeń ani nie tworzy własnego
   kontrolera. Osobny plik bazy rozważyć dopiero przy rzeczywistym wydzieleniu.
2. **Trwały projekt wiedzy.** Identyfikator UUID niezależny od ścieżki, portu
   i rejestracji runtime. Opcjonalne powiązanie z runtime jest usuwalne;
   odłączenie runtime pozostawia projekt wiedzy dostępny w GUI i MCP.
   Ponowna rejestracja ścieżki nie łączy danych automatycznie. W K0 porównać
   ten model z `RemoteProjectIdentity`, która obecnie wymaga `sourceRemote`.
   Nie tworzyć dwóch niezależnych rejestrów tej samej tożsamości: wybrać
   wspólny model lub jawne mapowanie o ograniczonej unikalności.
3. **Wspólne operacje.** Nowe `src/server/modules/knowledge/index.ts` i
   serwis aplikacyjny; kontrakty bez Node w `src/shared/contracts/knowledge.ts`;
   SQL w `src/server/infrastructure/sqlite/knowledge-queries.ts`;
   UI i klient w `src/features/knowledge/`. To proponowane nowe ścieżki.
   `ControlService` pozostaje fasadą. Przenosić istniejący kod tylko wtedy,
   gdy wymaga tego implementowany przepływ.
4. **Treść i pochodzenie osobno.** Serwer zapisuje principal, czas i rewizję.
   Nazwa klienta/modelu to opis. Importowane `human:*` i `agent:*` zachować
   jako historyczne deklaracje, bez nadawania im uprawnień.
5. **Jawne konflikty.** Aktualizacje wymagają `expectedRevision`.
   Mutacja, historia, relacje i zapis klucza idempotencji są jedną transakcją.
   Powtórzenie tego samego żądania zwraca ten sam wynik; zmiana treści przy
   tym samym kluczu kończy się konfliktem. Sprawdzać uprawnienia także przy
   odtwarzaniu wyniku poprzedniego żądania.
6. **Proste wyszukiwanie.** Zacząć od indeksowanych filtrów i ograniczonego
   wyszukiwania tekstowego. FTS5 dodać po sprawdzeniu możliwości używanego
   SQLite i pomiarze na fixture. Bez zewnętrznej wyszukiwarki i bez inference.
7. **Pliki poza logami.** Załączniki w katalogu wiedzy, z identyfikatorem,
   hashem i rozmiarem w bazie. Brak automatycznego pobierania URL. Import
   zapisuje plik tymczasowy, weryfikuje hash, publikuje niezmienny obiekt,
   a następnie zatwierdza referencję. Przerwanie może zostawić osierocony
   obiekt, ale nie widoczny rekord wskazujący niedokończony plik.
8. **Eksport nie jest drugim miejscem zapisu.** Wersjonowany JSON zachowuje
   pełne dane, Markdown służy do czytania. Backup i odtwarzanie obejmują
   referencje do plików oraz ich hashe. Nie kopiować działającego SQLite/WAL
   zwykłym kopiowaniem plików.

## Minimalny kontrakt danych i operacji

Nazwy poniżej są propozycją, a nie już dostępnym API.

| Rekord | Minimalna treść i zachowanie |
| --- | --- |
| Projekt wiedzy | Stabilne ID, nazwa, archiwizacja, opcjonalne mapowania runtime/remote; bez wymogu repozytorium |
| Wątek i odpowiedź | Tytuł, Markdown, źródła, principal, rewizje; odpowiedź należy do wątku w tym samym projekcie |
| Zadanie | Tytuł, opis, rodzaj, priorytet, stan; opcjonalne zakres, kryteria odbioru, ryzyko i dowody |
| Pamięć | Treść, źródła, oznaczenie propozycji lub przyjętej decyzji, powiązanie `supersedes`; historia pozostaje dostępna |
| Relacja | Typ i końce należące do projektu; zewnętrzny link pozostaje opisanym odnośnikiem |
| Rewizja/zdarzenie | Kto zmienił co i kiedy; stan sprzed zmiany; zatwierdzenie dotyczy konkretnej rewizji |
| Źródło importu | Projekt źródłowy, commit, ścieżka, legacy ID, hash i oryginalny payload; ID źródłowe unikalne w obrębie źródła |
| Załącznik | Nazwa prezentacyjna, rozmiar, hash, typ, bezpieczny klucz obiektu i uprawnienia projektu |

Nowe zadanie wymaga tytułu, opisu i projektu; źródło może wskazywać bieżący
wątek lub zgłoszenie użytkownika. Formularz nie wymaga pełnego planu ryzyka
przy szybkim zapisie. Proponowane stany to `open`, `in_progress`, `blocked`,
`done`, `archived`; priorytety zachowują `now`, `next`, `later`.
Zakończenie zadania zapisuje podsumowanie i wynik weryfikacji, także jawne
„nie wykonano / nie dotyczy”. Otwarcie zakończonego zadania jest nowym
zdarzeniem. Usuwanie fizyczne danych nie wchodzi do pierwszego przepływu.

Operacje obejmują listę i szczegóły, zapis wątku/odpowiedzi/zadania, zmianę
zadania, utworzenie zadania z wątku, zapis i zastąpienie pamięci, pobranie
kontekstu zadania, eksport oraz osobne `planImport`/`applyImport`.
Wszystkie transporty przekazują zaufany kontekst autora do tego samego serwisu.
Odmowa dostępu, brak rekordu, konflikt i przekroczenie limitu mają stabilny
kod błędu; HTTP, MCP i CLI mapują go bez zmiany znaczenia.

Początkowe limity do pomiaru w K0: 25 rekordów na stronę, maksymalnie 100;
64 KiB treści pojedynczej mutacji; maksymalnie 256 KiB kompaktowego kontekstu.
Są to propozycje limitów produktu, bez zmiany polityki zasobów hosta.
Lista zwraca skróty; odpowiedzi i załączniki mają osobne stronicowane odczyty.
Limit importu jest oddzielny od limitu formularza i uwzględnia rozmiary
istniejącego archiwum. Każde pominięcie ma licznik i wskazanie dalszego odczytu.

## Etapy i warunki zakończenia

### K0. Kontrakty, próbka danych i pomiar bazowy

- Zrobić inwentaryzację schematów i nadpisań Huba, kategorii, stanów, notatek,
  done, relacji, dokumentów i załączników. Zapisać liczby i rozmiary, bez
  kopiowania prywatnych materiałów do fixture publikowanych w repozytorium.
- Ustalić model projektu, principal, uprawnień, rewizji, relacji i importu.
  Przejrzeć istniejące zadania o kontach i scoped MCP tokens. Wspólną część
  tożsamości wydzielić z pierwszym konsumentem, bez przebudowy całego runtime.
- Przygotować syntetyczny projekt z otwartym i zakończonym zadaniem, notatką,
  zagnieżdżonym załącznikiem, niestandardowym `body` i nierozwiązaną relacją.
- Zapisać punkt odniesienia dla istniejących testów i zasobów kontrolera.
  Szczególnie sprawdzić usunięcie projektu, blokadę kontrolera oraz brak
  kosztownych skanów Git przy odczycie wiedzy.

Odbiór: zatwierdzony technicznie kontrakt, tabela mapowania Huba, lista
nierozwiązanych pól i scenariusze negatywne. Najpierw rozstrzygnąć tożsamość
i usuwanie danych; bez nich nie udostępniać zapisu prawdziwych danych.

### K1. Trwała tożsamość i najwęższy zakres dostępu

Aktualizacja 2026-09-17: [globalne tryby CLI i plugin Better Auth](../NOTE-20260909-self-hosted-saas-plan/authentication-modes-and-plugin.md)
zastępują poniższy wymóg oddzielnego logowania właściciela do wiedzy.
Nowy token instalacji obejmie runtime i wiedzę, a jawny `open` nie będzie wymagał
poświadczeń. Ograniczenia starych tokenów obowiązują do jawnej migracji;
ograniczenia scoped tokenów i historyczna tożsamość pozostają zachowane.
Pełny dostęp instalacji oraz anonimowy autor wymagają własnych testów i jawnego
zapisu w audycie. Zapis planu nie dowodzi wdrożenia tych zmian.

- Wprowadzić trwały principal właściciela i identyfikowalne, odwoływalne
  poświadczenia agentów z zakresem projektu i operacji wiedzy. Przechowywać
  hashe sekretów; dane poświadczeń nie trafiają do wyników MCP ani audytu.
- Dostęp do wiedzy nie przyznaje prawa startowania procesów ani uruchamiania
  testów. Stary wspólny token zachowuje istniejące działanie runtime, lecz
  nie otrzymuje automatycznie nowych praw zapisu i zatwierdzania wiedzy.
- Rejestrować rzeczywisty rodzaj uwierzytelnienia. Nie nazywać operacji
  „zatwierdzoną przez człowieka” wyłącznie dlatego, że nadeszła z web/CLI.
  Wybrać odrębne uwierzytelnienie właściciela dla zatwierdzeń; do czasu jego
  wdrożenia pamięć pozostaje propozycją i generowanie instrukcji jest wyłączone.

Odbiór: agent A nie odczytuje ani nie zmienia projektu B; odebranie grantu
działa także w istniejącej sesji, eksporcie, pobieraniu plików i subskrypcji.
Podszycie się pod `human:*` nie daje zatwierdzenia. Klient wiedzy nie może
wywołać operacji runtime. Testy istniejących tokenów i parowania nadal przechodzą.

### K2. Pionowy przepływ serwisu i SQLite

- Dodać migracje, projekt wiedzy, wątki, odpowiedzi, zadania, relacje,
  historię i trwałą idempotencję. Dodać operacje poprzez fasadę bez importów
  Git/process-manager w module wiedzy.
- Rewizje zmieniać warunkowym zapisem; klucze idempotencji wiązać z principal,
  projektem, operacją i hashem treści. Sprawdzić kolizję klucza przed zapisem.
- Zadanie utworzone z wątku dostaje relację i powstaje atomowo. Ponowione
  żądanie po utracie odpowiedzi nie tworzy drugiego zadania.
- Archiwizacja i odłączenie runtime zachowują wiedzę. Zaprojektować ponowne
  podłączenie runtime do istniejącego projektu wiedzy.

Odbiór: pełny przepływ przez serwis przetrwa restart; równoległe edycje
ujawniają konflikt; błąd w środku transakcji nie zostawia połowy zapisu.
Usunięcie runtime i czyszczenie logów/worktree nie usuwa wiedzy. Próba
otwarcia drugiego kontrolera lub offline CLI respektuje singleton lock.

### K3. MCP, CLI i pierwszy ekran użytkownika

- Dodać cienkie adaptery HTTP/MCP/CLI do operacji K2. CLI korzysta z działającej
  usługi; jeśli oferuje tryb offline, zdobywa tę samą blokadę przed bazą.
- Pokazać osobny widok „Wiedza” z zakładkami „Backlog”, „Dyskusje”, „Pamięć”.
  Zacząć od listy, filtrów, szczegółów i szybkiego zapisu; tablica Kanban
  nie jest wymagana. Projekt wiedzy bez runtime musi być wybieralny.
- Zapewnić trwały link do rekordu działający po odświeżeniu strony statycznej,
  np. przez parametry URL obsługiwane przez istniejącą stronę.
- Konflikt pokazuje zapisaną wersję i zachowuje lokalny szkic. Błędy zapisu
  nie znikają po odświeżeniu. Formularze mają etykiety, focus i obsługę
  klawiatury; wszystkie teksty użytkowe są dostępne po polsku i angielsku.
- Zdarzenia wiedzy odświeżają tylko odpowiedni widok. Korzystać z jednej
  subskrypcji dashboardu; odczyt szczegółów nie pobiera całego drzewa Git.

Odbiór: użytkownik i dwie osobne sesje agentów zapisują wątek, odpowiadają,
znajdują go i tworzą zadanie. Wynik jest widoczny w drugim kliencie,
powtórzenie nie duplikuje wpisu, a stan claimów i serwerów się nie zmienia.
Test fixture UI oraz test prawdziwych transportów muszą przejść osobno.

### K4. Pamięć, wyszukiwanie i kontekst kolejnej sesji

- Dodać źródłowe powiązania pamięci, jawne zastępowanie starszego wpisu oraz
  zatwierdzanie konkretnej rewizji zgodnie z K1. Edycja zatwierdzonej treści
  nie dziedziczy automatycznie zatwierdzenia.
- Wyszukiwać po tytule, treści, tagach, legacy ID, stanie i projekcie.
  Domyślnie odfiltrować archiwalne i zastąpione wpisy, z możliwością ich odczytu.
- Kompaktowy kontekst zadania zawiera zakres, aktualne decyzje, otwarte
  pytania i odnośniki do dowodów wraz z rewizjami. Pełny wątek pobiera się
  osobno. Nie generować automatycznych streszczeń bez wskazania ich pochodzenia.
- Eksport Markdown/JSON zawiera wersję formatu, ID, rewizje i czas wykonania.

Odbiór: trzecia sesja odtwarza zakres i nierozstrzygnięte pytania bez wcześniejszego
czatu; rozpoznaje zastąpione ustalenie i nieaktualny eksport. Zapisać liczbę
odczytów i korekt właściciela; nie deklarować oszczędności tokenów bez pomiaru.

### K5. Załączniki, backup i odtwarzanie

- Dodać storage załączników z limitami pliku, projektu i całej operacji.
  Odrzucać traversal, symlinki i rozbieżności hash/rozmiar. Wymagać grantów
  także przy pobieraniu. HTML i inne aktywne pliki podawać jako pobranie,
  a Markdown renderować bez aktywnego HTML i niebezpiecznych schematów URL.
- Dostarczyć backup właściciela bazy przez SQLite backup API. Manifest
  opisuje wersję aplikacji i schematu, migawkę DB oraz zestaw niezmiennych
  plików z hashami. Podczas backupu nie usuwać referencjonowanych obiektów.
- Wprowadzić osobny logiczny eksport/import projektu wiedzy, aby odtworzenie
  wiedzy nie cofało rezerwacji, wyników testów i konfiguracji runtime.
- Odtwarzać najpierw do izolowanego katalogu, weryfikować manifest, pliki,
  integralność i relacje. Pełne odtworzenie stanu kontrolera jest operacją
  offline pod singleton lock, z ponownym sprawdzeniem właścicieli procesów.

Odbiór: backup wykonany podczas zapisów daje spójną migawkę; po restore
liczby, ID, rewizje, relacje i hashe są zgodne. Brak pliku, pełny dysk,
przerwany zapis i nieobsługiwana wersja są widoczną porażką. Nie nadpisywać
działającej bazy w ramach testu ani nie przywracać aktywnych claimów w ciemno.

### K6. Import Huba z raportem przed zapisem

- Czytać zamrożony commit wybranego repozytorium i konfigurację backloga.
  Brudny checkout nie jest domyślnym źródłem; oddzielny import lokalnej
  migawki wymaga jawnego wyboru i nie może udawać importu commita.
- Walidować według rozpoznanej wersji i nadpisań schematów. Użyć przypiętej,
  zaufanej wersji validatora Huba w narzędziu migracji albo dostarczyć zgodny
  parser TypeScript z testami porównawczymi. Wybrać wariant w K0; nie
  uruchamiać skryptów z importowanego repozytorium. Nie wprowadzać Pythona
  jako zależności codziennej pracy kontrolera.
- `planImport` zwraca mapowanie, liczniki, hashe, braki i konflikty; zapis
  wymaga ID/hasza tego planu, identycznego źródła i oczekiwanej rewizji celu.
  Nie pobierać automatycznie adresów, do których prowadzą relacje.
- Importować do niewidocznej partii staging z ograniczonymi porcjami pracy.
  Odsłonić partię atomowo dopiero po weryfikacji wszystkich rekordów i plików.
  Przerwanie można wznowić; błąd nie publikuje połowy projektu.

| Źródło Huba | Docelowe zachowanie |
| --- | --- |
| `feature/fix/rework/security` | Zadanie zachowuje rodzaj, area, stan, priorytet, scope, validation, ryzyko i `risk_acceptance` |
| `notes[]` zadania | Historyczny kontekst z datą i deklarowanym autorem; bez uwierzytelnionego zatwierdzenia |
| `done/` | Rekord zakończenia; powiązać przez `item_id`, zachować snapshot i follow-up; brak starego zadania nie blokuje archiwalnego rekordu |
| `notes/<ID>/` | Historyczna notatka z oryginalnym `body`, polami dodatkowymi i odkrytymi plikami; domyślnie bez statusu przyjętej decyzji |
| `links.related_ids`, PR, ścieżki | Rozwiązać w drugim przebiegu; zachować nierozwiązane referencje w raporcie, nie zgadywać celu |
| `docs/*.md`, AGENTS/CLAUDE | Zachować odnośnik do repo/commita i metadane; dokument pozostaje własnością repo, późniejsze etapy obsługują inspekcję |
| Konfiguracja i schematy | Zachować pochodzenie i reguły mapowania; nie traktować ich jako wykonywalnej konfiguracji kontrolera |
| `index.json`, wygenerowany HTML/cache | Materiał pochodny, nie źródło pełnego importu; index nie obejmuje całego archiwum done |

Zachować oryginalne źródło z hashem również wtedy, gdy pole nie ma jeszcze
odpowiednika w UI. Raport odróżnia „zachowane tylko w źródle” od „obsługiwane”.
Nieobsługiwany schemat lub brak załącznika blokuje przełączenie projektu.
Zewnętrzne, nierozwiązane referencje mogą pozostać po jawnym przeglądzie raportu.

Odbiór: identyczny import nie zmienia danych i nie tworzy duplikatów. Zmieniony
rekord źródłowy przy niezmienionym imporcie docelowym daje proponowaną nową
rewizję; zmiana po obu stronach wymaga rozstrzygnięcia. Te same legacy ID
w dwóch repozytoriach nie kolidują. Round-trip eksport/import zachowuje
oryginalne pola, załączniki, historię i relacje.

### K7. Pilotaż i przełączenie jednego projektu

1. Wskazać jeden projekt i osobę odpowiedzialną za przełączenie. Najpierw
   wykonać pełną próbę na kopii; pozostawić Hub źródłem prawdy w czasie próby.
2. Na ustalone okno wstrzymać edycje starego backloga. Zapisać źródłowy SHA,
   backup, raport końcowego importu i wersję aplikacji. Jeśli źródło zmieniło
   się od dry-run, ponowić plan i walidację.
3. Zweryfikować liczniki oraz reprezentatywne zadanie, done, notatkę,
   załącznik, ryzyko i relację. Uruchomić scenariusz użytkownik + dwa agenty.
4. Przełączyć miejsce zapisu dla tego projektu na Switcher. Zaktualizować
   jego instrukcje repozytorium, z zachowaniem par AGENTS/CLAUDE, i oznaczyć
   stary backlog jako archiwum. Przed udostępnieniem zapisu potwierdzić,
   że klienci odczytują nowe instrukcje. Nie przełączać innych projektów.
5. Przez proponowane 5 dni roboczych używać nowego obiegu i wykonać jedno
   próbne odtworzenie. Zbierać błędy zapisu/odczytu, konflikty, pominięcia
   importu i sytuacje, w których właściciel musi powtarzać kontekst.

Odbiór: działające zapis, odczyt, wyszukiwanie, eksport i restore; brak utraty
danych oraz dwóch aktywnych miejsc zapisu. Właściciel może odszukać i rozwinąć
wpis w kolejnej sesji. Dopiero wtedy migrować następne projekty.

Wycofanie przed pierwszym nowym zapisem przywraca dotychczasowy obieg Huba.
Po nowych zapisach najpierw zamrozić moduł, wyeksportować wszystkie zmiany
od przełączenia i uzgodnić ich przeniesienie do poprawnej bazy lub archiwum
repozytorium. Zweryfikować brak utraty danych przed ponownym otwarciem zapisu.
Samo uruchomienie starego Huba pomijałoby nowe dane. Przy współdzielonej bazie
preferować poprawkę aplikacji lub logiczne odtworzenie wiedzy; pełny rollback
DB cofa również runtime i nie jest domyślną procedurą.

### K8. Playbooki i inspekcja instrukcji

- Zachować osobne małe wdrożenia: najpierw playbook z wersją, ostatnią
  weryfikacją i zgłoszeniem nieskutecznej procedury; potem raport brakujących
  plików/linków i przeterminowanego przeglądu; następnie explorer instrukcji.
- Kontrole są raportowe. Upływ terminu ma zmieniać stan bez nowego commita.
  Oddzielić czas skanu, czas źródła i stan unavailable/stale. Nie uruchamiać
  poleceń zapisanych w dokumentacji.
- Explorer wskazuje worktree, commit, dirty state, zakres katalogu, kolejność
  źródeł, pominięcia i różnice. Profile odkrywania instrukcji oprzeć na
  oficjalnej dokumentacji właściwego klienta sprawdzonej przy implementacji.

Odbiór: testy z zegarem, brakującymi plikami, poprawionymi błędami, zagnieżdżonym
zakresem, izolacją katalogów, symlinkami, dirty state i limitami odczytu.
Widok nie twierdzi, że pokazuje pełny prompt agenta. Raport niczego nie zapisuje
w repozytorium i nie wymaga claima.

### K9. Składanie instrukcji z zatwierdzonych reguł

- Wymaga działającej ścieżki zatwierdzenia z K1/K4. Reguła ma zakres,
  zatwierdzoną rewizję i źródła; dyskusja sama nie staje się instrukcją.
- Dla celu wybrać własność repozytorium albo generowanie z bazy. Najpierw
  pokazać deterministyczny wynik i diff. Wykryć zmianę bazowego pliku,
  ręczne modyfikacje i zastąpione reguły.
- Zastosowanie patcha to osobna lokalna operacja, z aktualnym sprawdzeniem
  bazowych hashy i zgodą na konkretny diff. Obsługiwać parę AGENTS/CLAUDE.
  Eksport nie wykonuje poleceń i nie uruchamia procesów.

Odbiór: odrzucenie niezatwierdzonych i obcych zakresowo reguł; stały wynik
dla tych samych rewizji; konflikt po zmianie pliku między preview a apply;
brak częściowego zastosowania pary plików i brak ukrytego nadpisania.

## Kolejność zmian i zależności

`K0 → K1 → K2 → K3 → K4 → K5 → K6 → K7` daje pierwsze migrowane wydanie.
`K8 → K9` rozszerza je po udanym pilotażu. Analizę fixture importu rozpocząć
w K0, aby wcześnie wykryć straty danych. Nie czekać z nią do gotowego UI.

Każdy etap można podzielić na kilka PR-ów, ale każdy PR ma zachować działający
kontroler i własny zakres testów. K1 współdzieli fundament z istniejącym
zadaniem scoped tokens; nie wymaga pełnego SaaS ani rozbudowanego RBAC.
Jeśli istniejąca ścieżka właściciela nie pozwala wiarygodnie zatwierdzać,
zależność od kont trzeba rozwiązać przed zatwierdzeniami, a nie ukrywać w UI.
Remote verification i agent fleet nie są warunkami uruchomienia backloga.
Nie zmieniać automatycznie priorytetów innych otwartych prac.

Na razie utrzymać jeden wpis nadrzędny i tę notatkę. Przy rozpoczynaniu etapu
wydzielić jego konkretne zadanie implementacyjne z zależnościami i odbiorem;
nie oznaczać funkcji jako ukończonej po samym przygotowaniu planu.

## Gałęzie etapów i pull requesty

Gałąź `t3code/implement-llmopshub-worker-delegation` jest gałęzią integracyjną
tej implementacji. Obowiązuje przepływ: gałąź slice'a → PR do gałęzi
integracyjnej → końcowy PR gałęzi integracyjnej do `main`. Każdy nowy slice
to ograniczony zakres z własnym odbiorem, osobną gałęzią i jednym PR-em.
Większy etap K można podzielić na kilka takich zmian, ale nie dopisywać
kolejnego etapu do trwającego PR-a.

1. **Przed zleceniem pracy** kontroler podaje workerowi: etap i zakres,
   wyłączenia, kryteria odbioru, nazwę gałęzi, dokładną ścieżkę worktree,
   bazowy commit oraz docelową gałąź PR-a. Sprawdza faktyczną gałąź i stan
   zmian; planowana nazwa nie oznacza, że gałąź już istnieje.
2. **Nowy slice zaczyna się z aktualnej gałęzi integracyjnej po merge
   poprzedniego slice'a.** Odświeżyć referencje i wskazać bazowy SHA gałęzi
   `t3code/implement-llmopshub-worker-delegation`. Utworzyć gałąź przed edycją
   kodu, np. `t3code/knowledge-k2-service-sqlite` lub
   `t3code/knowledge-k3-mcp-cli`. Pracować w czystym worktree albo utworzyć
   osobny; nie przenosić ani nie usuwać cudzych niezacommitowanych zmian.
   Nie tworzyć zależnych gałęzi z niepołączonego slice'a w tym przebiegu.
3. **Istniejące K0/K1 jest wyjątkiem organizacyjnym:** jego kod znajduje się
   już na gałęzi integracyjnej. Zachować istniejącą historię i artefakty;
   odbiór przypisać do konkretnego zakresu commitów i końcowego SHA.
   Nie tworzyć PR-a gałęzi do niej samej ani traktować K0/K1 jako końcowego
   PR-a do `main`. Dalsze poprawki wydzielać na gałęzie z PR-em do integracji.
   K2 zaczynać po odbiorze K0/K1 i połączeniu wymaganych poprawek.
4. **Przed oddaniem PR-a do odbioru** zacommitować komplet zmian danego
   slice'a i uruchomić wymagane testy oraz `pnpm check`; dla zmian modułów,
   transportów i UI także `pnpm build` oraz odpowiednie scenariusze
   integracyjne/przeglądarkowe z sekcji poniżej. Używać kolejki MCP zgodnie
   z zasadami repozytorium. Wyniki mają dotyczyć wskazanego SHA i czystego
   źródła; `dirty_source`, `uncertain`, przerwanie lub sam kod wyjścia 0
   nie stanowią pozytywnego odbioru kolejki. Po poprawkach sprawdzić nową
   rewizję w zakresie wynikającym ze zmian i wymaganych kontroli.
5. **PR slice'a opisuje finalny zakres**, zmianę zachowania, powiązany etap,
   wyniki/ID weryfikacji i pozostałe ograniczenia. Jego bazą jest
   `t3code/implement-llmopshub-worker-delegation`. Kontroler porównuje cały
   diff do tej bazy z przydzielonym zakresem i zgłasza uwagi z lokalizacją
   oraz warunkiem poprawy. Draft można otworzyć wcześniej, ale nie oznacza
   on odbioru ani ukończenia etapu.
6. **Po review i merge slice'a** zapisać numer PR-a, wynik odbioru i commit
   na gałęzi integracyjnej. Odświeżyć bazę następnego slice'a; nie kontynuować
   nowych funkcji na połączonej gałęzi slice'a. Samo utworzenie PR-a lub
   przejście testów nie jest merge. Odbiór slice'a oznacza integrację etapu,
   nie dostarczenie całej funkcji na `main`.
7. **Końcowy PR do `main`** wychodzi z gałęzi integracyjnej po odbiorze
   uzgodnionego zakresu funkcji. Kontroler sprawdza cały diff do `main`,
   kompletność zakresu i dowody działania połączonych etapów. Wymagane
   kontrole oraz scenariusze całego przepływu muszą dotyczyć finalnej rewizji.
   Zapisać końcowy PR i commit po merge do `main`; dopiero wtedy zamykać
   odpowiadający dostarczonemu zakresowi wpis nadrzędny.

Plan, nowe zadania, decyzje właściciela i trwałe dowody podlegają
[regułom backloga](../../AGENTS.md): utrzymywać je na `main`, wykonać Hub
`fmt`/`validate` i synchronizować przed przekazaniem kolejnego zlecenia.
Ta reguła dotyczy kanonicznego backloga; kod slice'ów trafia do gałęzi
integracyjnej. Worker ma otrzymać aktualny kontrakt; zmiany pozostawione
wyłącznie w innym worktree nie są przekazanym wymaganiem. Formalne zamknięcie
zadania slice'a następuje po odbiorze i merge do integracji (dla istniejącego
K0/K1 po odbiorze wskazanego zakresu commitów), przez jeden commit na `main`
zastępujący otwarty wpis wpisem `done/`. Nie zamyka to wpisu nadrzędnego.

## Testy i dowody odbioru

| Warstwa | Najważniejsze przypadki | Miejsce / wykonanie |
| --- | --- | --- |
| Serwis | Stan zadania, relacje, rewizje, retry, cofnięty grant, fałszywe zatwierdzenie | Nowe testy przy `modules/knowledge/`; istniejący `pnpm test` z filtrem ścieżki |
| SQLite | Migracja z aktualnego i starszego wspieranego schematu, rollback transakcji, restart, odłączenie projektu | `src/server/infrastructure/sqlite/*.test.ts`; baza tymczasowa na dysku |
| Transporty | Ten sam scenariusz HTTP/MCP/CLI, uwierzytelnienie, origin, kody błędów, limity, retry po utracie odpowiedzi | Istniejące testy HTTP/MCP/CLI i nowe fixture integracyjne |
| Import | Wszystkie typy, custom schema, dodatkowe pola, identyczne ID w dwóch projektach, zmiany po imporcie, błędny plik, przerwanie | Nowe testy importera oraz eksportu z fixture Huba |
| Backup | Zapis równoległy, brak pliku, hash, pełny dysk, uszkodzony manifest, nieobsługiwana wersja | Izolowany backup/restore; porównanie DB i manifestów |
| UI | Szybki zapis, filtry, deep link, konflikt ze szkicem, odłączenie runtime, klawiatura, PL/EN, mobile | `pnpm build`, potem `pnpm test:ui`; fixture API nie dowodzi działania backendu |
| Cały przepływ | Użytkownik + dwa klienty MCP, restart, import, wyszukanie dowodu, odtworzenie | Rozszerzone `pnpm test:integration` i `pnpm test:e2e` z izolowanym stanem |
| Regresje | Claims, start/stop, kolejka testów, singleton, brak skanów Git i mnożenia SSE | Istniejące testy lifecycle, HTTP/MCP, eventów, dashboardu i granic architektury |
| Zasoby | 10 tys. rekordów, stronicowanie, seria zapisów, import z limitami, event-loop/RSS przed i po | Fixture pomiarowa; istniejący `pnpm bench:resources` po uzasadnionym rozszerzeniu |

Próg wydajności ustalić po pomiarze K0 na tej samej maszynie i danych.
Proponowany cel UX: pierwsza strona i szczegóły poniżej 300 ms p95 lokalnie
dla 10 tys. rekordów. To cel do potwierdzenia, nie wynik pomiaru. Import ma
oddawać sterowanie między porcjami i zachować responsywność operacji runtime.
Nie luzować istniejących progów regresji zasobów, żeby zaliczyć nową funkcję.

Przed połączeniem zmian kodu uruchomić `pnpm check`; zmiany modułów, transportów
i UI wymagają również `pnpm build`. Testy przeglądarkowe i integracyjne dotyczą
artefaktów tej samej rewizji. Dodatkowe pełne przebiegi mają wynikać ze zmiany
lub niepewności; nie powtarzać ich bez powodu.

Zgodnie z root AGENTS, jeśli projekt udostępnia presety w Worktree Switcher,
najpierw `list_test_presets`, a następnie `run_test` na dokładnej ścieżce z
`list_worktrees`. Zachować klucz idempotencji i czekać przez `get_test_run`
na stan końcowy. Bez dostępnej kolejki używać wspieranych komend skończonych.
Weryfikacja potrzebująca zarządzanego serwera wymaga odrębnego claima i MCP.
Ciężkie buildy i przeglądarki uruchamiać kolejno, zgodnie z polityką hosta.

Dla każdego etapu zapisać commit, wersję schematu/eksportu, scenariusz,
komendę lub ID kolejki, wynik i brakujące pokrycie. Przerwany proces nie jest
zaliczonym testem. W raporcie pilotażu zachować manifest importu oraz dowód
odtworzenia. Zmiany samych dokumentów wymagają Hub `fmt`, `validate` i
`git diff --check`.

## Historyczny pierwszy krok z 2026-09-13

Rozpocząć od K0 i K1: inwentaryzacji importu, kontraktu trwałego projektu
oraz tożsamości i uprawnień wiedzy. Pierwszy pokaz działania powinien kończyć
się przepływem K3. Do przeniesienia prawdziwego backloga wymagane są również
K4–K6 i kontrolowane przełączenie K7. Niniejszy plan nie uruchamia migracji,
nie zmienia instrukcji nadzorowanych projektów i nie wyłącza Huba.
