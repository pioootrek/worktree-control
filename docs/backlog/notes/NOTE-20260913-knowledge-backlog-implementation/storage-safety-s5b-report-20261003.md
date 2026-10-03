# S5b — zmiana repozytorium i uzgadnianie historii

[PR #76](https://github.com/pioootrek/worktree-switcher/pull/76) scalono
2026-10-03 jako `3e99b7b95055ae125749d54bfbebe9975d015cc6`, z końcowego head
`e9b7e6c65b2e0951c06bfdd30a53f41d8af9da28`. Backupy pozostają opcjonalne,
domyślnie wyłączone i konfigurowane przez operatora w CLI.

Offline `backup remote rebind` uwierzytelnia nowe repozytorium restic i publikuje
jeden rekord formatu 2 pod istniejącymi blokadami kontrolera oraz właściciela
kanonicznej bazy. Inspekcja nie otwiera SQLite ani nie wykonuje recovery.
Niedokończony restore blokuje zmianę. Stare potwierdzenia, źródła i niepewne
transfery pozostają w archiwach; nowy cel zaczyna bez potwierdzenia. Limit
czterech archiwów lub 4 MiB dziennika odmawia dalszej operacji bez kasowania dowodów.

`backup remote reupload <backup-id>` jawnie wybiera pojedynczą starą kopię,
sprawdza jej tożsamość i zachowuje pierwotny wiek danych. Potwierdzenie na nowym
celu nie zwalnia niepewnego źródła przypiętego do starego celu. Nie ma automatycznej
migracji kopii, drugiej kolejki ani kasowania danych z repozytorium.

Uzgadnianie uwierzytelnia maksymalnie 32 nowych kandydatów w przebiegu, przy
pełnym spisie do 256 migawek i 512 KiB. Dowody ID/tree, skrót spisu oraz budżety
przeżywają restart. Limity obejmują 256 MiB odczytów na przebieg, osiem przebiegów
oraz 256 dowodów na transfer i 1024 łącznie. Rezerwacja jest trwała przed efektem.
Błąd odczytu pozostaje niewiadomą; tylko pełna, poprawnie uwierzytelniona
niezgodność dowodzi częściowej migawki. Zmiana spisu, kilka kompletnych kopii
lub brak budżetu blokują nowy zapis. Jawna generacja retry odnawia budżet;
po niepewnym wyniku uploadu najpierw następuje odczyt i uzgodnienie historii.
Potwierdzenie i rebind usuwają tylko zbędny cache dowodów.

Rebind nie zmienia parametrów usługi. README opisuje okno utrzymaniowe:
zatrzymanie usługi i jej automatycznego restartu, przygotowanie nowych argumentów,
rebind oraz odświeżenie konfiguracji przed uruchomieniem. `--from` przyjmuje
`destinationId` z prywatnego statusu, czyli SHA256 identyfikatora repozytorium.
Stara włączona konfiguracja odmawia startupu z `backup_invalid`. Jawne
`--backup-remote-disabled` pozwala uruchomić tryb lokalny i tworzyć lokalne kopie,
zachowując stare przypięte źródła; nowe parametry pozwalają wznowić normalną pracę.

Jedna runda n8n przyniosła trzy poprawki: trwałe wyniki zakończonych restore oraz
nowy operationId przy retry, zwalnianie zbędnego cache dowodów i powyższą procedurę
operatora wraz z testami startupu. Codex nie zgłosił dodatkowych problemów.
Wszystkie trzy wątki mają odpowiedzi z dowodami i są resolved; zero odroczonych
uwag i zero false positives.

Kolejka MCP potwierdziła 58 testów celowanych oraz lint/types, 965 Vitest i siedem
skryptów na ostatnim commicie kodu aplikacji `2ed3918`. Build przeszedł na
`9425834`; końcowy commit zmienia tylko README i scenariusze akceptacyjne.
Na końcowym head przeszły próby HTTPS oraz zainstalowanego pakietu: dwa repozytoria,
dwa stare receipts, jeden zachowany pin, dwa jawne transfery, 34 częściowych
kandydatów, checkpoint 32 dowodów, restart i potwierdzenie bez kolejnego uploadu.
Obie próby obejmują odmowę starego startupu, tryb lokalny i poprawny nowy startup.
Installed smoke ma 20 kroków, Node 24.19.0 i SHA256 pakietu
`d396c1e0b1f4a04dde76e7a77546a159be2cda7a327cb80452d92f8accc21e80`.
Sterownik testowy pochodzi z repozytorium; CLI, HTTP, assets i zależności aplikacji
pochodzą z instalacji produkcyjnej pakietu. Posprzątano własne procesy i profil testów.

CI `37137172368` przeszło wszystkie cztery zadania: 965 unit, siedem skryptów,
HTTPS, 36 integracji, 166 UI, trzy E2E, po 18 kroków smoke Node 22.23.2/24.21.0
i lifecycle systemd na jednorazowym runnerze. Trzy integracje restic pominięto
bez binariów fixture; odpowiednie próby z binariami wykonano lokalnie przez MCP.
Artefakt z czystego synthetic merge `e09e22ee7d9966cff109405608643f23f5b5e08c`
ma SHA256 `50478564cdb7a45c4e2901877d38bd1a0c036edeefb9fb7a67650701c6b59dba`.
Sprawdzono sumy pakietu i skryptów, rodziców merge i zawartość bundla.

Wcześniejszy check `68a73311-3889-4f58-8fce-df2881290d3c` pozostaje nieudany:
19 błędów czasowych podczas zaobserwowanej presji CPU/pamięci/I/O. Dokładna
przyczyna nie została dowiedziona. Kontrolowany rerun przeszedł bez zmiany
limitów, guardów i timeoutów; pozostałe naprawione błędy fixture/types zachowano
w [dowodach](storage-safety-s5b-evidence-20261003.json).

Scenariusz przyspiesza tylko termin zatrzymanego fixture; odstępy produkcyjne
pozostają bez zmian. Nie jest to próba odzyskania ani pomiar RPO/RTO. S5c wykona
[przyjęty kontrakt zainstalowanych artefaktów](storage-safety-s5c-contract-20261003.md).
Docelowy host, klucze i rollout pozostają osobno; produkcji ani usług hosta nie zmieniano.
