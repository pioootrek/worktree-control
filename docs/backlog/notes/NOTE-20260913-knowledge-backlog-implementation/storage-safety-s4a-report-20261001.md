# S4a: operacyjne kopie SQLite i GUI operatora

Data: 2026-10-01. Zadanie: `RWK-20260928-sqlite-data-safety`.
Zakres: wyłącznie S4a. Implementacja i wymagana weryfikacja zakończone;
PR jest gotowy do review, bez scalenia ani wdrożenia.

## Rewizja i kontrakt

Pobrano `origin/main` i potwierdzono obecność S3b:
`42859c9d34db15b060e2f553c5e75a55af8c1175`, wraz z raportem
`22ad9b590aedc393c5bd796adfa2a99ebaa899c1`.
Prace wykonano na `feat/sqlite-backup-operations`, w osobnym worktree
`/home/pioootrek/development/worktree-switcher-s4a`.

[Kontrakt maintenance/handoff/restart](storage-safety-s4a-protocol.md)
zapisano przed kodowaniem i zsynchronizowano na `main` w
`2ec416287101a3cd9c5b43b4ad608ea4d773fea3`. Implementacja jest w
[PR #72](https://github.com/pioootrek/worktree-switcher/pull/72).
Końcowy head: `1147b2ff0269eb6d63dd3df81a104b5aee22707c`.
Raport i backlog są oddzielnym commitem dokumentacji na `main`.

## Polityka i wykonanie

Polityka jest niezmiennym wynikiem parsowania argumentów uruchomienia,
a nie ustawieniem w SQLite. Domyślnie brak harmonogramu i akcji web.
Sam katalog kopii nie włącza żadnej z nich. Argumenty i prywatność katalogu
są sprawdzane przed otwarciem bazy lub instalacją definicji usługi.
Definicja zachowuje argumenty; restore ich nie nadpisuje. Dotychczasowy,
niezależny opt-in `--backup-before-migration --backup-dir` pozostaje.

| Argument | Domyślna wartość lub zakres |
| --- | --- |
| `--backup-dir` | Brak; wymagany przez harmonogram i akcje web |
| `--backup-interval-seconds` | Brak; 60–2 592 000 s |
| `--backup-retain-count` | 30; 1–1000 |
| `--backup-retain-days` | 30; 1–3650 |
| `--backup-max-bytes` | 16 GiB; 1 MiB–128 GiB |
| `--backup-timeout-seconds` | 300; 1–3600 s, kontrola kooperacyjna |
| `--backup-queue-limit` | 4; 1–32 przyjęte/wykonywane zlecenia |
| `--backup-ui-actions` | `none`; `create`, `restore`, `create,restore` |

Kontroler, CLI i HTTP korzystają ze wspólnych operacji aplikacji oraz S3b.
Aktywny backup używa istniejącego połączenia kontrolera. CLI przy aktywnym
właścicielu korzysta z istniejącego prywatnego kanału administracyjnego;
niedostępny kanał odmawia działania, bez obejścia locka.
Ręczna kopia offline zachowuje niezmigrowany schemat i termin harmonogramu.

Jeden executor serializuje zlecenia. Checksummed rejestr poza SQLite utrwala
klucze idempotencji, stan, wynik i aktora. Restart rozlicza przerwane operacje;
rozpoznaje komplet opublikowany przez S3, którego potwierdzenie przerwano.
Nie odtwarza kolejki ani lawiny zaległych terminów. Ręczne tworzenie nie zmienia
terminu usługi. Błędy backupu, admission harmonogramu i retencji są widoczne,
bez zatrzymania działającej aplikacji.

Rejestr ma limit 1024 operacji i 4 MiB. GUI pokazuje ostatnie 50.
Starsze zakończone operacje okresowe bez istniejącego materiału są usuwane
z historii; trwały watermark terminów odmawia ich powtórnego wykonania.
Ręczne klucze pozostają. Zapełniony rejestr odmawia nowego admission i wymaga
przeglądu operatora. Katalog ogranicza skan do 4096 wpisów i 1024 kopii.

Retencja działa wyłącznie po udanym okresowym backupie z włączonym
harmonogramem. Usuwa tylko własne, zapisane w rejestrze, okresowe kopie po
pełnej weryfikacji i sprawdzeniu zachowanego hasha manifestu. Chroni najnowsze
punkty ratunkowe, ręczne i pre-migration kopie oraz wszystkie przyjęte źródła
restore. Uszkodzone, obce, symlinkowane i nieznane materiały pozostają.
Wyłączenie harmonogramu nie usuwa kopii i nie wykonuje retencji.
Nie dodano GC załączników ani starych generacji restore.

## Tożsamość, GUI i restore

Web wymaga aktualnego tokenu instalacji i odpowiedniej akcji dopuszczonej
przez CLI. Uprawnienia są sprawdzane przy odczycie, admission i wykonaniu.
Właściciel projektu, agent i worker nie stają się operatorem. Tryby open,
legacy i niezaufane rozróżnienie tożsamości nie udostępniają operacji web.
Nie powstał endpoint ani narzędzie MCP zmieniające politykę usługi.
Klient wysyła ID, klucz i jawne potwierdzenie, bez ścieżek ani komend.
Publiczne odpowiedzi nie zawierają sekretów i ścieżek infrastruktury.

Dialog PL/EN udostępnia katalog, datę z manifestu, rozmiar, zgodność,
weryfikację publikacji, politykę i status. Podgląd restore ponownie sprawdza
kompletną kopię i opisuje skutki dla całej instalacji. Native checkbox wymaga
jawnego potwierdzenia utraty późniejszych zmian. Session storage zachowuje
zlecenie i klucz bez sekretu tokenu; ponowne otwarcie odczytuje aktualną
autoryzację i status. Nie powstała dodatkowa subskrypcja ani pętla odpytywania.

Trwałe zlecenie S3b poprzedza odpowiedź i maintenance. Maintenance blokuje
nowe zapisy/zlecenia HTTP, MCP i CLI, zamyka admission wspólnego lifecycle,
kończy przyjęte operacje i backup, anuluje testy przez ich maszynę stanów,
a następnie zatrzymuje zweryfikowane własne procesy. Błąd cleanup zatrzymuje
handoff. SQLite zostaje zamknięte przed executorem pod lockiem bazy;
singleton kontrolera pozostaje utrzymany. HTTP nie podmienia otwartej bazy.

Stan i dowód przeżywają podmianę SQLite. Restart w tym samym procesie Node
zachowuje argumenty. Po awarii `executing` uruchamia recovery S3b przed
zwykłym otwarciem bazy. Aktualna polityka uwierzytelniania jest utrwalona
poza bazą i przywracana przed listenerami; wszystkie przywrócone poświadczenia
zakresowe zostają unieważnione. Dawny token instalacji nie odzyskuje zaufania.
Ponowienie naprawia potwierdzenie, zamiast wykonywać drugi restore.
CLI odmawia dostępu offline, gdy ten fence pozostaje niedokończony.

## Weryfikacja końcowa

Zadania wykonano kolejno przez Worktree Switcher MCP, według odkrytych
presetów i dokładnej ścieżki z `list_worktrees`. Nie uruchamiano ani nie
przełączano zarządzanego serwera developerskiego. Integracja uruchamia własne
izolowane kontrolery, a UI prawdziwy statyczny eksport z fixture API.

| Preset | Run ID | Wynik na `1147b2f` |
| --- | --- | --- |
| `node:check` | `a6a51adb-42a3-4ff1-a743-95a852592f81` | PASS: lint, typy, 769 Vitest / 90 plików + 7 testów skryptów |
| `node:build` | `9875bce1-5b56-4f9c-8fe4-c05477b83ed0` | PASS: statyczny eksport i bundle CLI |
| `node:test:integration` | `565b5455-5070-4f14-88cf-f4512750bfba` | PASS: 28 testów / 6 plików, fingerprint artefaktu |
| `node:test:ui` | `005321ab-f12a-4a0a-955d-f1f5757be881` | PASS: 142 testy, 1 worker |
| `node:test:ui:backups` | `ac218a56-fba1-4e3c-9d81-8c8486703695` | PASS: 7 testów |

Wszystkie przebiegi w tabeli mają fazę `passed`, exit 0, `dirty=false` na
enqueue/preflight/finish oraz `observed_match`. Surowe ograniczone ogony i
obserwacje Git są w [pliku dowodów](storage-safety-s4a-evidence-20261001.json).

47 nowych testów unit/transport obejmuje konfigurację domyślną i błędną,
argumenty usługi, brak zmian przy walidacji katalogu, serializację, idempotencję,
restart, zaległe terminy, wyłączenie harmonogramu, watermark historii,
odmowę/cofnięcie uprawnień, timeout, nieudany backup i bezpieczną retencję.
Regresja lifecycle sprawdza kolejność drain → stop → close. Testy handoff
obejmują błędny cleanup, konflikt otwartego właściciela, powtórne wykonanie,
odmowę CLI po przerwanym fence i cofnięcie polityki restore przy restarcie.

Siedem rzeczywistych SIGKILL na izolowanych fixture ext4 dotyczy publikacji
zlecenia, maintenance, zamknięcia SQLite, `executing`, intencji podmiany,
S3b `verified` i potwierdzenia executora. Recovery zachowuje stary kompletny
stan lub wznawia dokładnie jeden restore, kończy fence i zachowuje późniejsze
zapisy. SIGKILL nie jest dowodem odporności na utratę zasilania.

GUI sprawdza PL/EN, Space/Enter/Escape i powrót fokusu, utratę odpowiedzi,
ponowienie tego samego klucza, status po ponownym otwarciu, cofnięcie dostępu,
brak menu open/legacy, szerokości 1440/1366/390/320, krótki ekran 320×320
i oba motywy. Screenshoty podglądu obejrzano; potwierdzenie mieści się w małym
ekranie z pionowym przewijaniem. Rzeczywisty browser zoom 200% pozostaje
niezweryfikowany; zwężenia viewportu nie utożsamiono z zoomem.

## Diagnozy i wcześniejsze rewizje

Brudne przebiegi robocze, również exit 0, nie są czystym zaliczeniem kolejki.
Naprawione błędy obejmowały położenie shebang, przekazanie pola transportowego
do strict kontraktu S3b, kolejność kluczy checksum, fixture sortowania,
React lint i asercję poprzedniej kolejności shutdown. Nowe testy ograniczania
historii i prywatności fixture także wykryły błędne założenia, poprawione
przed zamrożeniem kodu. Dowody zachowują ich wyniki.

Check i build na `3e4ec5e` przeszły. Integracja
`d2fe29ce-f09b-4832-9d2d-b54b5fc3e794` i pierwszy
[CI](https://github.com/pioootrek/worktree-switcher/actions/runs/36915630986)
wykazały błąd fixture: CLI bootstrap-owner oczekiwał legacy pairing,
którego token mode nie udostępnia. Fixture korzysta teraz z aktualnego
API administracji tokenowej i poświadczenia agenta. Ukierunkowana integracja
`c06617f7-a718-4757-97a0-6a49a5fbc23c` przeszła na `66a1141` (2 testy).
Ten commit zamknął także dostęp offline przed zakończeniem restore fence.

Ukierunkowane UI `ca603c46-985c-4187-915d-e37bd847fb38` wykazało 4 błędy.
Trace potwierdził brak `crypto.randomUUID` pod HTTP oraz zachowanie podglądu
po zamknięciu. `a0038da` używa `getRandomValues` i świeżego dialogu po otwarciu.
Kolejny run `6a523d59-0d1d-426b-a27c-d8b93e3d9594` miał 6 PASS i błąd
strict selektora dwóch statusów. `1147b2f` ogranicza asercję do dialogu;
wszystkie 7 przeszło. Nie dodano opóźnień, retry ani słabszych asercji.
Logi i trace’y zachowano przed ponowieniem w `/tmp/wts-s4a-ui-failure-1/`,
`/tmp/wts-s4a-ui-failure-2/` i `/tmp/wts-s4a-ci-36915630986-failed.log`.
CI `36916906421` anulowano przez kolejny commit; nie jest zaliczony.

## Pakiet, ograniczenia i zakończenie

[Końcowy CI](https://github.com/pioootrek/worktree-switcher/actions/runs/36917252428)
przeszedł check/build, HTTPS, integration, UI, E2E i pakowanie. Smoke
zainstalowanego artefaktu przeszedł na Node 22.23.2 i 24.21.0; lifecycle
systemd przeszedł na jednorazowym runnerze. Workflow testuje syntetyczny
merge checkout dla head `1147b2f`, oddzielnie od lokalnego dokładnego SHA.
Nie uruchamiano instalacji ani zmiany usługi na llm-worker.

Źródło pakietu: czysty syntetyczny merge
`244958fd2f5b3e392927a63bfbcd6634d26ac6cf`. Artefakt
`worktree-switcher-0.1.0-trial.1.tgz` ma 821975 bajtów i SHA256
`37fa91913e5e6dd5542376b653a3caf168e5850467d46c665e41a70e7133e9b3`.
Zweryfikowano checksum artefaktu oraz obu dołączonych skryptów względem
provenance. Jego pole `pending-package-smoke` pochodzi z chwili pakowania;
oddzielne raporty smoke potwierdzają po 13 udanych kroków i graceful cleanup.
Raport lifecycle potwierdza 3 preflight, 6 faz i 2 negatywne scenariusze,
brak faults oraz usunięcie usługi przy zachowaniu danych. Zwięzłe wyniki
i powiązanie artefaktu są zapisane w pliku dowodów.

Kopie pozostają na jednym hoście. Timeout jest kooperacyjny: synchroniczne
I/O może potrwać dłużej przed następnym sprawdzeniem. Ręczne klucze idempotencji
i chronione kopie mogą wypełnić limity, wymagając przeglądu operatora.
Przerwane stagingi i stare generacje pozostają materiałem recovery i mogą
zajmować dysk. Nie wykonano fizycznego zapełnienia dysku, power loss,
aktualizacji ze starego zainstalowanego artefaktu ani próby na produkcyjnej bazie.
Nie zmieniano produkcji, usług ani hostowych limitów.

PR jest gotowy do review, wszystkie wymagane kontrole są zielone.
Nie ma rzeczywistego blokera w dostarczeniu S4a. Zadanie nadrzędne
pozostaje otwarte. S4u, transfer poza hosta S4b, odbiór S5 i późniejszy cutover
nie zostały rozpoczęte. Nie scalono PR i nie wdrożono produkcji.
