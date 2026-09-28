# Plan poprawek czytania wiedzy po audycie

Stan: propozycja na podstawie audytu z 2026-09-28; nie jest akceptacją nowego wyglądu ani zmianą modelu danych. [Raport i 19 zrzutów](visual-audit.md) opisują dowody, a [analiza źródłowa](source-analysis.md) wskazuje przyczyny. Nie zaczynać ponownie implementacji całego modułu wiedzy.

## Docelowy przepływ

Użytkownik wybiera projekt, znajduje wpis po tytule lub treści, otwiera go i czyta. Tytuł, status, zwięzła informacja o pochodzeniu i właściwa treść są widoczne przed operacjami administracyjnymi. Notatka zawierająca plan prowadzi bezpośrednio do planu. Czytelnik wraca do poprzedniej listy z tym samym zapytaniem i pozycją.

Na desktopie: lista i czytnik; długość wiersza dokumentu ograniczona do około 65–80 znaków jako punkt startowy do oceny. Szerokości dopasować do realnej treści, nie do identyfikatorów. Na małym ekranie: lista albo czytnik z powrotem, a nie filtr i szczegół naraz. Przed wyborem użyteczna lista zajmująca dostępny obszar; sam komunikat w pustej prawej kolumnie nie rozwiązuje uwagi właściciela. Po otwarciu rekordu lista i czytnik, z możliwością rozszerzenia czytnika. To propozycja do oceny na reprezentatywnej treści.

Jedno główne pole wyszukiwania z podanym zakresem. Drugorzędne filtry w rozwijanym panelu z licznikiem aktywnych filtrów. „Dodaj” pozostaje dostępne, ale nie wypełnia całej szerokości czytnika. Edycja, archiwizacja, zastąpienie i oryginalny payload trafiają do jawnych akcji rekordu lub rozwijanych szczegółów. Zatwierdzenie nadal wyraźnie odnosi się do konkretnej rewizji; nie można schować znaczenia statusu.

Zachować zatwierdzony kierunek grafit/lime i obecne komponenty shadcn. Akcent tekstowy w jasnym motywie wymaga osobnego kontrastowego tokena. Bez kopiowania wyglądu WinPath, nowej biblioteki UI ani zmian architektury kontrolera.

## 1. Miejsce na czytanie i spójna nawigacja

Zakres: KR-10–12, KR-15 częściowo, KR-16 i KR-17. Po [uwagach właściciela](owner-feedback.md) pierwszy etap ma objąć użyteczny widok bez wyboru, mniejszą gęstość list i hierarchię rozmowy oraz formularz wypierający treść. Podzielić ten etap na mniejsze PR-y, jeśli zakres przestanie być łatwy do oceny. Nie czekać z tym na indeksowanie załączników.

- Przed wyborem wykorzystać miejsce na listę; po otwarciu zachować orientację, przewinięcie i fokus. Nie zastępować dużej pustej powierzchni samą dekoracją lub przypadkowo otwartym rekordem.
- W dyskusji pokazać właściwą rozmowę bezpośrednio pod tytułem i zwięzłym kontekstem. Pochodzenie importu, dodatkowe relacje i akcje przenieść do drugorzędnej prezentacji. Nie chować głównego dokumentu notatki razem z dodatkowymi załącznikami.
- Listę oprzeć na czytelnych tytułach i krótkich podglądach. Usunąć wizualną dominację powtarzanego prefiksu importu i ID, zachowując pochodzenie w metadanych. Gdy brak tytułu w kontrakcie, zaplanować ograniczoną projekcję z etapu 3, zamiast zgadywać nazwę.
- Uporządkować nagłówek projektu wiedzy i trzy zakładki jako jeden kontekst nawigacyjny. Dokładne rozwiązanie jest propozycją agenta, bo strzałki właściciela nie precyzują oczekiwanej zmiany.
- Ujednolicić wysokość pól tekstowych, selectów i przycisków filtrów, linię etykiet i odstępy; sprawdzić wspólne krawędzie także po zawinięciu. Nie stosować lokalnych przesunięć pod jeden screenshot.
- Nadać zapytaniu sensowną minimalną szerokość i przenosić pozostałe filtry do następnego wiersza/panelu, zanim pole zostanie ściśnięte. Nie skracać etykiety kosztem jej znaczenia.
- Ukrywać filtry w szczególe mobilnej pamięci tak jak w backlogu. Ograniczyć wysokość wspólnej belki w widoku czytania; operacje runtime nie powinny wypierać tekstu notatki.
- Ujednolicić wybór, pusty szczegół, liczniki i linki wierszy. Zachować prawdziwe href i możliwość otwarcia osobno.
- Zachować stan listy osobno dla projektu i zakładki. Określić stan w URL dla zapytania/filtrów/strony; przewinięcie i fokus odtwarzać w odpowiednim zakresie. Uważać na zmianę projektu i uprawnień.
- Rozdzielić ładowanie listy, szczegółu i historii; błąd pobocznej historii nie może usuwać poprawnie pobranej treści. Pokazać możliwość ponowienia.
- Poprawić kontrast wybranego linku w light i ujednolicić focus-visible. W mobilnym przejściu przenosić fokus na początek czytnika, po powrocie na wybrany wpis.

Odbiór: PL i EN, dark/light, 1440×1000, 1366×768, 390×844, 320 px szerokości, niski viewport oraz rzeczywisty zoom 200%. Pole nie zwęża się do 59 px; przy 390×844 po otwarciu natywnej krótkiej notatki widać tytuł i początek treści bez przechodzenia przez pełny formularz. Filtry wracają po zmianie zakładki i Back/Forward, a zmiana projektu nie przenosi cudzego wyboru. Test opóźnienia i błędu historii odróżnia loading od pustych wyników. Tab/Enter/Back nie tracą logicznej pozycji.

Miejsca pracy: `memory-panel.tsx`, `knowledge-dashboard.tsx`, `use-knowledge.ts`, selekcja w dashboardzie i tokeny motywu. Dla Sol: high dla całego etapu po uwagach właściciela; medium dopiero dla precyzyjnie wydzielonego PR dotyczącego samej prezentacji. Nie łączyć PR z backendem dokumentów.

## 2. Czytelna notatka i dokumenty

Zakres: KR-01, KR-02, KR-06 i część KR-09. Najważniejszy wynik: plan Markdown da się przeczytać w Switcherze.

- W modelu odczytu jawnie odróżnić importowaną notatkę/manifest od tekstu natywnego. Wykorzystać zapisane pochodzenie; nie zgadywać typu po znaku `{` ani nie przepisywać trwałego body dla wyglądu.
- Pokazać opis notatki, dokumenty oraz drugorzędne metadane. Oryginalny payload zawsze dostępny osobno. Dla body-string, body-object i braku body określić jednoznaczne zachowanie.
- Dodać autoryzowany podgląd Markdown i tekstu oraz obrazu, z osobną akcją pobrania oryginału. Obsłużyć nagłówki, listy, tabele, kod i linki; HTML/skrypty z materiału nie mogą się wykonywać.
- Dokument ma adres możliwy do skopiowania i powrót do notatki. Link względny otwiera tylko znany, dostępny dokument albo jasno informuje o braku celu. Nie wykonywać odwołań do dowolnych lokalnych plików.
- Ograniczyć rozmiar odczytu i renderowania. Dla pliku binarnego, dużego, uszkodzonego lub niedostępnego wyświetlić czytelny stan i dostępną akcję. Nie osłabiać kontroli dostępu obecnego pobierania.

Odbiór: reprezentatywna notatka z `implementation-plan.md` pokazuje tabelę etapów i link do `database-portability.md`; zwykła notatka nadal ma zwykłą treść. Markdown z niebezpiecznym HTML/linkiem nie uruchamia kodu. Dokument niedostępny dla danego aktora nie ujawnia treści. Pobranie daje niezmienione bajty. Cofnięcie wraca do notatki i listy z zachowanym kontekstem. PL/EN i telefon obejmują tabelę oraz blok kodu, nie tylko krótkie zdanie.

Miejsca pracy: `record-attachments.tsx`, `memory-panel.tsx`, kontrakty odczytu i aplikacyjne operacje załączników. Dla Sol: high; przed kodem przekazać dokładną semantykę pochodzenia, limitów i względnych linków. W razie potrzeby rozdzielić kontrakt oraz UI na dwa następujące po sobie PR-y.

## 3. Znaczenie zadania, relacji i historii

Zakres: KR-04, KR-05, KR-07, reszta KR-09 i KR-14. Chronologia jest P1; można wyodrębnić ją jako wcześniejszy niezależny PR, jeśli prace nad czytnikiem będą długie.

- Zachować rozdział problemu, zakresu i walidacji w prezentacji importowanego zadania. Nie pokazywać starego payloadu jako aktualnej treści po natywnej edycji; kontrakt musi rozróżniać wersję źródłową i obecną.
- Zwracać ograniczone projekcje celów relacji: tytuł, typ, kierunek, status, dostępność. Unikać osobnego żądania dla każdego linku i nie omijać autoryzacji rekordów.
- Ustalić kolejność importowanych komentarzy zgodną ze źródłem, zachowując tie-breaker dla tej samej daty i przypadki dat brakujących/nieprawidłowych. Zdefiniować miejsce nowych natywnych odpowiedzi. Dla starych importów korzystać tylko z zachowanej proweniencji; nie wymyślać brakującej kolejności.
- Pokazać autora źródła i czas historyczny oddzielnie od aktora i czasu importu. W pamięci dodać kategorię, datę i czytelne źródła, nie wyciągając wniosków z nazwy użytkownika/ID.
- Historię prezentować jako datowaną listę zmian z opisem i porównaniem na żądanie. Techniczny JSON pozostaje dodatkową opcją.

Odbiór: obecny wątek z 14 komentarzami zachowuje kolejność źródłową, także dla kilku zmian kierunku tego samego dnia. Test obejmuje import ponowiony, dane historyczne po migracji i nowe odpowiedzi. Relacja mówi, co łączy i z czym; usunięty/niedostępny cel ma prawdziwy stan. Natywna edycja zadania nie odtwarza starego opisu. Zatwierdzenie i jego unieważnianie nadal zależą od rewizji.

Dla Sol: high, ze szczególnym wskazaniem transakcji, migracji i zachowania idempotencji importu. Każdy transport korzysta ze wspólnej operacji aplikacyjnej. Bez zmiany SQLite na inną bazę.

## 4. Wyszukiwanie prowadzące do treści

Zakres: KR-03 i KR-08. Zależność od adresowalnego czytnika z etapu 2.

- Zdefiniować jeden zrozumiały zakres: rekordy i obsługiwane dokumenty projektu. Filtry typu zawężają zakres; użytkownik widzi, które są aktywne.
- Indeksować ograniczony tekst obsługiwanych dokumentów przy zapisie/imporcie, z bezpiecznym uzupełnieniem istniejących załączników. Nie skanować plików i Git na każde naciśnięcie klawisza.
- Wynik ma tytuł dokumentu/wątku, rodzaj, fragment wokół trafienia i kontekst. „Reply” nie jest wystarczającą nazwą.
- Nawigować do konkretnej odpowiedzi lub dokumentu, także poza pierwszą stroną, z widocznym trafieniem i stabilnym powrotem do wyników. Polityka zaznaczania musi traktować tekst jako dane, nie HTML.

Odbiór: fraza `Cel i granice pierwszego wydania` znajduje dokument; `dual-engine` pokazuje fragment zawierający zapytanie i otwiera właściwą odpowiedź. Osobny przypadek ma ponad 25 odpowiedzi. Testy obejmują zakres projektu i uprawnienia, archiwalne/zastąpione rekordy, aktualizację i usunięcie pliku, limit rozmiaru, spójność po restarcie i ponownym imporcie. Nie obiecywać wyszukiwania formatów, których nie indeksujemy.

Dla Sol: high. Najpierw plan indeksu, aktualizacji i docelowych adresów, potem kod. Nie rozszerzać tego PR o wyszukiwarkę semantyczną, embeddingi ani nową usługę.

## Weryfikacja i przekazanie

Każdy zakres kodu: osobny worktree i opis bazy SHA, minimalny zestaw zmian, testy zachowania objętego ryzykiem, `pnpm check`, build dla bundlingu oraz przegląd rzeczywistych widoków. Dla zarejestrowanego projektu używać presetów kolejki i osobnego claimu do przeglądarki. Jeden ciężki przebieg naraz.

Zachować obecne pokrycie rewizji, konfliktów, idempotencji, pochodzenia, autoryzacji, backupu i importu. Zmiany wieloplikowe React sprawdzić właściwym skill review. Po utworzeniu konkretnego PR przekazać review do istniejącego n8n zgodnie z wcześniejszą dyspozycją właściciela; obsłużyć komentarze i scalać dopiero przy zielonych wymaganych kontrolach na końcowym SHA. Audyt dokumentacyjny nie zastępuje tej ścieżki dla przyszłego kodu.

Odbiór całości: właściciel znajduje zadanie, rozpoznaje problem i warunki odbioru, przechodzi do dyskusji w prawdziwej kolejności, czyta plan bez pobierania, odnajduje konkretną decyzję i wraca do poprzedniej listy. Dopiero ten scenariusz pozwala oceniać, czy GUI faktycznie nadaje się do codziennego czytania.
