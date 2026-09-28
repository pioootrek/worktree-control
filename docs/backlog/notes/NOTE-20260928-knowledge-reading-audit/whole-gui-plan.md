# Wspólny plan poprawek GUI Switchera

Propozycja po audycie Wiedzy i czterech paneli runtime, 2026-09-28. Rozszerzenie audytu jest dyspozycją właściciela; poniższe szczegółowe rozwiązania są propozycjami agenta. Nie oznacza to zatwierdzenia nowej makiety. Zachować [obowiązujący kierunek](../NOTE-20260911-approved-gui-direction/direction.md), shadcn, obecne kontrakty własności serwera i kolejki. Źródła: [Wiedza](visual-audit.md), [uwagi właściciela](owner-feedback.md), [Worktrees/Testy/Zasoby/Logi](runtime-audit.md).

Szczegółową kompozycję wspólnej ramy, trzech układów pracy i zastosowania shadcn opisuje [propozycja całego layoutu](layout-direction.md), dodana po kolejnym pytaniu właściciela.

## Kolejność

| Etap | Wynik dla użytkownika | Zakres | Agent i myślenie |
|---|---|---|---|
| 1. Wspólny układ | Na pierwszym ekranie widać właściwą pracę, a główne akcje są dostępne | RT-01/02/05/09, wspólna część KR-10–12 i uwag o wyrównaniu | Sol high: kilka widoków i zachowanie stanu; wydzielone korekty CSS medium |
| 2. Czytanie Wiedzy | Lista wykorzystuje miejsce; notatkę i rozmowę można przeczytać bez technicznego szumu | Szczegółowy plan Wiedzy etapy 1–2, wraz z uwagami właściciela | Sol high |
| 3. Zrozumiałe stany i diagnoza | Błąd prowadzi do właściwego uruchomienia, wynik testu jasno opisuje źródła i aktualność | RT-03/04/06/07/10; osobne małe PR-y | Sol high dla modelu aktualności, medium dla ściśle opisanej prezentacji |
| 4. Nawigacja do znalezionej treści | Wyszukiwanie otwiera trafienie zamiast pustego panelu lub początku długiego wątku | RT-08 oraz etapy 3–4 planu Wiedzy; logi jako niezależny mały PR | Sol medium dla logów, high dla kontraktów/importu/indeksu Wiedzy |

## Pierwsze konkretne zlecenie implementacyjne

Osobny worktree od aktualnego main. Zacząć od wspólnego nagłówka, podsumowań i Worktrees; kolejne panele mogą wejść w osobne PR-y korzystające z tego samego wzorca. Nie łączyć pierwszego PR z parserem notatek, migracjami, nową wyszukiwarką ani zmianą polityki rezerwacji.

1. Zweryfikować najbliższe AGENTS i bieżący kod, nie traktować zdjęcia jako specyfikacji danych. Oprzeć widok na projekcie/gałęzi/stanie/działaniu; pełne ścieżki, SHA i identyfikatory pozostawić dostępne drugorzędnie.
2. Skrócić wspólną belkę na małych ekranach, zachowując wybór projektu i nawigację oraz widoczny sygnał istotnego błędu. Dodatkowe operacje pozostawić w nazwanym menu; nie usuwać ich ani nie zmieniać uprawnień.
3. Zastąpić pionowy stos dużych kart na telefonie zwięzłym podsumowaniem z rozwinięciem. W Testach pusta kolejka ma być krótkim stanem, a nie dużą sekcją przed historią.
4. Worktrees desktop: projekt, gałąź, aktualny stan i główna akcja mieszczą się bez początkowego przewijania w poziomie. Techniczne kolumny mogą przejść do szczegółu. Mobile: zrozumiały wiersz/karta zamiast szerokiej tabeli ukrytej pod przewijaniem. Zachować prawdziwe nazwy długich gałęzi i ich dostępny pełny tekst.
5. Wspólny wzorzec filtrów: zgodne wysokości i linie etykiet, główne wyszukiwanie o użytecznej szerokości, dodatkowe opcje rozwijane z licznikiem aktywnych. Nie resetować filtrów, sortowania ani fokusu przez zmianę prezentacji.
6. Czytelny stan rezerwacji: krótkie kto/co blokuje z rozwijanymi szczegółami. Nadal blokować operacje obcego właściciela. Nie podejmować automatycznie próby zwolnienia lub przejęcia claimu.

Odbiór pierwszego zakresu: 1440×1000, 1366×768, 390×844, 320 px i rzeczywisty zoom 200%, PL/EN, dark/light. Na telefonie pierwszy wynik i jego główna akcja widoczne w pierwszym ekranie w typowym stanie bez rozbudowanego alertu; dla błędu widoczne powiązanie i następny krok. Długie nazwy, stan stopped/running/failed, dirty/clean i claim innego aktora. Klawiatura i logiczny powrót z panelu szczegółu. Testy powinny chronić zachowanie i blokady, nie arbitralne klasy CSS.

## Następne zlecenia

Czytanie Wiedzy ma już [szczegółowy plan z kryteriami](implementation-plan.md). Zachować jego wymagania dotyczące pochodzenia, rewizji, autoryzacji dokumentów, chronologii i adresów trafień. Nie traktować kosmetyki list jako rozwiązania problemu surowego JSON i plików dostępnych tylko przez pobranie.

Testy: oddzielić „wynik polecenia”, „obserwacje źródła podczas testu” i „aktualność względem worktree”. Wskazać konkretną przyczynę nieznanego stanu. Najpierw odtworzyć na źródłowych danych, dlaczego UI pokazuje unknown; nie osłabiać warunków freshness w celu uzyskania zielonego badge. Osobno powiązać błąd startu z ostatnim uruchomieniem/gałęzią i logami.

Zasoby: zachować rozdział dysk/serwery i powody blokad. Pokazać pierwszy punkt historii, dodać dostępną alternatywę danych wykresu. Bez automatycznego usuwania cache.

Logi: zapytanie wszystkich projektów daje sumę i liczniki per projekt; sekcje bez trafień pozostają zwarte, trafienie ma bezpośredni cel. Zachować pauzę, bufor i eksport, literalne bezpieczne zaznaczanie tekstu. Odbiór obejmuje trafienia wyłącznie w trzecim projekcie, brak trafień, aktualizację strumienia podczas pauzy i klawiaturę.

## Dostarczenie

Kod zlecać Sol zgodnie z dyspozycją właściciela, z dokładnym zakresem i poziomem myślenia dobranym do ryzyka. Każdy PR na worktree, wymagane sprawdzenia przez kolejkę Switchera, jeden ciężki przebieg naraz i browser QA na kopii. Po utworzeniu PR zlecić review w istniejącym n8n, obsłużyć uwagi, ponowić wymagane kontrole na końcowym SHA i scalać po zielonym wyniku. Bez ponownego pytania o już udzieloną zgodę na ten tryb pracy. Raport audytu sam nie jest implementacją tych zmian.
