# Tryby uwierzytelniania i opcjonalny plugin Better Auth

## Aktualny stan, 2026-09-27

Etap 1 A–F i poprawki review są scalone w PR #54 (`main` `17d0c9d`),
a CI 36312411574 jest zielone. CLI wyboru trybu i tokena jest dostępne;
Better Auth pozostaje niedostępnym dostawcą. Zadanie etapu 1 nadal obejmuje
konkretną lukę: CLI wiedzy, administracji tożsamością oraz logicznego
importu/eksportu wymaga tokena przed sprawdzeniem trybu open. Szczegóły są w
[przeglądzie](../NOTE-20260829-readiness-assessment/reconciliation-20260927.md).
Opis bazowego kodu i propozycje etapu 1 niżej zachowują historię decyzji;
bieżące polecenia i ograniczenia opisuje [instrukcja auth](../../../authentication.md).

Data: 2026-09-17. Baza przeglądu: `a727fd8` na `main`.
Status: plan; zapis nie zmienia działającego kontrolera ani jego konfiguracji.

## Kierunek właściciela i kolejność

1. CLI wybiera jeden tryb dla całej instalacji: `open`, `token`, `better-auth`.
   `open` nie wymaga żadnego uwierzytelnienia. `token` używa jednego tokena
   wygenerowanego w CLI do wszystkich funkcji, włącznie z wiedzą.
   `better-auth` może początkowo zwracać komunikat o braku implementacji.
2. Wdrożyć Better Auth jako opcjonalną integrację z modularną granicą.
   Rdzeń pozostaje MIT. Osobny plugin jest proponowanym sposobem dostarczania
   płatnej integracji; cena, licencja własnego kodu i aktywacja pozostają otwarte.

Etap 1 aktualizuje [zadanie trybów dostępu](../../feature/FEAT-20260829-independent-auth-modes.json).
Etap 2 aktualizuje [zadanie kont](../../feature/FEAT-20260829-local-web-accounts.json).
Nie tworzyć równoległych implementacji tych samych funkcji. Nowy kierunek zastępuje
wcześniejsze niezależne przełączniki Web/MCP oraz wymóg osobnego tokena wiedzy
w podstawowym przepływie właściciela. Scoped tokeny agentów pozostają opcjonalnym,
osobnym zakresem; nie są warunkiem użycia wszystkich funkcji przez właściciela.

## Historyczny stan kodu z 2026-09-17

- `src/cli/index.ts` składa kontroler, SQLite, identity, knowledge, HTTP i MCP.
  Nadal istnieją token parowania Web i odrębny token MCP.
- `src/cli/identity-management.ts` obsługuje bootstrap/recovery właściciela
  oraz tokeny agentów. Nie ma jeszcze globalnego wyboru trzech trybów.
- `src/server/http-server.ts` rozdziela uwierzytelnienie runtime i wiedzy.
  `src/features/dashboard/use-dashboard.ts` przechowuje je osobno.
- `IdentityService` weryfikuje własne poświadczenia i granty wiedzy. Samo
  wystawienie sesji przez Better Auth nie daje dostępu do obecnych operacji.
- `SqliteStateStore` implementuje interfejsy kilku modułów na jednym połączeniu.
  Dashboard jest statyczny; dynamiczny backend Next.js nie jest uruchamiany.

## Etap 1: jedna polityka dostępu całej instalacji

Proponowany kontrakt CLI, do potwierdzenia testami pomocy i zgodności podczas
implementacji. Polecenia są już dostępne po etapie 1; zapis zachowuje
pierwotny zakres:

```text
worktree-switcher auth status
worktree-switcher auth mode set open
worktree-switcher auth mode set token
worktree-switcher auth token generate
worktree-switcher auth token rotate
worktree-switcher auth mode set better-auth
```

| Tryb | Zachowanie |
| --- | --- |
| `open` | Dashboard, API, włączony MCP, wiedza, załączniki, eksport/import i pozostałe operacje nie wymagają tokena, hasła ani sesji logowania. |
| `token` | Jeden token instalacji wygenerowany przez CLI daje dostęp do wszystkich funkcji udostępnionych przez dany transport. Dashboard nie pyta osobno o token wiedzy. |
| `better-auth` | Do etapu 2 wybór zwraca stabilny błąd `auth_provider_unavailable` i czytelne „Better Auth: to be implemented soon”. Dotychczasowy tryb pozostaje aktywny. |

### Wspólna granica i zachowanie trybów

- Wprowadzić mały kontrakt dostawcy uwierzytelniania i wspólny kontekst wywołania
  w aplikacji. HTTP, MCP i CLI korzystają z tej samej polityki; uwzględnić SSE,
  pobieranie plików, odtwarzanie wyników i wszystkie obecne operacje wiedzy.
- `open` jest pełnym brakiem uwierzytelniania, także dla zapisu i zatwierdzania
  wiedzy. Wewnętrzny identyfikator instalacji służy historii i idempotencji,
  nie udaje uwierzytelnionego człowieka. Audyt i zatwierdzenia zapisują jawnie
  `authentication: none`; wcześniejszy warunek sesji właściciela trzeba
  zastąpić świadomą polityką trybu, nie obejściem w samym HTTP.
- Token instalacji jest pełnym dostępem do instalacji, także wiedzy i jej
  administracji. Posiadanie wspólnego tokena nie dowodzi, który człowiek lub
  agent wykonał operację; nazwy klientów są deklarowanymi metadanymi.
  Historia zachowuje istniejących autorów, granty i identyfikatory projektów.
- Pełny dostęp nie usuwa walidacji danych, rewizji, rezerwacji, zasad wykonania
  procesów ani uprawnień narzędzi MCP wynikających z ich kontraktu. Klient MCP
  nadal nie dostaje narzędzia do zmiany trybu, wydawania tokenów ani przejmowania
  cudzej rezerwacji. Identyfikatory sesji/lease służą koordynacji, nie są
  dodatkowym logowaniem do funkcji w trybie otwartym.
- Istniejące scoped tokeny pozostają ograniczone swoimi grantami w trybach
  wymagających uwierzytelnienia. Globalny token nie musi być dzielony na tokeny
  funkcjonalne. W `open` granty nie tworzą pozornej granicy dostępu anonimowego.
- Zachować jednego właściciela SQLite i lifecycle. Tryb nie zmienia adresów
  nasłuchu, portów, włączenia listenerów ani zarządzania procesami.
  `open` nie wymaga dodatkowego hasła, tokena, HTTPS ani interaktywnego
  potwierdzenia jako warunku aktywacji; jawne polecenie CLI jest wyborem.
  Ochrona origin/Host, limity i walidacja pozostają niezależne od uwierzytelnienia.
  Status i dashboard pokazują tryb otwarty oraz rzeczywisty adres nasłuchu.

### CLI, migracja i przełączenie

- Zmiana trybu jest operacją lokalnego administratora przez CLI. Przy działającym
  kontrolerze używa kanału administracyjnego chronionego prawami systemu
  operacyjnego, nie publicznej anonimowej trasy HTTP. Offline korzysta z singleton
  lock; nie otwiera drugiego właściciela bazy. Nie wymaga dodatkowego tokena wiedzy.
- Ustawienia są trwałe. Nowa instalacja domyślnie wybiera `token`; istniejąca
  instalacja zachowuje ochronę do jawnej migracji. Kontroler nie wybiera `open`
  wskutek braku konfiguracji, tokena lub uszkodzenia pluginu.
  Aktywacja `token` wymaga wygenerowanego tokena; jego brak zwraca instrukcję
  użycia CLI, bez udostępnienia operacji i bez zmiany poprzedniego trybu.
- `generate` tworzy token raz, pokazuje go w prywatnym wyjściu CLI i przechowuje
  verifier. Powtórne generowanie nie podmienia aktywnego sekretu; służy temu
  `rotate`. Token pozostaje ważny przez restart, do jawnej rotacji/odwołania.
  Sekret nie trafia do argumentów procesu, zwykłych logów ani statusu.
- Migracja wymienia dotychczasowy pairing/MCP/token wiedzy na jeden nowy token
  instalacji i aktualizuje instrukcje klienta. Nie podnosi automatycznie uprawnień
  starych tokenów. Usunąć wymóg drugiego pola wiedzy w UI. Określić los prywatnego
  service-access record oraz poleceń `service open` i `config mcp`, skoro surowy
  token nie jest odtwarzany z verifiera; mogą przyjmować token lokalnie lub
  raportować potrzebę podania go, bez ukrytego generowania kolejnego sekretu.
- W `token` ten sam sekret może być używany jako Bearer w CLI/MCP oraz wymieniony
  na sesję przeglądarkową. Sesja obejmuje cały dashboard i wiedzę. Wylogowanie
  kończy tę sesję, a rotacja tokena unieważnia wszystkie sesje z niego wywiedzione.
- Przełączenie waliduje docelową konfigurację przed zapisem i zmienia politykę
  atomowo. Unieważnia wcześniejsze sesje Web/MCP oraz zamyka stare subskrypcje.
  Nie zatrzymuje serwerów projektów ani testów; rezerwacje zachowują ustaloną
  politykę wygaśnięcia. Kontrolowany restart samego kontrolera, jeśli konieczny,
  musi być osobnym jawnym krokiem, nie skutkiem ubocznym ustawienia trybu.
- Brak Better Auth blokuje jego aktywację. Jeśli niedostępny provider został
  wpisany ręcznie do konfiguracji, start kończy się jednoznacznym błędem przed
  udostępnieniem funkcji. Nie ma automatycznego przejścia do `open` lub `token`.

Odbiór etapu 1: macierz HTTP/MCP/CLI/Web potwierdza brak poświadczeń w `open`,
pełny przepływ runtime + wiedza z jednym tokenem w `token`, odrzucenie braku lub
błędnego tokena, rotację, restart, migrację starych klientów, SSE i załączniki.
Sprawdzić pełne operacje wiedzy na istniejącym i nowym projekcie oraz uczciwy
zapis autora operacji anonimowej. Testy obejmują atomowość zmiany, błąd placeholdera,
lokalny dostęp administracyjny przy działającym kontrolerze i blokadę offline.

## Etap 2: plugin Better Auth

Pierwszy zakres: jeden właściciel, logowanie username/password, wylogowanie,
sesje całego produktu, zmiana/reset hasła i odzyskanie dostępu przez lokalne CLI.
Wielu użytkowników, role zespołowe, publiczna rejestracja, e-maile, billing oraz
organizacje są kolejnymi funkcjami, nie warunkami tego etapu.

### Granica pakietu

- Rdzeń MIT publikuje wersjonowany kontrakt providera i normalizuje wynik
  uwierzytelnienia do własnej tożsamości. Wspólne operacje nadal egzekwują zasady
  dostępu. Nie uzależniać kontraktów domeny od typów Better Auth.
- Plugin jest osobnym, opcjonalnym pakietem instalowanym przez operatora.
  Bootstrap ładuje jawnie skonfigurowany lokalny pakiet, sprawdza wersję API
  i podpina trasy/sesje w istniejącym kontrolerze Node. Bez pobierania kodu z
  żądań HTTP, marketplace, skanowania repozytoriów ani ogólnego frameworka pluginów.
- Kod pluginu działa z uprawnieniami kontrolera; ten kontrakt nie jest sandboxem.
  Określić lifecycle, dispose i odpowiedzialność za błędy oraz migracje.
- Zachować statyczny dashboard. Wybrać podczas pierwszej integracji mały ekran
  logowania w rdzeniu albo zbudowane statyczne zasoby pluginu; prywatny kod
  serwerowy nie trafia do publicznego bundle ani paczki Community.
- Integracja używa SQLite pod istniejącym właścicielem połączenia i migracji.
  Najpierw sprawdzić transakcje, zamykanie połączenia i zgodność adaptera Better
  Auth; biblioteka nie otwiera niezależnie drugiej bazy. PostgreSQL jest osobnym
  późniejszym zadaniem.
- Konta Better Auth mapują się na trwałe ID Switchera. Unieważnienie konta lub
  sesji działa na API, wiedzę, SSE i załączniki; nie pozostawia ważnej kopii sesji
  w dotychczasowym IdentityService. MCP/CLI automatyzacji zachowują poświadczenia
  maszynowe, bez przesyłania hasła przy każdym wywołaniu.
- Użyć biblioteki do obsługi haseł i sesji. Zweryfikować limity logowania,
  cookies, origin/CSRF, reset/unieważnienie sesji i HTTPS dla zdalnego logowania.
  Dokumentacja username nadal wymaga e-maila w standardowym tworzeniu konta:
  rozstrzygnąć provisioning przed implementacją. Nie obiecywać bezmailowych kont
  na podstawie samej dostępności `signIn.username`.

Odbiór etapu 2: świeża instalacja i aktualizacja, login/logout/recovery, pełna
sesja runtime+wiedza, zmiana hasła i unieważnienie sesji. Przetestować brak,
niezgodność i błąd pluginu bez osłabienia ochrony oraz jawny powrót CLI do
`token` bez utraty danych. Paczka Community buduje się i działa bez pluginu.

### Plugin a opłata i licencja

Better Auth jest na MIT. Jego licencja dopuszcza sprzedaż i użycie w produkcie
komercyjnym, z zachowaniem wymaganych informacji licencyjnych. Własny plugin
integracyjny może być dostarczany osobno na innych warunkach; licencja Better
Auth i prawa do jego kodu pozostają zachowane. Otwartość rdzenia umożliwia też
innym autorom napisanie konkurencyjnego providera.

Plugin rozdziela kod i dystrybucję. Klucz lub podpisany plik licencji to osobny
mechanizm uprawnienia do używania płatnego pakietu, nie alternatywa dla pluginu.
Propozycja pierwszej wersji: dostarczanie pakietu klientowi, bez serwera aktywacji.
Ewentualny podpisany plik offline można dodać później. Decyzja o cenie i egzekwowaniu
licencji pozostaje otwarta; nie budować systemu licencyjnego jako zależności
etapu 1. Wygaśnięcie lub awaria licencji nigdy nie przełącza ochrony na `open`.
Politykę takich zdarzeń trzeba ustalić przed dodaniem egzekwowania licencji.

Źródła sprawdzone 2026-09-17:

- [Licencja Better Auth](https://github.com/better-auth/better-auth/blob/main/LICENSE.md).
- [Tekst MIT](https://opensource.org/license/mit).
- [Username](https://better-auth.com/docs/plugins/username).
- [Adapter SQLite](https://better-auth.com/docs/adapters/sqlite).

## Powiązanie z SaaS i weryfikacja

Ten sam plugin może dostarczać logowanie w self-hosted i usłudze właściciela.
SaaS dodaje osobny onboarding, odzyskiwanie konta bez terminala, izolację klientów,
subskrypcje i utrzymanie. Sesja logowania nie jest granicą organizacji.
`open` oraz wspólny token instalacji są trybami self-hosted; nie służą do
rozróżniania klientów publicznego SaaS. Zachować bramki izolacji i workerów z
[planu SaaS](implementation-plan.md).

Przy implementacji etapów: testy opisanych zachowań, `pnpm check`, build dla
zmian modułów/pakowania, dotknięte przepływy przeglądarkowe i test paczki poza
repozytorium. Używać kolejki MCP i istniejących zasad lifecycle/hosta.
Zapis tego planu wymaga tylko Hub `fmt`, `validate` i `git diff --check`.
