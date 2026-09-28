# Cały layout: przejrzystość i wygoda na shadcn

Propozycja z 2026-09-28 po dodatkowym pytaniu właściciela o cały layout. Dyspozycja: przejrzystość i wygoda mają pierwszeństwo, interfejs ma pozostać ładny, korzystać z shadcn i czerpać z jego wzorców. To doprecyzowanie [wspólnego planu](whole-gui-plan.md), nie zatwierdzona nowa makieta ani wykonana zmiana aplikacji.

## Ocena

Obecny szkielet z lewą nawigacją jest sensowny. Zmiany wymaga rozłożenie uwagi i powierzchni: rozbudowana belka globalna, powtarzany kontekst projektu, nagłówki, podsumowania i filtry odkładają właściwą pracę na dalszą część strony. Kolejne obramowane karty nie naprawią tego problemu. Zachować zatwierdzony grafit/lime, etykiety nawigacji, semantykę stanów i dostęp do szczegółów.

Dowody lokalne: [audyt Wiedzy](visual-audit.md), [uwagi właściciela](owner-feedback.md), [audyt pozostałych paneli](runtime-audit.md). Oficjalne źródła shadcn sprawdzono 2026-09-28. Poniższe zastosowania są naszą propozycją produktową, nie zaleceniem shadcn dla Switchera. Nie wykonano nowego browser QA ani implementacji proponowanego layoutu.

## 1. Jeden nagłówek, jedno miejsce wyboru kontekstu

Na desktopie pozostawić lewy pasek z nazwami sekcji. Punktem startowym do prototypu jest około 208–224 px szerokości; zwinięcie do ikon to świadomy wybór użytkownika. Nie otwierać automatycznie kilku poziomów menu i nie dodawać drugiego zestawu tych samych zakładek w treści.

Górna belka: przycisk nawigacji, wybór bieżącego projektu/zakresu, ścieżka sekcji, zwięzły stan systemu i menu preferencji. Zamiast osobnych stale widocznych kontrolek języka, motywu, wylogowania, limitu i MCP — nazwane menu i panel stanu. Istotna awaria, brak połączenia lub blokada nadal muszą być widoczne bez otwierania menu. Zwykły stan poprawny nie potrzebuje szeregu zielonych kontrolek. Nie pokazywać ogólnego „OK”, gdy dane są nieaktualne lub niepełne.

„Dodaj projekt” przenieść do wyboru/katalogu projektów. W obszarze pracy wyróżniać operację danej sekcji: „Dodaj zadanie”, „Nowa notatka”, „Uruchom test”. Jedna dominująca akcja w danym kontekście. Pozostałe zachować z czytelnymi nazwami w menu lub przy rekordzie.

Wiedza ma własne projekty i autoryzację; runtime własne identyfikatory i uprawnienia. Pierwszy etap ujednolica miejsce i wygląd wyboru, ale pokazuje właściwy zakres. Wspólny projekt we wszystkich sekcjach wymaga jawnego mapowania, obsługi niezmapowanego projektu i kontroli dostępu. Nigdy nie mapować po samej nazwie ani nie przenosić poświadczeń między zakresami. Nie dokładać jednocześnie globalnego i lokalnego selecta bez wyraźnego wyjaśnienia ich roli.

Inspiracja: [Sidebar](https://ui.shadcn.com/docs/components/radix/sidebar) — komponowalne grupy, zwijanie i oddzielne obszary nawigacji oraz preferencji. Obecna aplikacja już używa Sidebar; chodzi o lepszą kompozycję, nie wymianę biblioteki.

## 2. Trzy układy pracy we wspólnej ramie

| Układ | Sekcje | Zachowanie |
|---|---|---|
| Lista operacyjna | Worktrees, Testy, Zasoby | Zwięzły kontekst, pasek filtrów, dane i jawna główna akcja. Krótkie szczegóły w bocznym panelu. |
| Lista i czytnik | Backlog, dyskusje, pamięć | Przed wyborem użyteczna lista wykorzystuje szerokość. Po otwarciu rekordów regulowany podział; czytnik można rozszerzyć. |
| Konsola | Logi | Wybór projektu/uruchomienia i wyszukiwanie nad treścią. Wyniki zbiorcze prowadzą do pasującej konsoli, puste sekcje pozostają zwarte. |

Wiedza: lista startowo około 320–380 px, reszta na czytnik, z minimum szerokości obu paneli i przejściem na jeden panel przy zbyt małej przestrzeni. Preferencja szerokości jest zapamiętywana. Długie dokumenty mają własny adres i widok czytania, nie ciasny modal. Po powrocie pozostają zapytanie, przewinięcie i wybrany wpis. Nagłówek rekordu → krótki kontekst → treść/rozmowa → informacje dodatkowe. Nie stosować jednakowego fontu i ciężaru dla tytułu, ID, źródła i tekstu.

Do krótkiego podglądu wyniku testu, zasobu lub właściwości używać Sheet. Do czytania długiej notatki używać normalnej przestrzeni strony. Dialog pozostawić dla krótkiego formularza i decyzji wymagającej skupienia. Wybór wiersza nie uruchamia serwera; bieżący runtime i cel operacji nadal są odrębne, zgodnie z zatwierdzoną makietą.

Inspiracje: [Tasks](https://ui.shadcn.com/examples/tasks) pokazuje filtrowanie, status, priorytet i akcje przy tabeli; [Resizable](https://ui.shadcn.com/docs/components/radix/resizable) daje regulowane panele z obsługą klawiatury; [Sheet](https://ui.shadcn.com/docs/components/radix/sheet) nadaje się do pobocznego szczegółu. Nie kopiować wszystkich kolumn i checkboxów przykładu, jeśli nie odpowiadają rzeczywistym operacjom.

## 3. Treść wcześniej, mniej ramek i powtórzeń

- Zastąpić cztery duże karty na każdej stronie krótkim podsumowaniem, np. liczba działających serwerów, błędów i oczekujących testów. Rozbudowane metryki zostawić tam, gdzie są zadaniem użytkownika: w Zasobach. Liczniki będące filtrami muszą wyglądać i działać jak filtry oraz pokazywać aktywny stan.
- Jeden tytuł sekcji i zwięzły kontekst. Usunąć redundantne „bieżący projekt” w stopce, jeśli ten sam kontekst jest stale widoczny w belce. Nie powtarzać tytułu jako nagłówka karty bez nowego znaczenia.
- Jeden pasek narzędzi: wyszukiwanie, najczęstsze filtry, „Filtry” z licznikiem, akcja sekcji. Aktywne filtry widoczne i usuwalne pojedynczo; „Wyczyść” rozróżnia filtry od całego formularza. Zakres wyszukiwania musi być nazwany.
- W tabelach najpierw nazwa i istotny stan, potem czas/wynik, na końcu widoczna główna akcja. Ścieżka, pełny SHA i identyfikator jako szczegół/kopiowanie. Długie nazwy mają czytelny pełny wariant także bez hover.
- Większe odstępy między sekcjami, mniejsze między elementami jednego zadania. Ograniczyć zagnieżdżone karty i obramowania. Nie zmniejszać tekstu, żeby zmieścić więcej kontrolek.
- Punkt startowy: tekst interfejsu 14–16 px, treść czytelnika 16 px z wygodną interlinią i linią około 65–80 znaków, nagłówek sekcji 24–28 px. To wartości do sprawdzenia na rzeczywistej treści, nie sztywna specyfikacja.
- Limonka dla wyboru i głównej akcji; stany mają też słowo i ikonę. Neutralne „zatrzymany” lub „zarezerwowany” nie powinny stale wyglądać jak awaria. Przywrócić odpowiedni kontrast tekstu akcentowego w light.

## 4. Przewidywalne przewijanie i telefon

Zwykłe listy operacyjne przewijają stronę. Nie umieszczać każdej tabeli, karty i sekcji w osobnym scrollu. W desktopowej Wiedzy dopuszczalne są dwa celowe obszary: lista i czytnik; każdy ma nazwę i poprawny fokus. Konsola ma własne przewijanie oraz jawne śledzenie/pauzę. Elementy sticky nie mogą zasłaniać fokusu, trafienia ani końca treści.

Na telefonie zostawić zwięzły pasek projektu/nawigacji, a ustawienia w menu. Pokazywać listę albo szczegół z nazwanym powrotem, nie oba naraz. Worktree jako wiersz/karta z gałęzią, stanem i akcją. Filtry w rozwijanym panelu, z podsumowaniem aktywnych ustawień poza nim. Duże zestawienia mogą mieć przewijanie poziome, ale główna codzienna operacja nie może go wymagać.

## 5. Udogodnienia po podstawowym porządku

Szybkie przejście do projektu/sekcji i nazwanych poleceń przez przycisk oraz Ctrl/Cmd+K jest użyteczne przy 30–300 projektach. [Command](https://ui.shadcn.com/docs/components/radix/command) dostarcza podstawę takiego menu. Nie oznaczać tego jako „szukaj wszędzie”, dopóki nie istnieje autoryzowane przeszukiwanie dokumentów. Rozdzielić szybką nawigację od wyszukiwania treści. Skrót jest dodatkiem do widocznej drogi myszą i dotykiem; nie może uruchamiać nieoczekiwanych operacji na serwerze.

Na później można rozważyć wybór gęstości tabel. Najpierw potrzebny jest jeden dobrze działający wariant, a nie przełącznik między dwiema niedopracowanymi wersjami.

## Przełożenie na repozytorium i odbiór

`components.json` używa `radix-nova`, neutralnych tokenów i Lucide. Zachować obecną bazę. Nie uruchamiać ponownie shadcn init, nie podmieniać presetu na domyślny z dokumentacji, nie migrować do Base UI. Sidebar, Sheet, Table, Tabs, DropdownMenu i Collapsible są już lokalnie dostępne. Resizable i Command nie występują obecnie w `src/components/ui`; dodać tylko przy wdrażaniu odpowiadającego przepływu, po sprawdzeniu zgodności API i zależności.

Pierwszy przekrój do zaprojektowania i implementacji: ten sam nagłówek + Worktrees + czytnik Wiedzy, na identycznym zestawie danych desktop/mobile. To pozwoli ocenić wspólną ramę na dwóch różnych zadaniach. Kolejne PR-y stosują ustalony wzorzec do Testów, Zasobów i Logów. Kod zgodnie z wcześniejszą dyspozycją właściciela: Sol, osobny worktree, review n8n, uwagi i zielone wymagane kontrole przed scaleniem. Ten dokument nie wprowadza dodatkowej bramki zatwierdzania.

Sprawdzać skuteczność: użytkownik znajduje projekt, rozpoznaje działający serwer i cel przełączenia, dociera do nieudanego testu oraz jego logu, czyta plan i wraca do poprzedniej pozycji. Pierwszy ekran pokazuje istotne dane/akcję zamiast samego formularza. Brak pustej połowy ekranu przed wyborem rekordu. Brak ukrytej głównej akcji przy 1440 px. Obsługa klawiatury, PL/EN, dark/light, 320/390 px, niski viewport i rzeczywisty zoom 200%. Dużych alertów nie usuwać w celu sztucznego zaliczenia kryterium wysokości.

## Dostępność źródeł inspiracji

Oficjalne strony Tasks i komponentów wymienione wyżej zostały odczytane. Próba odczytu `/blocks/sidebar` przekroczyła limit narzędzia web, a `/examples/mail` zwróciła 404. Nie przedstawiamy tych dwóch stron jako obejrzanych ani zweryfikowanych przykładów. Układ lista/czytnik jest naszą propozycją opartą na zadaniu i Resizable, nie deklaracją aktualnego wyglądu niedostępnego przykładu Mail.
