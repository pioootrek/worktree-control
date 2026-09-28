# Czytanie backlogu, notatek i pamięci: analiza źródłowa

Stan: część źródłowa ukończona, audyt wizualny i interakcyjny oczekuje na dostęp do sprawnego narzędzia przechwytywania. Data: 2026-09-28. Kod: `e4a3a2f`, Worktree Switcher. Osobny worktree: gałąź `audit/knowledge-reading`. Zakres nie obejmuje LLM Ops Hub.

## Cel i granice dowodów

Człowiek powinien móc znaleźć zadanie, przeczytać jego uzasadnienie i kryteria odbioru, otworzyć powiązaną dyskusję, przeczytać dokument notatki i ustalić aktualną decyzję bez znajomości identyfikatorów bazy oraz bez pobierania tekstów do zewnętrznego edytora.

Poniższe ustalenia wynikają z bieżącego kodu i kontraktów. Nie zastępują oględzin zalogowanego interfejsu. Istniejące testy zostały przeczytane, ale nie uruchomiono ich ponownie w ramach analizy. Dawne zrzuty i raporty nie stanowią dowodów tego audytu. Wbudowana przeglądarka otworzyła aktualny adres usługi; odczyt DOM pokazał brak tokena, a dwie próby snapshotu zakończyły się `PreviewAutomationExecutionError`. Nie uzyskano zaakceptowanego zrzutu. Nie ustalono rewizji eksportu GUI uruchomionej usługi.

## Najważniejszy wniosek

Problem zaczyna się przed CSS. Interfejs pokazuje techniczny model zapisanych rekordów, a właściwe materiały do czytania pozostawia w załącznikach. Poprawienie kolorów lub samo sformatowanie JSON nie rozwiąże dojścia do dokumentów, wyszukiwania, znaczenia relacji i kolejności historii.

Importer zachowuje oryginalne dane i pliki. To dobra podstawa: należy poprawić ich odczyt i prezentację, bez przepisywania źródeł ani udawania, że brakujące metadane zostały ustalone.

## Ścieżka czytelnika do sprawdzenia w przeglądarce

1. Wejście do Wiedzy i wybór projektu. Ocena wizualna: oczekuje. Sprawdzić zgodność kontekstu z pickerem projektu runtime w bocznej nawigacji.
2. Lista backlogu, widoki i wyszukiwanie. W kodzie są liczniki, statusy, priorytety i paginacja; brak pełnego przeszukiwania treści w tej zakładce.
3. Szczegóły długiego zadania. W kodzie problem, zakres i walidacja są jednym tekstem bez nazw sekcji.
4. Przejście do relacji i dyskusji. Linki istnieją, ale pokazują techniczne ID; kolejność importowanych wypowiedzi wymaga weryfikacji.
5. Lista pamięci i wybór notatki. W kodzie fragmenty wyników oraz treść mogą zawierać JSON.
6. Otwieranie dokumentu notatki. Potwierdzone w kodzie: dostępne jest pobranie pliku, brak czytnika dokumentu.
7. Znalezienie decyzji i powrót do zadania. Sprawdzić tytuły źródeł, status zatwierdzenia, zachowanie filtrów i pozycję przewijania.
8. Czytanie na telefonie i klawiaturą. Do przeprowadzenia na aktualnym eksporcie; sama obecność klas responsywnych nie dowodzi użyteczności.

## Ustalenia

Priorytet P1 oznacza przeszkodę w podstawowym czytaniu i wyszukiwaniu. P2 oznacza istotne utrudnienie orientacji. P3 oznacza dopracowanie lub ryzyko wymagające dodatkowego pomiaru. Numery odnoszą się do tej analizy, nie do wcześniejszego audytu GUI.

### KR-01 · P1 · Dokument notatki jest plikiem do pobrania

`RecordAttachments` pobiera bajty, tworzy Blob `application/octet-stream` i klika link z `download`. Nie oferuje podglądu Markdown, tekstu ani obrazów. Importer mapuje `note.json` na pamięć, a pozostałe pliki katalogu notatki na załączniki. Raport, plan i dowody leżą więc za kontrolką Załączniki, obok technicznych plików, a nie w głównej ścieżce czytania.

Źródła: `src/features/knowledge/record-attachments.tsx:29`, `src/server/modules/knowledge/hub-import-plan.ts:231`, `src/features/knowledge/memory-panel.tsx:128`.

Zalecenie: lista dokumentów z tytułem, typem i podglądem; podstawowa akcja Otwórz, dodatkowa Pobierz oryginał. Markdown i tekst czytać w aplikacji; obraz powiększać. Nie wykonywać HTML ani skryptów z załączników. Zachować oryginalne bajty i autoryzację odczytu.

Odbiór: użytkownik otwiera plan `.md`, czyta nagłówki, tabelę i kod, wraca do tej samej notatki bez pobrania pliku; plik binarny nadal można pobrać. Duży lub nieobsługiwany dokument ma jasny stan zastępczy.

### KR-02 · P1 · JSON zastępuje ludzką treść notatki

Importer używa `JSON.stringify(payload.body ?? payload)`, jeżeli body nie jest stringiem. Wiele manifestów ma body jako obiekt metadanych, a właściwy tekst w plikach. `MemoryPanel` wyświetla body bez rozpoznania formatu, a lista pokazuje jego początek. Samo dodanie wcięć do JSON nadal przedstawiałoby strukturę manifestu zamiast dokumentu.

Źródła: `src/server/infrastructure/sqlite/sqlite-state-store.ts:187`, `src/features/knowledge/memory-panel.tsx:108`, `src/features/knowledge/memory-panel.tsx:118`.

Zalecenie: jawne rozpoznanie pochodzenia i typu treści w modelu odczytu. Dla importowanej notatki: zwięzły opis, dokumenty, metadane źródła; oryginalny payload w rozwijanym widoku technicznym. Dla zwykłego tekstu zachować tekst. Nie zgadywać formatu na podstawie samego pierwszego znaku `{`.

Odbiór: notatka z body-string, body-object i bez body ma czytelną prezentację; oryginał pozostaje dostępny. Nie zmieniać trwałego body tylko w celu poprawienia wyglądu.

### KR-03 · P1 · Wyszukiwarka nie obejmuje treści dokumentów

SQL wyszukiwania łączy tytuły i body z wątków, odpowiedzi, zadań i pamięci. Nie odczytuje ani nie indeksuje treści załączników. Fraza występująca tylko w planie `.md` nie może dać wyniku, mimo że pole nazywa się „Szukaj w tytułach, treści i pamięci”. Backlog i dyskusje mają dodatkowo osobne wyszukiwanie wyłącznie po tytule.

Źródła: `src/server/infrastructure/sqlite/knowledge-queries.ts:127`, `src/server/infrastructure/sqlite/knowledge-queries.ts:181`, `src/server/infrastructure/sqlite/knowledge-queries.ts:214`, `src/i18n/messages.ts:32`.

Zalecenie: jasno określić zakres wyszukiwania i dodać ograniczone indeksowanie obsługiwanych dokumentów tekstowych. Wynik dokumentu musi prowadzić do właściwej notatki i pliku. Wydobycie tekstu powinno następować przy imporcie/zapisie, nie jako pełny skan przy każdym wyszukaniu.

Odbiór: fraza obecna wyłącznie w załączniku Markdown daje wynik z nazwą pliku i trafionym fragmentem; nie ujawnia dokumentu bez uprawnień.

### KR-04 · P1 · Zadanie traci strukturę problem–zakres–odbiór

Importer skleja tablice `problem`, `scope`, `validation` pustymi liniami, bez nazw sekcji. Ekran pokazuje jedno `p` z `whitespace-pre-wrap`. Nie da się szybko rozpoznać, co jest problemem, co planem prac, a co warunkiem zakończenia. Pozostałe pola, np. ryzyko i źródło, nie mają jawnej prezentacji w szczegółach. Oryginalny payload zachowany w proweniencji nie oznacza dostępnego widoku w GUI.

Źródła: `src/server/infrastructure/sqlite/sqlite-state-store.ts:181`, `src/features/knowledge/knowledge-dashboard.tsx:149`, `src/shared/contracts/knowledge.ts:45`.

Zalecenie: odczyt importowanego rekordu jako oznaczonych sekcji, z rozróżnieniem aktualnej treści i historycznego źródła. Nie pokazywać starego payloadu jako bieżącej treści po edycji zadania. Listy kontrolne walidacji nie powinny sugerować wyników, których nie zapisano.

Odbiór: długie importowane zadanie ma rozpoznawalne sekcje i pozwala znaleźć kryteria odbioru bez czytania całej ściany tekstu.

### KR-05 · P2 · Powiązania nie mówią, dokąd prowadzą

Ekran wyświetla „Powiązane zadanie/wątek” oraz ID zamiast tytułu docelowego rekordu. Typ relacji (`blocks`, `derived_from`, `supersedes`, `relates_to`) i kierunek nie są przedstawiane. Powiązanie z odpowiedzią jest samym tekstem ID.

Źródło: `src/features/knowledge/knowledge-dashboard.tsx:153`.

Zalecenie: tytuł, typ i kierunek relacji, stan celu, techniczne ID dopiero w metadanych. Zbiorcze, autoryzowane pobranie etykiet zamiast osobnego zapytania dla każdego linku. Dla niedostępnego celu neutralna informacja bez ujawniania jego tytułu.

Odbiór: użytkownik przed kliknięciem rozróżnia blokadę, źródłową dyskusję i zwykłe powiązanie; odpowiedź prowadzi do konkretnej wypowiedzi.

### KR-06 · P2 · Markdown pozostaje surowym tekstem

Opis zadania, treść dyskusji, odpowiedzi, body pamięci i fragmenty kontekstu są renderowane jako zwykłe akapity. Nagłówki, listy, tabele, linki i bloki kodu nie zyskują swojej semantyki. Zachowanie nowych linii nie zastępuje składu dokumentu.

Źródła: `knowledge-dashboard.tsx:149,161`, `memory-panel.tsx:118`, `task-context.tsx`.

Zalecenie: wspólna, bezpieczna prezentacja dokumentu, z prawdziwymi nagłówkami i listami, ograniczoną szerokością tekstu, kopiowaniem kodu i obsługą długich tabel. Wyłączyć wykonywalny HTML; rozwiązywać linki względne względem źródła i przypiętej rewizji, nie katalogu dashboardu.

Odbiór: polski i angielski tekst, tabela, kod, URL i bardzo długi ciąg nie psują kolumny przy 390 px oraz na desktopie.

### KR-07 · P1 · Ryzyko pomieszanej chronologii importowanych komentarzy

Import zapisuje odpowiedzi z jednym czasem publikacji `now`. ID odpowiedzi jest skrótem SHA-256 ścieżki źródła. Odczyt sortuje po `created_at, id`, nie po źródłowej kolejności `notes[]` ani historycznej dacie. Kod nie gwarantuje zachowania porządku rozmowy; trzeba potwierdzić na rzeczywistym imporcie przed uznaniem tego za obserwowany błąd ekranu.

Źródła: `src/server/infrastructure/sqlite/sqlite-state-store.ts:145,203`, `src/server/infrastructure/sqlite/knowledge-queries.ts:187`.

Zalecenie: zachować jawny porządek źródłowy i odróżnić czas importu od daty wypowiedzi. Brakujących dat nie wymyślać. Ustalić porządek rozmowy zawierającej komentarze historyczne i nowe.

Odbiór: import kilku komentarzy o tej samej dacie zachowuje porządek źródłowy, także po ponownym imporcie; nowa odpowiedź trafia w przewidywalne miejsce.

### KR-08 · P2 · Wynik wyszukiwania nie prowadzi do trafienia

Excerpt to zawsze pierwszych 300 znaków, nawet jeśli fraza występuje na końcu. Wynik odpowiedzi ma pusty tytuł i jest nazywany „Odpowiedź”; kliknięcie przechodzi do wątku bez wskazania konkretnej odpowiedzi i strony. Przy długiej dyskusji można otworzyć właściwy wątek i nadal nie znaleźć trafienia.

Źródła: `src/server/infrastructure/sqlite/knowledge-queries.ts:131,134`, `src/features/knowledge/memory-panel.tsx:105`.

Zalecenie: fragment wokół dopasowania, tytuł wątku, oznaczenie rodzaju wyniku, link do odpowiedzi i odpowiedniej strony. Podać, co było przeszukiwane i czy wynik został ograniczony.

Odbiór: trafienie w 30. odpowiedzi otwiera tę odpowiedź; fraza po pierwszych 300 znakach jest widoczna w podglądzie wyniku.

### KR-09 · P2 · Metadane importu dominują nad autorstwem i aktualnością

Pamięć na początku pokazuje długie ID oraz „Autor: installation”. Nie wyświetla kategorii notatka/decyzja/pytanie ani daty aktualizacji, choć kontrakt je udostępnia. Historyczne autorstwo komentarzy jest zachowane i pokazane osobno, co należy utrzymać. Pochodzenie repozytorium i pełny SHA zajmują zwykłą część czytanego dokumentu.

Źródła: `memory-panel.tsx:115,120`, `knowledge-dashboard.tsx:148,161`, `src/shared/contracts/knowledge-memory.ts:7`.

Zalecenie: obok tytułu kategoria, aktualność, ewentualne zatwierdzenie; osobno autor historyczny i podmiot importujący. Rozwijane szczegóły techniczne dla ID, SHA i rewizji. Bez wymyślania nazw autorów, jeśli model przechowuje tylko principal ID.

### KR-10 · P2 · Formularz zarządzania konkuruje z czytaniem

W pamięci stale widoczne są pola query, rodzaju rekordu, tagu, legacy ID, statusu, checkbox nieaktywnych, przycisk filtrowania i szeroki przycisk dodawania. Pod treścią są operacje zatwierdzenia, archiwizacji i wpisywane ręcznie ID zastępstwa. To uzasadnione możliwości systemu, ale nie powinny dominować podczas zwykłego czytania.

Źródło: `memory-panel.tsx:85–95,122–127`.

Zalecenie: wyszukiwanie i najczęstszy filtr na pierwszym poziomie, zaawansowane filtry w rozwijanym panelu, mutacje w menu rekordu. Zastąpienie wpisu przez wybór czytelnego tytułu z wyszukiwarki. Ocenić wielkość problemu na zrzutach, szczególnie przy 390 px.

### KR-11 · P2 · Różne zasady czytania między backlogiem i pamięcią

Backlog ma nagłówek listy, liczbę wyników, numer strony, podpowiedź pustego panelu, większy obszar kliknięcia i filtry ukrywane na mobilnych szczegółach. Pamięć ma inną proporcję kolumn, link tylko na tytule, brak analogicznego pustego panelu i numeru strony, a filtr pozostaje nad szczegółami. Te różnice wynikają z dwóch osobnych kompozycji.

Źródła: `knowledge-dashboard.tsx:132–162`, `memory-panel.tsx:85–130`.

Zalecenie: spójny wzorzec lista–czytnik, ale z informacją właściwą dla typu rekordu. Wspólna prezentacja dokumentu i metadanych zamiast dużego komponentu obsługującego wszystko.

### KR-12 · P2 · Filtry i miejsce powrotu nie tworzą trwałego adresu

URL przechowuje projekt, zakładkę i rekord, ale nie query, filtrów, strony ani miejsca przewijania. Zmiana zakładki resetuje filtry i offset; panel pamięci znika po przejściu do zadania. Istniejący test potwierdza zachowanie filtrów przy zmianie pamięci i Back w ramach tej samej zamontowanej zakładki, więc tego przypadku nie należy zgłaszać ponownie jako błędu.

Źródła: `use-knowledge.ts:34–65`, `memory-panel.tsx:30`, `tests/ui/knowledge.spec.ts:486`.

Zalecenie: przewidywalny powrót po przejściu do innego typu rekordu; dopiero potem decyzja, które filtry trzymać w URL, a które lokalnie. Nie umieszczać poświadczeń w adresach.

### KR-13 · P2 · Stan pusty pamięci nie odróżnia ładowania

Panel pamięci zaczyna z pustą listą i bez jawnej flagi ładowania; od razu renderuje pusty wynik. Pobrane rekord, lista i historia są związane jednym Promise.all. Błąd historii może wyczyścić także treść rekordu. Odświeżenie istnieje w nadrzędnym widoku i ma test regresji, ale nie jest lokalnym komunikatem obok problemu.

Źródła: `memory-panel.tsx:40–67,109`, `tests/ui/knowledge.spec.ts:445`.

Zalecenie: osobne stany ładowania, braku wyników i błędu; awaria pobocznej historii nie powinna blokować czytania poprawnie pobranej treści. Potwierdzić przejścia przy opóźnieniu i błędzie sieci.

### KR-14 · P2 · Historia rewizji to surowy zapis techniczny

Historia pamięci pokazuje klucz operacji, principal ID i previousJson. Nie pokazuje daty ani czytelnego opisu zmiany, chociaż kontrakt ma createdAt. Użytkownik musi sam porównywać obiekty.

Źródło: `memory-panel.tsx:129`, `src/shared/contracts/knowledge.ts:73`.

Zalecenie: oś zmian z datą, podmiotem, rewizją i opisem; porównanie treści na żądanie, surowy JSON jako dodatkowy widok. Nie sugerować, że importowane rekordy mają historię, jeżeli jej nie zapisano.

### KR-15 · P3 · Fokus i responsywność wymagają osobnego odbioru

Backlog ma nazwany region przewijania i tabIndex, pamięć nie ma równoważnego rozwiązania. Po otwarciu mobilnego szczegółu link z listy znika; kod nie pokazuje jawnego przeniesienia fokusu na nagłówek. Kontrast, rzeczywisty tab-order, zoom i ilość widocznej treści trzeba zmierzyć. Nie są to potwierdzone naruszenia dostępności na podstawie samego CSS.

Źródła: `knowledge-dashboard.tsx:135,144–146`, `memory-panel.tsx:104–114`.

Odbiór: otwarcie i powrót klawiaturą; widoczny fokus; brak pułapki przewijania; czytanie przy 200% powiększeniu; rzeczywisty viewport 390×844 i 1366×768; polskie długie etykiety, jasny i ciemny motyw.

## Co już działa i należy zachować

- Statusy zadań mają tekst i ikonę; listy mają paginację i ograniczone rozmiary odpowiedzi.
- Linki do rekordów są prawdziwymi odnośnikami; można otworzyć je osobno.
- Back/Forward i utrzymanie filtrów wewnątrz pamięci są objęte testem.
- Edytory zachowują szkice, obsługują konflikty i odzyskują fokus po zamknięciu.
- Autorstwo historyczne komentarza jest odróżnione od podmiotu importu.
- Pobranie załącznika idzie przez autoryzowaną operację; nie trzeba osłabiać kontroli dostępu dla podglądu.
- Eksport kontekstu jawnie ogranicza zakres i ma zastępcze ręczne kopiowanie.

## Proponowana kolejność prac

To propozycja do dopracowania po oględzinach, nie zatwierdzenie implementacji.

1. **Model czytania i dokumenty.** Ustalić reprezentatywny import oraz kontrakt rozróżniający notatkę, dokument i techniczną proweniencję. Bezpieczny czytnik Markdown/tekstu/obrazu, oryginał dostępny osobno. Obejmuje KR-01, KR-02 i KR-06.
2. **Zadanie z kontekstem.** Przywrócić czytelne sekcje, tytuły i znaczenie relacji, autorstwo i kolejność dyskusji. Obejmuje KR-04, KR-05, KR-07 i część KR-09.
3. **Wyszukiwanie, które znajduje dokument.** Zakres, indeks tekstowych plików, trafione fragmenty i link do właściwej odpowiedzi/dokumentu. Obejmuje KR-03 i KR-08. Osobny zakres backendu z testami autoryzacji i limitów.
4. **Spójne listy i czytnik.** Wspólne zasady nawigacji, filtry drugorzędne, metadane, miejsce powrotu, stany ładowania i historia. Obejmuje KR-09–KR-14. Po każdym kroku odbiór mobilny i klawiaturowy KR-15.

Kierunek wizualny pozostaje dotychczasowy: neutralny grafit, czytelny tekst, oszczędny akcent lime, shadcn. Długie dokumenty potrzebują przede wszystkim hierarchii, szerokości wiersza i miejsca do czytania. Konkretny układ należy ocenić na aktualnych ekranach przed projektowaniem wariantów.

## Matryca audytu wizualnego do uzupełnienia

- Lista backlogu i długie zadanie: desktop PL, widok niski 1366×768.
- Relacje i importowana dyskusja z wieloma komentarzami: tytuły, daty, kolejność, powrót.
- Lista pamięci: importowany JSON, zwykła notatka, decyzja zatwierdzona i zastąpiona.
- Notatka z wieloma plikami: Markdown, obraz, JSON, plik binarny; odnalezienie głównego dokumentu.
- Szukanie frazy w body, w dalszej odpowiedzi i wyłącznie w załączniku; brak wyników.
- Nawigacja rekord→powiązanie→Back, odświeżenie i otwarcie linku osobno.
- Mobilne lista/szczegół/powrót; pola filtrów i widoczna ilość treści.
- Klawiatura, zoom, focus, jasny/ciemny motyw, błędy sieci.

Każdy ekran musi dostać nowy zrzut, odczyt DOM, rzeczywiste wymiary, opis akcji i przypisanie do ustaleń. Bez tego nie należy uznawać części wizualnej za ukończoną.
