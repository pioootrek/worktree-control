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
Końcowy head po follow-up Opusa: `dcbf1a7e7dc47001710fe26dc5daf113ff708ae1`.
Wcześniejszy follow-up Kimi: `de89e998149112ffbe44c10f4a6a2a420c049ebb`.
Pierwotne dostarczenie: `1147b2ff0269eb6d63dd3df81a104b5aee22707c`.
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

Rejestr ma oddzielne limity 1024 ręcznych i 1082 okresowych operacji,
łącznie najwyżej 2106 wpisów i nadal 4 MiB. GUI pokazuje ostatnie 50.
Starsze zakończone operacje okresowe bez istniejącego materiału są usuwane
z historii; trwały watermark terminów odmawia ich powtórnego wykonania.
Ręczne klucze pozostają. Zapełnienie ich limitu odmawia nowych ręcznych
zleceń, zachowuje ich status po restarcie i nie zajmuje limitu harmonogramu.
Wspólny limit bajtów lub brak miejsca nadal mogą zatrzymać admission.
Bezpieczna procedura obsługi pełnej historii ręcznej pozostaje otwartym
punktem operacyjnym w zadaniu nadrzędnym; ręczne kasowanie ledgeru nie jest
procedurą recovery. Katalog ogranicza skan do 4096 wpisów i 1024 kopii.

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
nowe zapisy/zlecenia HTTP, MCP i CLI, zamyka admission wspólnego lifecycle
i startów procesów. Koordynuje drain przyjętych operacji i backupu z anulowaniem
testów przez ich maszynę stanów oraz zatrzymaniem zweryfikowanych własnych
procesów. Błąd cleanup zatrzymuje
handoff. SQLite zostaje zamknięte przed executorem pod lockiem bazy;
singleton kontrolera pozostaje utrzymany. HTTP nie podmienia otwartej bazy.

Stan i dowód przeżywają podmianę SQLite. Restart w tym samym procesie Node
zachowuje argumenty. Po awarii `executing` uruchamia recovery S3b przed
zwykłym otwarciem bazy. Aktualna polityka uwierzytelniania jest utrwalona
poza bazą i przywracana przed listenerami; wszystkie przywrócone poświadczenia
zakresowe zostają unieważnione. Dawny token instalacji nie odzyskuje zaufania.
Ponowienie naprawia potwierdzenie, zamiast wykonywać drugi restore.
CLI odmawia dostępu offline, gdy ten fence pozostaje niedokończony.

## Follow-up niezapisanych uwag Opusa — 2026-10-02

Odczytano zachowany wynik n8n execution `9579`: Opus oceniał head `1147b2f`
i przygotował pięć uwag, ale odmowa uprawnień nie pozwoliła opublikować ich
na GitHub. Nie są to nowe wątki GitHub ani ponowne review aktualnego head.
Każdą sprawdzono względem bieżącego kodu; wyniki opisuje poniższa tabela.

| Uwaga | Wynik |
| --- | --- |
| Względna ścieżka aktywnego CLI | `fix`, już wdrożony po Kimi w `d557fd6`; regresja nadal sprawdza katalog operatora. |
| Historia ręcznych zleceń blokuje harmonogram | `fix`: niezależny budżet 1082 wpisów okresowych; zapełnione 1024 ręczne klucze i restart nie blokują nowych terminów usługi. Ręcznych kluczy nie kasuje się automatycznie. |
| Shutdown czeka na timeout startu | `fix`: admission procesów zamyka się przed listenerami, start sprawdza zamknięcie przed spawn i podczas readiness. Cleanup procesów i drain lifecycle przebiegają razem. HTTP/MCP/admin zamykają idle keep-alive po końcu przyjętej odpowiedzi. |
| Preview blokuje HTTP pełną walidacją | `fix`: preview, admission i weryfikacja retencji korzystają z jednego ograniczonego procesu, otwierającego tylko clone. Deadline i limity bajtów pochodzą z CLI; shutdown czeka na jego zakończenie i cleanup. Autoryzację i manifest sprawdza się ponownie po await; równoczesne zlecenia są ograniczone, a jednakowe klucze restore współdzielą przyjęcie. |
| Kopia pre-migration bez ledgeru wygląda na uszkodzoną | `fix`: osobny stan `unverified` / brak zapisanego wyniku, odróżniony od `failed` w PL/EN. Taka kopia pozostaje chroniona; pełny preview nadal jest wymagany przed potwierdzeniem w GUI. |

`dcbf1a7` wspólnie sprawdza admission backupu i restore przed oraz po
asynchronicznej walidacji. Starszy receipt S3b nie może otworzyć nowego
handoff podczas zamykania kontrolera; odczyt statusu pozostaje dostępny.
Regresja potwierdza odmowę, brak nowego handoff i zachowanie danych.

Po przeniesieniu walidacji poza event loop test ujawnił utratę eventu `close`,
gdy klient odłączał się przed zakończeniem admission. `ca5f554` sprawdza także
zamkniętą odpowiedź i uruchamia to samo trwałe zlecenie. Smoke tarballa sprawdza
obecność helpera oraz rzeczywisty backup i preview po instalacji pakietu.

Nieudany check `13815243-54f8-4720-ad61-bf07aec98895` na `ceb6841` wykrył
trzy błędy typów IPC/środowiska. Log zapisano przed zmianą w
`/tmp/wts-s4a-opus-check-ceb6841.json`; ukierunkowany typecheck
`a9d7b423-6237-46bb-8dbd-b4ad7d95d82c` przeszedł po poprawce w `22c1884`.
Diagnoza HTTP `97551330-5a7b-4393-a586-5d0e22d519a4` miała 62 PASS i 1 FAIL;
log zapisano w `/tmp/wts-s4a-opus-disconnect-diagnostic.json`.
Po poprawce wszystkie 63 przeszły na czystym `ca5f554` w
`4db4f492-0969-4d95-8c3f-a3c4ef48a0a9`.

Pełna integracja `1f47ef85-1180-414b-81d4-50c1c72863f8` i
[CI 36930284650](https://github.com/pioootrek/worktree-switcher/actions/runs/36930284650)
wykryły błąd drain listenera w nowym gated-start regression: 29 PASS i 1 FAIL.
Logi zachowano przed diagnozą (`/tmp/wts-s4a-opus-integration-ca5f554-failed.json`,
`/tmp/wts-s4a-opus-ci-36930284650-failed.log`). Ukierunkowane przebiegi
`cf226ef9-864b-40d7-b1a3-0a74e29141e5` i
`1a8c3583-c580-4bce-ae79-8ed3f816de0a` dodały dowód: start oddał HTTP 400,
PID własnego procesu nie żył, ale kontroler czekał na listener podczas status
pollingu. Teardown SIGTERM był nieczysty; żadnego z tych przebiegów nie zaliczono.
`d48f10e` zamyka idle keep-alive po zakończeniu odpowiedzi, zachowując aktywne
handlery i wspólny drain. Ukierunkowane cztery integracje przeszły na czystym
SHA; gated restore trwał 1,3 s. Nie zwiększano timeoutów, nie dodano opóźnień
ani retry i nie osłabiono asercji. CI `36929665933` anulowane przez późniejszy
commit także nie jest zaliczone. Brudne przebiegi diagnostyczne pozostają
wyłącznie dowodem diagnozy, niezależnie od exit code.

Końcowe kontrole lokalne wykonano kolejno przez MCP na czystym
`dcbf1a7e7dc47001710fe26dc5daf113ff708ae1`, z `observed_match` dla
każdego enqueue/preflight/finish:

| Preset | Run ID | Wynik |
| --- | --- | --- |
| `node:test:backups` | `c2cffaa3-ce64-4c36-95ff-0b6f281e7118` | PASS: 64 testy |
| `node:check` | `ca98f5b0-ed54-4031-af27-90f83b3cb2ff` | PASS: lint, typy, 782 Vitest / 91 plików + 7 testów skryptów |
| `node:build` | `e20834c9-1686-437d-80b5-1d0cd2d12972` | PASS: eksport i bundle CLI z helperem |
| `node:test:integration` | `b149b882-f81b-48c4-b750-b3a4336f05cb` | PASS: 30 testów / 6 plików |
| `node:test:ui` | `4ff22a2c-4914-4c45-a2f3-56aba4a6e65c` | PASS: 144 testy, 1 worker; PL/EN, keyboard i mobile |

[Końcowe CI 36932383355](https://github.com/pioootrek/worktree-switcher/actions/runs/36932383355)
ma wszystkie cztery joby zielone: check/build z HTTPS, integracją, UI i E2E,
smoke pakietu na Node 22.23.2 i 24.21.0 oraz lifecycle usługi na jednorazowym
runnerze. Pobrane artefakty sprawdzono niezależnie: checksumy tarballa i obu
skryptów pasują do provenance, a tarball zawiera helper `backup-verifier.js`
i jego trzy współdzielone chunki. Źródło pakietu to czysty syntetyczny merge
`269636fac2ab0fa442bea4b209427e6860c4e25a`, odrębny od feature head.
Tarball ma 824242 bajty i SHA256
`2d5b671659a7c916e402b916b92f0b5ff5ba3a3e77d4b640430586b2c5c3d3bb`.
Oba raporty smoke potwierdzają 14 kroków, w tym backup i pełny preview
z zainstalowanego artefaktu, oraz graceful cleanup. Lifecycle ma 3 preflight,
6 faz i 2 scenariusze negatywne, bez faults; cleanup potwierdza brak usługi
i zachowanie danych. `pending-package-smoke` w provenance opisuje chwilę
pakowania; późniejsze raporty smoke są dowodem ukończenia. Anulowane CI
`36931812431` nie jest zaliczeniem. Nie pozostał bloker weryfikacji S4a.

## Follow-up review Kimi — head `de89e99`

Oba nierozwiązane wątki sklasyfikowano jako `fix` i rozwiązano po publikacji
poprawek oraz ich weryfikacji. Nie odłożono żadnego do backloga i nie uznano
żadnego za false positive.

- [Katalog względny aktywnego CLI](https://github.com/pioootrek/worktree-switcher/pull/72#discussion_r4160199484): CLI rozwiązuje ścieżkę względem własnego cwd przed wysłaniem jej kanałem administracyjnym. Regresja skompilowanego CLI z osobnego tymczasowego katalogu sprawdza kompletny manifest we wskazanym przez operatora miejscu.
- [Brak zlecenia restore](https://github.com/pioootrek/worktree-switcher/pull/72#discussion_r4160200987): brak receipt S3b (`ENOENT`) daje bezpieczny `backup_invalid` / HTTP 404. Inne błędy nadal są propagowane; aktualna autoryzacja poprzedza lookup. Testy sprawdzają nieznany klucz przed/po admission, odpowiedź CLI i odmowę po cofnięciu tokenu.

Poprawki kodu opublikowano w `d557fd6`. Nowa fixture używała początkowo
nieprawidłowego formatu ID, więc walidacja transportu słusznie zwracała 400.
Check `e2a651d2-2ba6-4320-99a4-9613bb0e7179` i
[CI 36923843336](https://github.com/pioootrek/worktree-switcher/actions/runs/36923843336)
miały 769 PASS i 1 FAIL; log zachowano w
`/tmp/wts-s4a-review-ci-36923843336-failed.log` przed diagnozą.
`de89e99` poprawia wyłącznie ID fixture do obowiązującego kontraktu.
Pozostawiono asercję 404, bez opóźnień, retry i osłabienia testu.
Najpierw przeszedł ukierunkowany preset backupów, następnie pełne sprawdzenia.

| Preset | Run ID | Wynik na `de89e99` |
| --- | --- | --- |
| `node:test:backups` | `6796db69-19b0-4c28-bf36-73fd9cef78ed` | PASS: 53 testy |
| `node:check` | `ce74ff67-9490-459c-87a9-169b162f3c02` | PASS: lint, typy, 770 Vitest + 7 testów skryptów |
| `node:build` | `1bde1211-4ba9-4627-8740-caa6df98a14c` | PASS |
| `node:test:integration` | `c85db7ff-fa0c-4bfb-ab6e-62f5069f5d95` | PASS: 29 testów |
| `node:test:ui` | `ba9813f4-e95c-4457-b4bb-c40578d41371` | PASS: 142 testy |

Wszystkie powyższe przebiegi zakończyły się `passed`, exit 0, czystym
enqueue/preflight/finish i `observed_match` na dokładnym końcowym SHA.
[Końcowy CI 36924532217](https://github.com/pioootrek/worktree-switcher/actions/runs/36924532217)
przeszedł check/build, HTTPS, integration, UI, E2E, smoke pakietu na Node
22.23.2/24.21.0 i systemd lifecycle na jednorazowym runnerze.
Nowy pakiet pochodzi z czystego syntetycznego merge
`fd164df0e44cd11e946d615c1a180b05521ddd69`, ma 822000 bajtów i SHA256
`1b61543b27493d1f2c2cd7744eb19fffb134df5c792f81dc9420a9f3220a11d3`.
Checksumy artefaktu i obu skryptów pasują do provenance; oddzielne raporty
potwierdzają po 13 kroków smoke z graceful cleanup i udany lifecycle bez faults.
Pole `pending-package-smoke` w provenance pozostaje stanem z chwili pakowania.
Wyniki pierwotnego dostarczenia i pakietu poniżej zachowano jako historię.

## Weryfikacja pierwotnego dostarczenia

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

[CI pierwotnego dostarczenia](https://github.com/pioootrek/worktree-switcher/actions/runs/36917252428)
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

Kopie pozostają na jednym hoście. Timeout tworzenia kopii jest kooperacyjny:
synchroniczne I/O może potrwać dłużej przed następnym sprawdzeniem. Walidacja
online ma limit czasu własnego procesu pomocniczego, z zakończeniem procesu
i cleanupem przed odpowiedzią. Ręczne klucze idempotencji
i chronione kopie mogą wypełnić limity, wymagając przeglądu operatora.
Przerwane stagingi i stare generacje pozostają materiałem recovery i mogą
zajmować dysk. Nie wykonano fizycznego zapełnienia dysku, power loss,
aktualizacji ze starego zainstalowanego artefaktu ani próby na produkcyjnej bazie.
Nie zmieniano produkcji, usług ani hostowych limitów.

PR jest gotowy do review, wszystkie wymagane kontrole są zielone.
Nie ma rzeczywistego blokera w dostarczeniu S4a. Zadanie nadrzędne
pozostaje otwarte. S4u, transfer poza hosta S4b, odbiór S5 i późniejszy cutover
nie zostały rozpoczęte. Nie scalono PR i nie wdrożono produkcji.
