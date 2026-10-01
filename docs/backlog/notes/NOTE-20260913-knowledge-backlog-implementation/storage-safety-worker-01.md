# Prompt pierwszego workera: S1a + S2a

Wklej poniższy prompt do sesji mającej dostęp do repozytorium. Pierwszy run
przygotowuje jeden PR; nie uruchamia całego planu ani wdrożenia produkcyjnego.

```text
Zaimplementuj pierwszy slice S1a + S2a zadania
RWK-20260928-sqlite-data-safety w repozytorium Worktree Switcher.

Źródło zakresu:
docs/backlog/notes/NOTE-20260913-knowledge-backlog-implementation/storage-safety-implementation-plan.md

1. Przeczytaj AGENTS.md, lokalne instrukcje dotykanych obszarów, indeks
   backloga, rekord zadania i plan. Zastosuj skill implement-issue.
   Odczytaj aktualny kod; zapisane w planie SHA i numery schematu są baseline'em,
   nie poleceniem cofnięcia checkoutu. Zachowaj cudze zmiany.

2. Doprowadź uzgodnioną dokumentację planu do osobnego commita na main.
   Jeśli nadal jest lokalna, sprawdź pełny diff i uwzględnij tylko cztery pliki:
   - storage-safety-implementation-plan.md i storage-safety-worker-01.md
     w katalogu notatki wskazanej wyżej;
   - note.json w tym samym katalogu;
   - docs/backlog/rework/RWK-20260928-sqlite-data-safety.json.
   Uruchom canonical Hub fmt/validate i git diff --check. Jeśli fmt zmienił
   index.json w związku z manifestem notatki, dołącz również wygenerowaną zmianę.
   Zsynchronizuj main
   zwykłym pushem, bez force i bez dołączania cudzych commitów. Gdy dokumenty
   są już zapisane i zsynchronizowane, nie twórz ich ponownie. Przy rozbieżnej
   historii lub niezwiązanych lokalnych commitach zachowaj je i zgłoś konkretną
   przeszkodę zamiast nadpisywać main.

3. Utwórz osobny worktree i branch feat/sqlite-pre-migration-backup
   z aktualnego main. Jeśli gałąź istnieje, sprawdź jej stan i kontynuuj tylko
   potwierdzoną pracę tego slice'a; nie resetuj jej.

4. Dostarcz dokładnie ten zakres:
   - Jeden właściciel kanonicznego zasobu bazy, również przy różnych katalogach
     stanu. Zachowaj lock kontrolera, wspólną koordynację i poprawne zwalnianie
     zasobów. Odrzuć nieobsługiwane aliasy; uwzględnij równoczesny start.
   - Oddziel inspekcję i otwarcie bez migracji od uruchamiania migratora.
     Ręczne backup create zachowuje źródłowy schemat i nie zmienia źródła
     przez konstruktor SqliteStateStore.
   - Wspólna definicja obsługiwanego schematu. Nowsza, obca lub nierozpoznana
     baza jest odrzucana przed DDL, zmianą trybu dziennika i inicjalizacją auth.
     Uwzględnij zwykły start, offline CLI i restore używający tego limitu.
   - Spójna kopia SQLite i wymaganych załączników, także dla wspieranych
     starszych schematów bez tabel wiedzy. Metadane odczytuj z migawki.
   - Minimalna opcja CLI wymagająca kopii przed migracją, domyślnie wyłączona.
     Przy wyłączonej opcji migracja działa bez celu kopii i bez zadań backupu.
     Po włączeniu kopia musi być zweryfikowana przed pierwszą zmianą schematu;
     jej błąd zatrzymuje migrację. Obsłuż przekazanie tej opcji do instalowanej
     usługi i waliduj argumenty przed mutacją. Nie dodawaj ustawienia do GUI.

   S1b/S2b, harmonogramy usługi i użytkownika, transfer poza host, GUI oraz
   pełny protokół restore pozostają kolejnymi slice'ami. Zachowaj dotychczasowy
   interfejs poza niezbędnymi zmianami tego zakresu. Nowe pliki danych twórz
   prywatnie; nie przeprowadzaj ogólnego refaktoru storage przy tej okazji.

5. Dodaj testy zachowania na izolowanych fixture:
   - backup starego schematu przez nowy kod, z zachowaniem rekordów i załączników;
   - wspierany schemat bez tabel wiedzy;
   - błąd wymaganej kopii przed migracją: schemat i dane pozostają stare;
   - backup wyłączony: poprawna migracja bez kopii i dodatkowych zadań;
   - nowszy/obcy schemat: odmowa bez zmiany danych i uwierzytelniania;
   - dwa rzeczywiste procesy, jedna baza, różne katalogi stanu i aliasy ścieżki;
   - błędne flagi CLI i przekazanie poprawnych do definicji usługi;
   - błąd otwarcia/backupowania: zwolnione własne zasoby, cudzy lock zachowany.
   Fixture starej wersji nie może być przypadkiem zmigrowany przez aktualny
   konstruktor podczas samego przygotowania testu.

6. Weryfikuj zgodnie z AGENTS.md i skillem worktree-switcher. Dla dostępnych
   presetów użyj list_worktrees, list_test_presets i run_test z właściwą ścieżką;
   poczekaj na wynik terminalny. Uruchom testy obszaru, pnpm check i pnpm build
   przez obsługiwane mechanizmy. Ciężkie zadania wykonuj pojedynczo. Działająca
   produkcja, jej baza, limity hosta i serwery innych użytkowników pozostają
   poza zakresem. Test usługi wykonuj na izolowanej instalacji.

7. Przejrzyj końcowy diff, utwórz skupione commity kodu, wypchnij feature branch
   i otwórz PR do main. Opis zawiera problem, wynikające zachowanie, rzeczywiste
   wyniki testów i ograniczenia. Przy niepełnej weryfikacji oznacz PR jako draft
   i opisz przyczynę. Raport końcowy podaje SHA, link do PR-a, testy i pozostałe
   braki. Zakończ na tym PR-ze: bez merge, wdrożenia ani rozpoczęcia slice'a 2.
```
