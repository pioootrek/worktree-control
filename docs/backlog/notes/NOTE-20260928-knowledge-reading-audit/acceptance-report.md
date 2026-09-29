# Odbiór przekrojowy GUI — 2026-09-29

Status: audyt zakończony; GA-01/02 poprawione i scalone w PR67 (`186253a`) po zielonych testach i rozliczeniu review. Nie jest to zamknięcie całego backloga GUI ani akceptacja migracji produkcyjnej.

## Zakres i dowody

Main `4b318df`, podgląd z kompilacji `c04eac2` w worktree historii. Porównanie Git potwierdza identyczność kodu aplikacji z main. Chromium/Playwright na zatwierdzonej odizolowanej kopii pilota; 25 aktualnych, otwartych i obejrzanych zrzutów. PL/dark i EN/light; desktop 1440×913 oraz 1440×1000, niski 1366×650, mobile 390×844 i 320×844. Rzeczywisty zoom Chrome 200% potwierdzony API przeglądarki: obszar CSS 683×325, DPR 2. [Pomiary](acceptance-evidence.json).

Nie zmieniano treści istniejących rekordów. Przez MCP pilota ponowiono wyłącznie celowo nieudany start syntetycznego Workera (exit 7), żeby mieć świeży błąd i logi; rezerwację zwolniono. Nie uruchamiano serwera poza Switcherem. Awarię odczytu historii 503 zasymulowano tylko w przeglądarce; przechwytywanie usunięto po sprawdzeniu ponowienia. Brak błędów JavaScript strony.

## Przejście przez interfejs — stan bazowy przed PR67

1. **Worktrees — działa.** Gałąź, stan, zmiany lokalne i akcja są widoczne na desktopie i telefonie. Celowo nieudany start oznacza właściwą gałąź `fix/brak-konfiguracji`; ma akcję przejścia do logów. Duży alert zabiera miejsce tylko w stanie błędu.

![Worktrees desktop](acceptance-screenshots/01-worktrees-desktop.png)
![Worktrees mobile z błędem](acceptance-screenshots/14-worktrees-mobile.png)

2. **Testy — wynik i diagnoza czytelne; dwie poprawki.** Wynik polecenia jest oddzielony od obserwacji źródła i dzisiejszej aktualności. Szczegół podaje exit 9, powód nieznanej aktualności i odświeżenie metadanych. Przejście do logu ustawia fokus na wyjściu tego testu. Przy 1366 px tabela ma 1125,55 px w kontenerze 1100 px; akcja jest częściowo poza prawą krawędzią (GA-02). Po zmianie szerokości z otwartym szczegółem powrót fokusu trafia na ukryty wariant przycisku (GA-01).

![Testy i wynik](acceptance-screenshots/02-tests-desktop.png)
![Nieudany test](acceptance-screenshots/03-test-failure-detail.png)
![Przycięta akcja na niskim ekranie](acceptance-screenshots/19-tests-light-short.png)
![Testy mobile](acceptance-screenshots/13-tests-mobile.png)

3. **Zasoby — czytelne pomiary i szczegół; GA-01 także tutaj.** Zajętość dysku, .next i daty są rozdzielone. Historia ma tekstową alternatywę. Układ mobile pokazuje pierwszy rekord bez poziomego szukania akcji. Przy 1366 tabela mieści się dokładnie w 1100 px; nie potrzebuje zmiany progu. Zamknięcie panelu po przejściu między mobile a desktopem gubi fokus.

![Zasoby desktop](acceptance-screenshots/04-resources-desktop.png)
![Historia rozmiaru](acceptance-screenshots/05-resource-detail.png)
![Zasoby mobile](acceptance-screenshots/12-resources-mobile.png)

4. **Logi — działa wejście do diagnozy i trafień.** Puste projekty są zwarte. Zapytanie ERROR rozwija trzeci projekt, pokazuje dwa trafienia; Enter w konsoli przechodzi 1/2 → 2/2. Widoczny jest stan wstrzymania oraz gałąź błędnego uruchomienia. W tym przebiegu nie ponawiano testu żywego strumienia podczas pauzy.

![Puste logi](acceptance-screenshots/06-logs-empty.png)
![Trafienia w Workerze](acceptance-screenshots/18-log-matches.png)

5. **Backlog → powiązana dyskusja — działa.** Lista wykorzystuje pełną szerokość. Powiązania mają tytuł, rodzaj i kierunek; przejście otwiera właściwą rozmowę. Historyczne wypowiedzi są w kolejności źródłowej, z oddzieloną atrybucją. Rozszerzenie i przywrócenie listy pozostaje dostępne również po przewinięciu końca rozmowy. Opis zadania pozostaje dowolnym tekstem zgodnie z decyzją właściciela.

![Backlog](acceptance-screenshots/07-backlog-list.png)
![Zadanie](acceptance-screenshots/08-task-relations.png)
![Dyskusja](acceptance-screenshots/09-discussion.png)

6. **Pamięć → dokument — działa.** Czytelny opis zastępuje techniczny manifest, pliki można otworzyć lub pobrać. Dokument zachowuje nagłówki i tabelę z lokalnym przewijaniem. Nadal widoczny jest formularz zastąpienia przez ID; to pozostały punkt ergonomii, a nie zmiana modelu description.

![Notatka i dokumenty](acceptance-screenshots/10-memory-documents.png)
![Otwarty dokument](acceptance-screenshots/11-document.png)

7. **Wyszukiwanie → konkretna odpowiedź → powrót — działa.** Fraza `dual-engine` daje fragment i nazwę wątku. Enter otwiera oraz wyróżnia dokładną odpowiedź; powrót odtwarza zapytanie i fokus wyniku. Fraza `Cel i granice pierwszego wydania`, obecna wyłącznie w załączniku, nadal daje brak wyników. KR-03 pozostaje osobnym zakresem indeksowania dokumentów.

![Wynik na telefonie](acceptance-screenshots/15-search-mobile.png)
![Dokładna odpowiedź](acceptance-screenshots/16-search-destination-mobile.png)
![Pozostały brak wyszukiwania dokumentów](acceptance-screenshots/17-document-search-gap.png)

8. **Historia, błąd odczytu i powiększenie — działa w badanych próbach.** Historia pokazuje daty/operacje i jawne szczegóły. Kontrolowany HTTP 503 dotyczy tylko historii: treść rekordu pozostaje w DOM i czytniku, lokalne ponowienie odzyskuje zdarzenia. W jasnym motywie wybrany tytuł ma ciemny tekst zamiast dawnego lime. W rzeczywistym zoomie 200% testy przechodzą na karty, a log jest czytelny i dostępny z klawiatury bez globalnego poziomego overflow.

![Historia](acceptance-screenshots/23-memory-light-history.png)
![Błąd ograniczony do historii](acceptance-screenshots/24-history-error-isolation.png)
![Rzeczywisty zoom 200%](acceptance-screenshots/21-tests-zoom.png)
![Wyjście testu w zoomie](acceptance-screenshots/22-detail-zoom-output.png)

## Konkretne poprawki tego etapu

- **GA-01, P2:** przy otwartym szczególe Testów/Zasobów zmiana szerokości ukrywa pierwotny przycisk. Powrót powinien znaleźć widoczny wariant tego samego projektu/rekordu; jeśli wiersz zniknął, użyć wyszukiwania w tej samej sekcji. Zwykłe zamknięcie po pełnym otwarciu działa. Bardzo szybki Escape dał niestabilny wynik w próbie narzędziowej; nie utożsamiać go z potwierdzoną przyczyną GA-01 ani deklarować odrębnej naprawy.
- **GA-02, P2:** Testy przy 1366 px uruchamiają tabelę zbyt wcześnie. Użyć już istniejącego układu kart, gdy tabela nie mieści głównej akcji. Zasoby przy tej szerokości mieszczą się, więc ich próg pozostaje bez zmian.

Kod zlecono Sol high w `fix/gui-detail-focus`, osobny worktree od `4b318df`. Root prowadzi kolejkę check/build/UI, ponowną próbę w pilocie, review n8n i scalenie po zielonym CI. Implementacja korzysta z istniejącego shadcn Sheet i [zdarzenia Radix onCloseAutoFocus](https://www.radix-ui.com/primitives/docs/components/dialog), bez obejścia pułapki fokusu.

## Rozliczenie poprzednich ustaleń

| Ustalenia | Stan po PR58–66 i tym odbiorze |
|---|---|
| KR-01/02: dokumenty, JSON zamiast notatki | Naprawione; otwarcie dokumentu i opis potwierdzone powyżej. |
| KR-03: tekst dokumentów w wyszukiwaniu | Otwarte, potwierdzony brak wyników; osobny przyszły zakres. |
| KR-04/06: struktura importowanego zadania / Markdown description | Właściciel zaakceptował dowolny opis i opcjonalne importowane dokumenty; nie wymuszać schematu ani renderera. Ewentualna prezentacja sekcji importu pozostaje opcją. |
| KR-05/07/08: relacje, chronologia, cel wyszukania | Naprawione; potwierdzone w przejściu zadanie/rozmowa/trafienie. |
| KR-09/10: metadane i kontrolki | Znacznie poprawione; ręczne ID zastąpienia i stałe akcje pamięci nadal do uproszczenia. |
| KR-11/12: wspólny czytnik i kontekst powrotu | Główne ścieżki czytania oraz wynik→odpowiedź→powrót działają; nie deklarujemy trwałego zachowania każdego filtra po dowolnej zmianie sekcji. |
| KR-13/14: błędy/loading i historia | Historia niezależna, jawna, ponowienie działa. Testy PR66 chronią również opóźnienia i zmianę zakresu. |
| KR-15/16/17: fokus, rozmiary, kontrast | Podstawowe przepływy działają; GA-01/02 poprawione w PR67; dowody po zmianie poniżej. Poprzedni lime-tekst wybranego tytułu usunięty. To nie pełny audyt kontrastu. |
| RT-01/02/03: akcje Worktrees, claim i błąd | Akcje i powiązany błąd potwierdzone. Obcego claimu nie odtwarzano ponownie w tym przebiegu. |
| RT-04/05: znaczenie i gęstość Testów | Poprawione; GA-02 na granicy szerokości domknięty w PR67. |
| RT-06: etykieta Close w PL | Panel testu i uruchomienie mają obecnie nazwę Zamknij. |
| RT-07: pierwszy pomiar | Marker i opis są w kodzie; obecna kopia ma już trzy pomiary. Tekstowa alternatywa sprawdzona. |
| RT-08/09: logi i mobile | Puste sekcje zwarte, trafienia widoczne, wiersze mobilne czytelne. |
| RT-10: język starego komunikatu po przełączeniu | Drobny pozostawiony punkt; nie odtwarzano nowej mutacji wyłącznie dla toastu. |

## Ograniczenia

To odbiór reprezentatywnych przepływów, nie kompletna zgodność WCAG ani pełne badanie użyteczności. Nie testowano czytnika ekranu, fizycznego telefonu, innych silników przeglądarki, pełnej macierzy grantów, aktywnej kolejki/anulowania ani obcego claimu w tej nowej sesji. Te mechanizmy mają wcześniejsze testy, ale nie są nowym dowodem tego audytu. Nie mierzono wydajności produkcyjnej ani czasu pracy człowieka. Szukanie dokumentów, wybór zastępstwa bez ID i niskopriorytetowe pozostałości pozostają jawnie otwarte.

## Wynik implementacji i sprawdzeń

Kod aplikacji `269e103`, końcowy commit testów `1e83f52`; porównanie Git potwierdza identyczność kodu aplikacji. [PR67](https://github.com/pioootrek/worktree-switcher/pull/67).

- Managed check `669f0a75-9228-40ab-a851-5d7a70aa9af3`: **PASS**, 515 testów aplikacji + 7 zasobów; znane wcześniejsze ostrzeżenie lint dotyczące zależności efektu w Knowledge, zero błędów.
- Managed build `7e990748-f9b9-49ff-ace7-ec62a02bb257`: **PASS**. Oba przebiegi na czystym `269e103`, `observed_match`.
- UI `3e0b9566-5555-48ce-889a-315e1ebec930`: **FAIL**, 132/134. Dwie nowe regresje miały błędy testu: Escape wysłany przed przejęciem fokusu przez Sheet oraz wyszukiwanie przycisku tła przez drzewo dostępności, z którego otwarty modal je ukrywa. Trace potwierdził przyczyny. `1e83f52` czeka na rzeczywisty fokus wewnątrz panelu i mierzy element tła przez DOM; bez arbitralnych opóźnień i bez zmian aplikacji.
- Końcowy UI `5a6b9333-ca5e-4d28-b5e8-ba5cc24d2076`: **PASS, 134/134** na czystym `1e83f52`, `observed_match`. Wcześniejszy UI na `6254153` został anulowany dla poprawki po review; nie jest zaliczony jako sukces.
- Pilot: oba kierunki 390↔1440 dla Testów i Zasobów przywracają właściwy przycisk, widoczny na ekranie. Testy 1366×650 mają pełną akcję w kartach, PL/dark i EN/light. Cztery końcowe zrzuty otwarto i sprawdzono. [Pomiary po poprawce](acceptance-final-evidence.json).
- Końcowe dodatkowe próby 200% zoomu przekroczyły timeout w czasie silnej presji I/O hosta (odczyt `/proc/pressure/io`: full avg10 ok. 81%). Nie zaliczono ich jako sukcesu; wcześniejszy sprawdzony zoom 200% dotyczy bazowego odbioru powyżej. Brak `pageerror` w sesji. Zamknięto Chromium, rezerwację zwolniono; podgląd pozostał uruchomiony na worktree `fix/gui-detail-focus`, port 3001.

![Testy po zmianie progu](acceptance-screenshots/26-tests-1366-fixed.png)
![Powrót do Testów na telefonie](acceptance-screenshots/27-tests-mobile-focus-restored.png)
![Powrót do Zasobów na telefonie](acceptance-screenshots/28-resources-mobile-focus-restored.png)
![Pełne akcje na laptopie, jasny motyw](acceptance-screenshots/29-tests-1366-light-fixed.png)

Review n8n: Claude wskazał możliwość przywrócenia fokusu poza ekranem po zmianie układu; poprawka ujawnia cel i ma regresję na niskim ekranie z wieloma wynikami. Publikacja review Claude została zablokowana uprawnieniami jego sesji, więc uwagę odczytano z logu. Kimi wskazał drugi przypadek: aktywny test występuje w sekcji Aktywne oraz w Historii; tożsamość celu musi zachować także grupę pochodzenia. Latest wyklucza aktywne uruchomienia. Codex nie znalazł dodatkowych uwag.

GitHub [Verify 36559079381](https://github.com/pioootrek/worktree-switcher/actions/runs/36559079381) na `1e83f52`: wszystkie cztery joby PASS (check/build/HTTPS/integration/UI/E2E oraz package smoke Node22/24 i service lifecycle). PR67 scalony jako `186253af0f2134bd0a9a42bfcc9c42126d1edbee`. Kimi: 1 fix, oryginalny wątek z odpowiedzią i rozwiązany; Claude: 1 fix odzyskany z logu, publikacja nadal niedostępna; Codex: brak dodatkowych uwag. Ponowny odczyt GitHub: zero nierozwiązanych wątków. Zasady widocznego celu i zachowania grupy pochodzenia dopisano do `docs/ui-standards.md`.
