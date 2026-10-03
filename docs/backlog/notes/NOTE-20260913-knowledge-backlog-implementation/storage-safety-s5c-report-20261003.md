# S5c — zainstalowane pakiety, aktualizacja i odzyskanie

[PR #77](https://github.com/pioootrek/worktree-switcher/pull/77) scalono
2026-10-03 jako `c2be81f1354d5e924eed7607459497298ceb39de`, z końcowego head
`2aed542097ec99d32242c4b65fbda97d50adfa8b`. S5a i S5b są na main przez
PR #75 i #76. To kończy uzgodniony zakres kodu i izolowanych testów S5;
[procedura odzyskania i przekazania do S6](storage-safety-recovery-runbook-20261003.md)
jest przygotowana. Docelowy host, klucze i rollout pozostają osobno.

Próba używa dokładnego historycznego `a727fd8ff01e141c6494615531e27e72a23f6320`,
jego oryginalnego lockfile i pakowania. Nie zmienia starego źródła i nie przypisuje
tego commitu aktualnej produkcji. Stary schemat 24 i obecny schemat 28 działają
w osobnych instalacjach zależności produkcyjnych. Aplikacja, CLI, HTTP, assets
i natywny SQLite pochodzą z pakietów; sterownik oraz przechwycenie wywołań
systemowych są jawnie oddzielonym kodem testowym repozytorium.

Historyczny pakiet ma SHA256
`b22fd38f590e31f44b1124a02b25aa3683e6d1280017cf0d89ce2d25445a5192`
(649955 bajtów). Końcowy lokalny pakiet ma SHA256
`f81b3b350b21072761df1ebc213a0fc3c62c2c9258c3d2eb2b4d3a1622354713`
(859412 bajtów). Oba mają czysty source, Node 24.19.0/Linux x64 i poprawnie
załadowane dostarczone prebuildy SQLite. Wspólny instalator i supervisor zastępują
fragment istniejącego smoke; nie powstał drugi packer. Sumy obejmują tarball
oraz skopiowane skrypty smoke, installer i lifecycle.

| Sprawdzenie | Wynik |
| --- | --- |
| Historyczne dane | Dwa projekty, owner, dwaj agenci, odrębne granty, dyskusje i odpowiedzi, zadania, relacje derived_from, pamięć, historia i dwa załączniki |
| Migracja | Schemat 24 → 28, zachowane treści/tożsamości, dokładne stare wpisy historii i dziewięć controller_audit_events; historyczne audit_events było puste |
| Backup-off | Migracja bez celu kopii i automatycznych zadań backupu |
| Włączony gate | Błąd celu blokuje migrację; pełna trwała kopia schematu 24 poprzedza migrację |
| Cztery przerwania SIGKILL | Przed migracją, po trwałej kopii oraz przed/po zastąpieniu bazy przy restore; odtworzona jedna pełna generacja |
| Istniejące dane celu | Stary sentinel znika po restore; zapisy po ukończonym odzyskaniu przeżywają kolejny restart |
| Odmowy | Uszkodzony format/źródłowa baza, przyszły schemat oraz aktywny właściciel kanonicznej bazy nie nadpisują celu |
| Powrót do starego wydania | Odtworzenie starej kopii do osobnego katalogu; nowy zapis zachowany w aktualnej kopii i odzyskaniu zdalnym |
| Usunięcie źródła | Usunięto i sprawdzono brak 11 oryginalnych/pochodnych lokalnych katalogów danych i kopii przed pobraniem z HTTPS |
| Odzyskanie z HTTPS | Poprawne treści, historia/audyt, hashe i bajty załączników, tożsamości i jawne odmowy dostępu między projektami |
| Sprzątanie | Kontrolery, fixture restic i pliki zakończone poprawnie; profil testów oraz przypisania usunięte |

Końcowy pełny run `8b354c13-73b4-4677-ab79-b7c544c99f82` przeszedł
z observed_match na `2aed542`: 19 kroków smoke oraz 15 aktualizacji/odzyskania.
Odzyskanie małego fixture po pobraniu z HTTPS trwało 5,648 s; nie jest to
produkcyjny RTO ani próba fizycznej utraty hosta. SIGKILL nie dowodzi odporności
na zanik zasilania. Wcześniejszy udany tryb diagnostyczny nie zastępuje pełnego runu.

Historyczna usługa używa `umask 0077`, naturalnie tworząc data 0700 i DB 0600.
Wariant foreground 0022 jest odrzucany przed zmianą bajtów, schematu i praw.
Stary pakiet nie obsługuje arbitralnego create_relation; użyto task_from_thread.
Agent nie dostaje owner-only knowledge:approve. Stare backup create/restore
wymagają ścieżek instalacji przez zmienne środowiskowe, nie argumenty nowszego CLI.
Offline restore zachowuje owner session oraz scoped tokeny z kopii. Odbiór
sprawdza granty i odmowy, ale operator musi rozliczyć stare poświadczenia przed
udostępnieniem odzyskanej instalacji. Osobny fence restore online ma dowody S4a.

Wcześniejsze wyniki zachowują własne SHA: check na `6c790fd` (965 unit + 16
skryptów), build na `5049bb3`, integracje na `bd3daef` (36 + 3 jawne pominięcia
bez binariów fixture), 14 testów celowanych review na `db483ae`. Kolejne zmiany
dotyczyły skryptów, guardów fixture i dokumentacji; kod aplikacji nie był zmieniany.

Końcowe CI `37142272392` zaliczyło wszystkie cztery zadania: 965 unit,
18 skryptów, build/HTTPS, 36 integracji (3 restic pominięte bez fixture),
166 UI, 3 E2E, po 18 etapów smoke Node 22.23.2/24.21.0 oraz lifecycle systemd
na jednorazowym runnerze. Pełną próbę starego/nowego pakietu wykonano osobno
przez MCP; CI lifecycle ma oldFixture=null i nie udaje tej próby.
Pakiet CI z czystego synthetic merge `3b6ccd3c2631fa90e275630944afd173f621dc1c`
ma SHA256 `760c80a8ec37ede5e7981c98f4dea8c99f88f4345c86c6c5b072c982b187924c`.
Sprawdzono sumy, rodziców merge, shipped INSTALL, bundled guide i poprawkę supervisora.

Jedno zlecenie n8n: Claude zgłosił dwie poprawki — brak pomocnika w liście
plików instalacyjnych i gubienie nazwy etapu HTTPS w diagnostyce. Obie naprawiono,
zweryfikowano i zamknięto z odpowiedziami. Kimi i Codex nie zgłosili dalszych
problemów na końcowym head. Wynik: 2 fix, 0 backlog, 0 false positives,
0 unresolved. [Dowody](storage-safety-s5c-evidence-20261003.json) zawierają
identyfikatory, hashe, źródła i odnośniki do odpowiedzi.

Zachowano sześć wcześniejszych porażek: niewidoczną fazę pierwszego błędu,
niedozwolony grant fixture, nieobsługiwane stare argumenty backupu, nierozpoznany
wynik starego supervisora, za długą ścieżkę zagnieżdżonego fixture i późniejsze
odrzucenie 108-bajtowej ścieżki przez dodany guard 107. Skrócono wyłącznie nazwy
fixture; limitów aplikacji, hosta i timeoutów nie zmieniano. Przyczyn dwóch
historycznych ogólnych błędów nie uznano za udowodnioną.

Techniczne zamknięcie nie usuwa znanych ograniczeń operacyjnych. Host/klucze,
monitor i powiadomienia, rzeczywiste RPO/RTO, produkcyjny upgrade, próba klienta
oraz S6/K7–K9 pozostają w rodzicach. Limit ręcznej historii backupu ma osobny
[otwarty wpis](../../rework/RWK-20261003-manual-backup-history-capacity.json).
Nie wykonano wdrożenia ani zmian usług, danych i poświadczeń produkcyjnych.
