# S5a — niezależny monitor kopii

PR #75 scalono 2026-10-03 jako `4bebff93956a2bd8a0ed664845f76fdc57850b3d`,
z końcowego head `94a5b4d53069c979e308792d41c62501c5cbe050`. Dostarcza opcjonalny, jednorazowy `backup monitor`, uruchamiany poza
procesem kontrolera. Domyślnie monitor jest wyłączony: nie kontaktuje się z
kontrolerem, nie otwiera SQLite i nie zgłasza alarmów. `--enabled` włącza jeden
odczyt prywatnego kanału administracyjnego. Konfiguracja progów i czasu probe
należy wyłącznie do wywołania CLI; HTTP/GUI/MCP nie zmieniają polityki usługi.

Odczyt ma limit 16 KiB oraz bezwzględny i bezczynnościowy deadline 50–30000 ms.
Odpowiedź zawiera małą projekcję dzienników bez skanowania katalogu kopii ani
hydracji manifestów; nie zawiera ścieżek, kluczy, aktorów ani treści kopii.
Osobne wieki kopii lokalnej i zdalnej liczone są konserwatywnie od czasu zlecenia
migawki, wraz z kolejką. Potwierdzenie transferu nie odmładza danych.

Monitor sprawdza dostępność ostatniej zarejestrowanej kopii lokalnej przez
ograniczone lstat katalogu, manifestu i niepustego pliku SQLite: wymaga zwykłych
prywatnych plików bieżącego UID i odmawia symlinków. Nie hashuje ponownie kopii,
nie sprawdza sieci ani odtworzenia: `remoteReachability: not-checked` oraz
`recovery: not-measured` są jawne. Wybiera ostatni zakończony wynik według
finishedAt, aby priorytet kopii okresowych nie ukrywał późniejszej awarii starszej
kopii ręcznej. Przy tym samym finishedAt zachowuje awarię konserwatywnie.

Brak/niedostępność kontrolera, limit odpowiedzi, błędna odpowiedź, niezgodny
format, przekroczenie czasu i nieprawidłowy zegar oznaczają unknown. Wyłączenie
obu polityk daje disabled; tryb tylko lokalny nie alarmuje o kopii zdalnej.
Włączony transfer zdalny jest monitorowany również przy ręcznym tworzeniu kopii
z wyłączonym harmonogramem lokalnym. Błędy i brak danych pozostają widoczne.
Wyjścia: 0 healthy/disabled; 1 warning; 2 critical; 3 unknown. Scheduler
zewnętrzny i wysyłanie powiadomień są osobnymi decyzjami operacyjnymi.

S5b pozostaje otwarte: jawna zmiana kryptograficznego repozytorium restic,
zachowanie poprzednich potwierdzeń i pending pins, ograniczone ponowne transfery
oraz ograniczone uzgadnianie historii częściowych migawek. S5c pozostaje otwarte:
zainstalowane stare/nowe artefakty, awarie aktualizacji, recovery, instrukcja S6.
Nie wykonano wdrożenia, transferu danych produkcyjnych, zmiany usług/guardów,
próby utraty fizycznego hosta ani potwierdzenia produkcyjnych RPO/RTO.

Błędne wywołania monitora, w tym flagi innych polityk, zwracają bezpieczny JSON
`unknown`, kod 3 i `invalid_options`. Obsługa monitora poprzedza pozostałe
parsery; nie wypisuje argumentów ani szczegółów błędu. To poprawka jedynej
uwagi n8n Claude. Kimi i Codex nie znaleźli dalszych problemów; Codex potwierdził
poprawkę w końcowym commicie. Jeden wątek: fix, odpowiedź z dowodami, resolved.
Pierwsze zlecenie n8n utknęło w preflight gh auth, zanim wystartował reviewer.
Po potwierdzonym zakończeniu tego procesu ponowne zlecenie wykonało jedną rundę
modelową; nie zmieniano usług ani limitów hosta.

Na końcowym commicie kolejka MCP potwierdziła observed_match: 36 testów
celowanych, lint/types + 940 Vitest i 7 skryptów, build, 3 integracje
(w tym osiem błędnych wywołań CLI), 19 etapów installed smoke Node 24.19.0.
Sprzątanie było graceful. Lokalny SHA256 pakietu:
`60fffba0258a49074a7eba285bdf54f5495567c049675d40d6ddd343e10f2600`.

CI `37130460325` zakończyło wszystkie cztery zadania: 940 unit + 7 skryptów,
build/HTTPS, 36 integracji (2 restic pominięte bez binariów fixture), 166 UI,
3 E2E, po 18 etapów smoke Node 22.23.2 i 24.21.0 oraz lifecycle systemd
na jednorazowym runnerze. Pakiet z czystego synthetic merge `7098347162407af162c4c22c94e3d94ac1bd8efa`
ma SHA256 `3d6bff931dd9163d835eedab15abf9c86fa21254a2c5bb7b43d9dd0af6f2e966`.
Zweryfikowano sumy pakietu/skryptów, rodziców merge i poprawkę w zbundlowanym CLI.

[Dowody](storage-safety-s5a-evidence-20261003.json) zachowują identyfikatory
przebiegów i wcześniejsze nieudane próby. S5b realizuje
[osobny kontrakt](storage-safety-s5b-contract-20261003.md); S5c pozostaje kolejnym PR.
